import { useState } from 'react';
import { motion } from 'framer-motion';
import { createRoom, joinRoom } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { logout } from '../services/auth';
import { Play, LogIn, LogOut, BookOpen, Users, Zap } from 'lucide-react';
import FloatingControls from '../components/FloatingControls';

export default function HomePage(): JSX.Element {
  const { setGameState, setCurrentPlayer, currentPlayer } = useGameStore();
  const [playerName, setPlayerName] = useState(currentPlayer?.name ?? '');
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'home' | 'create' | 'join'>('home');

  const handleLogout = async (): Promise<void> => {
    try {
      await logout();
      setCurrentPlayer(null);
      setGameState('home');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const handleCreateRoom = (): void => {
    if (!playerName.trim()) {
      alert('Please enter your name');
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
      alert('Please enter your name');
      return;
    }

    if (!roomId.trim()) {
      alert('Please enter a room ID');
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
      {/* Floating Controls */}
      <FloatingControls />

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
            className="absolute top-6 right-6 flex items-center gap-4 bg-avalon-card/50 backdrop-blur-sm px-4 py-2 rounded-lg border border-gray-600 hover:border-yellow-400 transition-colors"
          >
            <div className="text-sm">
              <p className="font-bold text-white">{currentPlayer.name}</p>
              <p className="text-xs text-gray-400">Ready to play</p>
            </div>
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleLogout}
              className="text-red-400 hover:text-red-300 transition-colors flex items-center gap-2"
              title="Logout"
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
              <p className="text-2xl text-gray-300 font-semibold">The Resistance</p>
              <p className="text-gray-400 text-sm">5-10 players • 20-30 minutes</p>
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
                <p className="text-xs text-gray-300">Team-Based</p>
              </div>
              <div className="bg-purple-900/30 border border-purple-500/50 rounded-lg p-3">
                <Zap size={20} className="text-purple-400 mx-auto mb-1" />
                <p className="text-xs text-gray-300">Real-Time</p>
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
                Create Game
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setMode('join')}
                className="w-full bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-purple-500/50"
              >
                <LogIn size={20} />
                Join Game
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('wiki')}
                className="w-full bg-gradient-to-r from-yellow-600 to-orange-600 hover:from-yellow-700 hover:to-orange-700 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-yellow-500/50"
              >
                <BookOpen size={20} />
                Wiki & Guide
              </motion.button>
            </motion.div>

            {/* Footer */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4 }}
              className="text-xs text-gray-500 pt-4 border-t border-gray-700"
            >
              <p>🎭 A game of deception and logic</p>
            </motion.div>
          </motion.div>
        )}

        {mode === 'create' && (
          <div className="space-y-6 bg-avalon-card/50 p-8 rounded-lg border border-blue-500/30">
            <h2 className="text-2xl font-bold text-center">Create a Game</h2>

            <input
              type="text"
              placeholder="Your Name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />

            <div className="space-y-3">
              <button
                onClick={handleCreateRoom}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
              >
                Create
              </button>

              <button
                onClick={() => {
                  setMode('home');
                  setPlayerName('');
                }}
                className="w-full bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {mode === 'join' && (
          <div className="space-y-6 bg-avalon-card/50 p-8 rounded-lg border border-purple-500/30">
            <h2 className="text-2xl font-bold text-center">Join a Game</h2>

            <input
              type="text"
              placeholder="Your Name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />

            <input
              type="text"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="w-full bg-avalon-card border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />

            <div className="space-y-3">
              <button
                onClick={handleJoinRoom}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
              >
                Join
              </button>

              <button
                onClick={() => {
                  setMode('home');
                  setPlayerName('');
                  setRoomId('');
                }}
                className="w-full bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg transition-all"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
    </div>
  );
}
