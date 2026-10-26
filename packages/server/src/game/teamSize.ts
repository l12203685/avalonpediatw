/**
 * Fit a proposed team to the size the engine expects (2026-10-26 fix: under
 * swapR1R2 and the 9-player variant the engine's quest sizes differ from
 * `AVALON_CONFIG`, so a bot pick sized from the table — and the old
 * fallback, sized the same way — was rejected and the room hung).
 *
 * Keeps the leader and then the preferred seats in their order (duplicates
 * and unknown ids dropped), trims to `size`, and pads with the remaining
 * seats in seat order.
 */
export function fitTeamToSize(
  preferred: readonly string[],
  size: number,
  leaderId: string,
  seatOrder: readonly string[],
): string[] {
  const known = new Set(seatOrder);
  const out: string[] = [];
  const push = (id: string): void => {
    if (out.length < size && known.has(id) && !out.includes(id)) out.push(id);
  };
  if (preferred.length === 0 || preferred.includes(leaderId)) push(leaderId);
  for (const id of preferred) push(id);
  for (const id of [leaderId, ...seatOrder]) push(id);
  return out;
}
