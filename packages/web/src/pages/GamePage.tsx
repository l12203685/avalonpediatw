import { useGameStore } from '../store/gameStore';
import { submitVote } from '../services/socket';
import { ThumbsUp, ThumbsDown } from 'lucide-react';

export default function GamePage(): JSX.Element {
  const { room, currentPlayer } = useGameStore();

  if (!room || !currentPlayer) {
    return <div className="text-center text-white">Loading...</div>;
  }

  const playerList = Object.values(room.players);

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-4xl space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-4xl font-bold text-white mb-2">Avalon</h1>
          <p className="text-gray-400">Round {room.currentRound}/{room.maxRounds}</p>
          <p className="text-sm text-gray-500 mt-2">Game State: {room.state}</p>
        </div>

        {/* Players Circle */}
        <div className="flex flex-wrap justify-center gap-6">
          {playerList.map((player) => (
            <div
              key={player.id}
              className="flex flex-col items-center gap-3"
            >
              <div
                className={`w-16 h-16 rounded-full flex items-center justify-center font-bold text-lg border-4 ${
                  player.id === currentPlayer.id
                    ? 'border-yellow-400 bg-gradient-to-br from-yellow-400 to-yellow-500'
                    : 'border-gray-600 bg-gradient-to-br from-blue-400 to-purple-400'
                }`}
              >
                {player.name.charAt(0).toUpperCase()}
              </div>
              <p className="font-bold text-white text-sm">{player.name}</p>
              {player.role && (
                <p className="text-xs text-gray-400 capitalize">
                  {player.role}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Voting Phase */}
        {room.state === 'voting' && !room.votes[currentPlayer.id] && (
          <div className="bg-avalon-card/50 border border-yellow-600 rounded-lg p-8 text-center space-y-6">
            <h2 className="text-2xl font-bold">Vote on the Proposed Team</h2>

            <div className="flex justify-center gap-6">
              <button
                onClick={() => submitVote(room.id, currentPlayer.id, true)}
                className="flex items-center gap-2 bg-avalon-good hover:bg-avalon-good/90 text-white font-bold py-3 px-8 rounded-lg transition-all"
              >
                <ThumbsUp size={20} />
                Approve
              </button>

              <button
                onClick={() => submitVote(room.id, currentPlayer.id, false)}
                className="flex items-center gap-2 bg-avalon-evil hover:bg-avalon-evil/90 text-white font-bold py-3 px-8 rounded-lg transition-all"
              >
                <ThumbsDown size={20} />
                Reject
              </button>
            </div>
          </div>
        )}

        {/* Vote Results */}
        {room.state === 'voting' && room.votes[currentPlayer.id] !== undefined && (
          <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-8 text-center">
            <p className="text-gray-300">Your vote: {room.votes[currentPlayer.id] ? '👍 Approve' : '👎 Reject'}</p>
            <p className="text-sm text-gray-500 mt-2">Waiting for other players...</p>
          </div>
        )}

        {/* Quest Phase */}
        {room.state === 'quest' && (
          <div className="bg-avalon-card/50 border border-blue-600 rounded-lg p-8 text-center">
            <h2 className="text-2xl font-bold mb-4">Quest in Progress</h2>
            <p className="text-gray-300">Quest Team Size: {room.questTeam.length}</p>
          </div>
        )}

        {/* Discussion Phase (Assassination) */}
        {room.state === 'discussion' && currentPlayer.role === 'assassin' && (
          <div className="bg-avalon-card/50 border border-red-600 rounded-lg p-8 text-center space-y-6">
            <h2 className="text-2xl font-bold">Assassinate Merlin</h2>
            <p className="text-gray-300">Choose who you think Merlin is</p>
          </div>
        )}

        {/* Game Ended */}
        {room.state === 'ended' && (
          <div
            className={`rounded-lg p-8 text-center border-4 ${
              room.evilWins
                ? 'bg-avalon-evil/20 border-avalon-evil'
                : 'bg-avalon-good/20 border-avalon-good'
            }`}
          >
            <h2 className="text-3xl font-bold mb-4">
              {room.evilWins ? '👹 Evil Wins!' : '⚔️ Good Wins!'}
            </h2>
            <p className="text-gray-300">Final Roles:</p>
            <div className="mt-4 grid grid-cols-2 gap-4">
              {playerList.map((player) => (
                <div key={player.id} className="text-sm">
                  <p className="font-bold">{player.name}</p>
                  <p className="text-gray-400 capitalize">{player.role}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
