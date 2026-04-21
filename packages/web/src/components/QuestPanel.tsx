import { Room, Player } from '@avalon/shared';
import { CheckCircle, XCircle, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { submitQuestVote } from '../services/socket';
import audioService from '../services/audio';
import { seatPrefix } from '../utils/seatDisplay';

// Base seconds for the quest-vote phase. Matches server QUEST_TIMEOUT_MS at 1x.
const QUEST_BASE_SECONDS = 30;

interface QuestPanelProps {
  room: Room;
  currentPlayer: Player;
  isLoading?: boolean;
}

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

  const handleVote = async (vote: 'success' | 'fail') => {
    if (!isInTeam || isSubmitting || hasVoted) return;
    // Client-side guard: good-side can only vote success
    if (isGoodSide && vote === 'fail') return;

    setIsSubmitting(true);
    try {
      audioService.playSound('vote');
      submitQuestVote(room.id, currentPlayer.id, vote);
      setHasVoted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Keyboard shortcuts: S = success, F = fail (fail only for evil side)
  useEffect(() => {
    if (!isInTeam || hasVoted || isSubmitting) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 's' || e.key === 'S') handleVote('success');
      else if ((e.key === 'f' || e.key === 'F') && !isGoodSide) handleVote('fail');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isInTeam, hasVoted, isSubmitting, isGoodSide]);

  if (!isInTeam) {
    const votedCount = room.questVotedCount ?? 0;
    const teamSize = room.questTeam.length;
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/50 border-2 border-blue-600 rounded-lg p-8 text-center space-y-4"
      >
        <h2 className="text-2xl font-bold text-white">{t('game:questPanel.notInTeamTitle')}</h2>
        <p className="text-gray-300">
          <Trans
            i18nKey="game:questPanel.notInTeamVoted"
            values={{ voted: votedCount, total: teamSize }}
            components={{ count: <span className="text-blue-400 font-bold" /> }}
          />
        </p>
        <div className="w-full max-w-xs mx-auto h-2 bg-gray-700 rounded-full overflow-hidden">
          <motion.div
            animate={{ width: `${teamSize > 0 ? (votedCount / teamSize) * 100 : 0}%` }}
            className="h-full bg-gradient-to-r from-blue-500 to-blue-400"
          />
        </div>
        <p className="text-sm text-gray-500">
          {t('game:questPanel.notInTeamWaiting')}
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/50 border-2 border-blue-600 rounded-lg p-8 space-y-6"
    >
      {/* 標題 */}
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-2">{t('game:questPanel.title')}</h2>
        <p className="text-gray-300">{t('game:questPanel.subtitle')}</p>
      </div>

      {/* 計時器 */}
      <div className="flex justify-center">
        {isUnlimited ? (
          <div className="flex items-center gap-2 px-4 py-2 rounded-full font-bold bg-blue-500/30 text-blue-200 border border-blue-500/40">
            <Clock size={18} />
            {t('game:questPanel.unlimitedTimer')}
          </div>
        ) : (
          <motion.div
            animate={{
              backgroundColor: isUrgent ? '#ef4444' : '#3b82f6',
              color: '#fff',
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-full font-bold"
          >
            <Clock size={18} />
            {timeLeft}s
          </motion.div>
        )}
      </div>

      {/* ⏱ Quest countdown bar — matches server QUEST_TIMEOUT, auto-success fallback after 0 */}
      {!isUnlimited && effectiveSeconds > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] font-semibold">
            <span className={isUrgent ? 'text-red-300' : 'text-gray-500'}>
              {t('game:questPanel.countdownLabel')}
            </span>
            <span className={isUrgent ? 'text-red-300 font-bold' : 'text-gray-500'}>
              {timeLeft}s / {effectiveSeconds}s
            </span>
          </div>
          <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
            <motion.div
              animate={{ width: `${Math.max(0, Math.min(100, (timeLeft / effectiveSeconds) * 100))}%` }}
              transition={{ duration: 0.6, ease: 'linear' }}
              className={`h-full rounded-full ${isUrgent ? 'bg-gradient-to-r from-red-500 to-red-400' : 'bg-gradient-to-r from-blue-500 to-blue-400'}`}
            />
          </div>
        </div>
      )}

      {/* 隊伍成員列表 — seat# prefix so "#3 Guest_444" format (#93) */}
      <div className="space-y-2">
        <p className="text-gray-300 text-sm font-semibold">{t('game:questPanel.teamLabel')}</p>
        <div className="grid grid-cols-2 gap-2">
          {room.questTeam.map((memberId) => (
            <div
              key={memberId}
              className={`p-2 rounded-lg text-sm font-semibold ${
                memberId === currentPlayer.id
                  ? 'bg-yellow-500/30 border border-yellow-400 text-yellow-300'
                  : 'bg-blue-500/20 border border-blue-400 text-blue-300'
              }`}
            >
              {seatPrefix(memberId, room.players)} {room.players[memberId].name}
              {memberId === currentPlayer.id && t('game:questPanel.youSuffix')}
            </div>
          ))}
        </div>
      </div>

      {/* 投票按鈕 */}
      {hasVoted ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-4 text-blue-400 font-semibold"
        >
          {t('game:questPanel.submitted')}
        </motion.div>
      ) : (
        <div className="flex justify-center gap-6">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleVote('success')}
            disabled={isSubmitting || isLoading}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
          >
            <CheckCircle size={20} />
            {isSubmitting ? t('game:questPanel.submitting') : t('game:questPanel.successBtn')}
          </motion.button>

          {!isGoodSide && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => handleVote('fail')}
              disabled={isSubmitting || isLoading}
              className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-lg transition-all"
            >
              <XCircle size={20} />
              {isSubmitting ? t('game:questPanel.submitting') : t('game:questPanel.failBtn')}
            </motion.button>
          )}
        </div>
      )}

      {/* 提示信息 */}
      {!hasVoted && (
        <div className="text-center text-sm text-gray-400 space-y-1">
          <p>
            {room.questTeam.length === 1
              ? t('game:questPanel.votingCount_one')
              : t('game:questPanel.votingCount_other', { count: room.questTeam.length })}
          </p>
          {isGoodSide ? (
            <p className="text-xs text-gray-600">
              <Trans i18nKey="game:questPanel.goodSideHint" components={{ key: <kbd className="bg-gray-800 px-1 rounded" /> }} />
            </p>
          ) : (
            <p className="text-xs text-gray-600">
              <Trans i18nKey="game:questPanel.evilSideHint" components={{ success: <kbd className="bg-gray-800 px-1 rounded" />, fail: <kbd className="bg-gray-800 px-1 rounded" /> }} />
            </p>
          )}
        </div>
      )}
    </motion.div>
  );
}
