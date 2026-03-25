import { useGameStore } from '../store/gameStore';
import { startGame } from '../services/socket';
import { Users, Play } from 'lucide-react';

export default function LobbyPage(): JSX.Element {
  const { room, currentPlayer } = useGameStore();

  if (!room || !currentPlayer) {
    return <div className="text-center text-white">Loading...</div>;
  }

  const playerList = Object.values(room.players);
  const isHost = room.host === currentPlayer.id;
  const canStart = playerList.length >= 5;

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-2xl space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-4xl font-bold text-white mb-2">{room.name}</h1>
          <p className="text-gray-400">Room ID: {room.id}</p>
        </div>

        {/* Players */}
        <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-8">
          <div className="flex items-center gap-2 mb-6">
            <Users size={24} />
            <h2 className="text-2xl font-bold">
              Players ({playerList.length}/{room.maxPlayers})
            </h2>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {playerList.map((player) => (
              <div
                key={player.id}
                className="bg-avalon-dark rounded-lg p-4 border border-gray-600 flex items-center gap-3"
              >
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-purple-400 flex items-center justify-center font-bold">
                  {player.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1">
                  <p className="font-bold text-white">{player.name}</p>
                  <p className="text-sm text-gray-400">
                    {player.id === room.host ? '👑 Host' : 'Player'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Start Button */}
        {isHost && (
          <div className="space-y-4">
            {!canStart && (
              <div className="bg-yellow-900/50 border border-yellow-600 rounded-lg p-4 text-yellow-200">
                Need at least 5 players to start (currently {playerList.length})
              </div>
            )}

            <button
              onClick={() => startGame(room.id)}
              disabled={!canStart}
              className={`w-full font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 ${
                canStart
                  ? 'bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white'
                  : 'bg-gray-600 text-gray-400 cursor-not-allowed'
              }`}
            >
              <Play size={20} />
              Start Game
            </button>
          </div>
        )}

        {!isHost && (
          <div className="text-center text-gray-400">
            Waiting for host to start the game...
          </div>
        )}
      </div>
    </div>
  );
}
