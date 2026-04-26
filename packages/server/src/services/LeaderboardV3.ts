/**
 * LeaderboardV3 — Edward 8-metric leaderboard (2026-04-26 22:41)
 * + Bayesian shrinkage (P2)
 * + 角色×位置 精準 metric (P2 進階)
 *
 * Data source: analysis_cache.json (rebuilt from 2146 raw 牌譜).
 *
 * 入場門檻 (Edward verbatim 22:41)：
 *   - 能力角 (刺/娜/德/奧/派/梅) ≥ 3 場 each
 *   - 忠臣 ≥ 15 場
 *
 * 8 metric (對齊 Edward 22:41 verbatim, 紅角 only / 藍角 only / 加權)：
 *   1 三紅      = mean (rate of 三紅 outcome | player on red role)
 *   2 三藍死    = mean (rate of 三藍死 outcome | player on red role)
 *   3 三藍活    = mean (rate of 三藍活 outcome | player on blue role)
 *   4 紅勝      = 1 + 2  (衍生)
 *   5 藍勝      = 3      (衍生 — 同 metric 3)
 *   6 三藍      = 三藍死(藍角) + 三藍活(藍角)
 *   7 任務勝    = Σ 紅角 三紅率·P(red) + Σ 藍角 三藍率·P(blue)
 *   8 期望勝    = Σ 紅角 紅勝率·P(red) + Σ 藍角 藍勝率·P(blue)
 *
 * Bayesian shrinkage (P2)：對每個 metric 算 raw + shrunk 兩個版本：
 *   posterior_rate = (n × sample_rate + α × global_rate) / (n + α)，α=10
 *
 * 角色×位置 精準 metric (P2 進階, Edward 22:45 verbatim)：
 *   expected_rate(p) = Σ_role Σ_seat P(role) × P(seat) × actual_rate(p, role, seat)
 *   - P(role) by 10p config: 刺/娜/德/奧/派/梅 各 1/10, 忠臣 4/10
 *   - P(seat) = 1/10
 *   - actual_rate(p, role, seat) 套 Bayesian shrinkage（cell-level）
 */

import type { PlayerStats } from './sheetsAnalysis';
import { getAllPlayerStats, isSheetsReady } from './sheetsAnalysis';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ABILITY_ROLES = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林'] as const;
const RED_ROLES = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫'] as const;
const BLUE_ROLES = ['派西維爾', '梅林', '忠臣'] as const;
const ALL_ROLES = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'] as const;

/** Bayesian shrinkage pseudo-count (Edward spec α=10) */
const SHRINK_ALPHA = 10;

/** Cell-level shrinkage uses larger α since cells are smaller (sample variance ↑) */
const CELL_SHRINK_ALPHA = 5;

/** Edward 2026-04-26 22:41: 能力角 floor (each of 刺/娜/德/奧/派/梅) */
const MIN_ABILITY_ROLE_GAMES = 3;
/** Edward 2026-04-26 22:41: 忠臣 floor */
const MIN_LOYAL_GAMES = 15;

/** Total seats in standard 10p Avalon */
const TOTAL_SEATS = 10;

/** P(role) for 10p config — 6 fixed ability roles + 4 loyalists */
const ROLE_PROBABILITY: Record<string, number> = {
  刺客: 1 / 10,
  莫甘娜: 1 / 10,
  莫德雷德: 1 / 10,
  奧伯倫: 1 / 10,
  派西維爾: 1 / 10,
  梅林: 1 / 10,
  忠臣: 4 / 10,
};

/** P(seat) = 1/10 */
const SEAT_PROBABILITY = 1 / TOTAL_SEATS;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * 8 metric per player + raw + shrunk versions.
 * All rates are in 0-100 scale (% basis), rounded to 1 decimal.
 */
export interface LeaderboardV3Entry {
  playerId: string;
  displayName: string;
  totalGames: number;
  redGames: number;
  blueGames: number;
  /** redRoleRate as fraction 0-1 (P_R) */
  pRed: number;
  /** blueRoleRate as fraction 0-1 (P_B) */
  pBlue: number;

  /** Raw (sample) 8 metrics */
  raw: EightMetrics;
  /** Shrunk (Bayesian posterior, α=10 toward global mean) 8 metrics */
  shrunk: EightMetrics;

  /**
   * 角色×位置 精準 metric (Edward 22:45)：weighted sum of per-cell shrunk win-rate.
   * Reported as % (0-100). null if 任意 cell 完全無資料 (defensive — 198 玩家 dataset 不會發生).
   */
  precisionWinRate: number | null;
  /** Number of (role, seat) cells player has played (max 70) */
  cellsCovered: number;
}

export interface EightMetrics {
  /** 1. 三紅 — rate of 三紅 outcome when player on red role (0-100) */
  threeRedOnRed: number;
  /** 2. 三藍死 — rate when player on red role */
  threeBlueDeadOnRed: number;
  /** 3. 三藍活 — rate when player on blue role */
  threeBlueAliveOnBlue: number;
  /** 4. 紅勝 — = 三紅 + 三藍死 (紅角立場勝率, 衍生) */
  redWinOnRed: number;
  /** 5. 藍勝 — = 三藍活 (藍角立場勝率, 衍生 = 同 metric 3) */
  blueWinOnBlue: number;
  /** 6. 三藍 — = 三藍死(藍角) + 三藍活(藍角) (任務防禦) */
  threeBlueOnBlue: number;
  /** 7. 任務勝 — Σ_R 三紅·P_R + Σ_B 三藍率·P_B (任務戰績全角加權) */
  missionWin: number;
  /** 8. 期望勝 — Σ_R 紅勝·P_R + Σ_B 藍勝·P_B (傳統獲勝全角加權) */
  expectedWin: number;
}

export interface LeaderboardV3Response {
  /** All players passing 入場門檻, sorted by shrunk.expectedWin desc */
  entries: LeaderboardV3Entry[];
  /** Population means used as Bayesian priors (for transparency) */
  globalMeans: {
    threeRedOnRed: number;
    threeBlueDeadOnRed: number;
    threeBlueAliveOnBlue: number;
    cellMean: number;
  };
  meta: {
    totalPlayers: number;
    eligiblePlayers: number;
    minAbilityRoleGames: number;
    minLoyalGames: number;
    shrinkAlpha: number;
    cellShrinkAlpha: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rnd1(n: number): number {
  return Math.round(n * 10) / 10;
}

// RED_ROLES / BLUE_ROLES reserved for future per-faction filters.
void RED_ROLES;
void BLUE_ROLES;

/**
 * 入場門檻檢查：每個能力角 ≥ 3 場 AND 忠臣 ≥ 15 場
 */
function isEligible(p: PlayerStats): boolean {
  for (const role of ABILITY_ROLES) {
    const games = p.rawRoleGames[role] ?? 0;
    if (games < MIN_ABILITY_ROLE_GAMES) return false;
  }
  const loyalGames = p.rawRoleGames['忠臣'] ?? 0;
  if (loyalGames < MIN_LOYAL_GAMES) return false;
  return true;
}

/**
 * Closed-form Bayesian shrinkage:
 *   posterior = (n·sample + α·prior) / (n + α)
 * Returns rate in same units as inputs (0-100 if % basis).
 */
function shrink(sampleRate: number, n: number, priorRate: number, alpha: number): number {
  if (n + alpha <= 0) return priorRate;
  return (n * sampleRate + alpha * priorRate) / (n + alpha);
}

// ---------------------------------------------------------------------------
// Per-player extended fields type (after our patched cache schema)
// ---------------------------------------------------------------------------

interface ExtendedPlayerStats extends PlayerStats {
  rawRedThreeRed?: number;
  rawRedMerlinDead?: number;
  rawRedMerlinAlive?: number;
  rawBlueThreeRed?: number;
  rawBlueMerlinDead?: number;
  rawBlueMerlinAlive?: number;
  roleSeatStats?: Record<string, { games: number; wins: number; winRate: number }>;
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute population priors:
 *   - global means for 三紅 / 三藍死 / 三藍活 (faction-conditional)
 *   - cell-level mean win rate (for precision metric prior)
 *
 * Uses count-weighted mean across all players (= overall sample rate).
 */
function computeGlobalMeans(players: ExtendedPlayerStats[]): {
  threeRedOnRed: number;
  threeBlueDeadOnRed: number;
  threeBlueDeadOnBlue: number;
  threeBlueAliveOnBlue: number;
  threeBlueOnBlue: number;
  cellMean: number;
} {
  let totalRedGames = 0;
  let totalRedThreeRed = 0;
  let totalRedThreeBlueDead = 0;
  let totalBlueGames = 0;
  let totalBlueThreeBlueDead = 0;
  let totalBlueThreeBlueAlive = 0;

  let totalCellGames = 0;
  let totalCellWins = 0;

  for (const p of players) {
    totalRedGames += p.rawRedGames ?? 0;
    totalRedThreeRed += p.rawRedThreeRed ?? 0;
    totalRedThreeBlueDead += p.rawRedMerlinDead ?? 0;
    totalBlueGames += p.rawBlueGames ?? 0;
    totalBlueThreeBlueDead += p.rawBlueMerlinDead ?? 0;
    totalBlueThreeBlueAlive += p.rawBlueMerlinAlive ?? 0;

    if (p.roleSeatStats) {
      for (const stats of Object.values(p.roleSeatStats)) {
        totalCellGames += stats.games;
        totalCellWins += stats.wins;
      }
    }
  }

  const threeBlueDeadOnBlue =
    totalBlueGames > 0 ? (totalBlueThreeBlueDead / totalBlueGames) * 100 : 0;
  const threeBlueAliveOnBlue =
    totalBlueGames > 0 ? (totalBlueThreeBlueAlive / totalBlueGames) * 100 : 0;
  return {
    threeRedOnRed: totalRedGames > 0 ? (totalRedThreeRed / totalRedGames) * 100 : 0,
    threeBlueDeadOnRed: totalRedGames > 0 ? (totalRedThreeBlueDead / totalRedGames) * 100 : 0,
    threeBlueDeadOnBlue,
    threeBlueAliveOnBlue,
    threeBlueOnBlue: threeBlueDeadOnBlue + threeBlueAliveOnBlue,
    cellMean: totalCellGames > 0 ? (totalCellWins / totalCellGames) * 100 : 0,
  };
}

/**
 * Compute 8 metrics (raw + shrunk) for a single player.
 */
function computeEightMetrics(
  p: ExtendedPlayerStats,
  globalMeans: ReturnType<typeof computeGlobalMeans>,
): { raw: EightMetrics; shrunk: EightMetrics; pRed: number; pBlue: number } {
  // pRed / pBlue from sample distribution (player's actual red vs blue mix)
  const totalGames = p.totalGames || 0;
  const pRed = totalGames > 0 ? (p.rawRedGames ?? 0) / totalGames : 0;
  const pBlue = totalGames > 0 ? (p.rawBlueGames ?? 0) / totalGames : 0;

  // Raw rates from cache (already %)
  const m1Raw = p.red3Red;
  const m2Raw = p.redMerlinDead;
  const m3Raw = p.blueMerlinAlive;
  const m4Raw = m1Raw + m2Raw; // 紅勝 (衍生)
  const m5Raw = m3Raw; // 藍勝 (衍生 = m3)
  const m6Raw = p.blueMerlinDead + p.blueMerlinAlive; // 三藍 (藍角) = 三藍死+三藍活 from blue side
  // m7 任務勝: 紅角 三紅率·P_R + 藍角 (三藍率)·P_B
  // 三藍率 (藍角立場) = blueMerlinDead + blueMerlinAlive (blue mission won)
  const blueThreeBlueRate = m6Raw;
  const m7Raw = m1Raw * pRed + blueThreeBlueRate * pBlue;
  // m8 期望勝: 紅角 紅勝率·P_R + 藍角 藍勝率·P_B
  const m8Raw = m4Raw * pRed + m5Raw * pBlue;

  // Shrunk versions — apply shrinkage to the 3 ATOMIC rates (m1, m2, m3),
  // then derive m4-m8 from shrunk atoms (consistency).
  const nRed = p.rawRedGames ?? 0;
  const nBlue = p.rawBlueGames ?? 0;
  const m1Shrunk = shrink(m1Raw, nRed, globalMeans.threeRedOnRed, SHRINK_ALPHA);
  const m2Shrunk = shrink(m2Raw, nRed, globalMeans.threeBlueDeadOnRed, SHRINK_ALPHA);
  const m3Shrunk = shrink(m3Raw, nBlue, globalMeans.threeBlueAliveOnBlue, SHRINK_ALPHA);

  // m6 三藍 (藍角) = 三藍死(藍角) + 三藍活(藍角).
  // Shrink each atom independently toward its own population mean, then sum.
  const blueDeadShrunk = shrink(
    p.blueMerlinDead,
    nBlue,
    globalMeans.threeBlueDeadOnBlue,
    SHRINK_ALPHA,
  );
  const m6Shrunk = blueDeadShrunk + m3Shrunk;

  const m4Shrunk = m1Shrunk + m2Shrunk;
  const m5Shrunk = m3Shrunk;
  const m7Shrunk = m1Shrunk * pRed + m6Shrunk * pBlue;
  const m8Shrunk = m4Shrunk * pRed + m5Shrunk * pBlue;

  const raw: EightMetrics = {
    threeRedOnRed: rnd1(m1Raw),
    threeBlueDeadOnRed: rnd1(m2Raw),
    threeBlueAliveOnBlue: rnd1(m3Raw),
    redWinOnRed: rnd1(m4Raw),
    blueWinOnBlue: rnd1(m5Raw),
    threeBlueOnBlue: rnd1(m6Raw),
    missionWin: rnd1(m7Raw),
    expectedWin: rnd1(m8Raw),
  };
  const shrunk: EightMetrics = {
    threeRedOnRed: rnd1(m1Shrunk),
    threeBlueDeadOnRed: rnd1(m2Shrunk),
    threeBlueAliveOnBlue: rnd1(m3Shrunk),
    redWinOnRed: rnd1(m4Shrunk),
    blueWinOnBlue: rnd1(m5Shrunk),
    threeBlueOnBlue: rnd1(m6Shrunk),
    missionWin: rnd1(m7Shrunk),
    expectedWin: rnd1(m8Shrunk),
  };
  return { raw, shrunk, pRed, pBlue };
}

/**
 * 角色×位置 精準 metric (Edward 22:45)
 *   expected_rate(p) = Σ_role Σ_seat P(role) × P(seat) × actual_rate(p, role, seat)
 *   actual_rate is shrunk (cell α=5 toward population cell mean).
 *
 * Returns {precisionWinRate (% 0-100), cellsCovered}.
 */
function computePrecisionMetric(
  p: ExtendedPlayerStats,
  cellPriorRate: number,
): { precisionWinRate: number; cellsCovered: number } {
  if (!p.roleSeatStats) {
    return { precisionWinRate: 0, cellsCovered: 0 };
  }

  let weightedSum = 0;
  let cellsCovered = 0;

  // Iterate the canonical (role × seat) grid so missing cells use prior alone.
  for (const role of ALL_ROLES) {
    const pRole = ROLE_PROBABILITY[role] ?? 0;
    if (pRole <= 0) continue;
    for (let seat = 1; seat <= TOTAL_SEATS; seat++) {
      const key = `${role}|${seat}`;
      const cell = p.roleSeatStats[key];
      const sampleRate = cell ? cell.winRate : cellPriorRate;
      const n = cell ? cell.games : 0;
      const cellShrunk = shrink(sampleRate, n, cellPriorRate, CELL_SHRINK_ALPHA);
      const w = pRole * SEAT_PROBABILITY;
      weightedSum += w * cellShrunk;
      if (cell && cell.games > 0) cellsCovered += 1;
    }
  }

  return { precisionWinRate: rnd1(weightedSum), cellsCovered };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _cache: { data: LeaderboardV3Response; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Get full v3 leaderboard.
 * Cached for 60s — analysis_cache.json is static, so this is essentially eternal
 * within a single deploy.
 */
export async function getLeaderboardV3(): Promise<LeaderboardV3Response> {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL_MS) return _cache.data;

  if (!isSheetsReady()) {
    return {
      entries: [],
      globalMeans: { threeRedOnRed: 0, threeBlueDeadOnRed: 0, threeBlueAliveOnBlue: 0, cellMean: 0 },
      meta: {
        totalPlayers: 0,
        eligiblePlayers: 0,
        minAbilityRoleGames: MIN_ABILITY_ROLE_GAMES,
        minLoyalGames: MIN_LOYAL_GAMES,
        shrinkAlpha: SHRINK_ALPHA,
        cellShrinkAlpha: CELL_SHRINK_ALPHA,
      },
    };
  }

  const allPlayers = (await getAllPlayerStats()) as ExtendedPlayerStats[];
  const globalMeans = computeGlobalMeans(allPlayers);

  const eligible = allPlayers.filter(isEligible);
  const entries: LeaderboardV3Entry[] = [];

  for (const p of eligible) {
    const { raw, shrunk, pRed, pBlue } = computeEightMetrics(p, globalMeans);
    const { precisionWinRate, cellsCovered } = computePrecisionMetric(p, globalMeans.cellMean);
    entries.push({
      playerId: p.name,
      displayName: p.name,
      totalGames: p.totalGames,
      redGames: p.rawRedGames ?? 0,
      blueGames: p.rawBlueGames ?? 0,
      pRed: rnd1(pRed * 100) / 100,
      pBlue: rnd1(pBlue * 100) / 100,
      raw,
      shrunk,
      precisionWinRate: cellsCovered > 0 ? precisionWinRate : null,
      cellsCovered,
    });
  }

  // Default sort: shrunk.expectedWin desc (matches Edward's metric 8 + shrinkage)
  entries.sort((a, b) => b.shrunk.expectedWin - a.shrunk.expectedWin);

  const response: LeaderboardV3Response = {
    entries,
    globalMeans: {
      threeRedOnRed: rnd1(globalMeans.threeRedOnRed),
      threeBlueDeadOnRed: rnd1(globalMeans.threeBlueDeadOnRed),
      threeBlueAliveOnBlue: rnd1(globalMeans.threeBlueAliveOnBlue),
      cellMean: rnd1(globalMeans.cellMean),
    },
    meta: {
      totalPlayers: allPlayers.length,
      eligiblePlayers: entries.length,
      minAbilityRoleGames: MIN_ABILITY_ROLE_GAMES,
      minLoyalGames: MIN_LOYAL_GAMES,
      shrinkAlpha: SHRINK_ALPHA,
      cellShrinkAlpha: CELL_SHRINK_ALPHA,
    },
  };

  _cache = { data: response, ts: now };
  return response;
}

/** Test/debug-only invalidation. */
export function invalidateLeaderboardV3Cache(): void {
  _cache = null;
}

