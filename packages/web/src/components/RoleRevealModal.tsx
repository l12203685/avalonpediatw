import { motion, AnimatePresence } from 'framer-motion';
import { Room, Player, Role } from '@avalon/shared';
import { X, Eye, EyeOff } from 'lucide-react';

interface RoleRevealModalProps {
  room: Room;
  currentPlayer: Player;
  onClose: () => void;
}

const ROLE_INFO: Record<Role, {
  name: string;
  icon: string;
  team: 'good' | 'evil';
  color: string;
  bg: string;
  border: string;
  description: string;
  knowledge: string;
}> = {
  merlin: {
    name: '梅林 (Merlin)',
    icon: '🧙',
    team: 'good',
    color: 'text-blue-300',
    bg: 'from-blue-900/80 to-blue-800/60',
    border: 'border-blue-500',
    description: '你是好人的精神領袖。你知道誰是邪惡方，但必須隱藏這個秘密。',
    knowledge: '你能看到所有邪惡方成員（除了奧伯龍）。小心刺客的注目！',
  },
  percival: {
    name: '派西維爾 (Percival)',
    icon: '🛡️',
    team: 'good',
    color: 'text-cyan-300',
    bg: 'from-cyan-900/80 to-cyan-800/60',
    border: 'border-cyan-500',
    description: '你是梅林的守護者。你能感知梅林的存在，但莫甘娜也會偽裝。',
    knowledge: '你能看到梅林（及莫甘娜），但無法分辨誰是真正的梅林。',
  },
  loyal: {
    name: '忠臣 (Loyal Servant)',
    icon: '⚔️',
    team: 'good',
    color: 'text-indigo-300',
    bg: 'from-indigo-900/80 to-indigo-800/60',
    border: 'border-indigo-500',
    description: '你是亞瑟王的忠臣。你沒有特殊情報，只能靠邏輯與直覺。',
    knowledge: '你沒有額外資訊。觀察其他玩家的行為來找出邪惡方！',
  },
  assassin: {
    name: '刺客 (Assassin)',
    icon: '🗡️',
    team: 'evil',
    color: 'text-red-300',
    bg: 'from-red-900/80 to-red-800/60',
    border: 'border-red-500',
    description: '你是邪惡方的殺手。好人若贏得3次任務，你有一次機會刺殺梅林反敗為勝。',
    knowledge: '你知道隊友的身分。遊戲結束時，猜出梅林並刺殺他！',
  },
  morgana: {
    name: '莫甘娜 (Morgana)',
    icon: '👑',
    team: 'evil',
    color: 'text-purple-300',
    bg: 'from-purple-900/80 to-purple-800/60',
    border: 'border-purple-500',
    description: '你偽裝成梅林迷惑帕西瓦爾。讓帕西瓦爾無法分辨你和梅林的差異。',
    knowledge: '你知道邪惡方隊友。帕西瓦爾眼中，你看起來像梅林。',
  },
  oberon: {
    name: '奧伯倫 (Oberon)',
    icon: '👻',
    team: 'evil',
    color: 'text-gray-300',
    bg: 'from-gray-900/80 to-gray-800/60',
    border: 'border-gray-500',
    description: '你是隱藏在陰影中的邪惡。你不知道隊友，隊友也不知道你。',
    knowledge: '你不知道其他邪惡方的身分，他們也不知道你。獨自行動，製造混亂。',
  },
};

function getKnowledgeList(role: Role, room: Room, currentPlayer: Player): string[] {
  const players = Object.values(room.players);
  const evilRoles: Role[] = ['assassin', 'morgana', 'oberon'];
  const goodRoles: Role[] = ['merlin', 'percival', 'loyal'];

  switch (role) {
    case 'merlin': {
      // Merlin sees evil players except Oberon
      const evilPlayers = players.filter(
        p => p.id !== currentPlayer.id && evilRoles.includes(p.role ?? 'loyal') && p.role !== 'oberon'
      );
      if (evilPlayers.length === 0) return ['（無邪惡方玩家）'];
      return evilPlayers.map(p => `${p.name} — 邪惡方`);
    }
    case 'percival': {
      // Percival sees Merlin and Morgana (but can't tell apart)
      const merlinLike = players.filter(
        p => p.id !== currentPlayer.id && (p.role === 'merlin' || p.role === 'morgana')
      );
      if (merlinLike.length === 0) return ['（無法感知梅林）'];
      return merlinLike.map(p => `${p.name} — 可能是梅林`);
    }
    case 'assassin':
    case 'morgana': {
      // Evil players see each other (except Oberon)
      const evilTeam = players.filter(
        p => p.id !== currentPlayer.id && evilRoles.includes(p.role ?? 'loyal') && p.role !== 'oberon'
      );
      if (evilTeam.length === 0) return ['（無隊友）'];
      return evilTeam.map(p => `${p.name} — 邪惡隊友`);
    }
    case 'loyal':
    case 'oberon':
    default:
      return ['你沒有特殊情報。'];
  }
}

export default function RoleRevealModal({ room, currentPlayer, onClose }: RoleRevealModalProps): JSX.Element {
  const role = currentPlayer.role as Role;
  const info = ROLE_INFO[role] ?? ROLE_INFO.loyal;
  const knowledgeList = getKnowledgeList(role, room, currentPlayer);
  const isEvil = info.team === 'evil';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.8, y: 40, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.8, y: 40, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className={`relative w-full max-w-md bg-gradient-to-br ${info.bg} border-2 ${info.border} rounded-2xl p-6 shadow-2xl`}
          onClick={e => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>

          {/* Role icon + name */}
          <div className="text-center mb-6">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.1, type: 'spring', stiffness: 400 }}
              className="text-7xl mb-3"
            >
              {info.icon}
            </motion.div>
            <motion.h2
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className={`text-3xl font-black ${info.color}`}
            >
              {info.name}
            </motion.h2>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-bold ${
                isEvil
                  ? 'bg-red-900/60 text-red-300 border border-red-700'
                  : 'bg-blue-900/60 text-blue-300 border border-blue-700'
              }`}
            >
              {isEvil ? '🔴 邪惡方 (Evil)' : '🔵 正義方 (Good)'}
            </motion.div>
          </div>

          {/* Description */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className="bg-black/30 rounded-xl p-4 mb-4"
          >
            <p className="text-gray-200 text-sm leading-relaxed">{info.description}</p>
          </motion.div>

          {/* Knowledge / Special Info */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className={`rounded-xl p-4 mb-6 border ${
              isEvil ? 'bg-red-950/40 border-red-800/50' : 'bg-blue-950/40 border-blue-800/50'
            }`}
          >
            <div className="flex items-center gap-2 mb-3">
              <Eye size={16} className={info.color} />
              <p className={`text-sm font-bold ${info.color}`}>你知道的資訊</p>
            </div>
            {role === 'loyal' || role === 'oberon' ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <EyeOff size={14} />
                <span>{knowledgeList[0]}</span>
              </div>
            ) : (
              <ul className="space-y-2">
                {knowledgeList.map((item, i) => (
                  <motion.li
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.45 + i * 0.08 }}
                    className={`flex items-center gap-2 text-sm font-semibold rounded-lg px-3 py-2 ${
                      isEvil
                        ? 'bg-red-900/40 text-red-200'
                        : 'bg-blue-900/40 text-blue-200'
                    }`}
                  >
                    <span className="text-base">{isEvil ? '👹' : '✨'}</span>
                    {item}
                  </motion.li>
                ))}
              </ul>
            )}
          </motion.div>

          {/* Tip */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="text-xs text-gray-500 text-center mb-4"
          >
            {info.knowledge}
          </motion.p>

          {/* Start button */}
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.65 }}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={onClose}
            className={`w-full font-bold py-3 rounded-xl transition-all ${
              isEvil
                ? 'bg-gradient-to-r from-red-700 to-red-600 hover:from-red-600 hover:to-red-500 text-white'
                : 'bg-gradient-to-r from-blue-700 to-blue-600 hover:from-blue-600 hover:to-blue-500 text-white'
            }`}
          >
            了解！開始遊戲
          </motion.button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
