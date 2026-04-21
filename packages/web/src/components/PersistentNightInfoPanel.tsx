/**
 * PersistentNightInfoPanel — always-available role + night-info badge.
 *
 * Fixes the "resources disappear after one look" pain: the one-shot
 * RoleRevealModal used to be the only place to see per-player night info
 * (Merlin's evil list, Percival's Merlin-candidate pair, evil team roster,
 * etc.). Once dismissed, players had no way to re-check without clicking a
 * secondary button they didn't always notice.
 *
 * This panel docks to the bottom-right corner in collapsed form (icon +
 * role name) and expands inline when clicked to show the full per-viewer
 * night knowledge. Data is derived client-side from the current room +
 * viewer role, so it stays in sync with the server-sanitised payload and
 * never leaks other players' secrets.
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Room, Player, Role } from '@avalon/shared';
import { ChevronDown, ChevronUp, Eye, EyeOff, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ROLE_INFO, getKnowledgeList, getKnowledgeLabel } from '../utils/roleKnowledge';

interface PersistentNightInfoPanelProps {
  room: Room;
  currentPlayer: Player;
}

export default function PersistentNightInfoPanel({
  room,
  currentPlayer,
}: PersistentNightInfoPanelProps): JSX.Element | null {
  const { t } = useTranslation(['game']);
  const [expanded, setExpanded] = useState(false);

  const role = currentPlayer.role as Role | null;
  if (!role) return null;

  const info = ROLE_INFO[role] ?? ROLE_INFO.loyal;
  const knowledgeList = getKnowledgeList(role, room, currentPlayer);
  const knowledgeLabel = getKnowledgeLabel(role);
  const isEvil = info.team === 'evil';
  const hasNightInfo = role !== 'loyal' && role !== 'oberon';

  // Positioned at bottom-left but lifted above the FloatingControls FAB (which
  // sits at bottom-6 left-6 with a ~56px button). Stacking the night-info
  // panel above it keeps both accessible without tap-target collisions.
  return (
    <div className="fixed bottom-20 left-4 z-40 max-w-[calc(100vw-2rem)] sm:max-w-xs">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className={`bg-gradient-to-br ${info.bg} border-2 ${info.border} rounded-xl shadow-2xl overflow-hidden backdrop-blur-sm`}
      >
        {/* Collapsed header — always visible */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-black/20 transition-colors"
          aria-expanded={expanded}
        >
          <span className="text-2xl flex-shrink-0">{info.icon}</span>
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-black truncate ${info.color}`}>{info.name}</p>
            <p className="text-[10px] text-gray-300 truncate">
              {isEvil ? t('game:nightInfo.evil') : t('game:nightInfo.good')}
              {hasNightInfo && (
                <span className="ml-1.5 opacity-70">{t('game:nightInfo.clickToView')}</span>
              )}
            </p>
          </div>
          {expanded ? (
            <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
          ) : (
            <ChevronUp size={14} className="text-gray-400 flex-shrink-0" />
          )}
        </button>

        {/* Expanded body — knowledge + reminder */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3 space-y-2">
                {/* Knowledge label */}
                <div className="flex items-center gap-1.5 pt-1">
                  {hasNightInfo ? (
                    <Eye size={12} className={info.color} />
                  ) : (
                    <EyeOff size={12} className="text-gray-500" />
                  )}
                  <p className={`text-[10px] font-bold uppercase tracking-wider ${info.color}`}>
                    {knowledgeLabel}
                  </p>
                </div>

                {/* Knowledge list (per-viewer only, never leaks other roles) */}
                {hasNightInfo ? (
                  <ul className="space-y-1">
                    {knowledgeList.map((item, i) => (
                      <li
                        key={i}
                        className={`flex items-center gap-1.5 text-[11px] font-semibold rounded px-2 py-1 ${
                          isEvil
                            ? 'bg-red-900/40 text-red-200'
                            : 'bg-blue-900/40 text-blue-200'
                        }`}
                      >
                        <span>{isEvil ? '👹' : '✨'}</span>
                        <span className="truncate">{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-gray-400 italic">{knowledgeList[0]}</p>
                )}

                {/* Role reminder */}
                <div className="pt-1 border-t border-white/10">
                  <div className="flex items-center gap-1.5 mb-1">
                    <BookOpen size={10} className="text-gray-400" />
                    <p className="text-[9px] text-gray-400 uppercase tracking-wider">{t('game:nightInfo.hintLabel')}</p>
                  </div>
                  <p className="text-[10px] text-gray-300 leading-snug">{info.knowledge}</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
