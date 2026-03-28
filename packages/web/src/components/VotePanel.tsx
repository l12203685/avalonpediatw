import { Room, Player } from '@avalon/shared';
import { ThumbsUp, ThumbsDown, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

interface VotePanelProps {
  room: Room;
  currentPlayer: Player;
  onVote: (approve: boolean) => void;
  isLoading?: boolean;
}

export default function VotePanel({
  room,
  currentPlayer,
  onVote,
  isLoading = false,
}: VotePanelProps): JSX.Element {
  const [timeLeft, setTimeLeft] = useState(30); // 30秒投票時限
  const playerCount = Object.keys(room.players).length;
  const votedCount = Object.keys(room.votes).length;
  const hasVoted = room.votes[currentPlayer.id] !== undefined;
  const questTeamPlayers = room.questTeam.map(id => room.players[id]).filter(Boolean);

  // 投票倒計時
  useEffect(() => {
    if (!hasVoted && timeLeft > 0) {
      const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [timeLeft, hasVoted]);

  // 時間警告
  const isUrgent = timeLeft < 10;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/50 border-2 border-yellow-600 rounded-lg p-8 space-y-6"
    >
      {/* 標題 */}
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-2">隊伍提案投票</h2>
        <p className="text-gray-300">同意或拒絕此次任務隊伍</p>
      </div>

      {/* 提案隊伍 */}
      {questTeamPlayers.length > 0 && (
        <div className="bg-black/30 rounded-xl p-4">
          <p className="text-sm text-gray-400 mb-3 text-center">本次任務隊伍：</p>
          <div className="flex flex-wrap justify-center gap-2">
            {questTeamPlayers.map(player => (
              <div
                key={player.id}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border font-semibold text-sm ${
                  player.id === currentPlayer.id
                    ? 'bg-yellow-900/40 border-yellow-600 text-yellow-300'
                    : 'bg-avalon-card/60 border-gray-600 text-white'
                }`}
              >
                <span className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-purple-400 flex items-center justify-center text-xs font-bold text-white">
                  {player.name.charAt(0).toUpperCase()}
                </span>
                {player.name}
                {player.id === currentPlayer.id && ' (你)'}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 投票進度 */}
      <div className="flex justify-between items-center text-sm">
        <span className="text-gray-300">
          Votes: {votedCount}/{playerCount}
        </span>
        <motion.div
          animate={{
            backgroundColor: isUrgent ? '#ef4444' : '#fbbf24',
            color: isUrgent ? '#fff' : '#000',
          }}
          className="flex items-center gap-2 px-3 py-1 rounded-full font-bold"
        >
          <Clock size={16} />
          {timeLeft}s
        </motion.div>
      </div>

      {/* 投票進度條 */}
      <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${(votedCount / playerCount) * 100}%` }}
          className="h-full bg-gradient-to-r from-avalon-good to-yellow-400"
        />
      </div>

      {/* 投票按鈕 */}
      {!hasVoted ? (
        <div className="flex justify-center gap-6">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => onVote(true)}
            disabled={isLoading}
            className="flex items-center gap-2 bg-avalon-good hover:bg-avalon-good/90 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <ThumbsUp size={20} />
            {isLoading ? 'Voting...' : 'Approve'}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => onVote(false)}
            disabled={isLoading}
            className="flex items-center gap-2 bg-avalon-evil hover:bg-avalon-evil/90 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <ThumbsDown size={20} />
            {isLoading ? 'Voting...' : 'Reject'}
          </motion.button>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-3"
        >
          <p className="text-gray-300">
            Your vote: {room.votes[currentPlayer.id] ? '👍 Approved' : '👎 Rejected'}
          </p>
          <p className="text-sm text-gray-500 mt-1">Waiting for other players...</p>
        </motion.div>
      )}

      {/* 投票結果預覽（可選） */}
      {votedCount > 0 && (
        <div className="text-center text-sm text-gray-400">
          {votedCount === playerCount ? (
            <p className="text-yellow-400 font-bold">Votes are in! Calculating results...</p>
          ) : (
            <p>{playerCount - votedCount} player(s) still voting</p>
          )}
        </div>
      )}
    </motion.div>
  );
}
