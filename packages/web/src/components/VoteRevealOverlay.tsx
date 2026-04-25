import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { VoteRecord, Room } from '@avalon/shared';
import audioService from '../services/audio';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';
import { VOTE_IMAGES } from '../utils/avalonAssets';

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
    // #107 Edward 2026-04-25 「派票跟黑白球不要一直跳視窗出來」 — was a
    // fullscreen `fixed inset-0 bg-black/75 backdrop-blur-sm` modal that
    // popped between every phase and forced players to wait + dismiss.
    // Now a compact toast docked at the top so the board stays visible.
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className="fixed top-3 left-1/2 -translate-x-1/2 z-50 w-[min(92vw,28rem)] cursor-pointer"
      onClick={stableDismiss}
      role="status"
      aria-live="polite"
    >
      <div
        className="bg-avalon-card/95 border-2 rounded-xl shadow-2xl backdrop-blur-md overflow-hidden"
        style={{ borderColor: record.approved ? '#3b82f6' : '#ef4444' }}
      >
        {/* Header strip — Edward 2026-04-25 image batch: swap the ✅/❌
            emoji for the painted vote-yes / vote-no banner art so the toast
            mirrors the button art shown during the active vote. */}
        <div className={`px-4 py-2 flex items-center gap-3 ${
          record.approved
            ? 'bg-blue-900/40 text-blue-200'
            : 'bg-red-900/40 text-red-200'
        }`}>
          <img
            src={record.approved ? VOTE_IMAGES.yes : VOTE_IMAGES.no}
            alt={record.approved ? t('game:voteReveal.approved') : t('game:voteReveal.rejected')}
            className="w-7 h-7 object-contain flex-shrink-0"
            loading="lazy"
            draggable={false}
          />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-wider opacity-70">
              {t('game:voteReveal.roundProposal', { round: record.round, attempt: record.attempt })}
            </p>
            <p className="text-base font-bold truncate">
              {record.approved ? t('game:voteReveal.approved') : t('game:voteReveal.rejected')}
              <span className="ml-2 text-xs font-semibold opacity-80">
                {t('game:voteReveal.approveRejectCount', { approvals, rejections })}
              </span>
            </p>
          </div>
        </div>

        {/* Per-player vote chips — compact horizontal strip */}
        <div className="px-3 py-2 flex flex-wrap gap-1.5 max-h-[6.5rem] overflow-hidden">
          {playerOrder.map((playerId) => {
            const player = room.players[playerId];
            const vote = record.votes[playerId];
            if (!player) return null;
            return (
              <span
                key={playerId}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                  vote
                    ? 'bg-blue-900/30 border-blue-700/60 text-blue-200'
                    : 'bg-red-900/30 border-red-700/60 text-red-200'
                }`}
              >
                {vote
                  ? <ThumbsUp size={10} className="text-blue-400 flex-shrink-0" />
                  : <ThumbsDown size={10} className="text-red-400 flex-shrink-0" />
                }
                <span className="truncate max-w-[5rem]">
                  座 {displaySeatNumber(seatOf(playerId, room.players))}
                </span>
              </span>
            );
          })}
        </div>

        {/* Auto-dismiss progress bar */}
        <div className="h-0.5 bg-gray-800">
          <motion.div
            className="h-full"
            style={{
              width: `${progress}%`,
              backgroundColor: record.approved ? '#3b82f6' : '#ef4444',
            }}
          />
        </div>
      </div>
    </motion.div>
  );
}
