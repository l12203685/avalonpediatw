import { Player } from '@avalon/shared';
import { motion } from 'framer-motion';
import { ThumbsUp, ThumbsDown, Crown, Sword, WifiOff } from 'lucide-react';

const ROLE_NAMES: Record<string, string> = {
  merlin:   '梅林 (Merlin)',
  percival: '派西維爾 (Percival)',
  loyal:    '忠臣 (Loyal Servant)',
  assassin: '刺客 (Assassin)',
  morgana:  '莫甘娜 (Morgana)',
  oberon:   '奧伯倫 (Oberon)',
  mordred:  '莫德雷德 (Mordred)',
  minion:   '爪牙 (Minion)',
};

interface PlayerCardProps {
  player: Player;
  isCurrentPlayer: boolean;
  hasVoted: boolean;
  voted?: boolean;
  isLeader?: boolean;
  isOnQuestTeam?: boolean;
}

export default function PlayerCard({
  player,
  isCurrentPlayer,
  hasVoted,
  voted,
  isLeader = false,
  isOnQuestTeam = false,
}: PlayerCardProps): JSX.Element {
  return (
    <motion.div
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.95 }}
      // Fixed bounding box so the current player's extra labels don't spill out
      // and push neighbouring cards off their ring position. `relative` anchors
      // the absolutely-positioned role hint below the avatar without expanding
      // the layout box.
      className="relative flex flex-col items-center gap-1.5 w-16 sm:w-20"
    >
      {/* Avatar — smaller on mobile */}
      <motion.div
        className={`w-12 h-12 sm:w-16 sm:h-16 rounded-full flex items-center justify-center font-bold text-sm sm:text-lg border-[3px] sm:border-4 transition-all relative overflow-hidden ${
          player.status === 'disconnected'
            ? 'border-gray-600 bg-gradient-to-br from-gray-600 to-gray-700 opacity-50'
            : isCurrentPlayer
            ? 'border-yellow-400 bg-gradient-to-br from-yellow-400 to-yellow-500 shadow-lg shadow-yellow-400/50'
            : player.isBot
            ? 'border-indigo-500 bg-gradient-to-br from-indigo-600 to-purple-700'
            : 'border-gray-600 bg-gradient-to-br from-blue-400 to-purple-400'
        }`}
      >
        {player.isBot
          ? '🤖'
          : player.avatar
            ? <img src={player.avatar} alt={player.name} className="w-full h-full rounded-full object-cover" />
            : player.name.charAt(0).toUpperCase()
        }

        {/* Leader crown */}
        {isLeader && (
          <motion.div
            initial={{ scale: 0, y: -5 }}
            animate={{ scale: 1, y: 0 }}
            className="absolute -top-3 left-1/2 -translate-x-1/2 pointer-events-none"
          >
            <Crown size={16} className="text-yellow-400 drop-shadow-md" />
          </motion.div>
        )}

        {/* Quest team marker */}
        {isOnQuestTeam && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-1.5 -right-1.5 bg-blue-600 rounded-full p-0.5 pointer-events-none"
          >
            <Sword size={10} className="text-white" />
          </motion.div>
        )}

        {/* Disconnected marker */}
        {player.status === 'disconnected' && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -bottom-1.5 -left-1.5 bg-red-700 rounded-full p-0.5 pointer-events-none"
          >
            <WifiOff size={10} className="text-white" />
          </motion.div>
        )}

        {/* Vote indicator */}
        {hasVoted && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className={`absolute -bottom-1.5 -right-1.5 rounded-full p-0.5 pointer-events-none ${voted === undefined ? 'bg-gray-700' : 'bg-white'}`}
          >
            {voted === undefined ? (
              // Vote direction unknown — just show a neutral "voted" checkmark
              <span className="block text-[10px] leading-none text-gray-300 font-bold px-0.5 py-0.5">✓</span>
            ) : voted ? (
              <ThumbsUp size={12} className="text-green-500" />
            ) : (
              <ThumbsDown size={12} className="text-red-500" />
            )}
          </motion.div>
        )}
      </motion.div>

      {/* Player name — bounded so long names don't widen the card */}
      <p className={`font-bold text-[11px] sm:text-xs text-center w-full truncate ${player.status === 'disconnected' ? 'text-gray-500' : 'text-white'}`}>
        {player.name}
      </p>

      {/* Own-role hint — absolutely positioned so it doesn't extend the card's
          layout box (prevents pushing adjacent ring positions). */}
      {isCurrentPlayer && player.role && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute left-1/2 top-full mt-1 -translate-x-1/2 flex flex-col items-center gap-0.5 pointer-events-none"
        >
          <span className="text-[10px] sm:text-xs font-semibold bg-yellow-600/90 text-white px-2 py-0.5 rounded-full whitespace-nowrap shadow-md">
            {ROLE_NAMES[player.role] ?? player.role}
          </span>
          {player.team && (
            <span className="text-[10px] text-gray-300 bg-black/60 px-2 py-0.5 rounded-full whitespace-nowrap">
              {player.team === 'good' ? '⚔️ 好人' : '👹 邪惡'}
            </span>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
