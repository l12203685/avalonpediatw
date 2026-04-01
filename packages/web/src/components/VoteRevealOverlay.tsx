import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { VoteRecord, Room } from '@avalon/shared';
import audioService from '../services/audio';

interface VoteRevealOverlayProps {
  record: VoteRecord;
  room: Room;
  onDismiss: () => void;
  duration?: number; // ms
}

export default function VoteRevealOverlay({
  record,
  room,
  onDismiss,
  duration = 3500,
}: VoteRevealOverlayProps): JSX.Element {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    audioService.playSound(record.approved ? 'approval' : 'rejection');

    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(pct);
      if (pct === 0) clearInterval(interval);
    }, 50);

    const timeout = setTimeout(onDismiss, duration);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [duration, onDismiss]);

  const approvals = Object.values(record.votes).filter(Boolean).length;
  const rejections = Object.values(record.votes).filter(v => !v).length;
  const playerOrder = Object.keys(room.players);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <motion.div
        initial={{ scale: 0.7, y: 40 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.8, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="bg-avalon-card border-2 rounded-2xl p-8 max-w-md w-full mx-4 space-y-6 shadow-2xl"
        style={{ borderColor: record.approved ? '#22c55e' : '#ef4444' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title */}
        <div className="text-center">
          <p className="text-sm text-gray-400 mb-1">
            第 {record.round} 關 — 第 {record.attempt} 次提案
          </p>
          <h2 className="text-2xl font-bold text-white">投票結果 (Vote Results)</h2>
        </div>

        {/* Result */}
        <motion.div
          initial={{ scale: 0.5 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.15, type: 'spring', stiffness: 400, damping: 20 }}
          className={`text-center py-5 rounded-xl border-2 ${
            record.approved
              ? 'bg-green-900/40 border-green-500 text-green-300'
              : 'bg-red-900/40 border-red-500 text-red-300'
          }`}
        >
          <div className="text-5xl mb-2">{record.approved ? '✅' : '❌'}</div>
          <div className="text-3xl font-bold">
            {record.approved ? '通過 (Approved)' : '否決 (Rejected)'}
          </div>
          <div className="text-sm mt-1 opacity-80">
            {approvals} 贊成 / {rejections} 拒絕
          </div>
        </motion.div>

        {/* Proposed team */}
        {record.team.length > 0 && (
          <div className="bg-gray-800/40 border border-gray-700 rounded-xl px-4 py-2">
            <p className="text-xs text-gray-500 mb-1.5 font-semibold uppercase tracking-wider">任務隊伍 (Quest Team)</p>
            <div className="flex flex-wrap gap-1.5">
              {record.team.map(id => (
                <span key={id} className="text-xs bg-blue-900/40 border border-blue-700/50 text-blue-200 px-2 py-0.5 rounded-full">
                  {room.players[id]?.name ?? id}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Per-player votes */}
        <div className="grid grid-cols-2 gap-2">
          {playerOrder.map((playerId, i) => {
            const player = room.players[playerId];
            const vote = record.votes[playerId];
            if (!player) return null;
            return (
              <motion.div
                key={playerId}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + i * 0.07 }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-semibold ${
                  vote
                    ? 'bg-green-900/30 border-green-700 text-green-200'
                    : 'bg-red-900/30 border-red-700 text-red-200'
                }`}
              >
                {vote
                  ? <ThumbsUp size={14} className="flex-shrink-0 text-green-400" />
                  : <ThumbsDown size={14} className="flex-shrink-0 text-red-400" />
                }
                <span className="truncate">{player.name}</span>
              </motion.div>
            );
          })}
        </div>

        {/* Auto-dismiss progress bar */}
        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{
              width: `${progress}%`,
              backgroundColor: record.approved ? '#22c55e' : '#ef4444',
            }}
          />
        </div>
      </motion.div>
    </motion.div>
  );
}
