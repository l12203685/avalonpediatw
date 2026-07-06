import { Room, Player } from '@avalon/shared';
import { CheckCircle, XCircle, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { submitQuestVote } from '../services/socket';
import audioService from '../services/audio';

// Base seconds for the quest-vote phase. Matches server QUEST_TIMEOUT_MS at 1x.
const QUEST_BASE_SECONDS = 30;

interface QuestPanelProps {
  room: Room;
  currentPlayer: Player;
  isLoading?: boolean;
}

/**
 * Sticky-bottom inline action toolbar for the quest (mission) vote (#107
 * Edward 2026-04-25 「派票跟黑白球不要一直跳視窗出來」). Same shape as the
 * #107 VotePanel — anchors to the viewport bottom so the player ring +
 * scoresheet stay in view; thumb-reach Success/Fail buttons stay docked.
 *
 * For non-team viewers we render a thin inline waiting strip (still sticky)
 * so they get a tiny progress hint without a full overlay.
 */
export default function QuestPanel({
  room,
  currentPlayer,
  isLoading = false,
}: QuestPanelProps): JSX.Element {
  const { t } = useTranslation(['game']);
  // Derive per-room effective timer: base * multiplier. `null` = unlimited.
  const multiplier = room.timerConfig?.multiplier ?? 1;
  const isUnlimited = multiplier === null;
  const effectiveSeconds = isUnlimited ? 0 : Math.round(QUEST_BASE_SECONDS * (multiplier as number));

  const [timeLeft, setTimeLeft] = useState(effectiveSeconds);
  const isInTeam = room.questTeam.includes(currentPlayer.id);
  const isGoodSide = currentPlayer.team === 'good';
  // "Oberon must fail" house rule: when the host-enabled `oberonAlwaysFail`
  // flag is on AND the viewer is Oberon, the UI must show only the fail
  // button (success is not a legal choice — server will coerce anyway,
  // but mirroring the rule in the UI prevents confusion and mis-clicks).
  const oberonMustFail = Boolean(
    (room.roleOptions as unknown as Record<string, boolean>)?.oberonAlwaysFail
    && currentPlayer.role === 'oberon',
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasVoted, setHasVoted] = useState(false);

  // 任務倒計時 (skip when unlimited)
  useEffect(() => {
    if (isUnlimited) return;
    if (timeLeft > 0) {
      const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [timeLeft, isUnlimited]);

  // 時間警告
  const isUrgent = !isUnlimited && timeLeft < 10;
  const progressPct = effectiveSeconds > 0
    ? Math.max(0, Math.min(100, (timeLeft / effectiveSeconds) * 100))
    : 0;

  const handleVote = async (vote: 'success' | 'fail') => {
    if (!isInTeam || isSubmitting || hasVoted) return;
    // Client-side guard: good-side can only vote success
    if (isGoodSide && vote === 'fail') return;
    // "Oberon must fail" guard: swallow any stray success calls when the
    // rule is on. Server coerces anyway, but this keeps the UI honest.
    if (oberonMustFail && vote === 'success') return;

    setIsSubmitting(true);
    try {
      audioService.playSound('vote');
      submitQuestVote(room.id, currentPlayer.id, vote);
      setHasVoted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Keyboard shortcuts: S = success, F = fail (fail only for evil side).
  // When Oberon-must-fail is on, `S` is intentionally ignored so the only
  // legal key matches the only rendered button.
  useEffect(() => {
    if (!isInTeam || hasVoted || isSubmitting) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === 's' || e.key === 'S') && !oberonMustFail) handleVote('success');
      else if ((e.key === 'f' || e.key === 'F') && !isGoodSide) handleVote('fail');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isInTeam, hasVoted, isSubmitting, isGoodSide, oberonMustFail]);

  // Non-team viewers: thin sticky waiting strip (no buttons).
  if (!isInTeam) {
    const votedCount = room.questVotedCount ?? 0;
    const teamSize = room.questTeam.length;
    const teamPct = teamSize > 0 ? (votedCount / teamSize) * 100 : 0;
    return (
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        className="fixed bottom-0 inset-x-0 z-40 max-h-[30dvh] overflow-y-auto bg-gradient-to-t from-black/95 via-black/90 to-black/75 backdrop-blur-md border-t-2 border-blue-600 shadow-[0_-6px_20px_rgba(0,0,0,0.55)] pb-safe"
      >
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 flex items-center gap-3">
          <span className="text-sm font-semibold text-blue-200 whitespace-nowrap">
            {t('game:questPanel.notInTeamTitle')}
          </span>
          <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
            <motion.div
              animate={{ width: `${teamPct}%` }}
              className="h-full bg-gradient-to-r from-blue-500 to-blue-400"
            />
          </div>
          <span className="text-[11px] font-semibold text-blue-300 whitespace-nowrap">
            <Trans
              i18nKey="game:questPanel.notInTeamVoted"
              values={{ voted: votedCount, total: teamSize }}
              components={{ count: <span className="text-blue-400 font-bold" /> }}
            />
          </span>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 40 }}
      className="fixed bottom-0 inset-x-0 z-40 max-h-[30dvh] overflow-y-auto bg-gradient-to-t from-black/95 via-black/90 to-black/75 backdrop-blur-md border-t-2 border-blue-600 shadow-[0_-6px_20px_rgba(0,0,0,0.55)] pb-safe"
      role="region"
      aria-label={t('game:questPanel.title')}
    >
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex flex-col gap-2">
        {/* Top strip — title + countdown */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-blue-200 whitespace-nowrap">
            {t('game:questPanel.title')}
          </span>
          <span className="hidden sm:inline text-[11px] text-blue-100/80 truncate flex-1">
            {t('game:questPanel.subtitle')}
          </span>
          {isUnlimited ? (
            <span className="text-[11px] font-semibold text-blue-300 whitespace-nowrap flex items-center gap-1">
              <Clock size={12} />
              {t('game:questPanel.unlimitedTimer')}
            </span>
          ) : (
            <span className={`text-[11px] font-semibold whitespace-nowrap flex items-center gap-1 ${isUrgent ? 'text-red-300' : 'text-blue-300'}`}>
              <Clock size={12} />
              {timeLeft}s / {effectiveSeconds}s
            </span>
          )}
        </div>

        {/* Countdown bar — only when timed */}
        {!isUnlimited && effectiveSeconds > 0 && (
          <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
            <motion.div
              animate={{ width: `${progressPct}%` }}
              transition={{ duration: 0.6, ease: 'linear' }}
              className={`h-full rounded-full ${isUrgent ? 'bg-gradient-to-r from-red-500 to-red-400' : 'bg-gradient-to-r from-blue-500 to-blue-400'}`}
            />
          </div>
        )}

        {/* Action row — vote buttons OR submitted status */}
        {hasVoted ? (
          <div className="flex items-center justify-center py-1.5">
            <span className="text-sm text-blue-300 font-semibold">
              {t('game:questPanel.submitted')}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 sm:gap-3">
            {!oberonMustFail && (
              <motion.button
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => handleVote('success')}
                disabled={isSubmitting || isLoading}
                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold py-2.5 px-3 sm:px-6 rounded-lg transition-all text-sm sm:text-base"
              >
                <CheckCircle size={18} />
                {isSubmitting ? t('game:questPanel.submitting') : t('game:questPanel.successBtn')}
              </motion.button>
            )}

            {!isGoodSide && (
              <motion.button
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => handleVote('fail')}
                disabled={isSubmitting || isLoading}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-2.5 px-3 sm:px-6 rounded-lg transition-all text-sm sm:text-base"
              >
                <XCircle size={18} />
                {isSubmitting ? t('game:questPanel.submitting') : t('game:questPanel.failBtn')}
              </motion.button>
            )}
          </div>
        )}

        {/* Hint — desktop only */}
        {!hasVoted && (
          <div className="hidden sm:block text-center text-[10px] text-gray-500">
            {oberonMustFail ? (
              <span className="text-amber-400">{t('game:questPanel.oberonMustFailHint')}</span>
            ) : isGoodSide ? (
              <Trans i18nKey="game:questPanel.goodSideHint" components={{ key: <kbd className="bg-gray-800 px-1 rounded" /> }} />
            ) : (
              <Trans i18nKey="game:questPanel.evilSideHint" components={{ success: <kbd className="bg-gray-800 px-1 rounded" />, fail: <kbd className="bg-gray-800 px-1 rounded" /> }} />
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
