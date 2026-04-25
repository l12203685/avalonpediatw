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
  /**
   * #83 Phase 5 — chat + scoresheet slots for the center-column 2-col layout.
   * When both are provided, the center column renders:
   *   state banner → {children} (phase panel) → [chatSlot | scoresheetSlot]
   * On `lg:` screens the pair sits side-by-side (chat=flex-1, scoresheet=320px);
   * on mobile/tablet they stack vertically (chat first with a min-height). When
   * either slot is omitted the component falls back to the pre-Phase-5 layout
   * (just children under the banner) so GameBoard stays backward-compatible.
   */
  chatSlot?: ReactNode;
  scoresheetSlot?: ReactNode;
  /**
   * Leader team-selection wiring (#83 Phase 1). When `isPicking` is true, every
   * rail `PlayerCard` becomes a shield candidate; clicking toggles membership in
   * `selectedTeamIds` via `onSeatClick`.
   */
  isPicking?: boolean;
  selectedTeamIds?: Set<string>;
  onSeatClick?: (playerId: string) => void;
}

const STATE_LABELS: Record<string, string> = {
  lobby:            '等待中',
  voting:           '投票中',
  quest:            '任務中',
  lady_of_the_lake: '湖中女神',
  discussion:       '刺殺',
  ended:            '結束',
};

/**
 * 5v5 rails layout — clockwise seating (Edward 2026-04-21 revision, #93).
 *   ┌──────────────┬──────────────────────┬──────────────┐
 *   │ left rail    │   center (children)  │ right rail   │
 *   │ seats N..N/2 │   quest + history    │ seats 1..N/2 │
 *   │ (top=N)      │   + chat            │ (top=1)      │
 *   └──────────────┴──────────────────────┴──────────────┘
 * Right column runs 1→splitIndex top-to-bottom. Left column runs N→splitIndex+1
 * top-to-bottom (i.e. slice(splitIndex).reverse()). The visual rotation is
 * clockwise so a 10-player room reads: 1 top-right, down to 5 bottom-right,
 * wraps to 6 bottom-left, up to 10 top-left — matching physical table convention.
 *
 * Seat numbers stay locked to the original `playerIds` order (the server's
 * canonical seating). `seatIndex` passed to `renderPlayerCard` is the original
 * 0-based index, so `seat 10` always renders as `seatNumber={10}` regardless of
 * which rail it lives in after the reverse.
 *
 * Desktop: three columns (~210px | flex-1 | ~210px).
 * Mobile (<768px): two vertical rails side-by-side (1fr | 1fr), center column wraps
 *   below spanning both columns. No horizontal scroll — every seat visible at once.
 */
export default function GameBoard({
  room,
  currentPlayer,
  children,
  chatSlot,
  scoresheetSlot,
  isPicking = false,
  selectedTeamIds,
  onSeatClick,
}: GameBoardProps): JSX.Element {
  const players = Object.values(room.players);
  const playerIds = Object.keys(room.players);
  const leaderId = playerIds[room.leaderIndex % playerIds.length];

  // Split players into right (seats 1..splitIndex, top-to-bottom) and left
  // (seats splitIndex+1..N, reversed so highest seat sits on top). Ceil puts the
  // extra player on the RIGHT for odd counts so 5v5 lines up: 5→3+2, 6→3+3,
  // 7→4+3, 8→4+4, 9→5+4, 10→5+5.
  //
  // Each rail item carries the ORIGINAL seatIndex (0-based position in
  // `playerIds`). That keeps `seatNumber` stable through the reverse, so seat
  // 10 renders as 10 even though it sits at the top of the left rail visually.
  const splitIndex = Math.ceil(players.length / 2);
  const rightRail = players
    .slice(0, splitIndex)
    .map((player, i) => ({ player, seatIndex: i }));
  const leftRail = players
    .slice(splitIndex)
    .map((player, i) => ({ player, seatIndex: splitIndex + i }))
    .reverse();

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

  // Edward 2026-04-25 redesign: compute "last quest result" lookup so each
  // PlayerCard can flash a 任務牌 (success O / fail X) badge when this player
  // participated in the most recent completed quest. Only the latest quest
  // counts — past rounds are visible in the scoresheet / mission track.
  const lastQuestRecord = room.questHistory.length > 0
    ? room.questHistory[room.questHistory.length - 1]
    : undefined;
  const lastQuestParticipants = new Set<string>(lastQuestRecord?.team ?? []);
  const lastQuestResult: 'success' | 'fail' | undefined = lastQuestRecord?.result;

  const renderPlayerCard = (player: Player, seatIndex: number, side: 'left' | 'right'): JSX.Element => {
    const shieldSelected = Boolean(selectedTeamIds?.has(player.id));
    // All seats are valid picks (including leader's own seat — canonical Avalon allows
    // the leader to include themselves). We hand the click handler down only when in
    // picking mode so normal gameplay ignores the shield layer.
    const isShieldCandidate = isPicking;
    return (
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
          isShieldCandidate={isShieldCandidate}
          shieldSelected={shieldSelected}
          onShieldClick={isPicking ? onSeatClick : undefined}
          isLadyHolder={room.ladyOfTheLakeHolder === player.id}
          lastQuestResult={
            lastQuestParticipants.has(player.id) ? lastQuestResult : undefined
          }
        />
      </motion.div>
    );
  };

  // #83 Phase 5 — chat + scoresheet 2-col block. Rendered below `children` in
  // both desktop and mobile center columns when both slots are provided.
  //
  // Edward 2026-04-25 holistic redesign (matching LobbyPage commit df6b5726):
  // GameBoard now lives inside a `flex-1 min-h-0` parent so the center column
  // owns its own viewport-bound scroll. The chat slot needs `flex-1 min-h-0`
  // so it fills remaining vertical space without pushing the page; scoresheet
  // stays `auto` height because it's a compact recap.
  const centerExtras = (chatSlot || scoresheetSlot) ? (
    <div className="flex flex-col lg:flex-row gap-3 flex-1 min-h-0">
      {chatSlot && (
        <div className="flex-1 min-h-[200px] lg:min-h-0 flex flex-col">
          {chatSlot}
        </div>
      )}
      {scoresheetSlot && (
        <div className="lg:w-[320px] lg:flex-shrink-0 lg:min-h-0 lg:overflow-y-auto">
          {scoresheetSlot}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="w-full h-full min-h-0 flex flex-col">
      {/*
        Desktop / tablet: three-column grid filling parent height.
        Edward 2026-04-25 holistic — outer flex-1 min-h-0 lets each column own
        its own overflow-y-auto so the page itself never scrolls.
      */}
      <div
        className="hidden md:grid gap-3 lg:gap-4 flex-1 min-h-0"
        style={{ gridTemplateColumns: '210px minmax(0, 1fr) 210px' }}
      >
        {/* Left player rail — seats N..splitIndex+1 top-to-bottom (clockwise wrap) */}
        <aside className="flex flex-col gap-2 bg-avalon-card/30 border border-gray-700/60 rounded-xl p-2 overflow-y-auto min-h-0 min-w-0">
          {leftRail.map(({ player, seatIndex }) => renderPlayerCard(player, seatIndex, 'left'))}
        </aside>

        {/* Center — state banner + children (quest/vote/history) */}
        <section className="flex flex-col gap-3 min-w-0 min-h-0 overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="shrink-0 text-center bg-gradient-to-b from-avalon-card/60 to-avalon-card/30 border border-gray-700/60 rounded-xl py-3 px-4"
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
          {centerExtras}
        </section>

        {/* Right player rail — seats 1..splitIndex top-to-bottom (clockwise start) */}
        <aside className="flex flex-col gap-2 bg-avalon-card/30 border border-gray-700/60 rounded-xl p-2 overflow-y-auto min-h-0 min-w-0">
          {rightRail.map(({ player, seatIndex }) => renderPlayerCard(player, seatIndex, 'right'))}
        </aside>
      </div>

      {/*
        Mobile (<md): rails on top (compact horizontal grid, capped height) +
        center column flex-1 min-h-0 below. Edward 2026-04-25 holistic — the
        whole GamePage fits 100dvh; rails own their internal scroll so the
        viewport never grows past one screen.
      */}
      <div className="md:hidden flex flex-col gap-2 flex-1 min-h-0">
        <div
          className="grid gap-2 shrink-0"
          style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', maxHeight: '38dvh' }}
        >
          <aside className="bg-avalon-card/30 border border-gray-700/60 rounded-xl p-1.5 flex flex-col gap-1.5 overflow-y-auto min-h-0">
            {leftRail.map(({ player, seatIndex }) => renderPlayerCard(player, seatIndex, 'left'))}
          </aside>

          <aside className="bg-avalon-card/30 border border-gray-700/60 rounded-xl p-1.5 flex flex-col gap-1.5 overflow-y-auto min-h-0">
            {rightRail.map(({ player, seatIndex }) => renderPlayerCard(player, seatIndex, 'right'))}
          </aside>
        </div>

        {/* Center column below the rails — owns its own scroll */}
        <section className="flex flex-col gap-3 min-w-0 min-h-0 flex-1 overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="shrink-0 text-center bg-gradient-to-b from-avalon-card/60 to-avalon-card/30 border border-gray-700/60 rounded-xl py-2 px-3"
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
          {centerExtras}
        </section>
      </div>
    </div>
  );
}
