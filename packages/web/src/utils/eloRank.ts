/**
 * Player tier system (hard-threshold by total games) — LEGACY 6-tier UI utility.
 *
 * Edward 2026-04-24 13:43 — spec moved to **dual-dimension** scheme
 * (`TierGroup` × `EloTag`) in `@avalon/shared/derived/gameMetrics`.
 *
 * TODO (next wave): migrate Leaderboard / Analytics pages to consume the
 * server's `computed_stats/{playerId}` documents which already carry
 * `tierGroup` / `eloTag` / `theoreticalWinRate`. Once the `/api/leaderboard`
 * response exposes those three fields per entry, replace this file with a
 * thin adapter to the shared types.
 *
 * Edward 2026-04-26 — tier 切點改為 percentile-based (1/50/100/150/375/650)
 *  by `total_games`，對齊 Sheets 2146 場 / 62 玩家實際分佈。
 *  舊 1/6/16/31/61/101 切點推 41/62 (66%) 進大師、菜雞 0 人 — 不平衡。
 *  新切點取自 p16/p33/p50/p75/p90 percentile，rounded to clean numbers，
 *  分佈 ~11/10/10/15/10/6 跨 6 tier (中位數 149，落在「中堅」中段)：
 *   • 菜雞   total_games  1-49     (p<16, 11 玩家)
 *   • 初學   total_games  50-99    (p16-33, 10 玩家)
 *   • 新手   total_games  100-149  (p33-50, 10 玩家)
 *   • 中堅   total_games  150-374  (p50-75, 15 玩家, 中位數附近)
 *   • 高手   total_games  375-649  (p75-90, 10 玩家)
 *   • 大師   total_games  ≥ 650    (p90+, 6 玩家)
 *
 * Within a tier, entries remain sorted by ELO (higher first in UI).
 *
 * `getEloRank(elo, totalGames?)` — single-player lookup. Tier is determined
 *   purely by `totalGames` now (ELO no longer governs tier assignment); ELO
 *   is preserved in the data model and still drives list ordering.
 *
 * `rankLeaderboard(entries)` — batch lookup, same rule.
 */

export interface EloRank {
  label: string;
  color: string;       // Tailwind text color class
  bgColor: string;     // Tailwind bg color class
  borderColor: string; // Tailwind border color class
  /** ELO floor — preserved for back-compat / badge use, NOT used for tier assignment any more. */
  min: number;
  /** Minimum total games required to qualify for this tier (canonical rule). */
  minGames: number;
}

/** Pre-tier for players with 1-5 games. Displayed independently. */
export const ROOKIE_TIER: EloRank = {
  label: '菜雞',
  color: 'text-gray-400',
  bgColor: 'bg-gray-700/50',
  borderColor: 'border-gray-600',
  min: 0,
  minGames: 1,
};

/** Hard ceiling for 菜雞; player needs ≥ this many games to escape 菜雞. */
export const ROOKIE_MAX_GAMES = 50;

/**
 * Five ranked tiers (low → high) with hard `minGames` thresholds.
 *
 * `min` (ELO) is retained for back-compat with other call sites (badges etc.)
 * but is no longer consulted for tier assignment.
 *
 * Edward 2026-04-26 thresholds (by `total_games`, percentile-based on 62-player Sheets dataset):
 *   初學 50-99 / 新手 100-149 / 中堅 150-374 / 高手 375-649 / 大師 ≥650
 */
export const ELO_RANKS: EloRank[] = [
  { label: '初學', color: 'text-green-400',  bgColor: 'bg-green-900/40',  borderColor: 'border-green-700',  min: 0,    minGames: 50  },
  { label: '新手', color: 'text-blue-400',   bgColor: 'bg-blue-900/40',   borderColor: 'border-blue-700',   min: 950,  minGames: 100 },
  { label: '中堅', color: 'text-purple-400', bgColor: 'bg-purple-900/40', borderColor: 'border-purple-700', min: 1050, minGames: 150 },
  { label: '高手', color: 'text-yellow-400', bgColor: 'bg-yellow-900/40', borderColor: 'border-yellow-700', min: 1150, minGames: 375 },
  { label: '大師', color: 'text-orange-400', bgColor: 'bg-orange-900/40', borderColor: 'border-orange-700', min: 1300, minGames: 650 },
];

/** All tiers including pre-tier, low → high. Useful for filter UI. */
export const ALL_TIERS: EloRank[] = [ROOKIE_TIER, ...ELO_RANKS];

/**
 * Single-player tier lookup by total games.
 *
 * The `elo` parameter is kept for backward signature compatibility and may be
 * used by callers that want a rating label fallback, but tier assignment is
 * now driven exclusively by `totalGames`.
 *
 * When `totalGames` is undefined (legacy call sites with only ELO), we return
 * the lowest ranked tier (初學) to avoid a misleading 菜雞 label for players
 * whose game-count isn't wired through. Pass `totalGames` for correct result.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getEloRank(elo: number, totalGames?: number): EloRank {
  if (typeof totalGames !== 'number') {
    // Legacy caller — no game-count context, default to bottom ranked tier.
    return ELO_RANKS[0];
  }

  // Walk tiers high → low, return the first whose minGames the player satisfies.
  for (let i = ELO_RANKS.length - 1; i >= 0; i--) {
    if (totalGames >= ELO_RANKS[i].minGames) {
      return ELO_RANKS[i];
    }
  }
  return ROOKIE_TIER;
}

// ---------------------------------------------------------------------------
// Batch ranking by hard threshold
// ---------------------------------------------------------------------------

/** Minimal shape needed by `rankLeaderboard` — matches LeaderboardEntry. */
export interface RankInput {
  id: string;
  elo_rating: number;
  total_games: number;
}

/**
 * Compute each entry's tier from `total_games` using hard thresholds.
 *
 * A player with N total games lands in the highest tier whose `minGames`
 * they satisfy; anyone with N < 50 is 菜雞. Ordering within a tier is the
 * caller's responsibility (LeaderboardPage sorts by ELO).
 */
export function rankLeaderboard(entries: readonly RankInput[]): Map<string, EloRank> {
  const result = new Map<string, EloRank>();
  for (const e of entries) {
    result.set(e.id, getTierByGames(e.total_games));
  }
  return result;
}

/** Internal: resolve tier from total-games alone. */
function getTierByGames(totalGames: number): EloRank {
  for (let i = ELO_RANKS.length - 1; i >= 0; i--) {
    if (totalGames >= ELO_RANKS[i].minGames) {
      return ELO_RANKS[i];
    }
  }
  return ROOKIE_TIER;
}
