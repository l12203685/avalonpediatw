/**
 * Player tier system (hard-threshold by total games) — 3-tier UI utility.
 *
 * Edward 2026-04-26 12:32-12:35 — 砍 6-tier → 3-tier，chip 直接顯場數區間：
 *
 *   • `<100 場`     total_games  1-99    (under_100)
 *   • `100-199 場`  total_games  100-199 (mid_range)
 *   • `≥200 場`     total_games  ≥ 200   (over_200)
 *
 *  Edward 4 條反駁原話：
 *    1. 「總玩家人數之後一定會越來越多 所以應該直接以絕對總場數分就好」
 *       → 不用 percentile；切點以絕對 totalGames 計，玩家不會因新人加入「降級」。
 *    2. 「如果不要切這麼多塊 乾脆 少於100場|100~200|大於200場」
 *       → 6 tier 太多塊；改 3 tier。
 *    3. 「不要再 新手 中堅 高手 大師 這些屬於標籤 不是早就講過了」
 *       → 砍掉 abstract 命名；chip text 直接顯場數區間。
 *    4. 「而且應該要以我傳給你的2146場全部出現過的玩家」
 *       → leaderboard scope = Sheets 2146 場全部 distinct 玩家（Server side
 *          已不過濾，本檔僅負責 UI tier 切點）。
 *
 *  當前 62 玩家預期分佈 (median=152 落「100-199 場」)：~21 / ~15 / ~26
 *  跨 3 tier。
 *
 *  TODO (next wave): migrate Leaderboard / Analytics pages to consume the
 *  server's `computed_stats/{playerId}` documents which already carry
 *  `tierGroup` / `eloTag` / `theoreticalWinRate`. Once the `/api/leaderboard`
 *  response exposes those three fields per entry, replace this file with a
 *  thin adapter to the shared types.
 *
 *  `getEloRank(elo, totalGames?)` — single-player lookup. Tier is determined
 *    purely by `totalGames` (ELO no longer governs tier assignment); ELO is
 *    preserved in the data model and still drives list ordering.
 *
 *  `rankLeaderboard(entries)` — batch lookup, same rule.
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

/**
 * Three tiers (low → high) with hard `minGames` thresholds.
 *
 * `min` (ELO) is retained for back-compat with other call sites (badges etc.)
 * but is no longer consulted for tier assignment.
 *
 * Edward 2026-04-26 12:32-12:35 thresholds — **絕對固定切點 + 3 tier + 場數區間
 * 字面 label**（不再用 菜雞/初學/新手/中堅/高手/大師 abstract 命名）：
 *   `<100 場`    : 1-99
 *   `100-199 場` : 100-199
 *   `≥200 場`    : 200+
 */
export const ELO_RANKS: EloRank[] = [
  { label: '<100 場',    color: 'text-blue-400',   bgColor: 'bg-blue-900/40',   borderColor: 'border-blue-700',   min: 0,    minGames: 1   },
  { label: '100-199 場', color: 'text-purple-400', bgColor: 'bg-purple-900/40', borderColor: 'border-purple-700', min: 950,  minGames: 100 },
  { label: '≥200 場',    color: 'text-orange-400', bgColor: 'bg-orange-900/40', borderColor: 'border-orange-700', min: 1150, minGames: 200 },
];

/** All tiers low → high. Useful for filter UI. */
export const ALL_TIERS: EloRank[] = [...ELO_RANKS];

/**
 * Single-player tier lookup by total games.
 *
 * The `elo` parameter is kept for backward signature compatibility and may be
 * used by callers that want a rating label fallback, but tier assignment is
 * now driven exclusively by `totalGames`.
 *
 * When `totalGames` is undefined (legacy call sites with only ELO), we return
 * the lowest ranked tier (`<100 場`) so the UI remains stable for callers
 * that have not yet been wired to pass totalGames through.
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
  // totalGames === 0 — still show as bottom tier (chip never excludes 0-game players)
  return ELO_RANKS[0];
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
 * they satisfy. Ordering within a tier is the caller's responsibility
 * (LeaderboardPage sorts by ELO).
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
  return ELO_RANKS[0];
}
