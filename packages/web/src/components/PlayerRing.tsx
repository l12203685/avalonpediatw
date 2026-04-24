import { Player } from '@avalon/shared';
import { displaySeatNumber } from '../utils/seatDisplay';

interface PlayerRingProps {
  /** Ordered list of player IDs (seat 0..n-1). */
  playerIds: string[];
  /** Full player map (for names + role hints). */
  players: Record<string, Player>;
  /** Children rendered in the centre of the ring. */
  children: React.ReactNode;
  /** Player ID of the viewer (highlighted yellow). */
  currentPlayerId?: string;
}

/**
 * PlayerRing — outer ring of player seat labels surrounding a central
 * scoresheet (see Edward 2026-04-24 reference image).
 *
 * Layout: left column = seats 0, 9, 8, 7, 6 top-to-bottom (matching the
 * reference screenshot's anti-clockwise left column). Right column = seats
 * 1, 2, 3, 4, 5 top-to-bottom. The children (scoresheet) render in the
 * centre column.
 *
 * Responsive:
 *   - <sm (mobile): narrow side columns showing seat numbers only (no names)
 *     so the central matrix keeps maximum width. Tap a seat to see the name
 *     via native title tooltip.
 *   - sm+ (tablet/desktop): side columns widen and the player's display
 *     name renders below the seat number.
 *
 * Seat numbering follows the paper-scoresheet convention: seat N renders
 * as `displaySeatNumber(N+1)` so seat 9 appears as "0". For <10-player
 * games we just show the available seats and leave the remaining slots
 * empty.
 */
export default function PlayerRing({
  playerIds,
  players,
  children,
  currentPlayerId,
}: PlayerRingProps): JSX.Element {
  const SLOTS = 10;

  // Map reference seats → playerIds[idx] (fallback: undefined → empty slot).
  // Left column (top→bottom): seats 0, 9, 8, 7, 6
  // Right column (top→bottom): seats 1, 2, 3, 4, 5
  const leftSeats = [0, 9, 8, 7, 6];
  const rightSeats = [1, 2, 3, 4, 5];

  const renderSeat = (seatIdx: number): JSX.Element => {
    const pid = playerIds[seatIdx];
    const player = pid ? players[pid] : undefined;
    const isMe = pid && pid === currentPlayerId;
    const seatLabel = displaySeatNumber(seatIdx + 1);

    return (
      <div
        key={`ring-seat-${seatIdx}`}
        className={`flex flex-col items-center justify-center text-center px-0.5 sm:px-1 py-1 sm:py-2 min-h-[40px] sm:min-h-[48px] ${
          pid ? '' : 'opacity-30'
        }`}
        title={player?.name ?? ''}
      >
        <div
          className={`text-base sm:text-2xl font-bold leading-tight ${
            isMe ? 'text-yellow-300' : 'text-gray-200'
          }`}
        >
          {seatLabel}
        </div>
        {/* Name row — hidden on mobile to keep central matrix wide. */}
        <div
          className={`hidden sm:block text-[9px] sm:text-xs leading-tight truncate max-w-[80px] ${
            isMe ? 'text-yellow-200' : 'text-gray-400'
          }`}
        >
          {player?.name ?? (seatIdx < SLOTS ? '—' : '')}
        </div>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-1 sm:gap-2 w-full items-stretch">
      {/* Left column — seats 0, 9, 8, 7, 6 top→bottom. Narrow on mobile. */}
      <div className="flex flex-col justify-around w-[28px] sm:min-w-[96px]">
        {leftSeats.map(renderSeat)}
      </div>

      {/* Centre — scoresheet */}
      <div className="min-w-0">{children}</div>

      {/* Right column — seats 1, 2, 3, 4, 5 top→bottom. Narrow on mobile. */}
      <div className="flex flex-col justify-around w-[28px] sm:min-w-[96px]">
        {rightSeats.map(renderSeat)}
      </div>
    </div>
  );
}
