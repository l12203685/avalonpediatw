import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { createRoom, joinRoom, getStoredToken } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { fetchAdminMe, fetchLinkedAccounts, LinkedAccount, LinkProvider } from '../services/api';
import {
  Play,
  BookOpen,
  ExternalLink,
  Lock,
  BarChart3,
  Clock,
  Instagram,
  Youtube,
  MessageCircle,
  MessageSquare,
} from 'lucide-react';
import { TIMER_MULTIPLIER_OPTIONS, TimerMultiplier, PLAY_PLATFORM_URL } from '@avalon/shared';
import LanguageSwitcher from '../components/LanguageSwitcher';
import AuthGateModal, { AuthGateTarget } from '../components/AuthGateModal';
import BindingField from '../components/BindingField';
import InstallButton from '../components/InstallButton';
import ForceUpdateButton from '../components/ForceUpdateButton';
import PracticeSetupPanel from '../components/practice/PracticeSetupPanel';

/** `#practice` opens the practice setup directly (works for guests too). */
const PRACTICE_HASH = '#practice';

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

/**
 * 社群連結（Edward 2026-10-30：Linktree 的內容直接放首頁，不用再多一個跳轉頁）。
 * 網址取自 linktr.ee/avalonpediatw 的公開按鈕。
 */
const COMMUNITY_LINKS = [
  { key: 'line', label: 'LINE', href: 'https://line.me/ti/g/oO5RUpWeoj', Icon: MessageCircle },
  { key: 'discord', label: 'Discord', href: 'https://discord.com/invite/mBqFqM2TXs', Icon: MessageSquare },
  { key: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/avalonpediatw/', Icon: Instagram },
  { key: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/@AvalonPediaTW/streams', Icon: Youtube },
] as const;

export default function HomePage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState, setCurrentPlayer, currentPlayer, addToast } = useGameStore();
  const [playerName, setPlayerName] = useState(
    currentPlayer?.name ?? localStorage.getItem('avalon_player_name') ?? ''
  );
  const [roomId, setRoomId] = useState('');
  // 2026-10-09: 本站不再自建對局（改到 signage-cloud 玩）。'create' / 'join'
  // 表單保留但已無任何入口 — 大廳按鈕改成 PLAY_PLATFORM_URL 外連。
  // 'practice' = 與機器人練習 setup (2026-10-13); also opened by #practice.
  const [mode, setMode] = useState<'home' | 'create' | 'join' | 'practice'>(
    () => (window.location.hash === PRACTICE_HASH ? 'practice' : 'home'),
  );
  useEffect(() => {
    const onHash = (): void => {
      if (window.location.hash === PRACTICE_HASH) setMode('practice');
    };
    window.addEventListener('hashchange', onHash);
    return (): void => window.removeEventListener('hashchange', onHash);
  }, []);
  const closePractice = (): void => {
    setMode('home');
    try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); } catch { /* ignore */ }
  };
  const [roomPassword, setRoomPassword] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [pendingJoinRoom, setPendingJoinRoom] = useState<OpenRoom | null>(null);
  const [isAdminUser, setIsAdminUser] = useState(false);
  // 2026-04-24 #ux-phase-2 (hineko_20260424_1040): auth gate for Row 2
  // buttons that need an identity (個人戰績 / 登入綁定).
  const [authGateTarget, setAuthGateTarget] = useState<AuthGateTarget | null>(null);

  // Phase 3 pendingAction hop: user triggered OAuth from BindingField in
  // create/join mode. 2026-10-09: games moved to signage-cloud, so a leftover
  // hop no longer re-opens the create/join form — just clear the keys and stay
  // in the lobby (where the signage-cloud notice is shown).
  useEffect(() => {
    if (isGuestPlayer(currentPlayer)) return; // wait for authed state
    const action = localStorage.getItem('pendingAction');
    if (action === 'create' || action === 'join') {
      localStorage.removeItem('pendingAction');
      localStorage.removeItem('pendingRoomCode');
    }
  }, [currentPlayer]);

  // After an OAuth reload, check where the user was heading and route them there.
  // 'chat' branch: left from the removed main-page chat (2026-10-28) — stay on home.
  useEffect(() => {
    const target = localStorage.getItem('pendingGateTarget') as AuthGateTarget | null;
    if (!target) return;
    if (isGuestPlayer(currentPlayer)) return; // still guest → keep waiting
    localStorage.removeItem('pendingGateTarget');
    // 'createRoom' / 'joinRoom' (leftover from before 2026-10-09) → stay in the
    // lobby; games are played on signage-cloud now.
    if (target === 'stats') setGameState('personalStats');
    else if (target === 'settings') setGameState('settings');
    // 'chat' (the removed main-page chat): stay on home.
  }, [currentPlayer, setGameState]);

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

  // Edward 2026-04-25 22:10: 大廳左上「登入狀態 chip」(替代個人戰績按鈕底下
  // 「當前: Edward」副字)。已登入時顯主名 + G/D/L 三平台綁定狀態；訪客顯
  // clickable「登入/綁定」打開 AuthGateModal。資料源同 IdentityBadge：
  // /api/user/linked → LinkedAccount[]。fetch 失敗時退回三項皆「未綁」。
  const [linkedForChip, setLinkedForChip] = useState<LinkedAccount[]>([]);
  const [linkedLoadedFor, setLinkedLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (isGuestPlayer(currentPlayer)) {
      setLinkedForChip([]);
      setLinkedLoadedFor(null);
      return;
    }
    const playerId = currentPlayer?.id ?? null;
    if (!playerId) return;
    if (linkedLoadedFor === playerId) return;
    const token = getStoredToken();
    if (!token) return;
    fetchLinkedAccounts(token)
      .then(accounts => {
        setLinkedForChip(accounts);
        setLinkedLoadedFor(playerId);
      })
      .catch(() => { /* keep fallback (unlinked-everywhere) */ });
  }, [currentPlayer, linkedLoadedFor]);

  const isProviderLinked = (provider: LinkProvider): boolean =>
    linkedForChip.some(a => a.provider === provider && a.linked);

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

  // Old ?room=XXXX invite links (self-hosted rooms). 2026-10-09: games moved
  // to signage-cloud — no more auto-join; just drop the query and stay in the
  // lobby, where the signage-cloud notice + link are shown. The open-rooms
  // list (+ its 15 s game:list-rooms poll) is gone from the lobby for the
  // same reason.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('room')) return;
    window.history.replaceState({}, '', window.location.pathname);
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

  // Edward 2026-04-25 22:10: 「當前: Edward」副字砍掉後，currentName 不再用
  // 於按鈕內。chip 直接讀 currentPlayer.name (登入時必有值)。
  const chipName = currentPlayer?.name ?? '';
  const isGuest = isGuestPlayer(currentPlayer);

  return (
    // Edward 2026-04-27 PWA status-bar fix: pt-safe gives the lobby content
    // (chips + 標題 + 6-button grid + chat) a top inset = max(default,
    // env(safe-area-inset-top)) so iOS/Android status bar (notch + 電信/
    // 時間/電量) doesn't sit on top of the UI when launched as a PWA from
    // 加到桌面. Inner fixed chips below add their own top-safe-3 / sm:top-
    // safe-6 so they too clear the bar.
    <div className="min-h-screen bg-black px-3 py-4 sm:p-4 overflow-x-hidden pt-safe">
      {/* Background decorations */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        {/* Edward 2026-04-25 19:40: ambient logo bg 太淡看不到 — 改 cover
            填滿整頁 + opacity 25% + 緩 blur-md 讓 logo 明顯但不搶焦。
            含白字 /logo.png 仍是大廳視覺主軸 (Edward 19:18 spec)。
            Edward 2026-04-25 19:56: opacity 25% 仍太淡 → 提到 40% +
            blur-md 改 blur-sm，讓 logo 更明顯但不搶焦。 */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-no-repeat bg-center bg-cover opacity-40 blur-sm"
          style={{ backgroundImage: 'url(/logo.png)' }}
        />
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

      {/* Edward 2026-04-27 mobile single-viewport: pt-16 ate 64px above the
          fold so the 6-button grid + chat got pushed below 667px. pt-12 keeps
          enough room for the fixed chip in the top-left corner without wasting
          a third of the viewport. */}
      <div className="flex items-start sm:items-center justify-center min-h-screen relative z-10 pt-12 sm:pt-0">
        {/* Edward 2026-04-25 22:10: 大廳左上「登入狀態 chip」(替代個人戰績按鈕底下
            「當前: Edward」副字)。
              - 已登入: 「已登入: {name} | G: 綁定/未綁 | D: 綁定/未綁 | L: 綁定/未綁」
              - 訪客: clickable「登入/綁定」→ AuthGateModal (target='stats' 表登入後
                回大廳，不跳頁)
            fixed 對齊右上 IdentityBadge 的同級，z-30 避開 modal (z-50)。 */}
        <div className="fixed top-safe-3 sm:top-safe-6 left-3 sm:left-6 z-30 flex flex-col gap-1.5 items-start">
          {/* Edward 2026-04-26 17:07: PWA buttons (InstallButton +
              ForceUpdateButton) 從左上 chip 區搬到右下角 stack (見 fixed
              bottom-4 right-4 區塊). 左上 chip 區現在只剩登入狀態 chip. */}

          {isGuest ? (
            <button
              type="button"
              onClick={() => setAuthGateTarget('stats')}
              data-testid="home-login-chip-guest"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-900/40 border border-amber-700/50 text-amber-200 hover:bg-amber-900/60 hover:text-amber-100 text-[11px] font-semibold transition-colors"
            >
              {t('home.loginOrBind', { defaultValue: '登入/綁定' })}
            </button>
          ) : (
            <div
              data-testid="home-login-chip-authed"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-800/80 border border-zinc-700 text-zinc-200 text-[11px] font-mono whitespace-nowrap"
            >
              <span className="font-semibold text-white">
                {t('home.loggedInAs', { defaultValue: '已登入' })}: {chipName}
              </span>
              <span className="text-zinc-500">|</span>
              <span className={isProviderLinked('google') ? 'text-emerald-300' : 'text-zinc-500'}>
                G: {isProviderLinked('google')
                  ? t('home.bindStateLinked', { defaultValue: '綁定' })
                  : t('home.bindStateUnlinked', { defaultValue: '未綁' })}
              </span>
              <span className="text-zinc-500">|</span>
              <span className={isProviderLinked('discord') ? 'text-emerald-300' : 'text-zinc-500'}>
                D: {isProviderLinked('discord')
                  ? t('home.bindStateLinked', { defaultValue: '綁定' })
                  : t('home.bindStateUnlinked', { defaultValue: '未綁' })}
              </span>
              <span className="text-zinc-500">|</span>
              <span className={isProviderLinked('line') ? 'text-emerald-300' : 'text-zinc-500'}>
                L: {isProviderLinked('line')
                  ? t('home.bindStateLinked', { defaultValue: '綁定' })
                  : t('home.bindStateUnlinked', { defaultValue: '未綁' })}
              </span>
            </div>
          )}
        </div>

        {/* Top-right controls — language only. Logout / Profile / Admin 全部搬到資料設定頁。
            改 fixed 避免手機上 absolute 佔據 container 寬度把右側按鈕擠出螢幕。
            Edward 2026-04-25 22:25: 砍 IdentityBadge (盾牌 Edward chip) — 與大廳左上
            「已登入」chip 重複。IdentityBadge component 仍保留供其他頁使用。 */}
        <div className="fixed top-safe-3 sm:top-safe-6 right-3 sm:right-6 z-30 flex items-center gap-2">
          <LanguageSwitcher />
        </div>

        <div className="w-full max-w-5xl">
          {mode === 'home' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              /* Edward 2026-04-27 mobile single-viewport: space-y-6 (24px) was
                 burning vertical pixels on iPhone SE. Mobile: space-y-3 (12px)
                 between title / buttons / chat. Desktop unchanged. */
              className="text-center space-y-3 sm:space-y-6 w-full"
            >
              {/* Edward 2026-04-25 19:18 final spec — title block sits above
                  the 6-button grid. h1 「Avalon - Resistance」 大字, small
                  subtitle 「隱藏身分‧邏輯推理‧相互欺瞞」. BrandHeader component
                  still used by LoginPage / Forgot / Reset pages.
                  Edward 2026-04-27: mobile h1 縮 text-2xl + mt-1, 省 ~28px. */}
              <div className="text-center pt-1 sm:pt-2">
                <h1 className="text-2xl sm:text-5xl font-bold tracking-tight text-white">
                  {t('home.title', { defaultValue: 'Avalon - Resistance' })}
                </h1>
                <p className="mt-1 sm:mt-2 text-[11px] sm:text-sm text-zinc-400 tracking-wider">
                  {t('home.subtitle', { defaultValue: '隱藏身分‧邏輯推理‧相互欺瞞' })}
                </p>
                {/* 2026-10-09 owner decision: 對局改到 signage-cloud — 一行
                    小公告 + 外連，不擋畫面。 */}
                <p
                  data-testid="home-play-platform-notice"
                  className="mt-2 text-[11px] sm:text-xs text-amber-200/90"
                >
                  {t('home.playPlatformNotice')}{' '}
                  <a
                    href={PLAY_PLATFORM_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-semibold underline underline-offset-2 hover:text-amber-100 transition-colors"
                  >
                    {t('home.playPlatformNoticeLink')}
                    <ExternalLink size={11} className="flex-shrink-0" />
                  </a>
                </p>
              </div>

              {/* Main content: the button grid, centred (the lobby chat column was removed 2026-10-28) */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="max-w-xl mx-auto w-full pt-1 sm:pt-2"
              >
                {/* Buttons area — 2×3 on mobile, 3×2 on desktop */}
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 sm:gap-3">
                    {/*
                      #86 IA v3 — 6 main buttons（2026-04-23 拆兩頁）
                        Row 1: 建立房間 / 加入房間 / 數據排行
                        Row 2: 個人戰績 / 百科攻略 / 系統設定

                      整合決策：
                      - 「數據排行」 route → `analytics` (V3 精算榜 + 深度分析 + 特徵研究
                        三頁籤合一，第一頁底下可展開 V2 五分層瀏覽)。2026-04-27 由
                        `leaderboard` 改回 `analytics`：T1 lobby route hijack 切斷了深度
                        分析 + 特徵研究的入口，數據相關頁面整合到 AnalyticsPage 一頁全有。
                      - 「個人戰績」 route → `personalStats` (= ProfilePage 歷史戰績 + 追蹤 / 對戰
                        成績 placeholder)
                      - 「系統設定」 route → `settings` (基本資料 + 帳號綁定 + 登出)
                      - FAQ 獨立按鈕拿掉；設定頁內可加 FAQ link (未來)
                    */}
                    {/* Row 1 — Play (signage-cloud) / Stats
                        2026-10-09 owner decision: 建立房間 / 加入房間 兩顆按鈕
                        合併成一個外連 (新分頁) 到 signage-cloud — 本站不再開局。
                        佔兩格維持 3×2 / 2×3 格線。不需登入，故不走 AuthGate。 */}
                    <motion.a
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      href={PLAY_PLATFORM_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="home-btn-play-platform"
                      className="col-span-2 w-full min-w-0 bg-white hover:bg-zinc-200 text-black font-semibold py-2.5 sm:py-3 px-2 sm:px-4 rounded-lg transition-all flex items-center justify-center gap-1.5 sm:gap-2 shadow-md text-sm sm:text-base"
                    >
                      <Play size={18} className="flex-shrink-0" />
                      <span className="truncate">{t('home.playOnPlatform')}</span>
                      <ExternalLink size={14} className="flex-shrink-0" />
                    </motion.a>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setGameState('analytics')}
                      data-testid="home-btn-stats"
                      className="w-full min-w-0 bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-2.5 sm:py-3 px-2 sm:px-4 rounded-lg transition-all flex items-center justify-center gap-1.5 sm:gap-2 shadow-md text-sm sm:text-base"
                    >
                      <BarChart3 size={18} className="flex-shrink-0" />
                      <span className="truncate">{t('home.stats')}</span>
                    </motion.button>

                    {/* 2026-10-28 Edward：「個人資料」「個人戰績」「與機器人練習」目前用不到，首頁不放入口
                        （頁面保留：登入/綁定在左上角，個人分析從數據排行點玩家進入）。 */}
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setGameState('wiki')}
                      data-testid="home-btn-wiki"
                      className="w-full min-w-0 bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-2.5 sm:py-3 px-2 sm:px-4 rounded-lg transition-all flex items-center justify-center gap-1.5 sm:gap-2 shadow-md text-sm sm:text-base"
                    >
                      <BookOpen size={18} className="flex-shrink-0" />
                      <span className="truncate">{t('home.wikiAndGuide')}</span>
                    </motion.button>

                  </div>

                  {/* 社群（原 Linktree 的按鈕，Edward 2026-10-30） */}
                  <div data-testid="home-community-links" className="grid grid-cols-4 gap-2 sm:gap-3 pt-1">
                    {COMMUNITY_LINKS.map(({ key, label, href, Icon }) => (
                      <a
                        key={key}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`home-link-${key}`}
                        className="min-w-0 bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 hover:text-white rounded-lg py-2 px-1 transition-colors flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-sm"
                      >
                        <Icon size={16} className="flex-shrink-0" />
                        <span className="truncate">{label}</span>
                      </a>
                    ))}
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

                {/* #63 main-page public chat removed (Edward 2026-10-28: the synced chat made the page very long
                    and is no longer needed here). The LINE / Discord sync itself runs server-side as before. */}
              </motion.div>

              {/* Edward 2026-04-25 19:18: footer 「欺騙與邏輯的推理遊戲」
                  removed per final spec — subtitle 「隱藏身分‧邏輯推理‧相互
                  欺瞞」 已在頂端 h1 下方呈現，下方 footer 不再需要。 */}
            </motion.div>
          )}

          {mode === 'practice' && (
            <div className="max-w-xl mx-auto">
              <PracticeSetupPanel onBack={closePractice} />
            </div>
          )}

          {mode === 'create' && (
            <div className="space-y-3 sm:space-y-6 bg-zinc-900/70 p-4 sm:p-8 rounded-lg border border-zinc-700">
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
                      娛樂局
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
            <div className="space-y-3 sm:space-y-6 bg-zinc-900/70 p-4 sm:p-8 rounded-lg border border-zinc-700">
              <h2 className="text-2xl font-bold text-center text-white">{t('home.joinRoom')}</h2>

              {/* 2026-04-24 #ux-phase-3: same binding block as create mode. The
                  room code input stays below — that's the join-specific piece. */}
              <BindingField
                mode="join"
                playerName={playerName}
                onPlayerNameChange={setPlayerName}
                roomCode={roomId}
              />

              {/* Edward 2026-04-25: 4-digit numeric room codes. inputMode
                  triggers the numeric keypad on iOS/Android; the onChange
                  filter strips non-digits so paste/desktop entry stays
                  numeric-only. maxLength clamps to 4. */}
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={t('home.roomCodePlaceholder')}
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onKeyDown={e => e.key === 'Enter' && handleJoinRoom()}
                maxLength={4}
                className="w-full bg-black border border-zinc-700 rounded-lg px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white font-mono tracking-widest"
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

        {/* Edward 2026-04-26 17:07: PWA buttons stack 右下角.
              - 加到手機桌面 (上) — InstallButton, 已裝/不支援自動隱藏
              - 更新版本重新登入 (下) — ForceUpdateButton, 永遠顯示
            砍舊「遇到問題？強制更新」(home-btn-force-refresh) — 與
            ForceUpdateButton 功能重複, 由 ForceUpdateButton 替代. */}
        <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 items-end">
          <InstallButton />
          <ForceUpdateButton />
        </div>

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
