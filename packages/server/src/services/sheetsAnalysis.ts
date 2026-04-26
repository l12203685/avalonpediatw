/**
 * Analysis Cache Service
 *
 * Serves pre-computed Avalon game analysis from analysis_cache.json.
 * Zero parsing at runtime -- just JSON.parse and return.
 *
 * Cache is generated locally by generate_cache.py, committed to repo,
 * and deployed as a static file. Render free tier (512MB) handles this fine.
 */

import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlayerStats {
  name: string;
  totalGames: number;
  winRate: number;
  roleTheory: number;
  positionTheory: number;
  redWin: number;
  blueWin: number;
  red3Red: number;
  redMerlinDead: number;
  redMerlinAlive: number;
  blue3Red: number;
  blueMerlinDead: number;
  blueMerlinAlive: number;
  roleWinRates: Record<string, number>;
  roleDistribution: Record<string, number>;
  redRoleRate: number;
  blueRoleRate: number;
  seatWinRates: Record<string, number>;
  seatRedWinRates: Record<string, number>;
  seatBlueWinRates: Record<string, number>;
  rawRoleGames: Record<string, number>;
  rawRedWins: number;
  rawBlueWins: number;
  rawTotalWins: number;
  rawRedGames: number;
  rawBlueGames: number;
}

export interface ChemistryMatrix {
  players: string[];
  /**
   * Optional row labels (from the spreadsheet's first column of each row).
   * When present, the UI should use this for row headers instead of
   * `players` — the two arrays only align when the sheet is symmetric.
   * Older caches without this field fall back to `players`.
   */
  rowLabels?: string[];
  values: (number | null)[][];
}

export interface ChemistryData {
  coWin: ChemistryMatrix;
  coLose: ChemistryMatrix;
  winCorr: ChemistryMatrix;
  coWinMinusLose: ChemistryMatrix;
}

/**
 * Three-outcome breakdown — Edward 2026-04-26 spec:
 * fixed display order: 三紅 → 三藍死 → 三藍活
 * Pct values sum to ~100% (互斥). Used for any subset of games.
 */
export interface OutcomeBreakdown {
  threeRed: number;
  threeBlueDead: number;
  threeBlueAlive: number;
  threeRedPct: number;
  threeBlueDeadPct: number;
  threeBlueAlivePct: number;
}

export interface OverviewData {
  totalGames: number;
  totalPlayers: number;
  redWinRate: number;
  blueWinRate: number;
  merlinKillRate: number;
  outcomeBreakdown: OutcomeBreakdown;
  topPlayersByTheory: Array<{ name: string; roleTheory: number; winRate: number; games: number }>;
  topPlayersByGames: Array<{ name: string; games: number; winRate: number }>;
  seatPositionWinRates: Array<{
    seat: string;
    overallWinRate: number;
    totalGames: number;
    roles: Array<{ role: string; winRate: number; games: number }>;
  }>;
}

export interface SeatOrderPermutation {
  order: string;
  total: number;
  '\u4e09\u85cd\u6885\u6d3b': number;
  '\u4e09\u85cd\u6885\u6b7b': number;
  '\u4e09\u7d05': number;
  '\u7a7f\u63d2\u4efb\u52d9': number;
  redWinRate: number;
  blueWinRate: number;
  merlinKillRate: number;
  '\u7a7f\u63d2\u7387': number;
}

export interface SeatOrderData {
  permutations: SeatOrderPermutation[];
  totalGames: number;
  overallRedWinRate: number;
}

export interface CaptainMissionEntry {
  mission: number;
  redCaptainRate: number;
  blueCaptainRate: number;
  games: number;
}

export interface CaptainFactionVsOutcome {
  captainFaction: string;
  missionResult: 'pass' | 'fail';
  count: number;
  percentage: number;
}

export interface CaptainMissionGameWinRate {
  captainFaction: string;
  missionResult: 'pass' | 'fail';
  totalMissions: number;
  redGameWinRate: number;
  blueGameWinRate: number;
}

export interface CaptainAnalysisData {
  perMission: CaptainMissionEntry[];
  captainFactionVsOutcome: CaptainFactionVsOutcome[];
  captainMissionGameWinRates: CaptainMissionGameWinRate[];
}

// ---------------------------------------------------------------------------
// Panel A — 玩家 Archetype 雷達 (4 axes)
// ---------------------------------------------------------------------------
// Axes derived from per-player feature signature (loop 92 TSV):
//   honesty     — L141 lake_truthful_pct          (raw 0-100)
//   consistency — L142 proxy: 100 - anomaly_vote_rate * 5 (clipped)
//   stickiness  — L137 proxy: top role winrate    (raw 0-100)
//   flip        — L136 proxy: anomaly_vote_rate * 5 (clipped)
// hasData=false when player has <10 games (TSV cohort filter).

export interface ArchetypeAxes {
  honesty: number;
  consistency: number;
  stickiness: number;
  flip: number;
}

export interface ArchetypePlayerData {
  axes: ArchetypeAxes;
  /** percentile 0-100 vs same N>=10 cohort (50 = median). */
  percentiles: ArchetypeAxes;
  sampleSize: number;
  hasData: boolean;
}

export interface ArchetypeData {
  perPlayer: Record<string, ArchetypePlayerData>;
  cohort: {
    n: number;
    means: ArchetypeAxes;
    stds: ArchetypeAxes;
  };
  axisLabels: ArchetypeAxes & Record<string, string>;
  axisHelp: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Panel B — Strength Signature (per-role winrate × z-score)
// ---------------------------------------------------------------------------
export interface StrengthRoleEntry {
  role: string;
  /** null = sample below MIN_ROLE_SAMPLE for this player. */
  winRate: number | null;
  sampleSize: number;
  zScore: number | null;
  /** UI hint: 'high' (z>=0.5) | 'neutral' (-0.5<z<0.5) | 'low' (z<=-0.5) | 'insufficient'. */
  color: 'high' | 'neutral' | 'low' | 'insufficient';
}

export interface StrengthPlayerData {
  roles: StrengthRoleEntry[];
  /** Top 2 roles by zScore among scored cells. */
  topRoles: string[];
  /** Bottom 1 role by zScore among scored cells (only when >=3 scored). */
  bottomRoles: string[];
  hasData: boolean;
}

export interface StrengthData {
  perPlayer: Record<string, StrengthPlayerData>;
  cohort: {
    perRole: Record<string, { mean: number; std: number; n: number }>;
    minRoleSample: number;
    rolesOrder: string[];
  };
}

// ---------------------------------------------------------------------------
// Panel C — 對戰風格快照 (Playstyle Snapshot)
// ---------------------------------------------------------------------------
export interface PlaystyleSplit {
  red: number | null;
  blue: number | null;
}

export interface PlaystylePlayerData {
  /** R3+ reject rate per game-role camp (0-100). null when sample below threshold. */
  r3RejectRate: PlaystySplitOrNull;
  /** Cohort percentile (0-100) within N>=10 R3+ vote sample per camp. */
  r3RejectPercentile: PlaystySplitOrNull;
  /** Top 3 assassin target seats (1..10) by count; null when attempts<3. */
  assassinTopSeats: number[] | null;
  assassinAttempts: number;
  /** Captain stickiness % (same-team-next / total leader proposals); null when proposals<5. */
  captainStickiness: number | null;
  captainStickinessPercentile: number | null;
  sampleSize: number;
  hasData: boolean;
}

export type PlaystySplitOrNull = PlaystyleSplit;

export interface PlaystyleCohort {
  r3Red: { n: number; mean: number | null; std: number | null };
  r3Blue: { n: number; mean: number | null; std: number | null };
  captainStickiness: { n: number; mean: number | null; std: number | null };
  assassinAttempts: { n: number };
}

export interface PlaystyleData {
  perPlayer: Record<string, PlaystylePlayerData>;
  cohort: PlaystyleCohort;
  thresholds: {
    r3MinVotes: number;
    assassinMinAttempts: number;
    captainMinProposals: number;
  };
  labels: {
    r3RejectRedLabel: string;
    r3RejectBlueLabel: string;
    assassinTargetLabel: string;
    captainStickinessLabel: string;
  };
}

interface AnalysisCache {
  overview: OverviewData;
  players: { players: PlayerStats[]; total: number };
  playerDetails: Record<string, { player: PlayerStats; radar: Record<string, number> }>;
  chemistry: ChemistryData;
  missions: {
    missionPassRates: Array<{ round: number; passRate: number; totalGames: number }>;
    failDistribution: Array<{ fails: number; count: number; percentage: number }>;
    missionOutcomeByRound: Array<{ round: number; allPass: number; oneFail: number; twoFail: number; total: number }>;
  };
  lake: {
    perLake: Array<{
      lake: string;
      totalGames: number;
      holderStats: Array<{ faction: string; games: number; redWinRate: number; outcomes: OutcomeBreakdown }>;
      comboStats: Array<{ holderFaction: string; targetFaction: string; games: number; redWinRate: number; outcomes: OutcomeBreakdown }>;
    }>;
    holderRoleStats: Array<{ role: string; games: number; redWinRate: number; blueWinRate: number; outcomes: OutcomeBreakdown }>;
    targetRoleStats: Array<{ role: string; games: number; redWinRate: number; outcomes: OutcomeBreakdown }>;
    /** Per-lake detailed role stats (Fix #12) — present in current cache. */
    allLakeRoleStats?: Array<{
      lake: string;
      holderRoleStats: Array<{ role: string; games: number; redWinRate: number; blueWinRate: number; outcomes: OutcomeBreakdown }>;
      targetRoleStats: Array<{ role: string; games: number; redWinRate: number; outcomes: OutcomeBreakdown }>;
      sameFaction: { games: number; redWinRate: number; outcomes: OutcomeBreakdown };
      diffFaction: { games: number; redWinRate: number; outcomes: OutcomeBreakdown };
    }>;
  };
  rounds: {
    visionStats: {
      merlinInTeam: { games: number; mission1PassRate: number; redWinRate: number; blueWinRate: number };
      merlinNotInTeam: { games: number; mission1PassRate: number; redWinRate: number; blueWinRate: number };
      percivalInTeam: { games: number; mission1PassRate: number; redWinRate: number };
      percivalNotInTeam: { games: number; mission1PassRate: number; redWinRate: number };
    };
    redInR11: Array<{ redCount: number; games: number; mission1PassRate: number; redWinRate: number }>;
    mission1Branch: Array<{ passed: boolean; games: number; redWinRate: number; merlinKillRate: number }>;
    roundProgression: Record<string, { bluePct: number; redPct: number; total: number }>;
    gameStates: Array<{ state: string; games: number; redWinRate: number }>;
  };
  seatOrder?: SeatOrderData;
  captainAnalysis?: CaptainAnalysisData;
  archetype?: ArchetypeData;
  strength?: StrengthData;
  playstyle?: PlaystyleData;
}

// ---------------------------------------------------------------------------
// Cache loading
// ---------------------------------------------------------------------------

const CACHE_PATHS = [
  path.resolve(__dirname, '..', '..', 'analysis_cache.json'),
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'analysis_cache.json'),
];

let cache: AnalysisCache | null = null;

function loadCache(): AnalysisCache {
  if (cache) return cache;

  for (const p of CACHE_PATHS) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      cache = JSON.parse(raw) as AnalysisCache;
      console.log(`[sheetsAnalysis] Loaded analysis_cache.json from ${p}`);
      return cache;
    }
  }

  throw new Error(
    'analysis_cache.json not found. Run generate_cache.py locally to create it.',
  );
}

// ---------------------------------------------------------------------------
// Public API (matching existing function signatures)
// ---------------------------------------------------------------------------

export async function getOverview(): Promise<OverviewData> {
  return loadCache().overview;
}

export async function getAllPlayerStats(): Promise<PlayerStats[]> {
  return loadCache().players.players;
}

export async function getPlayerByName(name: string): Promise<PlayerStats | null> {
  const detail = loadCache().playerDetails[name];
  return detail ? detail.player : null;
}

export async function getChemistry(): Promise<ChemistryData> {
  return loadCache().chemistry;
}

export async function getMissionAnalysis(): Promise<AnalysisCache['missions']> {
  return loadCache().missions;
}

export async function getLakeAnalysis(): Promise<AnalysisCache['lake']> {
  return loadCache().lake;
}

export async function getRoundsAnalysis(): Promise<AnalysisCache['rounds']> {
  return loadCache().rounds;
}

export async function getSeatOrderAnalysis(): Promise<SeatOrderData> {
  const c = loadCache();
  if (!c.seatOrder) {
    return { permutations: [], totalGames: 0, overallRedWinRate: 0 };
  }
  return c.seatOrder;
}

export async function getCaptainAnalysis(): Promise<CaptainAnalysisData> {
  const c = loadCache();
  if (!c.captainAnalysis) {
    return { perMission: [], captainFactionVsOutcome: [], captainMissionGameWinRates: [] };
  }
  return c.captainAnalysis;
}

// ---------------------------------------------------------------------------
// Panel A / B accessors — used by /api/profile/:id/{archetype,strength}
// ---------------------------------------------------------------------------

/**
 * Lookup archetype data for a single player by analysis-cache key (display name).
 * Returns null when the player isn't tracked in the cache (e.g. brand-new
 * accounts with zero games). Players with N<10 games appear in the cache but
 * with `hasData: false` so the UI can render "資料不足".
 */
export async function getPlayerArchetype(name: string): Promise<{
  player: { name: string; totalGames: number };
  data: ArchetypePlayerData;
  cohort: ArchetypeData['cohort'];
  axisLabels: ArchetypeData['axisLabels'];
  axisHelp: ArchetypeData['axisHelp'];
} | null> {
  const c = loadCache();
  if (!c.archetype) return null;
  const data = c.archetype.perPlayer[name];
  if (!data) return null;
  const detail = c.playerDetails[name];
  return {
    player: {
      name,
      totalGames: detail ? detail.player.totalGames : data.sampleSize,
    },
    data,
    cohort:     c.archetype.cohort,
    axisLabels: c.archetype.axisLabels,
    axisHelp:   c.archetype.axisHelp,
  };
}

/**
 * Lookup strength signature data for a single player.
 * Returns null when the player isn't tracked. Per-role entries with sample
 * below `minRoleSample` (default 3) get `color: 'insufficient'`.
 */
export async function getPlayerStrength(name: string): Promise<{
  player: { name: string; totalGames: number };
  data: StrengthPlayerData;
  cohort: StrengthData['cohort'];
} | null> {
  const c = loadCache();
  if (!c.strength) return null;
  const data = c.strength.perPlayer[name];
  if (!data) return null;
  const detail = c.playerDetails[name];
  return {
    player: {
      name,
      totalGames: detail ? detail.player.totalGames : 0,
    },
    data,
    cohort: c.strength.cohort,
  };
}

/**
 * Lookup playstyle (Panel C) data for a single player.
 * Returns null when the player isn't tracked. Per-metric null inside the data
 * means insufficient sample for that specific signal (UI should hide that row).
 */
export async function getPlayerPlaystyle(name: string): Promise<{
  player: { name: string; totalGames: number };
  data: PlaystylePlayerData;
  cohort: PlaystyleCohort;
  thresholds: PlaystyleData['thresholds'];
  labels: PlaystyleData['labels'];
} | null> {
  const c = loadCache();
  if (!c.playstyle) return null;
  const data = c.playstyle.perPlayer[name];
  if (!data) return null;
  const detail = c.playerDetails[name];
  return {
    player: {
      name,
      totalGames: detail ? detail.player.totalGames : data.sampleSize,
    },
    data,
    cohort:     c.playstyle.cohort,
    thresholds: c.playstyle.thresholds,
    labels:     c.playstyle.labels,
  };
}

/** No-op: cache is static, no runtime invalidation needed. */
export function invalidateCache(): void {
  cache = null;
}

/** Always ready when cache file exists. */
export function isSheetsReady(): boolean {
  try {
    loadCache();
    return true;
  } catch {
    return false;
  }
}
