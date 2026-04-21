import { motion, AnimatePresence } from 'framer-motion';
import { Room, Player, Role } from '@avalon/shared';
import { X, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ROLE_INFO, getKnowledgeList } from '../utils/roleKnowledge';
import RoleAvatar from './RoleAvatar';

interface RoleRevealModalProps {
  room: Room;
  currentPlayer: Player;
  onClose: () => void;
}

export default function RoleRevealModal({ room, currentPlayer, onClose }: RoleRevealModalProps): JSX.Element {
  const { t } = useTranslation(['game']);
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

          {/* Role icon + name. Plan #83 Phase 4: add a large RoleAvatar badge
              under the emoji icon so the short-code (梅/派/刺/...) is
              prominent on reveal and matches the rail/night-panel avatars. */}
          <div className="text-center mb-6">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.1, type: 'spring', stiffness: 400 }}
              className="text-7xl mb-3"
            >
              {info.icon}
            </motion.div>
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.15, type: 'spring', stiffness: 400 }}
              className="flex justify-center mb-3"
            >
              <RoleAvatar role={role} size="lg" />
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
              {isEvil ? t('game:roleReveal.evilBadge') : t('game:roleReveal.goodBadge')}
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
              <p className={`text-sm font-bold ${info.color}`}>{t('game:roleReveal.knowledgeTitle')}</p>
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
            {t('game:roleReveal.startBtn')}
          </motion.button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
