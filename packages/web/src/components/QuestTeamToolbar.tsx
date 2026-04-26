import { AVALON_CONFIG, Room } from '@avalon/shared';
import { motion } from 'framer-motion';
import { Shield, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { selectQuestTeam } from '../services/socket';
import { seatOf } from '../utils/seatDisplay';

interface QuestTeamToolbarProps {
  room: Room;
  selectedTeamIds: Set<string>;
  onClear: () => void;
  isSubmitting?: boolean;
  /** Seconds remaining on the leader-AFK countdown (0 when unlimited or elapsed). */
  timer?: number;
  /** Total seconds at the start of this countdown; used to draw the progress bar. */
  timerTotal?: number;
}

/**
 * Sticky-bottom toolbar that replaces the old center TeamSelectionPanel modal
 * (#83 Phase 1). Leader-only — the caller decides when to render it. Shows:
 *   - 已選 N/M progress
 *   - countdown bar (hidden in unlimited-timer rooms)
 *   - 清空 button (disabled when nothing picked yet)
 *   - 確認任務隊伍 button (disabled until N === M)
 *
 * Picking is done by clicking rail `PlayerCard`s; this toolbar only reports
 * progress and submits. When the server auto-fills on AFK timeout
 * (commit 4812624), this toolbar just unmounts — no teardown needed.
 */
export default function QuestTeamToolbar({
  room,
  selectedTeamIds,
  onClear,
  isSubmitting = false,
  timer,
  timerTotal,
}: QuestTeamToolbarProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const playerCount = Object.keys(room.players).length;
  const config = AVALON_CONFIG[playerCount];
  const expectedTeamSize = config?.questTeams[room.currentRound - 1] ?? 0;
  const selected = selectedTeamIds.size;
  const isFull = selected === expectedTeamSize;

  // Edward 2026-04-26 18:32 spec 9: timer/timerTotal kept on prop signature
  // (RoomPage still passes them) for forward-compat, but the dedicated countdown
  // bar removed below — header `row 2` chip (Clock + teamSelectTimer) is the
  // single source of timer truth. void the locals so TS noUnusedLocals stays
  // clean without breaking the public component contract.
  void timer;
  void timerTotal;

  const handleConfirm = (): void => {
    if (!isFull || isSubmitting) return;
    // Edward 2026-04-25 22:38 GamePage 3-fix #2「遊戲內隊伍照數字大小順序」:
    // submit the team in canonical seat-ascending order (1, 2, ..., 9, 0 where
    // seat 10 displays as "0"), not the order the leader clicked. Server
    // stores `room.questTeam` in submission order, so sorting here propagates
    // to every downstream consumer (ChatPanel system feed, scoresheet,
    // proposed-team chips, replay) without further changes. Plain numeric
    // ascending sort already matches Edward's "1<2<...<9<0" because seat 10
    // is the largest numeric seat — only the *display* renders 10 as "0".
    const ordered = Array.from(selectedTeamIds).sort(
      (a, b) => seatOf(a, room.players) - seatOf(b, room.players),
    );
    selectQuestTeam(room.id, ordered);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 40 }}
      className="fixed bottom-0 inset-x-0 z-40 max-h-[30dvh] overflow-y-auto bg-gradient-to-t from-black/95 via-black/90 to-black/75 backdrop-blur-md border-t-2 border-amber-500 shadow-[0_-6px_20px_rgba(0,0,0,0.55)] pb-safe"
      role="region"
      aria-label={t('game:teamSelect.toolbarSelected', {
        selected,
        total: expectedTeamSize,
      })}
    >
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex flex-col gap-2">
        {/* Edward 2026-04-26 18:32 spec 9「計時器重複顯示」: 砍底部 timer 進度條,
            只留頂端 row 2 (否決+timer+eye) 那處. 頂端 chip 已含 teamSelectTimer
            倒數; 底部本來這條進度條視覺上重複, 直接整段砍.
            (timer / timerTotal props 仍保留 — 未來若改成 sticky-bar mini-indicator
            可重啟而不必改 caller signature.) */}

        {/* Row: progress + clear + confirm */}
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Shield size={18} className="text-yellow-400 flex-shrink-0" fill="#facc15" />
            <span className="text-sm sm:text-base font-bold text-white truncate">
              {t('game:teamSelect.toolbarSelected', {
                selected,
                total: expectedTeamSize,
              })}
            </span>
            <span className="hidden sm:inline text-[11px] text-gray-400 truncate">
              {t('game:teamSelect.shieldHint')}
            </span>
          </div>

          <motion.button
            whileHover={selected > 0 ? { scale: 1.04 } : {}}
            whileTap={selected > 0 ? { scale: 0.96 } : {}}
            onClick={onClear}
            disabled={selected === 0 || isSubmitting}
            className={`flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold border transition-colors ${
              selected > 0 && !isSubmitting
                ? 'border-gray-500 text-gray-200 hover:bg-gray-700/60'
                : 'border-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            <X size={14} />
            {t('game:teamSelect.toolbarClear')}
          </motion.button>

          <motion.button
            whileHover={isFull && !isSubmitting ? { scale: 1.04 } : {}}
            whileTap={isFull && !isSubmitting ? { scale: 0.96 } : {}}
            onClick={handleConfirm}
            disabled={!isFull || isSubmitting}
            className={`px-3 sm:px-5 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-bold transition-all ${
              isFull && !isSubmitting
                ? 'bg-amber-600 hover:bg-amber-700 text-white shadow-lg shadow-amber-500/30'
                : 'bg-gray-700 text-gray-400 cursor-not-allowed opacity-70'
            }`}
          >
            {isSubmitting
              ? t('game:teamSelect.submitting')
              : t('game:teamSelect.toolbarConfirm')}
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}
