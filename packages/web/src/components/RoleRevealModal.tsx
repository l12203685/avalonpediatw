import { motion, AnimatePresence } from 'framer-motion';
import { Room, Player, Role } from '@avalon/shared';
import { X, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ROLE_INFO, getKnowledgeList } from '../utils/roleKnowledge';
import RoleAvatar from './RoleAvatar';
import { CampDisc } from './CampDisc';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';

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
  // Edward 2026-04-25 19:40: 角色揭曉頁多顯一行「你是 N家」 — seat 由
  // currentPlayer 在 room.players 的順序計算（與 seatOf util 對齊），
  // 用 displaySeatNumber 把 seat 10 渲為 "0" 維持牌譜慣例。
  const seat = seatOf(currentPlayer.id, room.players);
  const seatLabel = seat > 0 ? displaySeatNumber(seat) : '';

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
          /* Edward 2026-04-27 mobile single-viewport: roles with long knowledge
             lists (mordred sees evil×3, morgana sees evil×2 etc.) can push the
             card past iPhone SE 667px. Cap to 90dvh + scroll the inner card so
             the start button stays reachable without forcing the whole page to
             scroll. */
          className={`relative w-full max-w-md max-h-[90dvh] overflow-y-auto bg-gradient-to-br ${info.bg} border-2 ${info.border} rounded-2xl p-4 sm:p-6 shadow-2xl`}
          onClick={e => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>

          {/* Role avatar + name. Edward 2026-04-25: simplified reveal — keep
              only avatar + name + camp chip + description. The top banner
              shield and the large emoji icon were redundant (avatar already
              represents the role; chip already represents the camp). The
              small painted shield in the camp chip is preserved (#152
              emblem unification). */}
          <div className="text-center mb-3 sm:mb-6">
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1, type: 'spring', stiffness: 400 }}
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
            {seatLabel !== '' && (
              <motion.p
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 }}
                className="mt-1 text-sm font-bold text-yellow-300"
                data-testid="role-reveal-seat"
              >
                {t('game:roleReveal.youAreSeat', { seat: seatLabel })}
              </motion.p>
            )}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className={`inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full text-sm font-bold ${
                isEvil
                  ? 'bg-red-900/60 text-red-300 border border-red-700'
                  : 'bg-blue-900/60 text-blue-300 border border-blue-700'
              }`}
            >
              {/* Edward 2026-04-25 19:40 emoji→lake-disc swap: 陣營 chip 圓盤
                  從 dragon/phoenix shield 換為 lake-yes/lake-no 圓圈, 與全站
                  陣營 vocabulary 統一。 */}
              <CampDisc team={isEvil ? 'evil' : 'good'} className="w-4 h-4" />
              {isEvil ? t('game:roleReveal.evilBadge') : t('game:roleReveal.goodBadge')}
            </motion.div>
          </div>

          {/* Description */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className="bg-black/30 rounded-xl p-3 sm:p-4 mb-3 sm:mb-4"
          >
            <p className="text-gray-200 text-sm leading-relaxed">{info.description}</p>
          </motion.div>

          {/* Knowledge / Special Info */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className={`rounded-xl p-3 sm:p-4 mb-3 sm:mb-6 border ${
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
                    {/* Edward 2026-04-25 19:40 emoji→lake-disc swap: per-line camp glyph
                        uses the lake-yes/lake-no painted disc instead of 👹/✨ emoji. */}
                    <CampDisc team={isEvil ? 'evil' : 'good'} className="w-4 h-4" />
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
            className="text-[11px] sm:text-xs text-gray-500 text-center mb-3 sm:mb-4"
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
