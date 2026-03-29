import { Room, Player } from '@avalon/shared';
import { CheckCircle, XCircle, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { submitQuestVote } from '../services/socket';

interface QuestPanelProps {
  room: Room;
  currentPlayer: Player;
  isLoading?: boolean;
}

export default function QuestPanel({
  room,
  currentPlayer,
  isLoading = false,
}: QuestPanelProps): JSX.Element {
  const [timeLeft, setTimeLeft] = useState(30); // 30秒任務投票時限
  const isInTeam = room.questTeam.includes(currentPlayer.id);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasVoted, setHasVoted] = useState(false);

  // 任務倒計時
  useEffect(() => {
    if (timeLeft > 0) {
      const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [timeLeft]);

  // 時間警告
  const isUrgent = timeLeft < 10;

  const handleVote = async (vote: 'success' | 'fail') => {
    if (!isInTeam || isSubmitting || hasVoted) return;

    setIsSubmitting(true);
    try {
      submitQuestVote(room.id, currentPlayer.id, vote);
      setHasVoted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isInTeam) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/50 border-2 border-blue-600 rounded-lg p-8 text-center space-y-4"
      >
        <h2 className="text-2xl font-bold text-white">⚔️ 任務進行中 (Quest in Progress)</h2>
        <p className="text-gray-300">
          任務隊伍人數 (Team size)：<span className="text-blue-400 font-bold">{room.questTeam.length}</span>
        </p>
        <p className="text-sm text-gray-400">
          等待任務隊伍成員投票… (Waiting for team members to vote…)
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/50 border-2 border-blue-600 rounded-lg p-8 space-y-6"
    >
      {/* 標題 */}
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-2">⚔️ 任務投票 (Quest Vote)</h2>
        <p className="text-gray-300">選擇讓此次任務成功或失敗 (Choose to succeed or fail this quest)</p>
      </div>

      {/* 計時器 */}
      <div className="flex justify-center">
        <motion.div
          animate={{
            backgroundColor: isUrgent ? '#ef4444' : '#3b82f6',
            color: '#fff',
          }}
          className="flex items-center gap-2 px-4 py-2 rounded-full font-bold"
        >
          <Clock size={18} />
          {timeLeft}s
        </motion.div>
      </div>

      {/* 隊伍成員列表 */}
      <div className="space-y-2">
        <p className="text-gray-300 text-sm font-semibold">任務隊伍：</p>
        <div className="grid grid-cols-2 gap-2">
          {room.questTeam.map((memberId) => (
            <div
              key={memberId}
              className={`p-2 rounded-lg text-sm font-semibold ${
                memberId === currentPlayer.id
                  ? 'bg-yellow-500/30 border border-yellow-400 text-yellow-300'
                  : 'bg-blue-500/20 border border-blue-400 text-blue-300'
              }`}
            >
              {room.players[memberId].name}
              {memberId === currentPlayer.id && '（你）'}
            </div>
          ))}
        </div>
      </div>

      {/* 投票按鈕 */}
      {hasVoted ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-4 text-green-400 font-semibold"
        >
          ✓ 已提交，等待其他隊員投票…
        </motion.div>
      ) : (
        <div className="flex justify-center gap-6">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleVote('success')}
            disabled={isSubmitting || isLoading}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <CheckCircle size={20} />
            {isSubmitting ? '投票中…' : '任務成功 (Quest Success)'}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleVote('fail')}
            disabled={isSubmitting || isLoading}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <XCircle size={20} />
            {isSubmitting ? '投票中…' : '任務失敗 (Quest Fail)'}
          </motion.button>
        </div>
      )}

      {/* 提示信息 */}
      {!hasVoted && (
        <div className="text-center text-sm text-gray-400">
          <p>
            {room.questTeam.length === 1
              ? '只有你在投票…'
              : `${room.questTeam.length} 位隊員投票中…`}
          </p>
        </div>
      )}
    </motion.div>
  );
}
