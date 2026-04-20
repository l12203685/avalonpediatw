import { Room, Player } from '@avalon/shared';
import PlayerCard from './PlayerCard';
import { motion } from 'framer-motion';
import audioService from '../services/audio';
import { useEffect, useLayoutEffect, useState, useRef } from 'react';

interface GameBoardProps {
  room: Room;
  currentPlayer: Player;
}

const STATE_LABELS: Record<string, string> = {
  lobby:            '等待中 (Lobby)',
  voting:           '投票中 (Voting)',
  quest:            '任務中 (Quest)',
  lady_of_the_lake: '湖中女神 (Lady)',
  discussion:       '刺殺 (Assassination)',
  ended:            '結束 (Ended)',
};

// Offset so the first player sits at the top (12 o'clock) instead of the right (3 o'clock).
// This makes the ring feel natural and matches tabletop seating conventions.
const ANGLE_OFFSET_DEG = -90;

export default function GameBoard({ room, currentPlayer }: GameBoardProps): JSX.Element {
  const playerCount = Object.values(room.players).length;
  const angleSlice = playerCount > 0 ? 360 / playerCount : 0;
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

  // Measure the container width with ResizeObserver so the board reacts to
  // orientation changes, DevTools mobile mode, and container resizes without
  // relying on `window.innerWidth` read at render time (which breaks when the
  // viewport changes after mount). Falling back to `window.innerWidth` only
  // for the very first paint before layout completes.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 480,
  );
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.clientWidth;
      if (w > 0) setContainerWidth(w);
    };
    measure();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    window.addEventListener('resize', measure);
    return (): void => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Derive all sizes from the actual container width rather than mutating a
  // post-render transform. The ring never needs scale-hacks that previously
  // shifted children off-centre.
  const isMobile = containerWidth < 480;
  // Card bounding box (wide enough for role/team labels on the current player).
  const cardAllowance = isMobile ? 56 : 72;
  // Safety gutter so the outermost card edge doesn't kiss the container edge.
  const gutter = 12;
  // Ideal ring radius per player count — larger counts need more circumference
  // so neighbouring cards don't collide.
  const idealRadius = isMobile
    ? (playerCount <= 6 ? 110 : playerCount <= 8 ? 130 : 150)
    : (playerCount <= 6 ? 150 : playerCount <= 8 ? 175 : 200);
  // Shrink radius if the container is narrower than the ideal ring + card edge.
  const maxRadiusForWidth = Math.max(60, (containerWidth - gutter * 2) / 2 - cardAllowance);
  const radius = Math.min(idealRadius, maxRadiusForWidth);
  // Board is just big enough to fit the ring + card edges; keeps the layout
  // compact on desktop while still filling narrow phones.
  const boardSize = Math.max(200, radius * 2 + cardAllowance * 2);

  return (
    <div
      ref={containerRef}
      className="w-full max-w-2xl mx-auto flex justify-center"
    >
      <div
        className="relative"
        style={{ width: boardSize, height: boardSize }}
      >
        {/* Background ring — sized in sync with the avatar ring so cards sit on its edge */}
        <motion.div
          animate={{
            boxShadow: [
              '0 0 20px rgba(59, 130, 246, 0.3)',
              '0 0 40px rgba(59, 130, 246, 0.5)',
              '0 0 20px rgba(59, 130, 246, 0.3)',
            ],
          }}
          transition={{ duration: 3, repeat: Infinity }}
          style={{
            width: radius * 2,
            height: radius * 2,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
          }}
          className="absolute rounded-full border-2 border-gray-600 bg-gradient-to-b from-avalon-dark/50 to-transparent pointer-events-none"
        />

        {/* Centre status text — sits behind player cards so it never masks avatars */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none z-0"
        >
          <motion.p
            key={room.state}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="text-lg sm:text-xl font-bold bg-gradient-to-r from-yellow-400 to-orange-400 bg-clip-text text-transparent whitespace-nowrap"
          >
            {STATE_LABELS[room.state] ?? room.state}
          </motion.p>

          {/* Vote progress counter */}
          {room.state === 'voting' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-2 text-xs text-gray-400"
            >
              <p>{Object.keys(room.votes).length}/{playerCount} 人已投票</p>
            </motion.div>
          )}
        </motion.div>

        {/* Players arranged around the ring — z-10 keeps them above the centre text */}
        {Object.values(room.players).map((player, index) => {
          const angle = (angleSlice * index + ANGLE_OFFSET_DEG) * (Math.PI / 180);
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;

          return (
            <motion.div
              key={player.id}
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: index * 0.08 }}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
              }}
              className="z-10"
            >
              <PlayerCard
                player={player}
                isCurrentPlayer={player.id === currentPlayer.id}
                hasVoted={room.votes[player.id] !== undefined}
                // During voting, only reveal own vote direction; others show as undefined (just "has voted")
                voted={
                  room.state === 'voting' && player.id !== currentPlayer.id
                    ? undefined
                    : room.votes[player.id]
                }
                isLeader={player.id === leaderId}
                isOnQuestTeam={room.questTeam.includes(player.id)}
              />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
