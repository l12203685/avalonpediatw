import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { VoteRecord, Room } from '@avalon/shared';
import audioService from '../services/audio';
import { seatPrefix } from '../utils/seatDisplay';

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
  const { t } = useTranslation(['game']);
  const [progress, setProgress] = useState(100);
  // Stabilize onDismiss so the timer effect does not restart on parent re-renders
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const stableDismiss = useCallback(() => onDismissRef.current(), []);

  useEffect(() => {
    audioService.playSound(record.approved ? 'approval' : 'rejection');

    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(pct);
      if (pct === 0) clearInterval(interval);
    }, 50);

    const timeout = setTimeout(stableDismiss, duration);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [duration, stableDismiss, record.approved]);

  const approvals = Object.values(record.votes).filter(Boolean).length;
  const rejections = Object.values(record.votes).filter(v => !v).length;
  const playerOrder = Object.keys(room.players);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onClick={stableDismiss}
    >
      <motion.div
        initial={{ scale: 0.7, y: 40 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.8, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="bg-avalon-card border-2 rounded-2xl p-8 max-w-md w-full mx-4 space-y-6 shadow-2xl"
        style={{ borderColor: record.approved ? '#3b82f6' : '#ef4444' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title */}
        <div className="text-center">
          <p className="text-sm text-gray-400 mb-1">
            {t('game:voteReveal.roundProposal', { round: record.round, attempt: record.attempt })}
          </p>
          <h2 className="text-2xl font-bold text-white">{t('game:voteReveal.title')}</h2>
        </div>

        {/* Result */}
        <motion.div
          initial={{ scale: 0.5 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.15, type: 'spring', stiffness: 400, damping: 20 }}
          className={`text-center py-5 rounded-xl border-2 ${
            record.approved
              ? 'bg-blue-900/40 border-blue-500 text-blue-300'
              : 'bg-red-900/40 border-red-500 text-red-300'
          }`}
        >
          <div className="text-5xl mb-2">{record.approved ? '✅' : '❌'}</div>
          <div className="text-3xl font-bold">
            {record.approved ? t('game:voteReveal.approved') : t('game:voteReveal.rejected')}
          </div>
          <div className="text-sm mt-1 opacity-80">
            {t('game:voteReveal.approveRejectCount', { approvals, rejections })}
          </div>
        </motion.div>

        {/* Proposed team — seat# prefix so "#3 Guest_444" format (#93) */}
        {record.team.length > 0 && (
          <div className="bg-gray-800/40 border border-gray-700 rounded-xl px-4 py-2">
            <p className="text-xs text-gray-500 mb-1.5 font-semibold uppercase tracking-wider">{t('game:voteReveal.teamLabel')}</p>
            <div className="flex flex-wrap gap-1.5">
              {record.team.map(id => (
                <span key={id} className="text-xs bg-blue-900/40 border border-blue-700/50 text-blue-200 px-2 py-0.5 rounded-full">
                  {seatPrefix(id, room.players)} {room.players[id]?.name ?? id}
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
                    ? 'bg-blue-900/30 border-blue-700 text-blue-200'
                    : 'bg-red-900/30 border-red-700 text-red-200'
                }`}
              >
                {vote
                  ? <ThumbsUp size={14} className="flex-shrink-0 text-blue-400" />
                  : <ThumbsDown size={14} className="flex-shrink-0 text-red-400" />
                }
                <span className="truncate">{seatPrefix(playerId, room.players)} {player.name}</span>
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
              backgroundColor: record.approved ? '#3b82f6' : '#ef4444',
            }}
          />
        </div>
      </motion.div>
    </motion.div>
  );
}
