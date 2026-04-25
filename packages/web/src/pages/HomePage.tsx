import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { createRoom, joinRoom, listRooms, spectateRoom, getSocket, getStoredToken } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { fetchAdminMe } from '../services/api';
import { forceRefresh } from '../utils/forceRefresh';
import {
  Play,
  LogIn,
  BookOpen,
  RefreshCw,
  RefreshCcw,
  Eye,
  Lock,
  BarChart3,
  Clock,
  User,
  Settings,
} from 'lucide-react';
import { TIMER_MULTIPLIER_OPTIONS, TimerMultiplier } from '@avalon/shared';
import LanguageSwitcher from '../components/LanguageSwitcher';
import PublicChatPanel from '../components/PublicChatPanel';
import BrandHeader from '../components/BrandHeader';
import IdentityBadge from '../components/IdentityBadge';
import AuthGateModal, { AuthGateTarget } from '../components/AuthGateModal';
import BindingField from '../components/BindingField';

function isGuestPlayer(player: { name?: string; provider?: string } | null | undefined): boolean {
  if (!player) return true;
  if (player.provider) return player.provider === 'guest';
  return /^Guest_\d{3,}$/i.test(player.name ?? '');
}

interface OpenRoom {
  id: string;
  fullId: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  createdAt: number;
  inProgress: boolean;
  isPrivate: boolean;
}

export default function HomePage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState, setCurrentPlayer, currentPlayer, addToast } = useGameStore();
  const [playerName, setPlayerName] = useState(
    currentPlayer?.name ?? localStorage.getItem('avalon_player_name') ?? ''
  );
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'home' | 'create' | 'join'>('home');
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);
  const [roomPassword, setRoomPassword] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [pendingJoinRoom, setPendingJoinRoom] = useState<OpenRoom | null>(null);
  const [isAdminUser, setIsAdminUser] = useState(false);
  // 2026-04-24 #ux-phase-2 (hineko_20260424_1040): auth gate for Row 2
  // buttons that need an identity (個人戰績 / 登入綁定).
  const [authGateTarget, setAuthGateTarget] = useState<AuthGateTarget | null>(null);

  // Phase 3 pendingAction hop: user triggered OAuth from BindingField in
  // create/join mode — after the reload, drop them back into that mode.
  // Separate localStorage key space from Phase 2 `pendingGateTarget` so the
  // two flows don't collide.
  useEffect(() => {
    if (isGuestPlayer(currentPlayer)) return; // wait for authed state
    const action = localStorage.getItem('pendingAction');
    if (action === 'create' || action === 'join') {
      setMode(action);
      localStorage.removeItem('pendingAction');
      if (action === 'join') {
        const code = localStorage.getItem('pendingRoomCode');
        if (code) {
          setRoomId(code);
          localStorage.removeItem('pendingRoomCode');
        }
      }
    }
  }, [currentPlayer]);

  // After an OAuth reload, check where the user was heading and route them there.
  // 'chat' branch: user was gated on the lobby chat input — stay on home but
  // scroll / focus the chat so the comeback loop is obvious. Slight 300ms
  // timeout so PublicChatPanel has time to mount and wire up its socket.
  useEffect(() => {
    const target = localStorage.getItem('pendingGateTarget') as AuthGateTarget | null;
    if (!target) return;
    if (isGuestPlayer(currentPlayer)) return; // still guest → keep waiting
    localStorage.removeItem('pendingGateTarget');
    if (target === 'stats') setGameState('personalStats');
    else if (target === 'settings') setGameState('settings');
    else if (target === 'chat') {
      // User came back from the lobby-chat gate. Stay on home; the chat
      // input unlocks itself once currentPlayer.provider !== 'guest'.
      // No explicit scroll/focus — the panel is already in view in the
      // right-column layout, and focusing a text field without a visible
      // cue would feel jumpy.
    }
  }, [currentPlayer, setGameState]);

  const tryGatedNavigate = (target: AuthGateTarget, proceed: () => void): void => {
    if (isGuestPlayer(currentPlayer)) {
      setAuthGateTarget(target);
      return;
    }
    proceed();
  };
  // Per-room phase-timer multiplier (1x default). null = unlimited.
  const [timerMultiplier, setTimerMultiplier] = useState<TimerMultiplier>(1);
  // 娛樂局 (Edward 2026-04-24 14:43): 勾選後此局戰績不計入 ELO。
  // 預設 false 以保留原本排位行為。
  const [casualMatch, setCasualMatch] = useState<boolean>(false);

  // Check admin status for UI conditional (shown after logged-in player loads)
  useEffect(() => {
    if (!currentPlayer) return;
    const token = getStoredToken();
    if (!token) return;
    fetchAdminMe(token)
      .then(me => setIsAdminUser(me.isAdmin))
      .catch(() => setIsAdminUser(false));
  }, [currentPlayer]);

  // Bug fix (Edward 2026-04-25): logged-in user clicked 建立房間 and saw
  // 「請輸入你的名字」 toast even though @Edward was bound. Root cause: the
  // playerName state seeds from currentPlayer at mount-time only, so if
  // auth resolves AFTER mount (typical socket flow) playerName stays ''.
  // BindingField hides the name input in the locked state, leaving no UI
  // to populate it. Sync playerName whenever currentPlayer.name shows up
  // and our local state is still empty / lagging the displayName.
  useEffect(() => {
    if (isGuestPlayer(currentPlayer)) return;
    const authedName = currentPlayer?.name?.trim();
    if (!authedName) return;
    if (!playerName.trim()) {
      setPlayerName(authedName);
    }
  }, [currentPlayer, playerName]);

  // Auto-populate (and auto-join) from ?room=XXXXXXXX invite link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteCode = params.get('room');
    if (!inviteCode) return;

    const code = inviteCode.toUpperCase().slice(0, 8);
    setRoomId(code);
    window.history.replaceState({}, '', window.location.pathname);

    // If player already has a name, auto-join immediately
    const name = currentPlayer?.name ?? playerName;
    if (name.trim()) {
      if (currentPlayer) {
        setCurrentPlayer({ ...currentPlayer, name });
      }
      joinRoom(code);
      setGameState('lobby');
    } else {
      setMode('join');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to room list updates + auto-refresh every 15 s
  useEffect(() => {
    let socket: ReturnType<typeof getSocket> | null = null;
    try { socket = getSocket(); } catch { return; }

    const handler = (rooms: OpenRoom[]) => setOpenRooms(rooms);
    socket.on('game:rooms-list', handler);
    listRooms(); // initial fetch

    const interval = setInterval(listRooms, 15_000);
    return () => {
      socket!.off('game:rooms-list', handler);
      clearInterval(interval);
    };
  }, []);

  // Effective name resolver: logged-in user → currentPlayer.name (displayName);
  // guest → the form input. This lets us skip the「請輸入你的名字」toast for
  // bound users whose BindingField renders the locked state with no input.
  const resolveEffectiveName = (): string => {
    const formName = playerName.trim();
    if (formName) return formName;
    if (!isGuestPlayer(currentPlayer)) {
      return currentPlayer?.name?.trim() ?? '';
    }
    return '';
  };

  const handleCreateRoom = (): void => {
    const effectiveName = resolveEffectiveName();
    if (!effectiveName) {
      addToast(t('home.enterYourName'), 'info');
      return;
    }

    // Preserve Firebase UID — server uses uid as player ID
    if (currentPlayer) {
      setCurrentPlayer({ ...currentPlayer, name: effectiveName });
    }

    localStorage.setItem('avalon_player_name', effectiveName);
    try {
      createRoom(
        effectiveName,
        roomPassword.trim() || undefined,
        timerMultiplier,
        casualMatch,
      );
      setGameState('lobby');
    } catch {
      addToast(t('home.createRoomFailed'), 'error');
    }
  };

  const handleJoinRoom = (): void => {
    const effectiveName = resolveEffectiveName();
    if (!effectiveName) {
      addToast(t('home.enterYourName'), 'info');
      return;
    }

    if (!roomId.trim()) {
      addToast(t('home.enterRoomCode'), 'info');
      return;
    }

    // Preserve Firebase UID — server uses uid as player ID
    if (currentPlayer) {
      setCurrentPlayer({ ...currentPlayer, name: effectiveName });
    }

    localStorage.setItem('avalon_player_name', effectiveName);
    try {
      joinRoom(roomId, joinPassword.trim() || undefined);
      setGameState('lobby');
    } catch {
      addToast(t('home.joinRoomFailed'), 'error');
    }
  };

  const currentName = currentPlayer?.name ?? t('auth.guest');

  return (
    <div className="min-h-screen bg-black px-3 py-4 sm:p-4 overflow-x-hidden">
      {/* Background decorations */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <motion.div
          animate={{
            x: [0, 50, 0],
            y: [0, 30, 0],
            opacity: [0.05, 0.15, 0.05],
          }}
          transition={{ duration: 20, repeat: Infinity }}
          className="absolute top-10 right-10 w-96 h-96 bg-white rounded-full blur-3xl"
        />
        <motion.div
          animate={{
            x: [0, -50, 0],
            y: [0, -30, 0],
            opacity: [0.05, 0.1, 0.05],
          }}
          transition={{ duration: 25, repeat: Infinity }}
          className="absolute bottom-10 left-10 w-96 h-96 bg-white rounded-full blur-3xl"
        />
      </div>

      <div className="flex items-start sm:items-center justify-center min-h-screen relative z-10 pt-16 sm:pt-0">
        {/* Top-right controls — language only. Logout / Profile / Admin 全部搬到資料設定頁。
            改 fixed 避免手機上 absolute 佔據 container 寬度把右側按鈕擠出螢幕。 */}
        <div className="fixed top-3 right-3 sm:top-6 sm:right-6 z-30 flex items-center gap-2">
          <IdentityBadge />
          <LanguageSwitcher />
        </div>

        <div className="w-full max-w-5xl">
          {mode === 'home' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center space-y-6 w-full"
            >
              {/* Title — shared BrandHeader (matches LoginPage) */}
              <BrandHeader size="lg" />

              {/* Main content: 6-button grid + lobby chat */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="grid grid-cols-1 md:grid-cols-5 gap-4 pt-2"
              >
                {/* Buttons area — 2×3 on mobile, 3×2 on desktop */}
                <div className="md:col-span-3 space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3">
                    {/*
                      #86 IA v3 — 6 main buttons（2026-04-23 拆兩頁）
                        Row 1: 建立房間 / 加入房間 / 數據排行
                        Row 2: 個人戰績 / 百科攻略 / 系統設定

                      整合決策：
                      - 「數據排行」 route → `analytics` (含排行榜 + 雷達圖 + AI 自對弈 + 深度分析四 tab)
                      - 「個人戰績」 route → `personalStats` (= ProfilePage 歷史戰績 + 追蹤 / 對戰
                        成績 placeholder)
                      - 「系統設定」 route → `settings` (基本資料 + 帳號綁定 + 登出)
                      - FAQ 獨立按鈕拿掉；設定頁內可加 FAQ link (未來)
                    */}
                    {/* Row 1 — Create / Join / Stats */}
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setMode('create')}
                      data-testid="home-btn-create"
                      className="w-full min-w-0 bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-3 px-2 sm:px-4 rounded-lg transition-all flex items-center justify-center gap-1.5 sm:gap-2 shadow-md text-sm sm:text-base"
                    >
                      <Play size={18} className="flex-shrink-0" />
                      <span className="truncate">{t('home.createRoom')}</span>
                    </motion.button>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setMode('join')}
                      data-testid="home-btn-join"
                      className="w-full min-w-0 bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-3 px-2 sm:px-4 rounded-lg transition-all flex items-center justify-center gap-1.5 sm:gap-2 shadow-md text-sm sm:text-base"
                    >
                      <LogIn size={18} className="flex-shrink-0" />
                      <span className="truncate">{t('home.joinRoom')}</span>
                    </motion.button>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setGameState('analytics')}
                      data-testid="home-btn-stats"
                      className="w-full min-w-0 bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-3 px-2 sm:px-4 rounded-lg transition-all flex items-center justify-center gap-1.5 sm:gap-2 shadow-md text-sm sm:text-base"
                    >
                      <BarChart3 size={18} className="flex-shrink-0" />
                      <span className="truncate">{t('home.stats')}</span>
                    </motion.button>

                    {/* Row 2 — Profile / Wiki / Settings */}
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => tryGatedNavigate('stats', () => setGameState('personalStats'))}
                      data-testid="home-btn-personal-stats"
                      className="w-full min-w-0 bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-3 px-2 sm:px-4 rounded-lg transition-all flex flex-col items-center justify-center gap-0.5 shadow-md text-sm sm:text-base"
                    >
                      <span className="inline-flex items-center gap-1.5 sm:gap-2 min-w-0">
                        <User size={18} className="flex-shrink-0" />
                        <span className="truncate">{t('home.personalStats')}</span>
                      </span>
                      <span className="text-[10px] text-zinc-400 truncate max-w-full">
                        {t('home.currentAs', { name: currentName })}
                      </span>
                    </motion.button>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setGameState('wiki')}
                      data-testid="home-btn-wiki"
                      className="w-full min-w-0 bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-3 px-2 sm:px-4 rounded-lg transition-all flex items-center justify-center gap-1.5 sm:gap-2 shadow-md text-sm sm:text-base"
                    >
                      <BookOpen size={18} className="flex-shrink-0" />
                      <span className="truncate">{t('home.wikiAndGuide')}</span>
                    </motion.button>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => tryGatedNavigate('settings', () => setGameState('settings'))}
                      data-testid="home-btn-settings"
                      className="w-full min-w-0 bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-3 px-2 sm:px-4 rounded-lg transition-all flex items-center justify-center gap-1.5 sm:gap-2 shadow-md text-sm sm:text-base"
                    >
                      <Settings size={18} className="flex-shrink-0" />
                      <span className="truncate">{t('home.binding', { defaultValue: '登入綁定' })}</span>
                    </motion.button>
                  </div>

                  {/* Admin link — small text, only shown to admins */}
                  {isAdminUser && (
                    <div className="pt-1">
                      <button
                        onClick={() => setGameState('adminClaims')}
                        className="text-xs text-zinc-500 hover:text-white underline underline-offset-2 transition-colors"
                      >
                        {t('nav.admin')}
                      </button>
                    </div>
                  )}
                </div>

                {/* #63 — Main-page public chat (guests read-only) */}
                <PublicChatPanel />
              </motion.div>

              {/* Open rooms */}
              {openRooms.length > 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.45 }}
                  className="bg-zinc-900/50 border border-zinc-700 rounded-xl p-4 text-left"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                      {t('home.openRooms')}
                    </h3>
                    <button
                      onClick={listRooms}
                      className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                      title={t('action.refresh')}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {openRooms.map(r => (
                      <div
                        key={r.id}
                        className="w-full flex items-center justify-between bg-zinc-900/70 border border-zinc-700 rounded-lg px-3 py-2"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {r.inProgress && (
                            <span className="text-xs px-1.5 py-0.5 bg-red-900/50 border border-red-700 text-red-400 rounded font-semibold flex-shrink-0">{t('home.inProgress')}</span>
                          )}
                          {r.isPrivate && (
                            <Lock size={11} className="text-zinc-300 flex-shrink-0" />
                          )}
                          <span className="text-sm font-semibold text-white truncate">{r.name}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                          <span className="text-xs text-zinc-400">
                            <span className={r.playerCount >= 5 ? 'text-white' : 'text-zinc-400'}>
                              {r.playerCount}
                            </span>
                            /{r.maxPlayers}
                          </span>
                          {r.inProgress ? (
                            <button
                              onClick={() => spectateRoom(r.fullId)}
                              className="flex items-center gap-1 text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-200 rounded transition-colors"
                              title={t('action.spectate')}
                            >
                              <Eye size={11} />
                              {t('action.spectate')}
                            </button>
                          ) : r.isPrivate ? (
                            <button
                              onClick={() => { setPendingJoinRoom(r); setRoomId(r.id); setJoinPassword(''); }}
                              className="flex items-center gap-1 text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-200 rounded transition-colors"
                            >
                              <Lock size={11} />
                              {t('action.join')}
                            </button>
                          ) : (
                            <button
                              onClick={() => { setRoomId(r.id); setMode('join'); }}
                              className="flex items-center gap-1 text-xs px-2 py-1 bg-white hover:bg-zinc-200 border border-white text-black rounded transition-colors"
                            >
                              <LogIn size={11} />
                              {t('action.join')}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Footer */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="text-xs text-zinc-500 pt-4 border-t border-zinc-800"
              >
                <p>{t('app.footer')}</p>
              </motion.div>
            </motion.div>
          )}

          {mode === 'create' && (
            <div className="space-y-6 bg-zinc-900/70 p-8 rounded-lg border border-zinc-700">
              <h2 className="text-2xl font-bold text-center text-white">{t('home.createRoom')}</h2>

              {/* 2026-04-24 #ux-phase-3: replaces the plain name input with an
                  inline OAuth binding block. Guests can still continue without
                  binding by expanding the "以訪客繼續" affordance. */}
              <BindingField
                mode="create"
                playerName={playerName}
                onPlayerNameChange={setPlayerName}
              />

              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="password"
                  placeholder={t('home.roomPasswordOptional')}
                  value={roomPassword}
                  onChange={(e) => setRoomPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateRoom()}
                  className="w-full bg-black border border-zinc-700 rounded-lg pl-8 pr-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
                />
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-zinc-400 font-semibold">
                  <Clock size={14} className="text-white" />
                  {t('home.thinkingTimeLabel')}
                </label>
                <select
                  value={timerMultiplier === null ? 'null' : String(timerMultiplier)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTimerMultiplier(v === 'null' ? null : (Number(v) as TimerMultiplier));
                  }}
                  className="w-full bg-black border border-zinc-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-white"
                >
                  {TIMER_MULTIPLIER_OPTIONS.map(opt => (
                    <option key={opt.value === null ? 'null' : String(opt.value)} value={opt.value === null ? 'null' : String(opt.value)}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-zinc-500 leading-relaxed">
                  {t('home.thinkingTimeHint')}
                </p>
              </div>

              {/* 娛樂局 — Edward 2026-04-24 14:43：
                    「遊戲開房多勾選一個"娛樂局" 的選項 在計算ELO時排除
                     有AI 與 有 勾選"娛樂局" 的場次」
                  勾選後此局戰績不計入 ELO / 排行榜。 */}
              <div className="space-y-1">
                <label
                  className="flex items-start gap-3 bg-zinc-800/40 border border-zinc-700 rounded-lg px-4 py-3 cursor-pointer hover:border-zinc-500 transition-colors"
                  title="勾選後此局戰績不計入 ELO (Casual match — not counted toward ELO)"
                >
                  <input
                    type="checkbox"
                    checked={casualMatch}
                    onChange={(e) => setCasualMatch(e.target.checked)}
                    data-testid="create-room-casual-checkbox"
                    className="w-5 h-5 mt-0.5 accent-amber-500 flex-shrink-0"
                  />
                  <div className="flex-1 text-left">
                    <div className="text-sm font-semibold text-white">
                      娛樂局 (Casual Match)
                    </div>
                    <p className="text-[10px] text-zinc-400 leading-relaxed mt-0.5">
                      勾選後此局戰績不計入 ELO 與排行榜。有 AI 參與的對局也會自動排除。
                    </p>
                  </div>
                </label>
              </div>

              <div className="space-y-3">
                <button
                  onClick={handleCreateRoom}
                  className="w-full bg-white hover:bg-zinc-200 text-black font-bold py-2 px-4 rounded-lg transition-all"
                >
                  {t('action.create')}
                </button>

                <button
                  onClick={() => {
                    setMode('home');
                    setPlayerName('');
                    setRoomPassword('');
                    setCasualMatch(false);
                  }}
                  className="w-full bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2 px-4 rounded-lg transition-all border border-zinc-700"
                >
                  {t('nav.back')}
                </button>
              </div>
            </div>
          )}

          {mode === 'join' && (
            <div className="space-y-6 bg-zinc-900/70 p-8 rounded-lg border border-zinc-700">
              <h2 className="text-2xl font-bold text-center text-white">{t('home.joinRoom')}</h2>

              {/* 2026-04-24 #ux-phase-3: same binding block as create mode. The
                  room code input stays below — that's the join-specific piece. */}
              <BindingField
                mode="join"
                playerName={playerName}
                onPlayerNameChange={setPlayerName}
                roomCode={roomId}
              />

              <input
                type="text"
                placeholder={t('home.roomCodePlaceholder')}
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && handleJoinRoom()}
                maxLength={6}
                className="w-full bg-black border border-zinc-700 rounded-lg px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white uppercase font-mono tracking-widest"
              />

              <div className="space-y-3">
                <button
                  onClick={handleJoinRoom}
                  className="w-full bg-white hover:bg-zinc-200 text-black font-bold py-2 px-4 rounded-lg transition-all"
                >
                  {t('action.join')}
                </button>

                <button
                  onClick={() => {
                    setMode('home');
                    setPlayerName('');
                    setRoomId('');
                  }}
                  className="w-full bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2 px-4 rounded-lg transition-all border border-zinc-700"
                >
                  {t('nav.back')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 2026-04-24 #ux-phase-2 auth gate modal (shared by 個人戰績 +
            登入綁定 buttons). Lives at HomePage root so only one instance
            mounts regardless of which Row 2 button triggered it. */}
        <AuthGateModal
          isOpen={authGateTarget !== null}
          onClose={() => setAuthGateTarget(null)}
          gateTarget={authGateTarget ?? 'stats'}
        />

        {/* 2026-04-24 #cache-upgrade: low-weight escape hatch for users
            who are stuck on a stale bundle but haven't triggered the
            version banner. Mirrors the Settings → 進階 button so there's
            a self-service path from anywhere in the lobby. */}
        <button
          type="button"
          data-testid="home-btn-force-refresh"
          onClick={() => { void forceRefresh(); }}
          className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 hover:border-amber-500/50 text-zinc-400 hover:text-amber-200 text-xs transition-colors backdrop-blur-sm"
          title={t('home.forceRefreshButton', { defaultValue: '遇到問題？強制更新' })}
        >
          <RefreshCcw size={12} />
          <span className="hidden sm:inline">{t('home.forceRefreshButton', { defaultValue: '遇到問題？強制更新' })}</span>
        </button>

        {/* Password modal for private rooms */}
        {pendingJoinRoom && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
            onClick={() => setPendingJoinRoom(null)}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-sm space-y-4"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                <Lock size={18} className="text-white" />
                <h3 className="font-bold text-white text-lg">{t('home.privateRoom')}</h3>
              </div>
              <p className="text-sm text-zinc-400">{t('home.enterPassword', { name: pendingJoinRoom.name })}</p>
              <input
                type="password"
                placeholder={t('home.roomPassword')}
                value={joinPassword}
                onChange={e => setJoinPassword(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    joinRoom(pendingJoinRoom.fullId, joinPassword.trim() || undefined);
                    setGameState('lobby');
                    setPendingJoinRoom(null);
                  }
                }}
                autoFocus
                className="w-full bg-black border border-zinc-700 rounded-lg px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    joinRoom(pendingJoinRoom.fullId, joinPassword.trim() || undefined);
                    setGameState('lobby');
                    setPendingJoinRoom(null);
                  }}
                  className="flex-1 bg-white hover:bg-zinc-200 text-black font-bold py-2 px-4 rounded-lg transition-all"
                >
                  {t('action.join')}
                </button>
                <button
                  onClick={() => setPendingJoinRoom(null)}
                  className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2 px-4 rounded-lg transition-all border border-zinc-700"
                >
                  {t('action.cancel')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
