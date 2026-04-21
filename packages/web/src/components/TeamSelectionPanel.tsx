import { Room, Player, AVALON_CONFIG } from '@avalon/shared';
import { CheckCircle, Circle, Crown } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { selectQuestTeam } from '../services/socket';

interface TeamSelectionPanelProps {
  room: Room;
  currentPlayer: Player;
  isLoading?: boolean;
  timer?: number;
  /** Total seconds at the start of this countdown (used to draw the progress bar). */
  timerTotal?: number;
}

export default function TeamSelectionPanel({
  room,
  currentPlayer,
  isLoading = false,
  timer,
  timerTotal,
}: TeamSelectionPanelProps): JSX.Element {
  const playerCount = Object.keys(room.players).length;
  const config = AVALON_CONFIG[playerCount];
  const expectedTeamSize = config.questTeams[room.currentRound - 1];

  const { t } = useTranslation(['game']);
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);

  const togglePlayer = (playerId: string) => {
    const newSelection = new Set(selectedPlayers);
    if (newSelection.has(playerId)) {
      newSelection.delete(playerId);
    } else if (newSelection.size < expectedTeamSize) {
      newSelection.add(playerId);
    }
    setSelectedPlayers(newSelection);
  };

  const handleSubmit = async () => {
    if (selectedPlayers.size !== expectedTeamSize) return;

    setIsSubmitting(true);
    try {
      selectQuestTeam(room.id, Array.from(selectedPlayers));
    } finally {
      setIsSubmitting(false);
    }
  };

  const isFull = selectedPlayers.size === expectedTeamSize;
  const isUnlimited = room.timerConfig?.multiplier === null;
  const showCountdown = !isUnlimited && timer !== undefined && (timerTotal ?? 0) > 0;
  const progressPct = showCountdown
    ? Math.max(0, Math.min(100, ((timer ?? 0) / (timerTotal ?? 1)) * 100))
    : 0;
  const isUrgent = showCountdown && (timer ?? 0) <= 20;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/50 border-2 border-amber-600 rounded-lg p-6 sm:p-8 space-y-6"
    >
      {/* 👑 YOU ARE THE LEADER — unmissable banner so solo / AI-room players can't miss their turn */}
      <motion.div
        animate={{ scale: [1, 1.01, 1] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        className="relative overflow-hidden rounded-xl border-2 border-amber-400 bg-gradient-to-r from-amber-600/40 via-yellow-500/30 to-amber-600/40 p-4 sm:p-5 text-center shadow-lg shadow-amber-500/30"
      >
        <div className="flex items-center justify-center gap-3">
          <Crown size={28} className="text-amber-300 drop-shadow-md flex-shrink-0" />
          <h2 className="text-2xl sm:text-3xl font-black text-white tracking-wide">
            {t('game:teamSelect.youAreLeaderBanner')}
          </h2>
          <Crown size={28} className="text-amber-300 drop-shadow-md flex-shrink-0" />
        </div>
        <p className="mt-2 text-amber-100 text-sm sm:text-base font-semibold">
          {t('game:teamSelect.youAreLeaderInstruction', { count: expectedTeamSize })}
        </p>
      </motion.div>

      {/* 標題和信息 */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-3 mb-2 flex-wrap">
          <h3 className="text-xl sm:text-2xl font-bold text-white">{t('game:teamSelect.title')}</h3>
          {isUnlimited ? (
            <span className="text-sm font-bold px-3 py-1 rounded-full bg-blue-900/70 text-blue-200">
              {t('game:teamSelect.unlimitedTimer')}
            </span>
          ) : (
            timer !== undefined && (
              <span className={`text-sm font-bold px-3 py-1 rounded-full ${isUrgent ? 'bg-red-900/70 text-red-100 animate-pulse' : 'bg-gray-800 text-gray-300'}`}>
                {t('game:teamSelect.timer', { seconds: timer })}
              </span>
            )
          )}
        </div>
        <p className="text-gray-300">
          {t('game:teamSelect.subtitle', { count: expectedTeamSize })}
        </p>
      </div>

      {/* ⏱ Countdown progress bar — big and unmissable so players notice they're on the clock */}
      {showCountdown && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs font-semibold">
            <span className={isUrgent ? 'text-red-300' : 'text-gray-400'}>
              {t('game:teamSelect.countdownLabel')}
            </span>
            <span className={isUrgent ? 'text-red-300 font-bold' : 'text-gray-400'}>
              {timer}s / {timerTotal}s
            </span>
          </div>
          <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
            <motion.div
              animate={{ width: `${progressPct}%` }}
              transition={{ duration: 0.6, ease: 'linear' }}
              className={`h-full rounded-full ${isUrgent ? 'bg-gradient-to-r from-red-500 to-red-400' : 'bg-gradient-to-r from-amber-500 to-yellow-400'}`}
            />
          </div>
          {isUrgent ? (
            <p className="text-center text-sm text-red-300 font-bold animate-pulse">
              {t('game:teamSelect.timeoutWarning', { seconds: timer })}
            </p>
          ) : (
            <p className="text-center text-[11px] text-gray-500">
              {t('game:teamSelect.autoSelectHint')}
            </p>
          )}
        </div>
      )}

      {/* 隊伍大小指示 */}
      <div className="flex justify-center">
        <div className="bg-avalon-card/70 rounded-full px-6 py-2">
          <p className="text-white font-bold">
            <Trans
              i18nKey="game:teamSelect.selectedCount"
              values={{ selected: selectedPlayers.size, total: expectedTeamSize }}
              components={{ sel: <span className="text-amber-400" />, total: <span className="text-gray-400" /> }}
            />
          </p>
        </div>
      </div>

      {/* 玩家選擇列表 */}
      <div className="space-y-2">
        <p className="text-gray-300 text-sm font-semibold">{t('game:teamSelect.pickMembersLabel')}</p>
        <div className="grid grid-cols-2 gap-3 max-h-96 overflow-y-auto">
          {Object.entries(room.players).map(([playerId, player]) => {
            const isSelected = selectedPlayers.has(playerId);
            const isYou = playerId === currentPlayer.id;

            return (
              <motion.button
                key={playerId}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => togglePlayer(playerId)}
                disabled={
                  isSubmitting ||
                  isLoading ||
                  (!isSelected && selectedPlayers.size >= expectedTeamSize)
                }
                className={`flex items-center gap-3 p-3 rounded-lg transition-all border-2 ${
                  isSelected
                    ? 'bg-amber-600/40 border-amber-400 text-white'
                    : 'bg-avalon-card/30 border-gray-600 text-gray-300 hover:border-gray-400'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <div className="relative">
                  {isSelected ? (
                    <CheckCircle size={20} className="text-amber-400" />
                  ) : (
                    <Circle size={20} className="text-gray-500" />
                  )}
                </div>
                <span className="font-semibold flex-1 text-left">
                  {player.name}
                  {isYou && t('game:teamSelect.youSuffix')}
                </span>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* 提交按鈕 */}
      <motion.button
        whileHover={isFull && !isSubmitting ? { scale: 1.02 } : {}}
        whileTap={isFull && !isSubmitting ? { scale: 0.98 } : {}}
        onClick={handleSubmit}
        disabled={!isFull || isSubmitting || isLoading}
        className={`w-full font-bold py-3 px-6 rounded-lg transition-all ${
          isFull && !isSubmitting
            ? 'bg-amber-600 hover:bg-amber-700 text-white cursor-pointer'
            : 'bg-gray-600 text-gray-300 cursor-not-allowed opacity-50'
        }`}
      >
        {isSubmitting ? t('game:teamSelect.submitting') : t('game:teamSelect.confirmBtn')}
      </motion.button>

      {/* 幫助文本 */}
      <div className="text-center text-sm text-gray-400">
        <p>
          {isFull
            ? t('game:teamSelect.teamComplete')
            : t(
                expectedTeamSize - selectedPlayers.size === 1
                  ? 'game:teamSelect.moreNeeded_one'
                  : 'game:teamSelect.moreNeeded_other',
                { count: expectedTeamSize - selectedPlayers.size },
              )}
        </p>
      </div>
    </motion.div>
  );
}
