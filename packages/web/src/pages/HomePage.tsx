import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { createRoom, joinRoom, listRooms, spectateRoom, getSocket, getStoredToken } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { logout } from '../services/auth';
import { fetchAdminMe } from '../services/api';
import { Play, LogIn, LogOut, BookOpen, Users, Zap, Trophy, UserCircle, RefreshCw, Eye, Lock, Bot, BarChart3, ShieldCheck, Clock, HelpCircle } from 'lucide-react';
import { TIMER_MULTIPLIER_OPTIONS, TimerMultiplier } from '@avalon/shared';
import LanguageSwitcher from '../components/LanguageSwitcher';

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
  const { setGameState, setCurrentPlayer, currentPlayer, navigateToProfile, addToast, setQuickSoloMode } = useGameStore();
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
  // Per-room phase-timer multiplier (1x default). null = unlimited.
  const [timerMultiplier, setTimerMultiplier] = useState<TimerMultiplier>(1);

  // Check admin status for UI conditional (shown after logged-in player loads)
  useEffect(() => {
    if (!currentPlayer) return;
    const token = getStoredToken();
    if (!token) return;
    fetchAdminMe(token)
      .then(me => setIsAdminUser(me.isAdmin))
      .catch(() => setIsAdminUser(false));
  }, [currentPlayer]);

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

  const handleLogout = async (): Promise<void> => {
    try {
      await logout();
      setCurrentPlayer(null);
      setGameState('home');
    } catch {
      addToast(t('auth.logoutFailed'), 'error');
    }
  };

  const handleCreateRoom = (): void => {
    if (!playerName.trim()) {
      addToast(t('home.enterYourName'), 'info');
      return;
    }

    // Preserve Firebase UID — server uses uid as player ID
    if (currentPlayer) {
      setCurrentPlayer({ ...currentPlayer, name: playerName });
    }

    localStorage.setItem('avalon_player_name', playerName.trim());
    try {
      createRoom(playerName, roomPassword.trim() || undefined, timerMultiplier);
      setGameState('lobby');
    } catch {
      addToast(t('home.createRoomFailed'), 'error');
    }
  };

  const handleQuickSolo = (): void => {
    const name = currentPlayer?.name || playerName.trim();
    if (!name) {
      addToast(t('home.enterNameFirst'), 'info');
      setMode('create');
      return;
    }
    if (currentPlayer) setCurrentPlayer({ ...currentPlayer, name });
    try {
      setQuickSoloMode(true);
      createRoom(name);
      setGameState('lobby');
    } catch {
      setQuickSoloMode(false);
      addToast(t('home.createRoomFailed'), 'error');
    }
  };

  const handleJoinRoom = (): void => {
    if (!playerName.trim()) {
      addToast(t('home.enterYourName'), 'info');
      return;
    }

    if (!roomId.trim()) {
      addToast(t('home.enterRoomCode'), 'info');
      return;
    }

    // Preserve Firebase UID — server uses uid as player ID
    if (currentPlayer) {
      setCurrentPlayer({ ...currentPlayer, name: playerName });
    }

    localStorage.setItem('avalon_player_name', playerName.trim());
    try {
      joinRoom(roomId, joinPassword.trim() || undefined);
      setGameState('lobby');
    } catch {
      addToast(t('home.joinRoomFailed'), 'error');
    }
  };

  return (
    <div className="min-h-screen bg-black p-4">
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

      <div className="flex items-center justify-center min-h-screen relative z-10">
        {/* Language switcher — always visible even when not logged in */}
        {!currentPlayer && (
          <div className="absolute top-6 right-6 z-20">
            <LanguageSwitcher />
          </div>
        )}

        {/* User Profile / Logout Button */}
        {currentPlayer && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute top-6 right-6 flex items-center gap-2"
          >
            <LanguageSwitcher />
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => navigateToProfile('me')}
              className="flex items-center gap-2 bg-zinc-900/70 backdrop-blur-sm px-3 py-2 rounded-lg border border-zinc-700 hover:border-white transition-colors"
            >
              <UserCircle size={16} className="text-white" />
              <span className="text-sm font-semibold text-white">{currentPlayer.name}</span>
            </motion.button>
            {isAdminUser && (
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setGameState('adminClaims')}
                className="p-2 bg-zinc-900/70 backdrop-blur-sm rounded-lg border border-zinc-600 hover:border-white text-zinc-200 hover:text-white transition-colors"
                title={t('nav.admin')}
              >
                <ShieldCheck size={18} />
              </motion.button>
            )}
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleLogout}
              className="p-2 bg-zinc-900/70 backdrop-blur-sm rounded-lg border border-zinc-700 hover:border-red-400 text-red-400 hover:text-red-300 transition-colors"
              title={t('auth.logout')}
            >
              <LogOut size={18} />
            </motion.button>
          </motion.div>
        )}

        <div className="w-full max-w-md">
          {mode === 'home' && (
            <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center space-y-8 w-full max-w-md"
          >
            {/* Title */}
            <motion.div
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200 }}
              className="space-y-4"
            >
              <img
                src="/logo.png"
                alt={t('app.name')}
                className="w-24 h-24 mx-auto rounded-2xl shadow-lg shadow-white/10"
              />
              <h1 className="text-6xl font-black text-white drop-shadow-2xl">
                AVALON
              </h1>
              <p className="text-2xl text-zinc-300 font-semibold">{t('app.tagline')}</p>
              <p className="text-zinc-500 text-sm">{t('app.playersRange')}</p>
            </motion.div>

            {/* Stats Cards */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="grid grid-cols-2 gap-3 py-4"
            >
              <div className="bg-zinc-900/60 border border-zinc-700 rounded-lg p-3">
                <Users size={20} className="text-white mx-auto mb-1" />
                <p className="text-xs text-zinc-300">{t('app.teamBattle')}</p>
              </div>
              <div className="bg-zinc-900/60 border border-zinc-700 rounded-lg p-3">
                <Zap size={20} className="text-white mx-auto mb-1" />
                <p className="text-xs text-zinc-300">{t('app.realtime')}</p>
              </div>
            </motion.div>

            {/* Buttons */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="space-y-3 pt-4"
            >
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setMode('create')}
                className="w-full bg-white hover:bg-zinc-200 text-black font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-white/20"
              >
                <Play size={20} />
                {t('home.createRoom')}
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setMode('join')}
                className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
              >
                <LogIn size={20} />
                {t('home.joinRoom')}
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('wiki')}
                className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
              >
                <BookOpen size={20} />
                {t('home.wikiAndGuide')}
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('leaderboard')}
                className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
              >
                <Trophy size={20} />
                {t('home.leaderboard')}
              </motion.button>

              <div className="grid grid-cols-2 gap-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setGameState('friends')}
                  className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-4 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
                >
                  <Users size={18} />
                  {t('home.friendsShort')}
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleQuickSolo}
                  className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-4 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
                >
                  <Zap size={18} />
                  {t('home.quickSolo')}
                </motion.button>
              </div>

              {currentPlayer && (
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => navigateToProfile('me')}
                  className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
                >
                  <UserCircle size={20} />
                  {t('home.profileShort')}
                </motion.button>
              )}

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('aiStats')}
                className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
              >
                <Bot size={20} />
                {t('home.aiStats')}
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('analysis')}
                className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
              >
                <BarChart3 size={20} />
                {t('home.analysis')}
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('help')}
                className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg border border-zinc-700 hover:border-zinc-500"
              >
                <HelpCircle size={20} />
                {t('nav.home')} FAQ
              </motion.button>
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

            <input
              type="text"
              placeholder={t('home.yourName')}
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateRoom()}
              autoFocus
              className="w-full bg-black border border-zinc-700 rounded-lg px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
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

            <input
              type="text"
              placeholder={t('home.yourName')}
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              autoFocus
              className="w-full bg-black border border-zinc-700 rounded-lg px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
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
  );
}
