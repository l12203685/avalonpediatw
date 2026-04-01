import { Room, Player } from '@avalon/shared';
import { ThumbsUp, ThumbsDown, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import audioService from '../services/audio';

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
  const [timeLeft, setTimeLeft] = useState(60); // 60秒投票時限 (matches server VOTE_TIMEOUT_MS)
  const playerCount = Object.keys(room.players).length;
  const votedCount = Object.keys(room.votes).length;
  const hasVoted = room.votes[currentPlayer.id] !== undefined;
  const questTeamPlayers = room.questTeam.map(id => room.players[id]).filter(Boolean);
  // Use questTeam + failCount as a key to reset timer on new vote round
  const voteRoundKey = room.questTeam.join(',') + ':' + room.failCount;

  // Reset timer when a new vote round starts
  useEffect(() => {
    setTimeLeft(60);
  }, [voteRoundKey]);

  // 投票倒計時
  useEffect(() => {
    if (!hasVoted && timeLeft > 0) {
      const timer = setTimeout(() => setTimeLeft(t => Math.max(0, t - 1)), 1000);
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
        <h2 className="text-3xl font-bold text-white mb-2">隊伍提案投票 (Team Vote)</h2>
        <p className="text-gray-300">同意或拒絕此次任務隊伍 (Approve or Reject the proposed team)</p>
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
          已投票：{votedCount}/{playerCount}
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
            onClick={() => { audioService.playSound('vote'); onVote(true); }}
            disabled={isLoading}
            className="flex items-center gap-2 bg-avalon-good hover:bg-avalon-good/90 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <ThumbsUp size={20} />
            {isLoading ? '投票中…' : '贊成 (Approve)'}
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => { audioService.playSound('vote'); onVote(false); }}
            disabled={isLoading}
            className="flex items-center gap-2 bg-avalon-evil hover:bg-avalon-evil/90 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <ThumbsDown size={20} />
            {isLoading ? '投票中…' : '拒絕 (Reject)'}
          </motion.button>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-3"
        >
          <p className="text-gray-300">
            你的票 (Your vote)：{room.votes[currentPlayer.id] ? '👍 贊成 (Approve)' : '👎 拒絕 (Reject)'}
          </p>
          <p className="text-sm text-gray-500 mt-1">等待其他玩家投票…</p>
        </motion.div>
      )}

      {/* Per-player voting status */}
      {playerCount > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {Object.values(room.players).map(player => {
            const hasPlayerVoted = player.id in room.votes;
            return (
              <div
                key={player.id}
                className={`text-xs px-2.5 py-1 rounded-full font-semibold transition-all ${
                  hasPlayerVoted
                    ? 'bg-green-900/50 border border-green-700 text-green-300'
                    : 'bg-gray-800/50 border border-gray-700 text-gray-500'
                } ${player.id === currentPlayer.id ? 'ring-1 ring-yellow-500/50' : ''}`}
              >
                {player.name}{hasPlayerVoted ? ' ✓' : ' …'}
              </div>
            );
          })}
        </div>
      )}

      {/* Status */}
      <div className="text-center text-sm text-gray-400">
        {votedCount === playerCount ? (
          <p className="text-yellow-400 font-bold">所有人已投票！計算結果中…</p>
        ) : votedCount > 0 ? (
          <p>還有 {playerCount - votedCount} 人尚未投票</p>
        ) : null}
      </div>
    </motion.div>
  );
}
