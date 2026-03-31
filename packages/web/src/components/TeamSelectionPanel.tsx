import { Room, Player, AVALON_CONFIG } from '@avalon/shared';
import { CheckCircle, Circle, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { selectQuestTeam } from '../services/socket';
import { toast } from '../store/toastStore';

interface TeamSelectionPanelProps {
  room: Room;
  currentPlayer: Player;
  isLoading?: boolean;
}

export default function TeamSelectionPanel({
  room,
  currentPlayer,
  isLoading = false,
}: TeamSelectionPanelProps): JSX.Element {
  const playerCount = Object.keys(room.players).length;
  const config = AVALON_CONFIG[playerCount];
  const expectedTeamSize = config?.questTeams[room.currentRound - 1] ?? 2;

  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);

  const togglePlayer = (playerId: string): void => {
    const next = new Set(selectedPlayers);
    if (next.has(playerId)) {
      next.delete(playerId);
    } else if (next.size < expectedTeamSize) {
      next.add(playerId);
    } else {
      toast.warning(`最多只能選 ${expectedTeamSize} 位玩家`);
      return;
    }
    setSelectedPlayers(next);
  };

  const handleSubmit = async (): Promise<void> => {
    if (selectedPlayers.size !== expectedTeamSize) return;
    setIsSubmitting(true);
    try {
      selectQuestTeam(room.id, Array.from(selectedPlayers));
    } catch {
      toast.error('提交隊伍失敗，請稍後再試');
    } finally {
      setIsSubmitting(false);
    }
  };

  const remaining = expectedTeamSize - selectedPlayers.size;
  const isFull = remaining === 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/50 border-2 border-purple-600 rounded-xl p-8 space-y-6"
    >
      {/* 標題 */}
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-2">👑 選擇任務隊伍</h2>
        <p className="text-gray-300">
          你是本輪隊長，請選擇 {expectedTeamSize} 位玩家執行任務
        </p>
      </div>

      {/* 進度指示 */}
      <div className="flex justify-center items-center gap-3">
        <div className="bg-avalon-card/70 rounded-full px-6 py-2 flex items-center gap-2">
          <Users size={16} className="text-purple-400" />
          <span className="text-white font-bold">
            <span className="text-purple-400">{selectedPlayers.size}</span>
            <span className="text-gray-500">/{expectedTeamSize}</span>
          </span>
        </div>
        {isFull ? (
          <motion.span
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
            className="text-green-400 text-sm font-semibold"
          >
            ✓ 隊伍人數已滿
          </motion.span>
        ) : (
          <span className="text-gray-400 text-sm">還需選 {remaining} 位</span>
        )}
      </div>

      {/* 玩家清單 */}
      <div className="grid grid-cols-2 gap-3 max-h-96 overflow-y-auto">
        {Object.entries(room.players).map(([playerId, player]) => {
          const isSelected = selectedPlayers.has(playerId);
          const isDisabled = isSubmitting || isLoading || (!isSelected && isFull);

          return (
            <motion.button
              key={playerId}
              whileHover={!isDisabled ? { scale: 1.02 } : {}}
              whileTap={!isDisabled ? { scale: 0.98 } : {}}
              onClick={() => togglePlayer(playerId)}
              disabled={isDisabled}
              className={`flex items-center gap-3 p-3 rounded-lg transition-all border-2 ${
                isSelected
                  ? 'bg-purple-600/40 border-purple-400 text-white'
                  : isDisabled
                  ? 'bg-avalon-card/20 border-gray-700 text-gray-500 cursor-not-allowed opacity-50'
                  : 'bg-avalon-card/30 border-gray-600 text-gray-300 hover:border-purple-400 hover:bg-purple-900/20'
              }`}
            >
              {isSelected ? (
                <CheckCircle size={20} className="text-purple-400 shrink-0" />
              ) : (
                <Circle size={20} className="text-gray-500 shrink-0" />
              )}
              <span className="font-semibold flex-1 text-left truncate">
                {player.name}
                {playerId === currentPlayer.id && '（我）'}
              </span>
            </motion.button>
          );
        })}
      </div>

      {/* 確認按鈕 */}
      <motion.button
        whileHover={isFull && !isSubmitting ? { scale: 1.02 } : {}}
        whileTap={isFull && !isSubmitting ? { scale: 0.98 } : {}}
        onClick={handleSubmit}
        disabled={!isFull || isSubmitting || isLoading}
        className={`w-full font-bold py-3 px-6 rounded-lg transition-all text-lg ${
          isFull && !isSubmitting
            ? 'bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white shadow-lg hover:shadow-purple-500/30'
            : 'bg-gray-700 text-gray-400 cursor-not-allowed'
        }`}
      >
        {isSubmitting ? '提交中...' : '確認隊伍，進入投票'}
      </motion.button>

      {isFull && !isSubmitting && (
        <p className="text-center text-xs text-gray-400">
          確認後所有玩家將投票批准或拒絕此隊伍
        </p>
      )}
    </motion.div>
  );
}
