import { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { motion } from 'framer-motion';
import { createRoom, joinRoom } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { logout } from '../services/auth';
import { toast } from '../store/toastStore';
import { Play, LogIn, LogOut, BookOpen, Users, Zap, Trophy, User, Bot, ArrowLeft } from 'lucide-react';
import FloatingControls from '../components/FloatingControls';

export default function HomePage(): JSX.Element {
  const [playerName, setPlayerName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'home' | 'create' | 'join'>('home');
  const { setGameState, setCurrentPlayer, currentPlayer } = useGameStore();

  // Auto-populate room code from URL ?room= param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('room');
    if (code) {
      setRoomId(code.toUpperCase());
      setMode('join');
    }
  }, []);

  const handleLogout = async (): Promise<void> => {
    try {
      await logout();
      setCurrentPlayer(null);
      setGameState('home');
    } catch {
      toast.error('登出失敗，請稍後再試');
    }
  };

  const handleCreateRoom = (): void => {
    if (!playerName.trim()) {
      toast.warning('請輸入您的名稱');
      return;
    }
    const playerId = uuidv4();
    setCurrentPlayer({
      id: playerId,
      name: playerName.trim(),
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    });
    try {
      createRoom(playerName.trim());
    } catch {
      toast.error('無法連接伺服器，請確認網路連線');
      return;
    }
    setGameState('lobby');
  };

  const handleJoinRoom = (): void => {
    if (!playerName.trim()) {
      toast.warning('請輸入您的名稱');
      return;
    }
    if (!roomId.trim()) {
      toast.warning('請輸入房間代碼');
      return;
    }
    const playerId = uuidv4();
    setCurrentPlayer({
      id: playerId,
      name: playerName.trim(),
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    });
    try {
      joinRoom(roomId.trim().toUpperCase(), playerId);
    } catch {
      toast.error('無法連接伺服器，請確認網路連線');
      return;
    }
    setGameState('lobby');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-avalon-dark via-avalon-card to-avalon-dark p-4">
      <FloatingControls />

      {/* Background decorations */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <motion.div
          animate={{ x: [0, 50, 0], y: [0, 30, 0], opacity: [0.1, 0.3, 0.1] }}
          transition={{ duration: 20, repeat: Infinity }}
          className="absolute top-10 right-10 w-96 h-96 bg-blue-500 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ x: [0, -50, 0], y: [0, -30, 0], opacity: [0.1, 0.2, 0.1] }}
          transition={{ duration: 25, repeat: Infinity }}
          className="absolute bottom-10 left-10 w-96 h-96 bg-purple-500 rounded-full blur-3xl"
        />
      </div>

      <div className="flex items-center justify-center min-h-screen relative z-10">
        {/* User Info + Logout */}
        {currentPlayer && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute top-6 right-6 flex items-center gap-3 bg-avalon-card/50 backdrop-blur-sm px-4 py-2 rounded-lg border border-gray-600 hover:border-yellow-400 transition-colors"
          >
            <div className="text-sm">
              <p className="font-bold text-white">{currentPlayer.name}</p>
              <p className="text-xs text-gray-400">準備好了</p>
            </div>
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleLogout}
              className="text-red-400 hover:text-red-300 transition-colors"
              title="登出"
            >
              <LogOut size={18} />
            </motion.button>
          </motion.div>
        )}

        <div className="w-full max-w-md">
          {/* ── Home Mode ── */}
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
                <p className="text-2xl text-gray-300 font-semibold">The Resistance</p>
                <p className="text-gray-400 text-sm">5-10 人 · 20-30 分鐘</p>
              </motion.div>

              {/* Feature Cards */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="grid grid-cols-2 gap-3 py-4"
              >
                <div className="bg-blue-900/30 border border-blue-500/50 rounded-lg p-3">
                  <Users size={20} className="text-blue-400 mx-auto mb-1" />
                  <p className="text-xs text-gray-300">團隊對抗</p>
                </div>
                <div className="bg-purple-900/30 border border-purple-500/50 rounded-lg p-3">
                  <Zap size={20} className="text-purple-400 mx-auto mb-1" />
                  <p className="text-xs text-gray-300">即時對戰</p>
                </div>
              </motion.div>

              {/* Action Buttons */}
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
                  建立遊戲
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setMode('join')}
                  className="w-full bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-purple-500/50"
                >
                  <LogIn size={20} />
                  加入遊戲
                </motion.button>

                <div className="grid grid-cols-4 gap-2">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setGameState('leaderboard')}
                    className="bg-gradient-to-r from-yellow-600 to-yellow-700 hover:from-yellow-700 hover:to-yellow-800 text-white font-bold py-3 px-1 rounded-lg transition-all flex flex-col items-center gap-1 shadow-lg text-xs"
                  >
                    <Trophy size={16} />
                    排行榜
                  </motion.button>

                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setGameState('profile')}
                    className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white font-bold py-3 px-1 rounded-lg transition-all flex flex-col items-center gap-1 shadow-lg text-xs"
                  >
                    <User size={16} />
                    個人檔案
                  </motion.button>

                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setGameState('ai-stats')}
                    className="bg-gradient-to-r from-cyan-600 to-cyan-700 hover:from-cyan-700 hover:to-cyan-800 text-white font-bold py-3 px-1 rounded-lg transition-all flex flex-col items-center gap-1 shadow-lg text-xs"
                  >
                    <Bot size={16} />
                    AI 統計
                  </motion.button>

                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setGameState('wiki')}
                    className="bg-gradient-to-r from-orange-600 to-orange-700 hover:from-orange-700 hover:to-orange-800 text-white font-bold py-3 px-1 rounded-lg transition-all flex flex-col items-center gap-1 shadow-lg text-xs"
                  >
                    <BookOpen size={16} />
                    百科
                  </motion.button>
                </div>
              </motion.div>

              {/* Footer */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="text-xs text-gray-500 pt-4 border-t border-gray-700"
              >
                <p>🎭 謊言與邏輯的遊戲</p>
              </motion.div>
            </motion.div>
          )}

          {/* ── Create Mode ── */}
          {mode === 'create' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6 bg-avalon-card/50 p-8 rounded-xl border border-blue-500/30"
            >
              <div className="flex items-center gap-3">
                <button onClick={() => setMode('home')} className="text-gray-400 hover:text-white transition-colors">
                  <ArrowLeft size={20} />
                </button>
                <h2 className="text-2xl font-bold">建立遊戲</h2>
              </div>

              <input
                type="text"
                placeholder="您的名稱"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateRoom()}
                maxLength={20}
                className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />

              <div className="space-y-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleCreateRoom}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg transition-all"
                >
                  建立房間
                </motion.button>
                <button
                  onClick={() => { setMode('home'); setPlayerName(''); }}
                  className="w-full bg-gray-700 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-all text-sm"
                >
                  取消
                </button>
              </div>
            </motion.div>
          )}

          {/* ── Join Mode ── */}
          {mode === 'join' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6 bg-avalon-card/50 p-8 rounded-xl border border-purple-500/30"
            >
              <div className="flex items-center gap-3">
                <button onClick={() => setMode('home')} className="text-gray-400 hover:text-white transition-colors">
                  <ArrowLeft size={20} />
                </button>
                <h2 className="text-2xl font-bold">加入遊戲</h2>
              </div>

              <input
                type="text"
                placeholder="您的名稱"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                maxLength={20}
                className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
              />

              <input
                type="text"
                placeholder="房間代碼"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
                maxLength={10}
                className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 tracking-widest font-mono"
              />

              <div className="space-y-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleJoinRoom}
                  className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-4 rounded-lg transition-all"
                >
                  加入房間
                </motion.button>
                <button
                  onClick={() => { setMode('home'); setPlayerName(''); setRoomId(''); }}
                  className="w-full bg-gray-700 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-all text-sm"
                >
                  取消
                </button>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
