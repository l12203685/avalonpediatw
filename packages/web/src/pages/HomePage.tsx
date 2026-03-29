import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { createRoom, joinRoom, listRooms, getSocket } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { logout } from '../services/auth';
import { Play, LogIn, LogOut, BookOpen, Users, Zap, Trophy, UserCircle, RefreshCw } from 'lucide-react';

interface OpenRoom {
  id: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  createdAt: number;
}

export default function HomePage(): JSX.Element {
  const { setGameState, setCurrentPlayer, currentPlayer, navigateToProfile, addToast } = useGameStore();
  const [playerName, setPlayerName] = useState(currentPlayer?.name ?? '');
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'home' | 'create' | 'join'>('home');
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);

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

    createRoom(playerName);
    setGameState('lobby');
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

    joinRoom(roomId);
    setGameState('lobby');
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
              <h1 className="text-6xl font-black bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent drop-shadow-2xl">
                AVALON
              </h1>
              <p className="text-2xl text-gray-300 font-semibold">抵抗組織 (The Resistance)</p>
              <p className="text-gray-400 text-sm">5–10 人 (players) • 即時連線對戰 (Real-time Online)</p>
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
                    <button
                      key={r.id}
                      onClick={() => { setRoomId(r.id); setMode('join'); }}
                      className="w-full flex items-center justify-between bg-gray-800/50 hover:bg-gray-700/50 border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-2 transition-all"
                    >
                      <span className="text-sm font-semibold text-white truncate">{r.name}</span>
                      <span className="text-xs text-gray-400 flex-shrink-0 ml-2">
                        <span className={r.playerCount >= 5 ? 'text-green-400' : 'text-yellow-400'}>
                          {r.playerCount}
                        </span>
                        /{r.maxPlayers} 人
                      </span>
                    </button>
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
    </div>
  );
}
