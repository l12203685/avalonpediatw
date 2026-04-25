import { Room, Player } from '@avalon/shared';
import { Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import audioService from '../services/audio';
import { VOTE_IMAGES } from '../utils/avalonAssets';

// Base seconds for the team-vote phase. Matches server VOTE_TIMEOUT_MS at 1x.
const VOTE_BASE_SECONDS = 90;

interface VotePanelProps {
  room: Room;
  currentPlayer: Player;
  onVote: (approve: boolean) => void;
  isLoading?: boolean;
}

/**
 * Sticky-bottom inline action toolbar for the team-proposal vote (#107 Edward
 * 2026-04-25 「派票跟黑白球不要一直跳視窗出來」). Replaces the center-column
 * full-page modal-style VotePanel so players can read the board + scoresheet
 * while voting; thumb-reach Approve/Reject buttons stay docked at the bottom.
 *
 * Why sticky: the previous big card pushed every other UI element below it,
 * making the screen scroll up/down on every phase transition. Anchoring it to
 * the viewport bottom (mirrors `QuestTeamToolbar`) keeps the viewport stable.
 */
export default function VotePanel({
  room,
  currentPlayer,
  onVote,
  isLoading = false,
}: VotePanelProps): JSX.Element {
  const { t } = useTranslation(['game']);
  // Derive per-room effective timer: base * multiplier. `null` = unlimited.
  const multiplier = room.timerConfig?.multiplier ?? 1;
  const isUnlimited = multiplier === null;
  const effectiveSeconds = isUnlimited ? 0 : Math.round(VOTE_BASE_SECONDS * (multiplier as number));

  const [timeLeft, setTimeLeft] = useState(effectiveSeconds);
  const playerCount = Object.keys(room.players).length;
  const votedCount = Object.keys(room.votes).length;
  const hasVoted = room.votes[currentPlayer.id] !== undefined;
  // Use questTeam + failCount as a key to reset timer on new vote round
  const voteRoundKey = room.questTeam.join(',') + ':' + room.failCount;

  // Reset timer when a new vote round starts
  useEffect(() => {
    setTimeLeft(effectiveSeconds);
  }, [voteRoundKey, effectiveSeconds]);

  // 投票倒計時 (skip when unlimited)
  useEffect(() => {
    if (isUnlimited) return;
    if (!hasVoted && timeLeft > 0) {
      const timer = setTimeout(() => setTimeLeft(t => Math.max(0, t - 1)), 1000);
      return () => clearTimeout(timer);
    }
  }, [timeLeft, hasVoted, isUnlimited]);

  // 時間警告
  const isUrgent = !isUnlimited && timeLeft < 10;
  const progressPct = effectiveSeconds > 0
    ? Math.max(0, Math.min(100, (timeLeft / effectiveSeconds) * 100))
    : 0;
  const votedPct = playerCount > 0 ? (votedCount / playerCount) * 100 : 0;

  // Keyboard shortcuts: Y/1 = approve, N/2 = reject
  useEffect(() => {
    if (hasVoted || isLoading) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'y' || e.key === 'Y' || e.key === '1') {
        audioService.playSound('vote');
        onVote(true);
      } else if (e.key === 'n' || e.key === 'N' || e.key === '2') {
        audioService.playSound('vote');
        onVote(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasVoted, isLoading, onVote]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 40 }}
      className="fixed bottom-0 inset-x-0 z-40 max-h-[30dvh] overflow-y-auto bg-gradient-to-t from-black/95 via-black/90 to-black/75 backdrop-blur-md border-t-2 border-yellow-600 shadow-[0_-6px_20px_rgba(0,0,0,0.55)] pb-safe"
      role="region"
      aria-label={t('game:votePanel.title')}
    >
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex flex-col gap-2">
        {/* Top strip — vote-token icon + voted progress + countdown side-by-side.
            Edward 2026-04-25 image batch: painted vote-token.png anchors the
            label so players associate "投票時間" with the same ballot icon used
            in the VoteRevealOverlay. Hidden on very narrow viewports to keep
            the progress bar dominant. */}
        <div className="flex items-center gap-2">
          <img
            src={VOTE_IMAGES.token}
            alt=""
            aria-hidden="true"
            className="hidden sm:inline-block w-5 h-5 object-contain flex-shrink-0 drop-shadow"
            draggable={false}
            loading="lazy"
          />
          <span className="text-[11px] font-semibold text-gray-300 whitespace-nowrap">
            {t('game:votePanel.votedCount', { voted: votedCount, total: playerCount })}
          </span>
          <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
            <motion.div
              animate={{ width: `${votedPct}%` }}
              transition={{ duration: 0.4 }}
              className="h-full bg-gradient-to-r from-avalon-good to-yellow-400"
            />
          </div>
          {isUnlimited ? (
            <span className="text-[11px] font-semibold text-blue-300 whitespace-nowrap flex items-center gap-1">
              <Clock size={12} />
              {t('game:votePanel.unlimitedTimer')}
            </span>
          ) : (
            <span className={`text-[11px] font-semibold whitespace-nowrap flex items-center gap-1 ${isUrgent ? 'text-red-300' : 'text-amber-300'}`}>
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
              className={`h-full rounded-full ${isUrgent ? 'bg-gradient-to-r from-red-500 to-red-400' : 'bg-gradient-to-r from-amber-500 to-yellow-400'}`}
            />
          </div>
        )}

        {/* Action row — buttons OR voted-status. Edward 2026-04-25 image batch:
            replace lucide ThumbsUp/Down icons with the painted yes/no banner art
            so the Approve / Reject buttons share visual language with the
            VoteRevealOverlay. Image size matches the previous icon footprint
            (~22px) so button height doesn't shift. */}
        {!hasVoted ? (
          <div className="flex items-center gap-2 sm:gap-3">
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => { audioService.playSound('vote'); onVote(true); }}
              disabled={isLoading}
              className="flex-1 flex items-center justify-center gap-2 bg-avalon-good hover:bg-avalon-good/90 disabled:opacity-50 text-white font-bold py-2.5 px-3 sm:px-6 rounded-lg transition-all text-sm sm:text-base"
            >
              <img
                src={VOTE_IMAGES.yes}
                alt=""
                aria-hidden="true"
                className="w-6 h-6 object-contain drop-shadow-md"
                draggable={false}
              />
              {isLoading ? t('game:votePanel.submitting') : t('game:votePanel.approveBtn')}
            </motion.button>

            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => { audioService.playSound('vote'); onVote(false); }}
              disabled={isLoading}
              className="flex-1 flex items-center justify-center gap-2 bg-avalon-evil hover:bg-avalon-evil/90 disabled:opacity-50 text-white font-bold py-2.5 px-3 sm:px-6 rounded-lg transition-all text-sm sm:text-base"
            >
              <img
                src={VOTE_IMAGES.no}
                alt=""
                aria-hidden="true"
                className="w-6 h-6 object-contain drop-shadow-md"
                draggable={false}
              />
              {isLoading ? t('game:votePanel.submitting') : t('game:votePanel.rejectBtn')}
            </motion.button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-1.5">
            {/* Edward 2026-04-25 emoji→image: 黑白球圖取代字串內 👍/👎,
                與 #154 視覺統一。i18n 字串已剝離 emoji，在此前置圖片。 */}
            <img
              src={room.votes[currentPlayer.id] ? VOTE_IMAGES.yes : VOTE_IMAGES.no}
              alt=""
              aria-hidden="true"
              className="w-4 h-4 object-contain flex-shrink-0"
              draggable={false}
            />
            <span className="text-sm text-gray-200 font-semibold">
              {room.votes[currentPlayer.id] ? t('game:votePanel.yourVoteApprove') : t('game:votePanel.yourVoteReject')}
            </span>
            <span className="text-xs text-gray-500">·</span>
            <span className="text-xs text-gray-400">{t('game:votePanel.waitingOthers')}</span>
          </div>
        )}

        {/* Shortcut hint — desktop only */}
        {!hasVoted && (
          <p className="hidden sm:block text-center text-[10px] text-gray-600">
            <Trans i18nKey="game:votePanel.shortcuts" components={{ approve: <kbd className="bg-gray-800 px-1 rounded" />, reject: <kbd className="bg-gray-800 px-1 rounded" /> }} />
          </p>
        )}
      </div>
    </motion.div>
  );
}
