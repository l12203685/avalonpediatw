import { Room, Player } from '@avalon/shared';
import PlayerCard from './PlayerCard';
import { motion } from 'framer-motion';
import audioService from '../services/audio';
import { useEffect } from 'react';

interface GameBoardProps {
  room: Room;
  currentPlayer: Player;
}

const STATE_LABELS: Record<string, string> = {
  lobby:      '等待中 (Lobby)',
  voting:     '投票中 (Voting)',
  quest:      '任務中 (Quest)',
  discussion: '刺殺 (Assassination)',
  ended:      '結束 (Ended)',
};

export default function GameBoard({ room, currentPlayer }: GameBoardProps): JSX.Element {
  const playerCount = Object.values(room.players).length;
  const angleSlice = 360 / playerCount;
  const playerIds = Object.keys(room.players);
  const leaderId = playerIds[room.leaderIndex % playerIds.length];

  // Play sound on state change
  useEffect(() => {
    try {
      if (room.state === 'voting') {
        audioService.playSound('vote');
      } else if (room.state === 'quest') {
        audioService.playSound('game-start');
      } else if (room.state === 'ended') {
        if (room.evilWins) {
          audioService.playFailureSound();
        } else {
          audioService.playSuccessChord();
        }
      }
    } catch (error) {
      // Silently fail - audio is not critical to gameplay
      console.warn('Failed to play game sound:', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [room.state, room.evilWins]);

  return (
    <div className="relative w-full h-96 max-w-2xl mx-auto">
      {/* 背景圓形 - 動畫光環 */}
      <motion.div
        animate={{
          boxShadow: [
            '0 0 20px rgba(59, 130, 246, 0.3)',
            '0 0 40px rgba(59, 130, 246, 0.5)',
            '0 0 20px rgba(59, 130, 246, 0.3)',
          ],
        }}
        transition={{ duration: 3, repeat: Infinity }}
        className="absolute inset-0 rounded-full border-2 border-gray-600 bg-gradient-to-b from-avalon-dark/50 to-transparent"
      />

      {/* 遊戲狀態中心 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center z-10"
      >
        <motion.p
          key={room.state}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="text-xl font-bold bg-gradient-to-r from-yellow-400 to-orange-400 bg-clip-text text-transparent"
        >
          {STATE_LABELS[room.state] ?? room.state}
        </motion.p>

        {/* 投票計數 */}
        {room.state === 'voting' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 text-xs text-gray-400"
          >
            <p>{Object.keys(room.votes).length}/{playerCount} 人已投票</p>
          </motion.div>
        )}
      </motion.div>

      {/* 玩家環形排列 */}
      {Object.values(room.players).map((player, index) => {
        const angle = (angleSlice * index) * (Math.PI / 180);
        const radius = 140;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;

        return (
          <motion.div
            key={player.id}
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: index * 0.1 }}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
            }}
          >
            <PlayerCard
              player={player}
              isCurrentPlayer={player.id === currentPlayer.id}
              hasVoted={room.votes[player.id] !== undefined}
              voted={room.votes[player.id]}
              isLeader={player.id === leaderId}
              isOnQuestTeam={room.questTeam.includes(player.id)}
            />
          </motion.div>
        );
      })}
    </div>
  );
}
