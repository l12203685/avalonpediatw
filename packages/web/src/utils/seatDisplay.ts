/**
 * Seat-number display helpers — paper scoresheet convention (#93).
 *
 * 10-player rooms traditionally render seat 10 as a single "0" digit so
 * nomination shorthand stays compact (e.g. "169" = leader 1, team 6 and 9;
 * "130" = leader 1, team 3 and 10). The rest of the seats (1-9) render as-is.
 *
 * Every component that surfaces a seat number should use these helpers so the
 * display stays consistent across the PlayerCard badge, scoresheet header,
 * nomination memo, team-pick overlays, and team-member lists.
 */

/**
 * @param seat 1-based seat index (1..N, where N is the room size)
 * @returns display string — "0" when seat is 10, otherwise the decimal number
 */
export function displaySeatNumber(seat: number): string {
  return seat === 10 ? '0' : String(seat);
}

/**
 * Resolves a player's 1-based seat number from a `Room.players` map.
 * Returns 0 when the id is unknown (callers should guard against that or accept
 * the placeholder; seat 0 itself is never assigned in canonical Avalon).
 *
 * @param playerId player id to look up
 * @param players `room.players` map (keyed by id; seat = insertion order + 1)
 */
export function seatOf(
  playerId: string,
  players: Record<string, unknown>,
): number {
  const ids = Object.keys(players);
  const idx = ids.indexOf(playerId);
  return idx === -1 ? 0 : idx + 1;
}

/**
 * Convenience: renders the seat-number label for a team-member list entry.
 * Returns an empty string for unknown players so the caller can safely
 * concatenate without guards.
 *
 * Edward 2026-04-25 21:59 撤回「N家」格式 — 改回純數字 (1, 2, ..., 9, 0)。
 * 牌桌口語仍說「N家」, 但 UI 顯示走精簡風, 座位號就是一個 digit。
 */
export function seatPrefix(
  playerId: string,
  players: Record<string, unknown>,
): string {
  const seat = seatOf(playerId, players);
  return seat === 0 ? '' : displaySeatNumber(seat);
}

/**
 * Canonical Avalon team-display sort: 1 < 2 < ... < 9 < 0 (10 = "0", largest).
 *
 * Edward 2026-04-27 spec「不能按照選的順序 要以數字由小到大 (0是最大)」.
 * Numeric ascending already gives this order because seat 10 is the largest
 * NUMERIC seat — only the *display* renders 10 as "0". Centralised so every
 * banner / scoresheet / chat / history / tooltip stays consistent and a
 * future rule change touches one place.
 *
 * @param seats 1-based seat numbers (10 represents seat 10 / display "0")
 * @returns new array sorted ascending, original input untouched
 */
export function sortSeatsForDisplay(seats: readonly number[]): number[] {
  return [...seats].sort((a, b) => a - b);
}

/**
 * Join an array of player IDs as a sorted seat-digit string. Filters out
 * unknown ids (seat 0). Result mirrors paper-scoresheet shorthand —
 * "134" / "4790" — and respects the canonical sort (`sortSeatsForDisplay`).
 *
 * @param playerIds team-member ids (any order)
 * @param players `room.players` map (insertion order = seat order)
 */
export function formatTeamSeatsDigitString(
  playerIds: readonly string[],
  players: Record<string, unknown>,
): string {
  const seats = playerIds
    .map((id) => seatOf(id, players))
    .filter((seat) => seat > 0);
  return sortSeatsForDisplay(seats).map(displaySeatNumber).join('');
}

/**
 * Same as `formatTeamSeatsDigitString` but renders with a custom separator
 * (e.g. Chinese 「、」 for natural-language sentence rendering in history /
 * tooltip / overlay panels). Sorts by canonical seat order before joining.
 */
export function formatTeamSeatsWithSeparator(
  playerIds: readonly string[],
  players: Record<string, unknown>,
  separator: string,
): string {
  const seats = playerIds
    .map((id) => seatOf(id, players))
    .filter((seat) => seat > 0);
  return sortSeatsForDisplay(seats).map(displaySeatNumber).join(separator);
}
