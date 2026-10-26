/**
 * Who holds the assassination (Edward 2026-05-11: the 7-player setup has no
 * plain assassin, so Mordred carries the blade; with Mordred switched off as
 * well, Morgana does). One rule for the engine, the socket server, self-play,
 * the replays and the invariant harness (2026-10-26 review fix: the bot
 * paths and the observation builders looked for `'assassin'` only, so a bot
 * Mordred never assassinated and never received the red roster).
 *
 * Priority: `assassin` > `mordred` > `morgana`.
 */

import type { Role } from '@avalon/shared';

const ORDER: readonly Role[] = ['assassin', 'mordred', 'morgana'];

/** The role that assassinates in a game dealt `roles` (undefined when none of the three is dealt). */
export function assassinatorRole(roles: Iterable<Role | string | null | undefined>): Role | undefined {
  const dealt = new Set<string>();
  for (const r of roles) if (r) dealt.add(r);
  return ORDER.find((r) => dealt.has(r));
}

/** True when `role` is the assassinator of a game dealt `roles`. */
export function isAssassinator(role: Role | string | null | undefined, roles: Iterable<Role | string | null | undefined>): boolean {
  return role !== null && role !== undefined && role === assassinatorRole(roles);
}
