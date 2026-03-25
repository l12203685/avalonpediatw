import { useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { submitVote, submitAssassination } from '../services/socket';
import GameBoard from '../components/GameBoard';
import VotePanel from '../components/VotePanel';
import QuestPanel from '../components/QuestPanel';
import TeamSelectionPanel from '../components/TeamSelectionPanel';

export default function GamePage(): JSX.Element {
  const { room, currentPlayer } = useGameStore();
  const [isVoting, setIsVoting] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [isAssassinating, setIsAssassinating] = useState(false);

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

  const handleAssassinate = async (targetId: string) => {
    setSelectedTarget(targetId);
    setIsAssassinating(true);
    try {
      submitAssassination(room.id, currentPlayer.id, targetId);
    } finally {
      setIsAssassinating(false);
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

        {/* Voting Phase - Team Proposal */}
        {room.state === 'voting' && (
          <>
            {/* Check if current player is the leader */}
            {currentPlayer.id === (room.players[Object.keys(room.players)[0]]?.id) ? (
              <TeamSelectionPanel
                room={room}
                currentPlayer={currentPlayer}
                isLoading={isVoting}
              />
            ) : (
              <VotePanel
                room={room}
                currentPlayer={currentPlayer}
                onVote={handleVote}
                isLoading={isVoting}
              />
            )}
          </>
        )}

        {/* Quest Phase - Team Members Vote */}
        {room.state === 'quest' && <QuestPanel room={room} currentPlayer={currentPlayer} />}

        {/* Discussion Phase - Assassination */}
        {room.state === 'discussion' && (
          <div className="bg-avalon-card/50 border-2 border-purple-600 rounded-lg p-8 space-y-6">
            {currentPlayer.role === 'assassin' ? (
              <>
                <div className="text-center">
                  <h2 className="text-3xl font-bold text-red-400 mb-2">🗡️ Assassinate Merlin</h2>
                  <p className="text-gray-300">Choose who you think Merlin is</p>
                </div>
                <div className="grid grid-cols-2 gap-4 max-h-96 overflow-y-auto">
                  {Object.values(room.players).map((player) => (
                    <button
                      key={player.id}
                      onClick={() => handleAssassinate(player.id)}
                      disabled={isAssassinating || selectedTarget !== null}
                      className={`p-4 rounded-lg border-2 transition-all font-semibold ${
                        selectedTarget === player.id
                          ? 'bg-red-600/40 border-red-400 text-white'
                          : 'bg-avalon-evil/30 border-red-600 text-white hover:bg-avalon-evil/60 disabled:opacity-50'
                      }`}
                    >
                      {player.name}
                      {selectedTarget === player.id && ' ✓'}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-center space-y-4">
                <h2 className="text-3xl font-bold text-purple-400">💬 Discussion Phase</h2>
                <p className="text-gray-300">The assassin is choosing their target...</p>
                <div className="text-sm text-gray-500">
                  Waiting for the assassin to make their choice...
                </div>
              </div>
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
