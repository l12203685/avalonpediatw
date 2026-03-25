import { Room, Player } from '@avalon/shared';
import PlayerCard from './PlayerCard';
import { motion } from 'framer-motion';

interface GameBoardProps {
  room: Room;
  currentPlayer: Player;
}

export default function GameBoard({ room, currentPlayer }: GameBoardProps): JSX.Element {
  const playerCount = Object.values(room.players).length;
  const angleSlice = 360 / playerCount;

  return (
    <div className="relative w-full h-96 max-w-2xl mx-auto">
      {/* 背景圓形 */}
      <div className="absolute inset-0 rounded-full border-2 border-gray-600 bg-gradient-to-b from-avalon-dark/50 to-transparent" />

      {/* 遊戲狀態中心 */}
      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center z-10">
        <p className="text-sm text-gray-400">Round {room.currentRound}/{room.maxRounds}</p>
        <p className="text-2xl font-bold text-white capitalize">{room.state}</p>
        <div className="mt-2">
          {room.questResults.length > 0 && (
            <div className="flex justify-center gap-2">
              {room.questResults.map((result, i) => (
                <div
                  key={i}
                  className={`w-3 h-3 rounded-full ${
                    result === 'success' ? 'bg-avalon-good' : 'bg-avalon-evil'
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </div>

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
            />
          </motion.div>
        );
      })}
    </div>
  );
}
