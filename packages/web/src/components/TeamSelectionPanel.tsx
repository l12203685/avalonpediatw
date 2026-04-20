import { Room, Player, AVALON_CONFIG } from '@avalon/shared';
import { CheckCircle, Circle } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { selectQuestTeam } from '../services/socket';

interface TeamSelectionPanelProps {
  room: Room;
  currentPlayer: Player;
  isLoading?: boolean;
  timer?: number;
}

export default function TeamSelectionPanel({
  room,
  currentPlayer,
  isLoading = false,
  timer,
}: TeamSelectionPanelProps): JSX.Element {
  const playerCount = Object.keys(room.players).length;
  const config = AVALON_CONFIG[playerCount];
  const expectedTeamSize = config.questTeams[room.currentRound - 1];

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

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/50 border-2 border-purple-600 rounded-lg p-8 space-y-6"
    >
      {/* 標題和信息 */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-3 mb-2">
          <h2 className="text-3xl font-bold text-white">👑 選擇任務隊伍 (Select Quest Team)</h2>
          {/* When room is in unlimited-timer mode, show "不計時" instead of countdown. */}
          {room.timerConfig?.multiplier === null ? (
            <span className="text-sm font-bold px-3 py-1 rounded-full bg-blue-900/70 text-blue-200">
              ⏱ 不計時
            </span>
          ) : (
            timer !== undefined && (
              <span className={`text-sm font-bold px-3 py-1 rounded-full ${timer < 20 ? 'bg-red-900/70 text-red-300' : 'bg-gray-800 text-gray-400'}`}>
                ⏱ {timer}s
              </span>
            )
          )}
        </div>
        <p className="text-gray-300">
          你是隊長，請選擇 {expectedTeamSize} 名隊員執行任務。(You are the Leader — select {expectedTeamSize} team members for the quest.)
        </p>
      </div>

      {/* 隊伍大小指示 */}
      <div className="flex justify-center">
        <div className="bg-avalon-card/70 rounded-full px-6 py-2">
          <p className="text-white font-bold">
            已選 (Selected)：<span className="text-purple-400">{selectedPlayers.size}</span>/
            <span className="text-gray-400">{expectedTeamSize}</span>
          </p>
        </div>
      </div>

      {/* 玩家選擇列表 */}
      <div className="space-y-2">
        <p className="text-gray-300 text-sm font-semibold">選擇隊員：</p>
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
                    ? 'bg-purple-600/40 border-purple-400 text-white'
                    : 'bg-avalon-card/30 border-gray-600 text-gray-300 hover:border-gray-400'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <div className="relative">
                  {isSelected ? (
                    <CheckCircle size={20} className="text-purple-400" />
                  ) : (
                    <Circle size={20} className="text-gray-500" />
                  )}
                </div>
                <span className="font-semibold flex-1 text-left">
                  {player.name}
                  {isYou && '（你）'}
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
            ? 'bg-purple-600 hover:bg-purple-700 text-white cursor-pointer'
            : 'bg-gray-600 text-gray-300 cursor-not-allowed opacity-50'
        }`}
      >
        {isSubmitting ? '提交中…' : '確認任務隊伍 (Confirm Team)'}
      </motion.button>

      {/* 幫助文本 */}
      <div className="text-center text-sm text-gray-400">
        <p>
          {isFull
            ? '隊伍已選完！點擊確認進行投票。(Team complete! Click confirm to vote.)'
            : `還需選擇 ${expectedTeamSize - selectedPlayers.size} 名隊員 (more member${expectedTeamSize - selectedPlayers.size > 1 ? 's' : ''} needed)`}
        </p>
      </div>
    </motion.div>
  );
}
