import { Room, Player } from '@avalon/shared';
import PlayerCard from './PlayerCard';
import { motion } from 'framer-motion';
import audioService from '../services/audio';
import { useEffect, type ReactNode } from 'react';

interface GameBoardProps {
  room: Room;
  currentPlayer: Player;
  /** Content rendered in the center column (quest/vote/history panels). */
  children?: ReactNode;
}

const STATE_LABELS: Record<string, string> = {
  lobby:            '等待中 (Lobby)',
  voting:           '投票中 (Voting)',
  quest:            '任務中 (Quest)',
  lady_of_the_lake: '湖中女神 (Lady)',
  discussion:       '刺殺 (Assassination)',
  ended:            '結束 (Ended)',
};

/**
 * 5v5 rails layout per Edward 2026-04-20 spec:
 *   ┌─────────┬──────────────────────┬─────────┐
 *   │ left    │   center (children)  │ right   │
 *   │ players │   quest + history    │ players │
 *   │ 1..N/2  │   + chat            │ N/2..N  │
 *   └─────────┴──────────────────────┴─────────┘
 * Desktop: three columns (~210px | flex-1 | ~210px).
 * Mobile (<768px): stacked — left rail (horizontal scroll) over center over right rail.
 */
export default function GameBoard({ room, currentPlayer, children }: GameBoardProps): JSX.Element {
  const players = Object.values(room.players);
  const playerIds = Object.keys(room.players);
  const leaderId = playerIds[room.leaderIndex % playerIds.length];

  // Split players into left/right halves. Ceil puts the extra player on the left for odd counts.
  // 5→3+2, 6→3+3, 7→4+3, 8→4+4, 9→5+4, 10→5+5.
  const splitIndex = Math.ceil(players.length / 2);
  const leftPlayers = players.slice(0, splitIndex);
  const rightPlayers = players.slice(splitIndex);

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

  // Determine whose turn it currently is, so the UI can draw a pulsing ring on their card.
  // Rules (match the game engine's phase semantics):
  //   • voting + empty team → leader is picking
  //   • voting + team set   → everyone who hasn't voted yet is acting
  //   • quest               → quest team members who haven't submitted
  //   • lady_of_the_lake    → holder of the Lady
  //   • discussion          → the Assassin
  const teamSelected = room.questTeam.length > 0;
  const isActiveTurn = (playerId: string): boolean => {
    if (room.state === 'voting' && !teamSelected) return playerId === leaderId;
    if (room.state === 'voting' && teamSelected) return room.votes[playerId] === undefined;
    if (room.state === 'quest') return room.questTeam.includes(playerId);
    if (room.state === 'lady_of_the_lake') return playerId === room.ladyOfTheLakeHolder;
    if (room.state === 'discussion') {
      // Only the assassin acts, but we don't always know their id client-side —
      // the server reveals the role to the assassin themselves, and others see
      // the generic "assassin is choosing" banner, so leaving this as no-ring
      // is safe for non-assassins.
      const role = room.players[playerId]?.role;
      return role === 'assassin';
    }
    return false;
  };

  const renderPlayerCard = (player: Player, seatIndex: number, side: 'left' | 'right'): JSX.Element => (
    <motion.div
      key={player.id}
      initial={{ opacity: 0, x: side === 'left' ? -20 : 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: seatIndex * 0.05 }}
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
        seatNumber={seatIndex + 1}
        side={side}
        isActiveTurn={isActiveTurn(player.id)}
      />
    </motion.div>
  );

  return (
    <div className="w-full">
      {/* Desktop / tablet: three-column grid */}
      <div className="hidden md:grid gap-3 lg:gap-4" style={{ gridTemplateColumns: '210px minmax(0, 1fr) 210px' }}>
        {/* Left player rail */}
        <aside className="flex flex-col gap-2 bg-avalon-card/30 border border-gray-700/60 rounded-xl p-2">
          {leftPlayers.map((p, i) => renderPlayerCard(p, i, 'left'))}
        </aside>

        {/* Center — state banner + children (quest/vote/history) */}
        <section className="flex flex-col gap-3 min-w-0">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center bg-gradient-to-b from-avalon-card/60 to-avalon-card/30 border border-gray-700/60 rounded-xl py-3 px-4"
          >
            <motion.p
              key={room.state}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-lg sm:text-xl font-bold bg-gradient-to-r from-yellow-400 to-amber-500 bg-clip-text text-transparent"
            >
              {STATE_LABELS[room.state] ?? room.state}
            </motion.p>
            {room.state === 'voting' && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-1 text-xs text-gray-400"
              >
                {Object.keys(room.votes).length}/{players.length} 人已投票
              </motion.p>
            )}
          </motion.div>

          {children}
        </section>

        {/* Right player rail */}
        <aside className="flex flex-col gap-2 bg-avalon-card/30 border border-gray-700/60 rounded-xl p-2">
          {rightPlayers.map((p, i) => renderPlayerCard(p, splitIndex + i, 'right'))}
        </aside>
      </div>

      {/* Mobile: stack rails horizontally above/below the center */}
      <div className="md:hidden flex flex-col gap-3">
        <aside className="bg-avalon-card/30 border border-gray-700/60 rounded-xl p-2">
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {leftPlayers.map((p, i) => (
              <div key={p.id} className="min-w-[160px] flex-shrink-0">
                {renderPlayerCard(p, i, 'left')}
              </div>
            ))}
          </div>
        </aside>

        <section className="flex flex-col gap-3 min-w-0">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center bg-gradient-to-b from-avalon-card/60 to-avalon-card/30 border border-gray-700/60 rounded-xl py-2 px-3"
          >
            <motion.p
              key={room.state}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-base font-bold bg-gradient-to-r from-yellow-400 to-amber-500 bg-clip-text text-transparent"
            >
              {STATE_LABELS[room.state] ?? room.state}
            </motion.p>
            {room.state === 'voting' && (
              <p className="mt-0.5 text-[11px] text-gray-400">
                {Object.keys(room.votes).length}/{players.length} 人已投票
              </p>
            )}
          </motion.div>

          {children}
        </section>

        <aside className="bg-avalon-card/30 border border-gray-700/60 rounded-xl p-2">
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {rightPlayers.map((p, i) => (
              <div key={p.id} className="min-w-[160px] flex-shrink-0">
                {renderPlayerCard(p, splitIndex + i, 'right')}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
