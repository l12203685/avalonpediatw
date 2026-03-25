import { Player } from '@avalon/shared';
import { motion } from 'framer-motion';
import { ThumbsUp, ThumbsDown } from 'lucide-react';

interface PlayerCardProps {
  player: Player;
  isCurrentPlayer: boolean;
  hasVoted: boolean;
  voted?: boolean;
}

export default function PlayerCard({
  player,
  isCurrentPlayer,
  hasVoted,
  voted,
}: PlayerCardProps): JSX.Element {
  return (
    <motion.div
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.95 }}
      className="flex flex-col items-center gap-2"
    >
      {/* 玩家頭像 */}
      <motion.div
        className={`w-20 h-20 rounded-full flex items-center justify-center font-bold text-lg border-4 transition-all relative ${
          isCurrentPlayer
            ? 'border-yellow-400 bg-gradient-to-br from-yellow-400 to-yellow-500 shadow-lg shadow-yellow-400/50'
            : 'border-gray-600 bg-gradient-to-br from-blue-400 to-purple-400'
        }`}
      >
        {player.name.charAt(0).toUpperCase()}

        {/* 投票指示器 */}
        {hasVoted && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -bottom-2 -right-2 bg-white rounded-full p-1"
          >
            {voted ? (
              <ThumbsUp size={16} className="text-green-500" />
            ) : (
              <ThumbsDown size={16} className="text-red-500" />
            )}
          </motion.div>
        )}
      </motion.div>

      {/* 玩家名字 */}
      <p className="font-bold text-white text-sm text-center max-w-20 truncate">
        {player.name}
      </p>

      {/* 角色提示（只有玩家自己可以看） */}
      {isCurrentPlayer && player.role && (
        <motion.p
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-xs font-semibold bg-yellow-600/80 text-white px-3 py-1 rounded-full"
        >
          {player.role.toUpperCase()}
        </motion.p>
      )}

      {/* 隊伍提示 */}
      {isCurrentPlayer && player.team && (
        <p className="text-xs text-gray-400">
          Team: {player.team === 'good' ? '⚔️ Good' : '👹 Evil'}
        </p>
      )}
    </motion.div>
  );
}
