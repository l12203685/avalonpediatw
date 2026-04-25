import { Room } from '@avalon/shared';
import { AVALON_CONFIG } from '@avalon/shared';
import { motion } from 'framer-motion';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CampDisc } from './CampDisc';

interface MissionTrackProps {
  room: Room;
  /**
   * Edward 2026-04-25 GamePage 4-revamp:
   *   - 'combined' (default, backward-compatible): mission circles + rejection
   *      diamonds rendered as a single block.
   *   - 'mission-only': render just the 5 mission round circles (no rejection).
   *      GamePage uses this so rejection chip lives in the header instead.
   *   - 'rejection-only': render just the rejection diamond row (compact chip).
   *      GamePage header places this above MissionTrack mission circles.
   */
  variant?: 'combined' | 'mission-only' | 'rejection-only';
}

export default function MissionTrack({ room, variant = 'combined' }: MissionTrackProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const playerCount = Object.keys(room.players).length;
  const config = AVALON_CONFIG[playerCount];
  if (!config) return <></>;

  const teamSizes = config.questTeams; // [2,3,2,3,3] for 5p, etc.
  const failsRequired = config.questFailsRequired;

  // Track how many times votes have been rejected to show the fail-vote track
  const rejectTrack = Array.from({ length: 5 }, (_, i) => {
    return room.failCount > i;
  });

  // Rejection-only render — compact chip used by GamePage header above the
  // mission circles. Mirrors the diamond row from the combined variant but
  // wraps it in its own root so callers can place it independently.
  if (variant === 'rejection-only') {
    if (room.failCount === 0 && room.state !== 'voting') return <></>;
    return (
      <div className="flex items-center justify-center gap-1.5">
        <span className="text-xs text-gray-500 mr-1">{t('game:missionTrack.rejectLabel')}</span>
        {Array.from({ length: 5 }, (_, i) => (
          <motion.div
            key={i}
            initial={room.failCount > i ? { scale: 0.5 } : false}
            animate={{ scale: 1 }}
            className={`w-3 h-3 rotate-45 rounded-sm ${
              room.failCount > i
                ? i >= 4
                  ? 'bg-red-500'
                  : 'bg-amber-500'
                : 'bg-gray-700 border border-gray-600'
            }`}
          />
        ))}
        {room.failCount >= 5 && (
          <span className="text-xs text-red-400 font-bold ml-1">{t('game:missionTrack.evilWinsReject')}</span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Mission circles */}
      <div className="flex items-center justify-center gap-2 sm:gap-3">
        {teamSizes.map((size, i) => {
          const roundNum = i + 1;
          const result = room.questResults[i]; // 'success' | 'fail' | undefined
          const isCurrent = roundNum === room.currentRound && room.state !== 'ended';
          const isPast = roundNum < room.currentRound || result !== undefined;
          const isFuture = !isCurrent && !isPast;

          let ringClass = '';
          let bgClass = '';
          let textClass = '';

          if (result === 'success') {
            ringClass = 'ring-2 ring-blue-400';
            bgClass = 'bg-blue-600';
            textClass = 'text-white';
          } else if (result === 'fail') {
            ringClass = 'ring-2 ring-red-400';
            bgClass = 'bg-red-700';
            textClass = 'text-white';
          } else if (isCurrent) {
            ringClass = 'ring-2 ring-yellow-400 ring-offset-2 ring-offset-avalon-dark';
            bgClass = 'bg-yellow-900/40';
            textClass = 'text-yellow-300';
          } else {
            ringClass = 'ring-1 ring-gray-600';
            bgClass = 'bg-gray-800/60';
            textClass = 'text-gray-500';
          }

          return (
            <motion.div
              key={i}
              initial={result !== undefined ? { scale: 0.8 } : false}
              animate={{ scale: 1 }}
              className="flex flex-col items-center gap-1"
            >
              <motion.div
                animate={isCurrent ? { boxShadow: ['0 0 0px rgba(234,179,8,0)', '0 0 12px rgba(234,179,8,0.6)', '0 0 0px rgba(234,179,8,0)'] } : {}}
                transition={isCurrent ? { duration: 2, repeat: Infinity } : {}}
                className={`w-12 h-12 rounded-full flex flex-col items-center justify-center ${bgClass} ${ringClass} transition-all`}
              >
                {result === 'success' && (
                  <div className="flex flex-col items-center">
                    {/* Edward 2026-04-25 camp emblem unification: 央圓盤 disc
                        sits above ✓ so each completed quest round shows the
                        winning camp at glyph weight. Star-frame intentionally
                        clipped — disc reads cleaner at 18px than full emblem. */}
                    <CampDisc team="good" className="w-[18px] h-[18px]" alt="正義方勝利" />
                    <span className="text-xs leading-none mt-0.5">✓</span>
                    {failsRequired[i] >= 2 && <span className="text-amber-300 text-[10px] font-black leading-none">×2</span>}
                  </div>
                )}
                {result === 'fail' && (
                  <div className="flex flex-col items-center">
                    <CampDisc team="evil" className="w-[18px] h-[18px]" alt="邪惡方勝利" />
                    <span className="text-xs leading-none mt-0.5">✗</span>
                    {failsRequired[i] >= 2 && <span className="text-amber-300 text-[10px] font-black leading-none">×2</span>}
                  </div>
                )}
                {!result && (
                  <div className={`flex flex-col items-center ${textClass}`}>
                    <div className="flex items-center gap-0.5">
                      <Users size={10} />
                      <span className="text-xs font-bold">{size}</span>
                    </div>
                    {failsRequired[i] >= 2 && (
                      <span className="text-amber-400 text-xs font-black leading-none">×2</span>
                    )}
                  </div>
                )}
              </motion.div>
              <span className={`text-xs font-semibold ${
                isCurrent ? 'text-yellow-400' : result ? (result === 'success' ? 'text-blue-400' : 'text-red-400') : 'text-gray-600'
              }`}>
                R{roundNum}
              </span>
            </motion.div>
          );
        })}
      </div>

      {/* Rejection track — 5 diamond slots showing consecutive vote rejects.
          Hidden when caller passes `variant="mission-only"` (GamePage moves
          the rejection chip into its header per Edward 2026-04-25 spec). */}
      {variant === 'combined' && (room.failCount > 0 || room.state === 'voting') && (
        <div className="flex items-center justify-center gap-1.5">
          <span className="text-xs text-gray-500 mr-1">{t('game:missionTrack.rejectLabel')}</span>
          {Array.from({ length: 5 }, (_, i) => (
            <motion.div
              key={i}
              initial={room.failCount > i ? { scale: 0.5 } : false}
              animate={{ scale: 1 }}
              className={`w-3 h-3 rotate-45 rounded-sm ${
                room.failCount > i
                  ? i >= 4
                    ? 'bg-red-500'
                    : 'bg-amber-500'
                  : 'bg-gray-700 border border-gray-600'
              }`}
            />
          ))}
          {room.failCount >= 5 && (
            <span className="text-xs text-red-400 font-bold ml-1">{t('game:missionTrack.evilWinsReject')}</span>
          )}
        </div>
      )}
    </div>
  );
}
