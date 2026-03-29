import { Player } from '@avalon/shared';
import { motion } from 'framer-motion';
import { ThumbsUp, ThumbsDown, Crown, Sword } from 'lucide-react';

const ROLE_NAMES: Record<string, string> = {
  merlin:   '梅林 (Merlin)',
  percival: '派西維爾 (Percival)',
  loyal:    '忠臣 (Loyal Servant)',
  assassin: '刺客 (Assassin)',
  morgana:  '莫甘娜 (Morgana)',
  oberon:   '奧伯倫 (Oberon)',
  mordred:  '莫德雷德 (Mordred)',
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
      className="flex flex-col items-center gap-2"
    >
      {/* 玩家頭像 */}
      <motion.div
        className={`w-20 h-20 rounded-full flex items-center justify-center font-bold text-lg border-4 transition-all relative ${
          isCurrentPlayer
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

        {/* 隊長皇冠 */}
        {isLeader && (
          <motion.div
            initial={{ scale: 0, y: -5 }}
            animate={{ scale: 1, y: 0 }}
            className="absolute -top-3 left-1/2 -translate-x-1/2"
          >
            <Crown size={18} className="text-yellow-400 drop-shadow-md" />
          </motion.div>
        )}

        {/* 任務隊伍標記 */}
        {isOnQuestTeam && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-2 -right-2 bg-blue-600 rounded-full p-1"
          >
            <Sword size={12} className="text-white" />
          </motion.div>
        )}

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
          {ROLE_NAMES[player.role] ?? player.role}
        </motion.p>
      )}

      {/* 隊伍提示 */}
      {isCurrentPlayer && player.team && (
        <p className="text-xs text-gray-400">
          陣營 (Team)：{player.team === 'good' ? '⚔️ 好人 (Good)' : '👹 邪惡 (Evil)'}
        </p>
      )}
    </motion.div>
  );
}
