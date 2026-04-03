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
  values: (number | null)[][];
}

export interface ChemistryData {
  coWin: ChemistryMatrix;
  coLose: ChemistryMatrix;
  winCorr: ChemistryMatrix;
  coWinMinusLose: ChemistryMatrix;
}

export interface OverviewData {
  totalGames: number;
  totalPlayers: number;
  redWinRate: number;
  blueWinRate: number;
  merlinKillRate: number;
  topPlayersByWinRate: Array<{ name: string; winRate: number; games: number }>;
  topPlayersByGames: Array<{ name: string; games: number; winRate: number }>;
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
      holderStats: Array<{ faction: string; games: number; redWinRate: number }>;
      comboStats: Array<{ holderFaction: string; targetFaction: string; games: number; redWinRate: number }>;
    }>;
    holderRoleStats: Array<{ role: string; games: number; redWinRate: number; blueWinRate: number }>;
    targetRoleStats: Array<{ role: string; games: number; redWinRate: number }>;
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
