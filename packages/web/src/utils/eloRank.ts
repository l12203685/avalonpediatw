/**
 * Player tier system.
 *
 * Two-layer design (per Edward 2026-04-20 spec):
 *   1. Pre-tier: 菜雞 (< 30 games) — shown independently, excluded from ranked distribution.
 *   2. Five ranked tiers (low→high): 初學 / 新手 / 中堅 / 高手 / 大師.
 *
 * Tier assignment uses a hybrid rule:
 *   • A minimum `totalGames` gate per tier (50 / 100 / 150 / 200 / 250).
 *   • A percentile band (bottom→top 15% / 25% / 30% / 25% / 15%) applied
 *     across all qualified (non-菜雞) players sorted by ELO.
 *
 * `getEloRank(elo, totalGames?)` returns a threshold-based tier used as a
 *   fallback when the full population isn't available (e.g. Profile / Friends
 *   page show a single entry). The ELO thresholds are tuned so a player
 *   sitting at the percentile centroid on a typical roster lands in the
 *   matching tier.
 *
 * `rankLeaderboard(entries)` returns per-entry tiers using the full 15/25/30/25/15
 *   percentile distribution, enforcing the game-count floor. Used by the
 *   LeaderboardPage to guarantee the spec's ELO spread.
 */

export interface EloRank {
  label: string;
  color: string;       // Tailwind text color class
  bgColor: string;     // Tailwind bg color class
  borderColor: string; // Tailwind border color class
  min: number;         // ELO floor (threshold fallback)
  minGames: number;    // games required to reach this tier
}

/** Pre-tier for players with < 30 games. Displayed independently. */
export const ROOKIE_TIER: EloRank = {
  label: '菜雞',
  color: 'text-gray-400',
  bgColor: 'bg-gray-700/50',
  borderColor: 'border-gray-600',
  min: 0,
  minGames: 0,
};

/** Threshold to escape the 菜雞 pre-tier. */
export const ROOKIE_MAX_GAMES = 30;

/**
 * Five ranked tiers, low → high.
 * ELO `min` values are tuned to the existing score distribution so a
 * single-entry lookup (Profile / Friends) gives a reasonable tier even
 * without population context.
 */
export const ELO_RANKS: EloRank[] = [
  { label: '初學', color: 'text-green-400',  bgColor: 'bg-green-900/40',  borderColor: 'border-green-700',  min: 0,    minGames: 50  },
  { label: '新手', color: 'text-blue-400',   bgColor: 'bg-blue-900/40',   borderColor: 'border-blue-700',   min: 950,  minGames: 100 },
  { label: '中堅', color: 'text-purple-400', bgColor: 'bg-purple-900/40', borderColor: 'border-purple-700', min: 1050, minGames: 150 },
  { label: '高手', color: 'text-yellow-400', bgColor: 'bg-yellow-900/40', borderColor: 'border-yellow-700', min: 1150, minGames: 200 },
  { label: '大師', color: 'text-orange-400', bgColor: 'bg-orange-900/40', borderColor: 'border-orange-700', min: 1300, minGames: 250 },
];

/** All tiers including pre-tier, low → high. Useful for filter UI. */
export const ALL_TIERS: EloRank[] = [ROOKIE_TIER, ...ELO_RANKS];

/**
 * Threshold-based tier lookup. Used when full population ranking is not
 * available (single player views). Falls back to 菜雞 if the player hasn't
 * reached the minimum game count (< 30 by default, or < 50 which is the
 * 初學 floor).
 */
export function getEloRank(elo: number, totalGames?: number): EloRank {
  // Unknown game count → assume qualified (back-compat for places that only
  // have ELO). Callers that want the 菜雞 gate must supply `totalGames`.
  if (typeof totalGames === 'number' && totalGames < ROOKIE_MAX_GAMES) {
    return ROOKIE_TIER;
  }

  let rank: EloRank = ELO_RANKS[0];
  for (const r of ELO_RANKS) {
    // Respect ELO floor and (if provided) the tier's minimum game count
    if (elo >= r.min) {
      if (typeof totalGames !== 'number' || totalGames >= r.minGames) {
        rank = r;
      }
    }
  }
  return rank;
}

// ---------------------------------------------------------------------------
// Percentile-based leaderboard ranking
// ---------------------------------------------------------------------------

/** Spec-required distribution across the 5 ranked tiers (low → high). */
const TIER_DISTRIBUTION: readonly number[] = [0.15, 0.25, 0.30, 0.25, 0.15];

/** Minimal shape needed by `rankLeaderboard` — matches LeaderboardEntry. */
export interface RankInput {
  id: string;
  elo_rating: number;
  total_games: number;
}

/**
 * Compute each entry's tier using the spec's percentile distribution.
 *
 * Algorithm:
 *   1. Split entries into 菜雞 (< 30 games) and qualified.
 *   2. Sort qualified entries by ELO ascending.
 *   3. Slice into 5 bands (bottom → top): 15% / 25% / 30% / 25% / 15%.
 *      This yields bottom = 初學, top = 大師.
 *   4. Enforce the game-count floor: if the percentile places an entry in
 *      a tier whose `minGames` they haven't met, demote to the highest
 *      tier they qualify for. This prevents low-game ELO spikes from
 *      squatting in top tiers.
 */
export function rankLeaderboard(entries: readonly RankInput[]): Map<string, EloRank> {
  const result = new Map<string, EloRank>();

  const qualified: RankInput[] = [];
  for (const e of entries) {
    if (e.total_games < ROOKIE_MAX_GAMES) {
      result.set(e.id, ROOKIE_TIER);
    } else {
      qualified.push(e);
    }
  }

  if (qualified.length === 0) return result;

  // Sort ascending so the bottom percentile band maps to 初學 (index 0).
  const sorted = [...qualified].sort((a, b) => a.elo_rating - b.elo_rating);
  const total = sorted.length;

  // Compute cumulative upper-bound indices (exclusive) for each band.
  // e.g. for distribution [0.15, 0.25, 0.30, 0.25, 0.15] → cumulative
  // thresholds [0.15, 0.40, 0.70, 0.95, 1.00].
  const cumulative: number[] = [];
  let acc = 0;
  for (const pct of TIER_DISTRIBUTION) {
    acc += pct;
    cumulative.push(Math.round(acc * total));
  }
  // Ensure the last threshold covers the full array.
  cumulative[cumulative.length - 1] = total;

  sorted.forEach((entry, idx) => {
    // Find the first band whose cumulative index strictly exceeds idx.
    let tierIdx = 0;
    for (let i = 0; i < cumulative.length; i++) {
      if (idx < cumulative[i]) {
        tierIdx = i;
        break;
      }
    }

    let tier = ELO_RANKS[tierIdx];

    // Enforce game-count floor: demote if the player hasn't earned this tier.
    while (tierIdx > 0 && entry.total_games < tier.minGames) {
      tierIdx -= 1;
      tier = ELO_RANKS[tierIdx];
    }

    result.set(entry.id, tier);
  });

  return result;
}
