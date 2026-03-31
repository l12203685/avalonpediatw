import { Room, Player } from '@avalon/shared';
import { CheckCircle, XCircle, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { submitQuestVote } from '../services/socket';
import { toast } from '../store/toastStore';

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
  const [timeLeft, setTimeLeft] = useState(30);
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isInTeam = room.questTeam.includes(currentPlayer.id);
  const isUrgent = timeLeft < 10;

  // 倒計時，投票後停止
  useEffect(() => {
    if (submitted || timeLeft <= 0) return;
    const timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft, submitted]);

  const handleVote = async (vote: 'success' | 'fail'): Promise<void> => {
    if (!isInTeam || isSubmitting || submitted) return;
    setIsSubmitting(true);
    try {
      submitQuestVote(room.id, currentPlayer.id, vote);
      setSubmitted(true);
      toast.success(vote === 'success' ? '已投票：任務成功' : '已投票：任務失敗');
    } catch {
      toast.error('投票失敗，請稍後再試');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 旁觀者視圖
  if (!isInTeam) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/50 border-2 border-blue-600 rounded-xl p-8 text-center space-y-4"
      >
        <h2 className="text-2xl font-bold text-white">⚔️ 任務進行中</h2>
        <p className="text-gray-300">
          任務隊伍人數：<span className="text-blue-400 font-bold">{room.questTeam.length}</span>
        </p>
        <div className="flex justify-center gap-2">
          {room.questTeam.map((id) => (
            <div key={id} className="text-sm bg-blue-900/30 border border-blue-600/40 text-blue-300 px-3 py-1 rounded-full">
              {room.players[id]?.name ?? id}
            </div>
          ))}
        </div>
        <motion.p
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="text-sm text-gray-400"
        >
          等待任務隊伍投票中...
        </motion.p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/50 border-2 border-blue-600 rounded-xl p-8 space-y-6"
    >
      {/* 標題 */}
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-2">⚔️ 任務投票</h2>
        <p className="text-gray-300">決定這次任務的成敗</p>
      </div>

      {/* 計時器 */}
      {!submitted && (
        <div className="flex justify-center">
          <motion.div
            animate={{
              backgroundColor: isUrgent ? '#ef4444' : '#3b82f6',
              scale: isUrgent ? [1, 1.05, 1] : 1,
            }}
            transition={{ duration: isUrgent ? 0.5 : 0, repeat: isUrgent ? Infinity : 0 }}
            className="flex items-center gap-2 px-4 py-2 rounded-full font-bold text-white"
          >
            <Clock size={18} />
            {timeLeft}s
          </motion.div>
        </div>
      )}

      {/* 隊伍成員 */}
      <div className="space-y-2">
        <p className="text-gray-400 text-sm font-semibold">本輪任務隊伍：</p>
        <div className="grid grid-cols-2 gap-2">
          {room.questTeam.map((memberId) => (
            <div
              key={memberId}
              className={`p-2 rounded-lg text-sm font-semibold text-center ${
                memberId === currentPlayer.id
                  ? 'bg-yellow-500/30 border border-yellow-400 text-yellow-300'
                  : 'bg-blue-500/20 border border-blue-400/50 text-blue-300'
              }`}
            >
              {room.players[memberId]?.name ?? memberId}
              {memberId === currentPlayer.id && '（我）'}
            </div>
          ))}
        </div>
      </div>

      {/* 投票按鈕 or 已投票 */}
      {!submitted ? (
        <div className="flex justify-center gap-6">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleVote('success')}
            disabled={isSubmitting || isLoading}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <CheckCircle size={20} />
            {isSubmitting ? '提交中...' : '任務成功'}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleVote('fail')}
            disabled={isSubmitting || isLoading}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <XCircle size={20} />
            {isSubmitting ? '提交中...' : '任務失敗'}
          </motion.button>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-4 bg-green-900/20 border border-green-600/40 rounded-lg"
        >
          <p className="text-green-300 font-semibold">✓ 已投票</p>
          <p className="text-gray-400 text-sm mt-1">
            等待其他 {room.questTeam.length - 1} 名隊員...
          </p>
        </motion.div>
      )}

      {!submitted && (
        <p className="text-center text-sm text-gray-400">
          共 {room.questTeam.length} 名隊員投票
        </p>
      )}
    </motion.div>
  );
}
