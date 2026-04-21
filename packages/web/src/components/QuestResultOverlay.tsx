import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { QuestRecord, Room } from '@avalon/shared';
import audioService from '../services/audio';
import { seatPrefix } from '../utils/seatDisplay';

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
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={stableDismiss}
    >
      <motion.div
        initial={{ scale: 0.6, y: 60 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.7, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 22 }}
        className="bg-avalon-card border-2 rounded-2xl p-8 max-w-sm w-full mx-4 space-y-6 shadow-2xl text-center"
        style={{ borderColor: success ? '#22c55e' : '#ef4444' }}
        onClick={e => e.stopPropagation()}
      >
        <p className="text-sm text-gray-400">第 {record.round} 關任務 (Quest {record.round})</p>

        {/* Dramatic icon */}
        <motion.div
          initial={{ scale: 0, rotate: -180 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 300, damping: 18 }}
          className="text-8xl"
        >
          {success ? '⚔️' : '💀'}
        </motion.div>

        {/* Result label */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
        >
          <h2
            className="text-4xl font-extrabold"
            style={{ color: success ? '#4ade80' : '#f87171' }}
          >
            {success ? '任務成功！' : '任務失敗！'}
          </h2>
          <p className="text-gray-400 text-sm mt-1">
            {success ? 'Quest Succeeded' : 'Quest Failed'}
          </p>
          {record.failCount > 0 && (
            <p className="text-red-400 text-sm mt-2">
              {record.failCount} 張失敗票 ({record.failCount} fail vote{record.failCount > 1 ? 's' : ''})
            </p>
          )}
        </motion.div>

        {/* Team members — seat# prefix so "#3 Guest_444" format (#93) */}
        {teamPlayers.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-gray-500">本次任務隊伍：</p>
            <div className="flex flex-wrap justify-center gap-2">
              {teamPlayers.map((player, i) => (
                <motion.span
                  key={player.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.35 + i * 0.06 }}
                  className="bg-gray-800 border border-gray-600 text-gray-200 text-sm px-3 py-1 rounded-full"
                >
                  {seatPrefix(player.id, room.players)} {player.name}
                </motion.span>
              ))}
            </div>
          </div>
        )}

        {/* Progress bar */}
        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{
              width: `${progress}%`,
              backgroundColor: success ? '#22c55e' : '#ef4444',
            }}
          />
        </div>
      </motion.div>
    </motion.div>
  );
}
