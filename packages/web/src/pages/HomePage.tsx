import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { createRoom, joinRoom, listRooms, spectateRoom, getSocket, getStoredToken } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { logout } from '../services/auth';
import { fetchAdminMe } from '../services/api';
import { Play, LogIn, LogOut, BookOpen, Users, Zap, Trophy, UserCircle, RefreshCw, Eye, Lock, Bot, BarChart3, ShieldCheck } from 'lucide-react';

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
      addToast('登出失敗，請稍後再試', 'error');
    }
  };

  const handleCreateRoom = (): void => {
    if (!playerName.trim()) {
      addToast('請輸入你的名字', 'info');
      return;
    }

    // Preserve Firebase UID — server uses uid as player ID
    if (currentPlayer) {
      setCurrentPlayer({ ...currentPlayer, name: playerName });
    }

    localStorage.setItem('avalon_player_name', playerName.trim());
    try {
      createRoom(playerName, roomPassword.trim() || undefined);
      setGameState('lobby');
    } catch {
      addToast('無法建立房間 — 伺服器連線失敗，請重新整理頁面', 'error');
    }
  };

  const handleQuickSolo = (): void => {
    const name = currentPlayer?.name || playerName.trim();
    if (!name) {
      addToast('請輸入你的名字再開始', 'info');
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
      addToast('無法建立房間 — 伺服器連線失敗，請重新整理頁面', 'error');
    }
  };

  const handleJoinRoom = (): void => {
    if (!playerName.trim()) {
      addToast('請輸入你的名字', 'info');
      return;
    }

    if (!roomId.trim()) {
      addToast('請輸入房間代碼', 'info');
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
      addToast('無法加入房間 — 伺服器連線失敗，請重新整理頁面', 'error');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-avalon-dark via-avalon-card to-avalon-dark p-4">
      {/* Background decorations */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <motion.div
          animate={{
            x: [0, 50, 0],
            y: [0, 30, 0],
            opacity: [0.1, 0.3, 0.1],
          }}
          transition={{ duration: 20, repeat: Infinity }}
          className="absolute top-10 right-10 w-96 h-96 bg-blue-500 rounded-full blur-3xl"
        />
        <motion.div
          animate={{
            x: [0, -50, 0],
            y: [0, -30, 0],
            opacity: [0.1, 0.2, 0.1],
          }}
          transition={{ duration: 25, repeat: Infinity }}
          className="absolute bottom-10 left-10 w-96 h-96 bg-purple-500 rounded-full blur-3xl"
        />
      </div>

      <div className="flex items-center justify-center min-h-screen relative z-10">
        {/* User Profile / Logout Button */}
        {currentPlayer && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute top-6 right-6 flex items-center gap-2"
          >
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => navigateToProfile('me')}
              className="flex items-center gap-2 bg-avalon-card/50 backdrop-blur-sm px-3 py-2 rounded-lg border border-gray-600 hover:border-blue-400 transition-colors"
            >
              <UserCircle size={16} className="text-blue-400" />
              <span className="text-sm font-semibold text-white">{currentPlayer.name}</span>
            </motion.button>
            {isAdminUser && (
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setGameState('adminClaims')}
                className="p-2 bg-avalon-card/50 backdrop-blur-sm rounded-lg border border-green-700 hover:border-green-400 text-green-400 hover:text-green-300 transition-colors"
                title="管理 (Admin)"
              >
                <ShieldCheck size={18} />
              </motion.button>
            )}
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleLogout}
              className="p-2 bg-avalon-card/50 backdrop-blur-sm rounded-lg border border-gray-600 hover:border-red-400 text-red-400 hover:text-red-300 transition-colors"
              title="登出"
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
                alt="阿瓦隆百科"
                className="w-24 h-24 mx-auto rounded-2xl shadow-lg shadow-blue-500/20"
              />
              <h1 className="text-6xl font-black bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent drop-shadow-2xl">
                AVALON
              </h1>
              <p className="text-2xl text-gray-300 font-semibold">抵抗組織 (The Resistance)</p>
              <p className="text-gray-400 text-sm">5-10 人 (players) / 即時連線對戰 (Real-time Online)</p>
            </motion.div>

            {/* Stats Cards */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="grid grid-cols-2 gap-3 py-4"
            >
              <div className="bg-blue-900/30 border border-blue-500/50 rounded-lg p-3">
                <Users size={20} className="text-blue-400 mx-auto mb-1" />
                <p className="text-xs text-gray-300">陣營對戰 (Team Battle)</p>
              </div>
              <div className="bg-purple-900/30 border border-purple-500/50 rounded-lg p-3">
                <Zap size={20} className="text-purple-400 mx-auto mb-1" />
                <p className="text-xs text-gray-300">即時連線 (Real-time)</p>
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
                className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-blue-500/50"
              >
                <Play size={20} />
                建立房間 (Create Room)
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setMode('join')}
                className="w-full bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-purple-500/50"
              >
                <LogIn size={20} />
                加入房間 (Join Room)
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('wiki')}
                className="w-full bg-gradient-to-r from-yellow-600 to-orange-600 hover:from-yellow-700 hover:to-orange-700 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-yellow-500/50"
              >
                <BookOpen size={20} />
                百科 & 攻略 (Wiki & Guide)
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('leaderboard')}
                className="w-full bg-gradient-to-r from-amber-600 to-yellow-500 hover:from-amber-700 hover:to-yellow-600 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-amber-500/50"
              >
                <Trophy size={20} />
                排行榜 (Leaderboard)
              </motion.button>

              <div className="grid grid-cols-2 gap-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setGameState('friends')}
                  className="w-full bg-gradient-to-r from-sky-700 to-blue-600 hover:from-sky-800 hover:to-blue-700 text-white font-bold py-3 px-4 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-sky-500/50"
                >
                  <Users size={18} />
                  追蹤列表
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleQuickSolo}
                  className="w-full bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-700 hover:to-cyan-700 text-white font-bold py-3 px-4 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-teal-500/50"
                >
                  <Zap size={18} />
                  快速練習
                </motion.button>
              </div>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('aiStats')}
                className="w-full bg-gradient-to-r from-purple-700 to-violet-700 hover:from-purple-800 hover:to-violet-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-purple-500/50"
              >
                <Bot size={20} />
                AI 自對弈統計 (AI Stats)
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('analysis')}
                className="w-full bg-gradient-to-r from-cyan-700 to-blue-700 hover:from-cyan-800 hover:to-blue-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-cyan-500/50"
              >
                <BarChart3 size={20} />
                數據分析 (Game Analysis)
              </motion.button>
            </motion.div>

            {/* Open rooms */}
            {openRooms.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.45 }}
                className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4 text-left"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                    開放房間 (Open Rooms)
                  </h3>
                  <button
                    onClick={listRooms}
                    className="p-1 text-gray-600 hover:text-gray-300 transition-colors"
                    title="重新整理 (Refresh)"
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
                <div className="space-y-2">
                  {openRooms.map(r => (
                    <div
                      key={r.id}
                      className="w-full flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {r.inProgress && (
                          <span className="text-xs px-1.5 py-0.5 bg-red-900/50 border border-red-700 text-red-400 rounded font-semibold flex-shrink-0">進行中</span>
                        )}
                        {r.isPrivate && (
                          <Lock size={11} className="text-yellow-500 flex-shrink-0" />
                        )}
                        <span className="text-sm font-semibold text-white truncate">{r.name}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                        <span className="text-xs text-gray-400">
                          <span className={r.playerCount >= 5 ? 'text-green-400' : 'text-yellow-400'}>
                            {r.playerCount}
                          </span>
                          /{r.maxPlayers}
                        </span>
                        {r.inProgress ? (
                          <button
                            onClick={() => spectateRoom(r.fullId)}
                            className="flex items-center gap-1 text-xs px-2 py-1 bg-purple-900/50 hover:bg-purple-800/60 border border-purple-700 text-purple-300 rounded transition-colors"
                            title="觀戰 (Spectate)"
                          >
                            <Eye size={11} />
                            觀戰
                          </button>
                        ) : r.isPrivate ? (
                          <button
                            onClick={() => { setPendingJoinRoom(r); setRoomId(r.id); setJoinPassword(''); }}
                            className="flex items-center gap-1 text-xs px-2 py-1 bg-yellow-900/50 hover:bg-yellow-800/60 border border-yellow-700 text-yellow-300 rounded transition-colors"
                          >
                            <Lock size={11} />
                            加入
                          </button>
                        ) : (
                          <button
                            onClick={() => { setRoomId(r.id); setMode('join'); }}
                            className="flex items-center gap-1 text-xs px-2 py-1 bg-blue-900/50 hover:bg-blue-800/60 border border-blue-700 text-blue-300 rounded transition-colors"
                          >
                            <LogIn size={11} />
                            加入
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
              className="text-xs text-gray-500 pt-4 border-t border-gray-700"
            >
              <p>🎭 欺騙與邏輯的推理遊戲 (A game of deception and logical deduction)</p>
            </motion.div>
          </motion.div>
        )}

        {mode === 'create' && (
          <div className="space-y-6 bg-avalon-card/50 p-8 rounded-lg border border-blue-500/30">
            <h2 className="text-2xl font-bold text-center">建立房間</h2>

            <input
              type="text"
              placeholder="你的名字"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateRoom()}
              autoFocus
              className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />

            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="password"
                placeholder="房間密碼（選填，留空為公開房間）"
                value={roomPassword}
                onChange={(e) => setRoomPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateRoom()}
                className="w-full bg-avalon-card border border-gray-600 rounded-lg pl-8 pr-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-3">
              <button
                onClick={handleCreateRoom}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
              >
                建立
              </button>

              <button
                onClick={() => {
                  setMode('home');
                  setPlayerName('');
                  setRoomPassword('');
                }}
                className="w-full bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
              >
                返回
              </button>
            </div>
          </div>
        )}

        {mode === 'join' && (
          <div className="space-y-6 bg-avalon-card/50 p-8 rounded-lg border border-purple-500/30">
            <h2 className="text-2xl font-bold text-center">加入房間</h2>

            <input
              type="text"
              placeholder="你的名字"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              autoFocus
              className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />

            <input
              type="text"
              placeholder="房間代碼（6 碼）"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoinRoom()}
              maxLength={6}
              className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 uppercase font-mono tracking-widest"
            />

            <div className="space-y-3">
              <button
                onClick={handleJoinRoom}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
              >
                加入
              </button>

              <button
                onClick={() => {
                  setMode('home');
                  setPlayerName('');
                  setRoomId('');
                }}
                className="w-full bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
              >
                返回
              </button>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* Password modal for private rooms */}
    {pendingJoinRoom && (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
        onClick={() => setPendingJoinRoom(null)}>
        <div className="bg-avalon-card border border-yellow-600/50 rounded-2xl p-6 w-full max-w-sm space-y-4"
          onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            <Lock size={18} className="text-yellow-400" />
            <h3 className="font-bold text-white text-lg">私人房間</h3>
          </div>
          <p className="text-sm text-gray-400">請輸入 <span className="text-white font-semibold">{pendingJoinRoom.name}</span> 的房間密碼</p>
          <input
            type="password"
            placeholder="房間密碼"
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
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-yellow-500"
          />
          <div className="flex gap-3">
            <button
              onClick={() => {
                joinRoom(pendingJoinRoom.fullId, joinPassword.trim() || undefined);
                setGameState('lobby');
                setPendingJoinRoom(null);
              }}
              className="flex-1 bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
            >
              加入
            </button>
            <button
              onClick={() => setPendingJoinRoom(null)}
              className="flex-1 bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
