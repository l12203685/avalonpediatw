import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { createRoom, joinRoom } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { Play, LogIn } from 'lucide-react';

export default function HomePage(): JSX.Element {
  const [playerName, setPlayerName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'home' | 'create' | 'join'>('home');
  const { setGameState, setCurrentPlayer } = useGameStore();

  const handleCreateRoom = (): void => {
    if (!playerName.trim()) {
      alert('Please enter your name');
      return;
    }

    const playerId = uuidv4();
    setCurrentPlayer({
      id: playerId,
      name: playerName,
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    });

    createRoom(playerName);
    setGameState('lobby');
  };

  const handleJoinRoom = (): void {
    if (!playerName.trim()) {
      alert('Please enter your name');
      return;
    }

    if (!roomId.trim()) {
      alert('Please enter a room ID');
      return;
    }

    const playerId = uuidv4();
    setCurrentPlayer({
      id: playerId,
      name: playerName,
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    });

    joinRoom(roomId, playerId);
    setGameState('lobby');
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-md">
        {mode === 'home' && (
          <div className="text-center space-y-8">
            <div className="space-y-4">
              <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                AVALON
              </h1>
              <p className="text-xl text-gray-300">The Resistance</p>
            </div>

            <div className="space-y-4 pt-8">
              <button
                onClick={() => setMode('create')}
                className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                <Play size={20} />
                Create Game
              </button>

              <button
                onClick={() => setMode('join')}
                className="w-full bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                <LogIn size={20} />
                Join Game
              </button>
            </div>
          </div>
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
  );
}
