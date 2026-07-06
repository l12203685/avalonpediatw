/**
 * SuspicionBoard — private per-player notes during game
 *
 * Players can mark each other as suspected evil / trusted / neutral.
 * Stored in localStorage, never sent to server.
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Room, Player } from '@avalon/shared';
import { ChevronDown, ChevronUp, ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';

type Suspicion = 'evil' | 'neutral' | 'trusted';

const SUSPICION_STYLE: Record<Suspicion, { emoji: string; bg: string; text: string }> = {
  evil:    { emoji: '👹', bg: 'bg-red-900/50 border-red-600',   text: 'text-red-300' },
  neutral: { emoji: '❓', bg: 'bg-gray-800/50 border-gray-600', text: 'text-gray-400' },
  trusted: { emoji: '✅', bg: 'bg-blue-900/50 border-blue-600',  text: 'text-blue-300' },
};

const CYCLE_ORDER: Suspicion[] = ['neutral', 'trusted', 'evil'];

interface SuspicionBoardProps {
  room: Room;
  currentPlayer: Player;
}

export default function SuspicionBoard({ room, currentPlayer }: SuspicionBoardProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const [expanded, setExpanded] = useState(false);
  const storageKey = `suspicion:${room.id}:${currentPlayer.id}`;

  const statusLabel: Record<Suspicion, string> = {
    evil: t('game:suspicionBoard.statusEvil'),
    neutral: t('game:suspicionBoard.statusNeutral'),
    trusted: t('game:suspicionBoard.statusTrusted'),
  };

  const [suspicions, setSuspicions] = useState<Record<string, Suspicion>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? (JSON.parse(saved) as Record<string, Suspicion>) : {};
    } catch {
      return {};
    }
  });

  // Persist on change
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(suspicions));
    } catch {
      // ignore
    }
  }, [suspicions, storageKey]);

  const cycleSuspicion = (playerId: string) => {
    setSuspicions(prev => {
      const current = prev[playerId] ?? 'neutral';
      const idx = CYCLE_ORDER.indexOf(current);
      const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
      return { ...prev, [playerId]: next };
    });
  };

  const otherPlayers = Object.values(room.players).filter(p => p.id !== currentPlayer.id);
  const evilCount  = otherPlayers.filter(p => (suspicions[p.id] ?? 'neutral') === 'evil').length;
  const trustCount = otherPlayers.filter(p => (suspicions[p.id] ?? 'neutral') === 'trusted').length;

  return (
    <div className="bg-avalon-card/50 border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-700/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ClipboardList size={16} className="text-amber-400" />
          <span className="text-sm font-bold text-gray-300">{t('game:suspicionBoard.headerTitle')}</span>
          <span className="text-xs text-gray-600">{t('game:suspicionBoard.privateLabel')}</span>
          {(evilCount > 0 || trustCount > 0) && (
            <span className="text-xs bg-gray-700 rounded-full px-2 py-0.5 text-gray-400">
              {evilCount > 0 && <span className="text-red-400">{evilCount}👹</span>}
              {evilCount > 0 && trustCount > 0 && ' '}
              {trustCount > 0 && <span className="text-blue-400">{trustCount}✅</span>}
            </span>
          )}
        </div>
        {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-2">
              <p className="text-xs text-gray-600 italic">{t('game:suspicionBoard.hint')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {otherPlayers.map(player => {
                  const status: Suspicion = suspicions[player.id] ?? 'neutral';
                  const cfg = SUSPICION_STYLE[status];
                  return (
                    <motion.button
                      key={player.id}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => cycleSuspicion(player.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-all hover:brightness-110 ${cfg.bg} ${cfg.text}`}
                    >
                      <span className="text-base">{cfg.emoji}</span>
                      <div className="text-left min-w-0">
                        <div className="font-bold truncate">{displaySeatNumber(seatOf(player.id, room.players))}家</div>
                        <div className="opacity-70">{statusLabel[status]}</div>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
