import { useState } from 'react';
import { motion } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import { submitVote, submitAssassination } from '../services/socket';
import { toast } from '../store/toastStore';
import GameBoard from '../components/GameBoard';
import VotePanel from '../components/VotePanel';
import QuestPanel from '../components/QuestPanel';
import TeamSelectionPanel from '../components/TeamSelectionPanel';
import ChatPanel from '../components/ChatPanel';
import { ROLE_DISPLAY } from '../data/mockData';
import { Home } from 'lucide-react';

export default function GamePage(): JSX.Element {
  const { room, currentPlayer, setGameState } = useGameStore();
  const [isVoting, setIsVoting] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [isAssassinating, setIsAssassinating] = useState(false);

  if (!room || !currentPlayer) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-white text-center">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-400 mb-3" />
          <p>載入中...</p>
        </div>
      </div>
    );
  }

  const handleVote = async (approve: boolean): Promise<void> => {
    setIsVoting(true);
    try {
      submitVote(room.id, currentPlayer.id, approve);
    } catch {
      toast.error('投票失敗，請稍後再試');
    } finally {
      setIsVoting(false);
    }
  };

  const handleAssassinate = (targetId: string): void => {
    if (isAssassinating || selectedTarget) return;
    setSelectedTarget(targetId);
    setIsAssassinating(true);
    try {
      submitAssassination(room.id, currentPlayer.id, targetId);
    } catch {
      toast.error('暗殺失敗，請稍後再試');
      setSelectedTarget(null);
    } finally {
      setIsAssassinating(false);
    }
  };

  const playerKeys = Object.keys(room.players);
  const leaderPlayerId = playerKeys[room.leaderIndex % playerKeys.length];
  const isLeader = currentPlayer.id === leaderPlayerId;

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black p-4">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-5xl font-bold text-white mb-2">🎭 Avalon</h1>
          <p className="text-gray-400">第 {room.currentRound}/{room.maxRounds} 輪</p>
          <div className="flex justify-center gap-4 mt-4 text-sm flex-wrap">
            <div className="bg-avalon-card/50 px-4 py-2 rounded-lg">
              <p className="text-gray-300">
                狀態：<span className="text-yellow-400 capitalize font-bold">{room.state}</span>
              </p>
            </div>
            {room.failCount > 0 && (
              <div className="bg-avalon-card/50 px-4 py-2 rounded-lg">
                <p className="text-gray-300">
                  失敗投票：<span className="text-red-400 font-bold">{room.failCount}</span>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Game Board */}
        <GameBoard room={room} currentPlayer={currentPlayer} />

        {/* ── Voting Phase ── */}
        {room.state === 'voting' && (
          <>
            {isLeader ? (
              <TeamSelectionPanel room={room} currentPlayer={currentPlayer} isLoading={isVoting} />
            ) : (
              <VotePanel room={room} currentPlayer={currentPlayer} onVote={handleVote} isLoading={isVoting} />
            )}
          </>
        )}

        {/* ── Quest Phase ── */}
        {room.state === 'quest' && (
          <QuestPanel room={room} currentPlayer={currentPlayer} />
        )}

        {/* ── Assassination Phase ── */}
        {room.state === 'discussion' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/50 border-2 border-purple-600 rounded-xl p-8 space-y-6"
          >
            {currentPlayer.role === 'assassin' ? (
              <>
                <div className="text-center">
                  <h2 className="text-3xl font-bold text-red-400 mb-2">🗡️ 暗殺 Merlin</h2>
                  <p className="text-gray-300">選擇你認為是 Merlin 的玩家</p>
                </div>
                <div className="grid grid-cols-2 gap-4 max-h-96 overflow-y-auto">
                  {Object.values(room.players)
                    .filter((p) => p.team !== 'evil')
                    .map((player) => (
                      <motion.button
                        key={player.id}
                        whileHover={!selectedTarget ? { scale: 1.02 } : {}}
                        whileTap={!selectedTarget ? { scale: 0.98 } : {}}
                        onClick={() => handleAssassinate(player.id)}
                        disabled={isAssassinating || selectedTarget !== null}
                        className={`p-4 rounded-lg border-2 transition-all font-semibold ${
                          selectedTarget === player.id
                            ? 'bg-red-600/40 border-red-400 text-white'
                            : 'bg-avalon-evil/30 border-red-600 text-white hover:bg-avalon-evil/60 disabled:opacity-50 disabled:cursor-not-allowed'
                        }`}
                      >
                        {player.name}
                        {selectedTarget === player.id && ' ✓'}
                      </motion.button>
                    ))}
                </div>
              </>
            ) : (
              <div className="text-center space-y-4">
                <h2 className="text-3xl font-bold text-purple-400">💬 討論階段</h2>
                <p className="text-gray-300">刺客正在選擇目標...</p>
                <motion.div
                  animate={{ opacity: [0.4, 1, 0.4] }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className="text-sm text-gray-500"
                >
                  等待刺客行動...
                </motion.div>
              </div>
            )}
          </motion.div>
        )}

        {/* ── Game Ended ── */}
        {room.state === 'ended' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`rounded-xl p-8 text-center border-4 space-y-6 ${
              room.evilWins
                ? 'bg-red-900/20 border-red-500'
                : 'bg-green-900/20 border-green-500'
            }`}
          >
            <motion.h2
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200 }}
              className="text-5xl font-black"
            >
              {room.evilWins ? '👹 邪惡陣營勝利！' : '⚔️ 好陣營勝利！'}
            </motion.h2>

            {/* Quest Result Summary */}
            <div className="flex justify-center gap-3">
              {room.questResults.map((result, i) => (
                <motion.div
                  key={i}
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: i * 0.1 + 0.3 }}
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    result === 'success' ? 'bg-green-500' : 'bg-red-500'
                  }`}
                >
                  {result === 'success' ? '✓' : '✗'}
                </motion.div>
              ))}
            </div>

            {/* Final Roles */}
            <div>
              <p className="text-gray-300 mb-4 font-semibold">最終角色揭露</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-lg mx-auto">
                {Object.values(room.players).map((player) => {
                  const roleInfo = ROLE_DISPLAY[player.role ?? ''];
                  return (
                    <motion.div
                      key={player.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`text-sm rounded-lg p-3 border ${
                        player.team === 'good'
                          ? 'bg-blue-900/30 border-blue-700/40'
                          : 'bg-red-900/30 border-red-700/40'
                      }`}
                    >
                      <p className="font-bold text-white truncate">{player.name}</p>
                      {roleInfo ? (
                        <p className={`${roleInfo.color} text-xs mt-0.5`}>
                          {roleInfo.icon} {roleInfo.label}
                        </p>
                      ) : (
                        <p className="text-gray-400 capitalize text-xs mt-0.5">{player.role}</p>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            </div>

            {/* Return Home */}
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setGameState('home')}
              className="flex items-center gap-2 mx-auto bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-8 rounded-xl transition-all"
            >
              <Home size={18} />
              返回主頁
            </motion.button>
          </motion.div>
        )}
      </div>

      {/* Chat Panel */}
      <ChatPanel
        roomId={room.id}
        currentPlayerId={currentPlayer.id}
        currentPlayerName={currentPlayer.name}
      />
    </div>
  );
}
