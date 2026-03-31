import { Room, Player } from '@avalon/shared';
import { ThumbsUp, ThumbsDown, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { toast } from '../store/toastStore';

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
  const [timeLeft, setTimeLeft] = useState(30);
  const playerCount = Object.keys(room.players).length;
  const votedCount = Object.keys(room.votes).length;
  const hasVoted = room.votes[currentPlayer.id] !== undefined;
  const isUrgent = timeLeft < 10;

  useEffect(() => {
    if (hasVoted || timeLeft <= 0) return;
    const timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft, hasVoted]);

  const handleVote = (approve: boolean) => {
    onVote(approve);
    toast.info(approve ? '已投票：贊成' : '已投票：反對');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/50 border-2 border-yellow-600 rounded-xl p-8 space-y-6"
    >
      {/* 標題 */}
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-2">隊伍提案投票</h2>
        <p className="text-gray-300">批准或拒絕本輪提議的任務隊伍</p>
      </div>

      {/* 進度 + 計時器 */}
      <div className="flex justify-between items-center text-sm">
        <span className="text-gray-300">
          已投票：{votedCount}/{playerCount}
        </span>
        {!hasVoted && (
          <motion.div
            animate={{
              backgroundColor: isUrgent ? '#ef4444' : '#fbbf24',
              color: isUrgent ? '#fff' : '#000',
              scale: isUrgent ? [1, 1.05, 1] : 1,
            }}
            transition={{ duration: isUrgent ? 0.5 : 0, repeat: isUrgent ? Infinity : 0 }}
            className="flex items-center gap-2 px-3 py-1 rounded-full font-bold"
          >
            <Clock size={16} />
            {timeLeft}s
          </motion.div>
        )}
      </div>

      {/* 進度條 */}
      <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
        <motion.div
          animate={{ width: `${(votedCount / playerCount) * 100}%` }}
          className="h-full bg-gradient-to-r from-avalon-good to-yellow-400"
        />
      </div>

      {/* 投票按鈕 or 已投票 */}
      {!hasVoted ? (
        <div className="flex justify-center gap-6">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleVote(true)}
            disabled={isLoading}
            className="flex items-center gap-2 bg-avalon-good hover:bg-avalon-good/90 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <ThumbsUp size={20} />
            {isLoading ? '投票中...' : '贊成'}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleVote(false)}
            disabled={isLoading}
            className="flex items-center gap-2 bg-avalon-evil hover:bg-avalon-evil/90 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <ThumbsDown size={20} />
            {isLoading ? '投票中...' : '反對'}
          </motion.button>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-4 bg-avalon-card/30 border border-gray-600 rounded-lg"
        >
          <p className="text-gray-300 font-semibold">
            你的投票：{room.votes[currentPlayer.id] ? '👍 贊成' : '👎 反對'}
          </p>
          <motion.p
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="text-sm text-gray-500 mt-1"
          >
            等待其他玩家投票...
          </motion.p>
        </motion.div>
      )}

      {/* 計票狀態 */}
      {votedCount > 0 && (
        <div className="text-center text-sm text-gray-400">
          {votedCount === playerCount ? (
            <motion.p
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="text-yellow-400 font-bold"
            >
              投票完成！統計中...
            </motion.p>
          ) : (
            <p>還有 {playerCount - votedCount} 人未投票</p>
          )}
        </div>
      )}
    </motion.div>
  );
}
