import { Room } from '@avalon/shared';
import { AVALON_CONFIG } from '@avalon/shared';
import { motion } from 'framer-motion';
import { Users } from 'lucide-react';

interface MissionTrackProps {
  room: Room;
}

export default function MissionTrack({ room }: MissionTrackProps): JSX.Element {
  const playerCount = Object.keys(room.players).length;
  const config = AVALON_CONFIG[playerCount];
  if (!config) return <></>;

  const teamSizes = config.questTeams; // [2,3,2,3,3] for 5p, etc.
  const failsRequired = config.questFailsRequired;

  // Track how many times votes have been rejected to show the fail-vote track
  const rejectTrack = Array.from({ length: 5 }, (_, i) => {
    return room.failCount > i;
  });

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
                    <span className="text-lg leading-none">✓</span>
                    {failsRequired[i] >= 2 && <span className="text-orange-300 text-xs font-black leading-none">×2</span>}
                  </div>
                )}
                {result === 'fail' && (
                  <div className="flex flex-col items-center">
                    <span className="text-lg leading-none">✗</span>
                    {failsRequired[i] >= 2 && <span className="text-orange-300 text-xs font-black leading-none">×2</span>}
                  </div>
                )}
                {!result && (
                  <div className={`flex flex-col items-center ${textClass}`}>
                    <div className="flex items-center gap-0.5">
                      <Users size={10} />
                      <span className="text-xs font-bold">{size}</span>
                    </div>
                    {failsRequired[i] >= 2 && (
                      <span className="text-orange-400 text-xs font-black leading-none">×2</span>
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

      {/* Rejection track — 5 diamond slots showing consecutive vote rejects */}
      {(room.failCount > 0 || room.state === 'voting') && (
        <div className="flex items-center justify-center gap-1.5">
          <span className="text-xs text-gray-500 mr-1">否決 (Reject):</span>
          {Array.from({ length: 5 }, (_, i) => (
            <motion.div
              key={i}
              initial={room.failCount > i ? { scale: 0.5 } : false}
              animate={{ scale: 1 }}
              className={`w-3 h-3 rotate-45 rounded-sm ${
                room.failCount > i
                  ? i >= 4
                    ? 'bg-red-500'
                    : 'bg-orange-500'
                  : 'bg-gray-700 border border-gray-600'
              }`}
            />
          ))}
          {room.failCount >= 5 && (
            <span className="text-xs text-red-400 font-bold ml-1">邪惡方獲勝！</span>
          )}
        </div>
      )}
    </div>
  );
}
