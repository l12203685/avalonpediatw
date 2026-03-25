import { useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { submitVote } from '../services/socket';
import GameBoard from '../components/GameBoard';
import VotePanel from '../components/VotePanel';

export default function GamePage(): JSX.Element {
  const { room, currentPlayer } = useGameStore();
  const [isVoting, setIsVoting] = useState(false);

  if (!room || !currentPlayer) {
    return <div className="text-center text-white">Loading...</div>;
  }

  const handleVote = async (approve: boolean) => {
    setIsVoting(true);
    try {
      await submitVote(room.id, currentPlayer.id, approve);
    } finally {
      setIsVoting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black p-4">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-5xl font-bold text-white mb-2">🎭 Avalon</h1>
          <p className="text-gray-400">Round {room.currentRound}/{room.maxRounds}</p>
          <div className="flex justify-center gap-4 mt-4 text-sm">
            <div className="bg-avalon-card/50 px-4 py-2 rounded-lg">
              <p className="text-gray-300">State: <span className="text-yellow-400 capitalize font-bold">{room.state}</span></p>
            </div>
            {room.failCount > 0 && (
              <div className="bg-avalon-card/50 px-4 py-2 rounded-lg">
                <p className="text-gray-300">Failed Votes: <span className="text-red-400 font-bold">{room.failCount}</span></p>
              </div>
            )}
          </div>
        </div>

        {/* Game Board */}
        <GameBoard room={room} currentPlayer={currentPlayer} />

        {/* Voting Phase */}
        {room.state === 'voting' && (
          <VotePanel
            room={room}
            currentPlayer={currentPlayer}
            onVote={handleVote}
            isLoading={isVoting}
          />
        )}

        {/* Quest Phase */}
        {room.state === 'quest' && (
          <div className="bg-avalon-card/50 border-2 border-blue-600 rounded-lg p-8 text-center space-y-4">
            <h2 className="text-3xl font-bold text-white">⚔️ Quest in Progress</h2>
            <p className="text-gray-300">Quest Team Size: <span className="text-blue-400 font-bold">{room.questTeam.length}</span></p>
            <p className="text-sm text-gray-400">Waiting for quest results...</p>
          </div>
        )}

        {/* Discussion Phase */}
        {room.state === 'discussion' && (
          <div className="bg-avalon-card/50 border-2 border-purple-600 rounded-lg p-8 text-center space-y-4">
            {currentPlayer.role === 'assassin' ? (
              <>
                <h2 className="text-3xl font-bold text-red-400">🗡️ Assassinate Merlin</h2>
                <p className="text-gray-300">Choose who you think Merlin is</p>
                <div className="grid grid-cols-2 gap-4">
                  {Object.values(room.players).map((player) => (
                    <button
                      key={player.id}
                      className="bg-avalon-evil/30 hover:bg-avalon-evil/60 border border-red-600 rounded-lg p-3 text-white transition-all"
                    >
                      {player.name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2 className="text-3xl font-bold text-purple-400">💬 Discussion Phase</h2>
                <p className="text-gray-300">The assassin is choosing their target...</p>
              </>
            )}
          </div>
        )}

        {/* Game Ended */}
        {room.state === 'ended' && (
          <div
            className={`rounded-lg p-8 text-center border-4 space-y-6 ${
              room.evilWins
                ? 'bg-avalon-evil/20 border-avalon-evil'
                : 'bg-avalon-good/20 border-avalon-good'
            }`}
          >
            <h2 className="text-4xl font-bold">
              {room.evilWins ? '👹 Evil Wins!' : '⚔️ Good Wins!'}
            </h2>
            <p className="text-gray-300">Final Roles:</p>
            <div className="grid grid-cols-2 gap-4">
              {Object.values(room.players).map((player) => (
                <div key={player.id} className="text-sm bg-avalon-card/30 p-3 rounded-lg">
                  <p className="font-bold text-white">{player.name}</p>
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
