import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { QuestRecord, Room } from '@avalon/shared';
import audioService from '../services/audio';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';
import { QUEST_RESULT_IMAGES } from '../utils/avalonAssets';

interface QuestResultOverlayProps {
  record: QuestRecord;
  room: Room;
  onDismiss: () => void;
  duration?: number;
}

export default function QuestResultOverlay({
  record,
  room,
  onDismiss,
  duration = 4000,
}: QuestResultOverlayProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const [progress, setProgress] = useState(100);
  const success = record.result === 'success';
  // Stabilize onDismiss so the timer effect does not restart on parent re-renders
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const stableDismiss = useCallback(() => onDismissRef.current(), []);

  useEffect(() => {
    audioService.playSound(success ? 'quest-success' : 'quest-fail');

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
  }, [duration, stableDismiss, success]);

  const teamPlayers = record.team.map(id => room.players[id]).filter(Boolean);

  return (
    // #107 Edward 2026-04-25 「派票跟黑白球不要一直跳視窗出來」 — was a
    // fullscreen `fixed inset-0 bg-black/80 backdrop-blur-sm` modal that
    // popped between every quest. Now a compact toast docked at the top so
    // the player ring stays visible and the screen doesn't slide.
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ type: 'spring', stiffness: 280, damping: 22 }}
      className="fixed top-3 left-1/2 -translate-x-1/2 z-50 w-[min(92vw,26rem)] cursor-pointer"
      onClick={stableDismiss}
      role="status"
      aria-live="polite"
    >
      <div
        className="bg-avalon-card/95 border-2 rounded-xl shadow-2xl backdrop-blur-md overflow-hidden"
        style={{ borderColor: success ? '#22c55e' : '#ef4444' }}
      >
        {/* Header strip — Edward 2026-04-25 image batch: replace the
            ⚔️/💀 emoji with the painted success/fail banner art. Image
            sits at 36px (matches old emoji visual weight) and never
            blocks the seat-list below. */}
        <div className={`px-4 py-2.5 flex items-center gap-3 ${
          success ? 'bg-green-900/40 text-green-200' : 'bg-red-900/40 text-red-200'
        }`}>
          <img
            src={success ? QUEST_RESULT_IMAGES.success : QUEST_RESULT_IMAGES.fail}
            alt={success ? t('game:questResult.success') : t('game:questResult.fail')}
            className="w-9 h-9 object-contain flex-shrink-0"
            loading="lazy"
            draggable={false}
          />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-wider opacity-70">
              {t('game:questResult.roundLabel', { round: record.round })}
            </p>
            <p className="text-lg font-extrabold truncate" style={{ color: success ? '#4ade80' : '#f87171' }}>
              {success ? t('game:questResult.success') : t('game:questResult.fail')}
              {record.failCount > 0 && (
                <span className="ml-2 text-xs font-semibold text-red-400">
                  {t('game:questResult.failCount', { count: record.failCount })}
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Team members — compact horizontal chips */}
        {teamPlayers.length > 0 && (
          <div className="px-3 py-2 flex flex-wrap gap-1.5">
            {teamPlayers.map((player) => {
              const seat = seatOf(player.id, room.players);
              return (
                <span
                  key={player.id}
                  className="bg-gray-800/80 border border-gray-600 text-gray-200 text-[11px] px-2 py-0.5 rounded-full font-semibold"
                >
                  座 {displaySeatNumber(seat)}
                </span>
              );
            })}
          </div>
        )}

        {/* Auto-dismiss progress bar */}
        <div className="h-0.5 bg-gray-800">
          <motion.div
            className="h-full"
            style={{
              width: `${progress}%`,
              backgroundColor: success ? '#22c55e' : '#ef4444',
            }}
          />
        </div>
      </div>
    </motion.div>
  );
}
