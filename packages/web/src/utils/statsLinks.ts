/**
 * Stats pages anyone can open without logging in (2026-10-13 players' report:
 * some thought the stats needed a login, one could not reach the leaderboard).
 *
 *  - PUBLIC_STATS_STATES: the gameStates App renders even when there is no
 *    session (guest mint / socket failed) and while the session is starting.
 *  - Deep links (the SPA has no router; the bots link these):
 *      #stats  (#analytics, #leaderboard, #rank) → 數據分析
 *      #player=<名字>                             → 數據分析 → 玩家雷達, that player
 */
import type { GameState } from '../store/gameStore';

export const PUBLIC_STATS_STATES: ReadonlySet<GameState> = new Set<GameState>([
  'analytics', 'analysis', 'leaderboard', 'wiki', 'help',
]);

export type StatsLink = { kind: 'stats' } | { kind: 'player'; name: string };

const STATS_HASHES = new Set(['stats', 'analytics', 'leaderboard', 'rank']);

/** Parse a location.hash; null when it is not a stats link (e.g. #practice). */
export function parseStatsHash(hash: string | null | undefined): StatsLink | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (!raw) return null;
  const m = /^player[=/](.+)$/i.exec(raw);
  if (m) {
    let name = m[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      // a lone "%" — keep the text as typed
    }
    name = name.trim();
    return name ? { kind: 'player', name } : { kind: 'stats' };
  }
  return STATS_HASHES.has(raw.toLowerCase()) ? { kind: 'stats' } : null;
}
