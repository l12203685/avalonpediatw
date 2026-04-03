/**
 * Google Sheets Analysis Service
 *
 * Connects to Google Sheets to load Avalon game data (2145+ games, 60+ players).
 * Provides parsed, cached data for the analysis API endpoints.
 *
 * Data sources:
 *   - 牌譜 sheet: per-game log with roles, missions, votes, outcomes
 *   - 同贏/同輸/贏相關/同贏-同輸: co-occurrence chemistry matrices
 *   - Aggregate stats from raw data columns
 */

import { sheets_v4, auth as gauth, sheets } from '@googleapis/sheets';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NEW_SHEET_ID = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';
const OLD_SHEET_ID = '13Mm_sZYQ9EOjrKd-NGLoIr_0B_t_KEMsb9tQEbU5oWE';

const CREDENTIALS_PATHS = [
  path.resolve(process.env.GOOGLE_SHEETS_CREDENTIALS || ''),
  path.resolve(process.env.HOME || process.env.USERPROFILE || '', '.claude/credentials/google_sheets_avalonpediatw.json'),
  path.resolve(__dirname, '../../../../..', '阿瓦隆百科/avalonpediatw-gs-api-credentials.json'),
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Role config: position in 配置 string maps to role name
const CONFIG_ROLE_ORDER = ['刺客', '娜美', '德魯', '奧伯', '派西', '梅林'] as const;
const ROLE_ABBR: Record<string, string> = {
  '刺客': '刺', '娜美': '娜', '德魯': '德',
  '奧伯': '奧', '派西': '派', '梅林': '梅', '忠臣': '忠',
};
const ABBR_TO_ROLE: Record<string, string> = Object.fromEntries(
  Object.entries(ROLE_ABBR).map(([k, v]) => [v, k]),
);

const RED_ROLES = new Set(['刺客', '娜美', '德魯', '奧伯']);
const BLUE_ROLES = new Set(['派西', '梅林', '忠臣']);

const MIN_GAMES_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeatRoles {
  [seat: string]: string;
}

export interface LakeParsed {
  holder: string;
  target: string;
}

export interface GameRow {
  id: string;             // 流水號
  config: string;         // 配置 (6-char role mapping)
  seatRoles: SeatRoles;
  outcome: string;        // 結果: 三紅, 三藍死, 三藍活
  redWin: boolean;
  blueWin: boolean;
  merlinKilled: boolean;
  // 1-1 team
  r11Seats: string[];
  r11Roles: string[];
  r11RedCount: number;
  r11BlueCount: number;
  r11HasMerlin: boolean;
  r11HasPercival: boolean;
  // Missions
  missions: MissionData[];
  // Lake
  lake1: LakeParsed | null;
  lake2: LakeParsed | null;
  lake3: LakeParsed | null;
  lake1HolderFaction: string;
  lake1TargetFaction: string;
  lake1HolderRole: string;
  lake1TargetRole: string;
  lake2HolderFaction: string;
  lake2TargetFaction: string;
  lake2HolderRole: string;
  lake2TargetRole: string;
  lake3HolderFaction: string;
  lake3TargetFaction: string;
  lake3HolderRole: string;
  lake3TargetRole: string;
  // Game state
  gameState: string;      // 局勢
  // Raw columns for round progression
  rounds: string[];       // 第一局~第五局 (藍/紅)
  roundResults: string[]; // 第一局成功失敗~第五局成功失敗 (ooo/oox etc.)
}

export interface MissionData {
  round: number;
  result: string;         // e.g. 'ooo', 'oox'
  fails: number;
  total: number;
}

export interface PlayerStats {
  name: string;
  totalGames: number;
  winRate: number;
  roleTheory: number;
  positionTheory: number;
  redWin: number;
  blueWin: number;          // derived: blue 3red + blue merlin alive
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
  values: number[][];  // [row][col], NaN for missing
}

export interface ChemistryData {
  coWin: ChemistryMatrix;      // 同贏
  coLose: ChemistryMatrix;     // 同輸
  winCorr: ChemistryMatrix;    // 贏相關
  coWinMinusLose: ChemistryMatrix; // 同贏-同輸
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

export interface AnalysisCache {
  gameRows: GameRow[];
  playerStats: PlayerStats[];
  chemistry: ChemistryData;
  overview: OverviewData;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Sheets client singleton
// ---------------------------------------------------------------------------

let sheetsClient: sheets_v4.Sheets | null = null;

function findCredentials(): string | null {
  for (const p of CREDENTIALS_PATHS) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function getSheetsClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

  // Option 1: Credentials JSON inline via env var (Render / cloud)
  const credJson = process.env.GOOGLE_SHEETS_CREDENTIALS_JSON;
  if (credJson) {
    try {
      const credentials = JSON.parse(credJson);
      const authClient = new gauth.GoogleAuth({ credentials, scopes });
      sheetsClient = sheets({ version: 'v4', auth: authClient });
      return sheetsClient;
    } catch (e) {
      console.error('[sheetsAnalysis] Failed to parse GOOGLE_SHEETS_CREDENTIALS_JSON:', e);
    }
  }

  // Option 2: Credentials file path
  const credPath = findCredentials();
  if (!credPath) {
    throw new Error(
      'Google Sheets credentials not found. Set GOOGLE_SHEETS_CREDENTIALS_JSON env var (JSON string) or GOOGLE_SHEETS_CREDENTIALS (file path)',
    );
  }

  const authClient = new gauth.GoogleAuth({ keyFile: credPath, scopes });
  sheetsClient = sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

// ---------------------------------------------------------------------------
// Low-level sheet reading
// ---------------------------------------------------------------------------

async function readSheet(
  spreadsheetId: string,
  range: string,
): Promise<string[][]> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return (res.data.values as string[][]) || [];
}

// ---------------------------------------------------------------------------
// Parsing helpers (ported from avalon_analysis.py)
// ---------------------------------------------------------------------------

function decodeConfig(config: string): SeatRoles {
  const seatRoles: SeatRoles = {};
  for (let i = 0; i < config.length && i < CONFIG_ROLE_ORDER.length; i++) {
    seatRoles[config[i]] = CONFIG_ROLE_ORDER[i];
  }
  // Fill remaining seats with 忠臣
  for (const s of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
    if (!(s in seatRoles)) {
      seatRoles[s] = '忠臣';
    }
  }
  return seatRoles;
}

function roleFaction(role: string): string {
  if (RED_ROLES.has(role)) return '紅方';
  if (BLUE_ROLES.has(role)) return '藍方';
  return '';
}

function parseLake(lakeStr: string): LakeParsed | null {
  if (!lakeStr || !lakeStr.includes('>')) return null;
  const cleaned = lakeStr.replace(/x/g, '');
  const parts = cleaned.split('>');
  if (parts.length === 2) {
    return { holder: parts[0].trim(), target: parts[1].trim() };
  }
  return null;
}

function countMissionFails(missionStr: string): number {
  if (!missionStr) return 0;
  return (missionStr.match(/x/g) || []).length;
}

function parsePercent(val: string): number {
  if (!val) return 0;
  const cleaned = val.replace(/%/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ---------------------------------------------------------------------------
// Data loading: 牌譜 (game log)
// ---------------------------------------------------------------------------

function parseHeaderIndex(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < headers.length; i++) {
    // If duplicate, keep first occurrence
    if (!map.has(headers[i])) {
      map.set(headers[i], i);
    }
  }
  return map;
}

async function loadGameLog(): Promise<GameRow[]> {
  const rows = await readSheet(NEW_SHEET_ID, '牌譜');
  if (rows.length < 2) return [];

  const headers = rows[0];
  const hIdx = parseHeaderIndex(headers);

  const col = (row: string[], name: string): string => {
    const idx = hIdx.get(name);
    if (idx === undefined) return '';
    return row[idx] || '';
  };

  const ROUND_NAMES = ['第一局', '第二局', '第三局', '第四局', '第五局'];
  const ROUND_RESULT_NAMES = [
    '第一局成功失敗', '第二局成功失敗', '第三局成功失敗',
    '第四局成功失敗', '第五局成功失敗',
  ];

  const gameRows: GameRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const id = col(row, '流水號').trim();
    if (!id) continue;

    const config = col(row, '配置').trim();
    if (config.length !== 6) continue;

    const seatRoles = decodeConfig(config);
    const outcome = col(row, '結果').trim();
    const redWin = outcome === '三紅';
    const blueWin = outcome === '三藍死' || outcome === '三藍活';
    const merlinKilled = outcome === '三藍死';

    // 1-1 team
    const r11Str = col(row, '1-1');
    const r11Seats = r11Str ? r11Str.split('') : [];
    const r11Roles = r11Seats.map(s => seatRoles[s] || '?');
    const r11RedCount = r11Roles.filter(r => RED_ROLES.has(r)).length;
    const r11BlueCount = r11Roles.filter(r => BLUE_ROLES.has(r)).length;
    const r11HasMerlin = r11Roles.includes('梅林');
    const r11HasPercival = r11Roles.includes('派西');

    // Missions
    const missions: MissionData[] = [];
    for (let m = 0; m < 5; m++) {
      const resultStr = col(row, ROUND_RESULT_NAMES[m]);
      if (!resultStr) continue;
      missions.push({
        round: m + 1,
        result: resultStr,
        fails: countMissionFails(resultStr),
        total: resultStr.length,
      });
    }

    // Lake
    const lake1 = parseLake(col(row, '首湖'));
    const lake2 = parseLake(col(row, '二湖'));
    const lake3 = parseLake(col(row, '三湖'));

    function lakeFactions(lake: LakeParsed | null): {
      holderFaction: string; targetFaction: string;
      holderRole: string; targetRole: string;
    } {
      if (!lake) return { holderFaction: '', targetFaction: '', holderRole: '', targetRole: '' };
      const holderRole = seatRoles[lake.holder] || '';
      const targetRole = seatRoles[lake.target] || '';
      return {
        holderFaction: holderRole ? roleFaction(holderRole) : '',
        targetFaction: targetRole ? roleFaction(targetRole) : '',
        holderRole,
        targetRole,
      };
    }

    const l1 = lakeFactions(lake1);
    const l2 = lakeFactions(lake2);
    const l3 = lakeFactions(lake3);

    // Round progression
    const rounds = ROUND_NAMES.map(name => col(row, name));
    const roundResults = ROUND_RESULT_NAMES.map(name => col(row, name));

    gameRows.push({
      id,
      config,
      seatRoles,
      outcome,
      redWin,
      blueWin,
      merlinKilled,
      r11Seats,
      r11Roles,
      r11RedCount,
      r11BlueCount,
      r11HasMerlin,
      r11HasPercival,
      missions,
      lake1, lake2, lake3,
      lake1HolderFaction: l1.holderFaction,
      lake1TargetFaction: l1.targetFaction,
      lake1HolderRole: l1.holderRole,
      lake1TargetRole: l1.targetRole,
      lake2HolderFaction: l2.holderFaction,
      lake2TargetFaction: l2.targetFaction,
      lake2HolderRole: l2.holderRole,
      lake2TargetRole: l2.targetRole,
      lake3HolderFaction: l3.holderFaction,
      lake3TargetFaction: l3.targetFaction,
      lake3HolderRole: l3.holderRole,
      lake3TargetRole: l3.targetRole,
      gameState: col(row, '局勢'),
      rounds,
      roundResults,
    });
  }

  return gameRows;
}

// ---------------------------------------------------------------------------
// Data loading: Aggregate stats (from sheet columns, ported from Python)
// ---------------------------------------------------------------------------

async function loadPlayerStats(): Promise<PlayerStats[]> {
  // The aggregate stats live in a separate sheet or we derive from the raw data sheet
  // Try reading from the sheet that has the tab-separated aggregate format
  // The Python script reads from avalon_stats_raw.txt, but the same data may be
  // available as a sheet tab. We'll try the "統計" or equivalent tab first.

  // Attempt to read from a stats-oriented tab
  let rows: string[][] = [];
  const tabNames = ['統計', '個人統計', 'Stats'];
  for (const tab of tabNames) {
    try {
      rows = await readSheet(NEW_SHEET_ID, tab);
      if (rows.length > 2) break;
    } catch {
      // tab doesn't exist, try next
    }
  }

  // If no dedicated stats tab, derive from game log
  if (rows.length < 2) {
    return derivePlayerStatsFromGameLog(await getGameRows());
  }

  return parseStatsSheet(rows);
}

function parseStatsSheet(rows: string[][]): PlayerStats[] {
  if (rows.length < 2) return [];

  const headers = rows[0];
  const hIdx = parseHeaderIndex(headers);
  const col = (row: string[], name: string): string => {
    const idx = hIdx.get(name);
    if (idx === undefined) return '';
    return row[idx] || '';
  };

  const players: PlayerStats[] = [];
  const ROLES = ['刺客', '娜美', '德魯', '奧伯', '派西', '梅林', '忠臣'];
  const SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = (row[0] || '').trim();
    if (!name) continue;

    const totalGames = parseFloat(col(row, '總場次')) || 0;
    if (totalGames === 0) continue;

    const roleWinRates: Record<string, number> = {};
    const roleDistribution: Record<string, number> = {};
    const rawRoleGames: Record<string, number> = {};

    for (const role of ROLES) {
      // Try various header patterns
      roleWinRates[role] = parsePercent(col(row, role) || col(row, `wr_${role}`));
      roleDistribution[role] = parsePercent(col(row, `dist_${role}`) || '0');
      rawRoleGames[role] = parseFloat(col(row, `raw_${role}`)) || 0;
    }

    const seatWinRates: Record<string, number> = {};
    const seatRedWinRates: Record<string, number> = {};
    const seatBlueWinRates: Record<string, number> = {};
    for (const s of SEATS) {
      seatWinRates[s] = parsePercent(col(row, `${s}勝`) || '0');
      seatRedWinRates[s] = parsePercent(col(row, `${s}紅勝`) || '0');
      seatBlueWinRates[s] = parsePercent(col(row, `${s}藍勝`) || '0');
    }

    players.push({
      name,
      totalGames,
      winRate: parsePercent(col(row, '勝率')),
      roleTheory: parsePercent(col(row, '角色理論')),
      positionTheory: parsePercent(col(row, '位置理論')),
      redWin: parsePercent(col(row, '紅勝')),
      blueWin: 0, // computed below
      red3Red: parsePercent(col(row, '紅方三紅')),
      redMerlinDead: parsePercent(col(row, '紅方梅死')),
      redMerlinAlive: parsePercent(col(row, '紅方梅活')),
      blue3Red: parsePercent(col(row, '藍方三紅')),
      blueMerlinDead: parsePercent(col(row, '藍方梅死')),
      blueMerlinAlive: parsePercent(col(row, '藍方梅活')),
      roleWinRates,
      roleDistribution,
      redRoleRate: parsePercent(col(row, '紅角率')),
      blueRoleRate: parsePercent(col(row, '藍角率')),
      seatWinRates,
      seatRedWinRates,
      seatBlueWinRates,
      rawRoleGames,
      rawRedWins: parseFloat(col(row, '紅勝')) || 0,
      rawBlueWins: parseFloat(col(row, '藍勝')) || 0,
      rawTotalWins: parseFloat(col(row, '總勝')) || 0,
      rawRedGames: parseFloat(col(row, '紅場')) || 0,
      rawBlueGames: parseFloat(col(row, '藍場')) || 0,
    });
  }

  // Derive blueWin for each player
  for (const p of players) {
    if (p.rawBlueGames > 0 && p.rawBlueWins > 0) {
      p.blueWin = Math.round((p.rawBlueWins / p.rawBlueGames) * 100 * 10) / 10;
    }
  }

  return players;
}

/** Fallback: derive player stats from game rows when no stats sheet exists. */
function derivePlayerStatsFromGameLog(games: GameRow[]): PlayerStats[] {
  // Build per-player tallies from game log
  const playerMap = new Map<string, {
    games: number; wins: number;
    redGames: number; redWins: number;
    blueGames: number; blueWins: number;
    roleGames: Record<string, number>;
    roleWins: Record<string, number>;
    seatGames: Record<string, number>;
    seatWins: Record<string, number>;
    merlinKills: number; merlinGamesAsRed: number;
  }>();

  for (const g of games) {
    // Each seat is a "player" identified by seat number for now
    // In reality we need player name columns. Without them, we can only aggregate game-level stats.
    // This fallback provides game-level overview only.
  }

  // Since we don't have player names per seat in the game log easily,
  // return empty and rely on overview computation from game rows
  return [];
}

// ---------------------------------------------------------------------------
// Data loading: Chemistry matrices
// ---------------------------------------------------------------------------

async function loadChemistryMatrices(): Promise<ChemistryData> {
  const sheetNames = ['同贏', '同輸', '贏相關', '同贏-同輸'] as const;
  const keys = ['coWin', 'coLose', 'winCorr', 'coWinMinusLose'] as const;

  const result: Record<string, ChemistryMatrix> = {};

  for (let i = 0; i < sheetNames.length; i++) {
    const rows = await readSheet(NEW_SHEET_ID, sheetNames[i]);
    if (rows.length < 2) {
      result[keys[i]] = { players: [], values: [] };
      continue;
    }

    const players = rows[0].slice(1).filter(Boolean);
    const values: number[][] = [];

    for (let r = 1; r < rows.length; r++) {
      if (!rows[r][0]) continue;
      const rowVals = rows[r].slice(1).map(v => {
        const cleaned = (v || '').replace(/%/g, '').trim();
        const num = parseFloat(cleaned);
        return isNaN(num) ? NaN : num;
      });
      values.push(rowVals);
    }

    result[keys[i]] = { players, values };
  }

  return result as unknown as ChemistryData;
}

// ---------------------------------------------------------------------------
// Computed analysis (ported from Python)
// ---------------------------------------------------------------------------

function computeOverview(games: GameRow[], players: PlayerStats[]): OverviewData {
  const totalGames = games.length;
  const redWins = games.filter(g => g.redWin).length;
  const blueWins = games.filter(g => g.blueWin).length;
  const merlinKills = games.filter(g => g.merlinKilled).length;

  // Unique player count from player stats, or approximate from game count
  const totalPlayers = players.length || 0;

  const significantPlayers = players.filter(p => p.totalGames >= MIN_GAMES_THRESHOLD);

  const topByWinRate = [...significantPlayers]
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 10)
    .map(p => ({ name: p.name, winRate: p.winRate, games: p.totalGames }));

  const topByGames = [...players]
    .sort((a, b) => b.totalGames - a.totalGames)
    .slice(0, 10)
    .map(p => ({ name: p.name, games: p.totalGames, winRate: p.winRate }));

  return {
    totalGames,
    totalPlayers,
    redWinRate: totalGames > 0 ? Math.round((redWins / totalGames) * 1000) / 10 : 0,
    blueWinRate: totalGames > 0 ? Math.round((blueWins / totalGames) * 1000) / 10 : 0,
    merlinKillRate: blueWins > 0 ? Math.round((merlinKills / (merlinKills + (blueWins - merlinKills))) * 1000) / 10 : 0,
    topPlayersByWinRate: topByWinRate,
    topPlayersByGames: topByGames,
  };
}

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------

let cache: AnalysisCache | null = null;

function isCacheValid(): boolean {
  if (!cache) return false;
  return Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

async function getGameRows(): Promise<GameRow[]> {
  if (isCacheValid()) return cache!.gameRows;
  await refreshCache();
  return cache!.gameRows;
}

async function refreshCache(): Promise<AnalysisCache> {
  const [gameRows, playerStats, chemistry] = await Promise.all([
    loadGameLog(),
    loadPlayerStats(),
    loadChemistryMatrices(),
  ]);

  const overview = computeOverview(gameRows, playerStats);

  cache = {
    gameRows,
    playerStats,
    chemistry,
    overview,
    fetchedAt: Date.now(),
  };

  return cache;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getOverview(): Promise<OverviewData> {
  if (isCacheValid()) return cache!.overview;
  const c = await refreshCache();
  return c.overview;
}

export async function getAllPlayerStats(): Promise<PlayerStats[]> {
  if (isCacheValid()) return cache!.playerStats;
  const c = await refreshCache();
  return c.playerStats;
}

export async function getPlayerByName(name: string): Promise<PlayerStats | null> {
  const players = await getAllPlayerStats();
  return players.find(p => p.name === name) || null;
}

export async function getChemistry(): Promise<ChemistryData> {
  if (isCacheValid()) return cache!.chemistry;
  const c = await refreshCache();
  return c.chemistry;
}

export async function getMissionAnalysis(): Promise<{
  missionPassRates: Array<{ round: number; passRate: number; totalGames: number }>;
  failDistribution: Array<{ fails: number; count: number; percentage: number }>;
  missionOutcomeByRound: Array<{ round: number; allPass: number; oneFail: number; twoFail: number; total: number }>;
}> {
  const games = await getGameRows();

  // Pass rate per mission round
  const missionPassRates: Array<{ round: number; passRate: number; totalGames: number }> = [];
  for (let r = 1; r <= 5; r++) {
    const withMission = games.filter(g => g.missions.some(m => m.round === r));
    if (withMission.length === 0) continue;
    const passed = withMission.filter(g => {
      const m = g.missions.find(m2 => m2.round === r);
      return m && m.fails === 0;
    }).length;
    missionPassRates.push({
      round: r,
      passRate: Math.round((passed / withMission.length) * 1000) / 10,
      totalGames: withMission.length,
    });
  }

  // Fail distribution across all missions
  const failCounts = new Map<number, number>();
  for (const g of games) {
    for (const m of g.missions) {
      failCounts.set(m.fails, (failCounts.get(m.fails) || 0) + 1);
    }
  }
  const totalMissions = [...failCounts.values()].reduce((a, b) => a + b, 0);
  const failDistribution = [...failCounts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([fails, count]) => ({
      fails,
      count,
      percentage: totalMissions > 0 ? Math.round((count / totalMissions) * 1000) / 10 : 0,
    }));

  // Per-round outcome breakdown
  const missionOutcomeByRound: Array<{ round: number; allPass: number; oneFail: number; twoFail: number; total: number }> = [];
  for (let r = 1; r <= 5; r++) {
    const withMission = games.filter(g => g.missions.some(m => m.round === r));
    if (withMission.length === 0) continue;
    let allPass = 0, oneFail = 0, twoFail = 0;
    for (const g of withMission) {
      const m = g.missions.find(m2 => m2.round === r);
      if (!m) continue;
      if (m.fails === 0) allPass++;
      else if (m.fails === 1) oneFail++;
      else twoFail++;
    }
    missionOutcomeByRound.push({ round: r, allPass, oneFail, twoFail, total: withMission.length });
  }

  return { missionPassRates, failDistribution, missionOutcomeByRound };
}

export async function getLakeAnalysis(): Promise<{
  perLake: Array<{
    lake: string;
    totalGames: number;
    holderStats: Array<{ faction: string; games: number; redWinRate: number }>;
    comboStats: Array<{ holderFaction: string; targetFaction: string; games: number; redWinRate: number }>;
  }>;
  holderRoleStats: Array<{ role: string; games: number; redWinRate: number; blueWinRate: number }>;
  targetRoleStats: Array<{ role: string; games: number; redWinRate: number }>;
}> {
  const games = await getGameRows();

  const lakeConfigs = [
    { key: 'lake1', label: '首湖', holderFactionKey: 'lake1HolderFaction' as const, targetFactionKey: 'lake1TargetFaction' as const, holderRoleKey: 'lake1HolderRole' as const, targetRoleKey: 'lake1TargetRole' as const },
    { key: 'lake2', label: '二湖', holderFactionKey: 'lake2HolderFaction' as const, targetFactionKey: 'lake2TargetFaction' as const, holderRoleKey: 'lake2HolderRole' as const, targetRoleKey: 'lake2TargetRole' as const },
    { key: 'lake3', label: '三湖', holderFactionKey: 'lake3HolderFaction' as const, targetFactionKey: 'lake3TargetFaction' as const, holderRoleKey: 'lake3HolderRole' as const, targetRoleKey: 'lake3TargetRole' as const },
  ];

  const perLake: Array<{
    lake: string;
    totalGames: number;
    holderStats: Array<{ faction: string; games: number; redWinRate: number }>;
    comboStats: Array<{ holderFaction: string; targetFaction: string; games: number; redWinRate: number }>;
  }> = [];

  for (const lc of lakeConfigs) {
    const subset = games.filter(g => g[lc.holderFactionKey] !== '');
    if (subset.length === 0) continue;

    // Group by holder faction
    const holderGroups = new Map<string, { count: number; redWins: number }>();
    for (const g of subset) {
      const faction = g[lc.holderFactionKey];
      const entry = holderGroups.get(faction) || { count: 0, redWins: 0 };
      entry.count++;
      if (g.redWin) entry.redWins++;
      holderGroups.set(faction, entry);
    }

    const holderStats = [...holderGroups.entries()].map(([faction, { count, redWins }]) => ({
      faction,
      games: count,
      redWinRate: Math.round((redWins / count) * 1000) / 10,
    }));

    // Group by holder x target faction combo
    const comboGroups = new Map<string, { count: number; redWins: number }>();
    for (const g of subset) {
      const key = `${g[lc.holderFactionKey]}|${g[lc.targetFactionKey]}`;
      const entry = comboGroups.get(key) || { count: 0, redWins: 0 };
      entry.count++;
      if (g.redWin) entry.redWins++;
      comboGroups.set(key, entry);
    }

    const comboStats = [...comboGroups.entries()].map(([key, { count, redWins }]) => {
      const [holderFaction, targetFaction] = key.split('|');
      return {
        holderFaction,
        targetFaction,
        games: count,
        redWinRate: Math.round((redWins / count) * 1000) / 10,
      };
    });

    perLake.push({ lake: lc.label, totalGames: subset.length, holderStats, comboStats });
  }

  // Holder role stats (首湖 only, matching Python)
  const lake1Games = games.filter(g => g.lake1HolderFaction !== '');
  const holderRoleGroups = new Map<string, { count: number; redWins: number; blueWins: number }>();
  for (const g of lake1Games) {
    const role = g.lake1HolderRole;
    if (!role) continue;
    const entry = holderRoleGroups.get(role) || { count: 0, redWins: 0, blueWins: 0 };
    entry.count++;
    if (g.redWin) entry.redWins++;
    if (g.blueWin) entry.blueWins++;
    holderRoleGroups.set(role, entry);
  }
  const holderRoleStats = [...holderRoleGroups.entries()].map(([role, { count, redWins, blueWins }]) => ({
    role,
    games: count,
    redWinRate: Math.round((redWins / count) * 1000) / 10,
    blueWinRate: Math.round((blueWins / count) * 1000) / 10,
  }));

  // Target role stats
  const targetRoleGroups = new Map<string, { count: number; redWins: number }>();
  for (const g of lake1Games) {
    const role = g.lake1TargetRole;
    if (!role) continue;
    const entry = targetRoleGroups.get(role) || { count: 0, redWins: 0 };
    entry.count++;
    if (g.redWin) entry.redWins++;
    targetRoleGroups.set(role, entry);
  }
  const targetRoleStats = [...targetRoleGroups.entries()].map(([role, { count, redWins }]) => ({
    role,
    games: count,
    redWinRate: Math.round((redWins / count) * 1000) / 10,
  }));

  return { perLake, holderRoleStats, targetRoleStats };
}

export async function getRoundsAnalysis(): Promise<{
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
}> {
  const games = await getGameRows();

  // Vision stats (R1-1)
  const valid = games.filter(g => g.r11Seats.length > 0);

  const merlinIn = valid.filter(g => g.r11HasMerlin);
  const merlinOut = valid.filter(g => !g.r11HasMerlin);
  const percIn = valid.filter(g => g.r11HasPercival);
  const percOut = valid.filter(g => !g.r11HasPercival);

  function mission1PassRate(gs: GameRow[]): number {
    if (gs.length === 0) return 0;
    const passed = gs.filter(g => {
      const m = g.missions.find(m2 => m2.round === 1);
      return m && m.fails === 0;
    }).length;
    return Math.round((passed / gs.length) * 1000) / 10;
  }

  function redWinRate(gs: GameRow[]): number {
    if (gs.length === 0) return 0;
    return Math.round((gs.filter(g => g.redWin).length / gs.length) * 1000) / 10;
  }

  function blueWinRate(gs: GameRow[]): number {
    if (gs.length === 0) return 0;
    return Math.round((gs.filter(g => g.blueWin).length / gs.length) * 1000) / 10;
  }

  const visionStats = {
    merlinInTeam: {
      games: merlinIn.length,
      mission1PassRate: mission1PassRate(merlinIn),
      redWinRate: redWinRate(merlinIn),
      blueWinRate: blueWinRate(merlinIn),
    },
    merlinNotInTeam: {
      games: merlinOut.length,
      mission1PassRate: mission1PassRate(merlinOut),
      redWinRate: redWinRate(merlinOut),
      blueWinRate: blueWinRate(merlinOut),
    },
    percivalInTeam: {
      games: percIn.length,
      mission1PassRate: mission1PassRate(percIn),
      redWinRate: redWinRate(percIn),
    },
    percivalNotInTeam: {
      games: percOut.length,
      mission1PassRate: mission1PassRate(percOut),
      redWinRate: redWinRate(percOut),
    },
  };

  // Red count in R1-1
  const redCountGroups = new Map<number, GameRow[]>();
  for (const g of valid) {
    const arr = redCountGroups.get(g.r11RedCount) || [];
    arr.push(g);
    redCountGroups.set(g.r11RedCount, arr);
  }
  const redInR11 = [...redCountGroups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([redCount, gs]) => ({
      redCount,
      games: gs.length,
      mission1PassRate: mission1PassRate(gs),
      redWinRate: redWinRate(gs),
    }));

  // Mission 1 branching
  const withM1 = games.filter(g => g.roundResults[0] && g.roundResults[0].length > 0);
  const m1Passed = withM1.filter(g => countMissionFails(g.roundResults[0]) === 0);
  const m1Failed = withM1.filter(g => countMissionFails(g.roundResults[0]) > 0);

  function merlinKillRate(gs: GameRow[]): number {
    if (gs.length === 0) return 0;
    return Math.round((gs.filter(g => g.merlinKilled).length / gs.length) * 1000) / 10;
  }

  const mission1Branch = [
    { passed: true, games: m1Passed.length, redWinRate: redWinRate(m1Passed), merlinKillRate: merlinKillRate(m1Passed) },
    { passed: false, games: m1Failed.length, redWinRate: redWinRate(m1Failed), merlinKillRate: merlinKillRate(m1Failed) },
  ];

  // Round progression (藍/紅 per round)
  const ROUND_LABELS = ['第一局', '第二局', '第三局', '第四局', '第五局'];
  const roundProgression: Record<string, { bluePct: number; redPct: number; total: number }> = {};
  for (let r = 0; r < 5; r++) {
    const withRound = games.filter(g => g.rounds[r] && g.rounds[r].length > 0);
    if (withRound.length === 0) continue;
    const blueCount = withRound.filter(g => g.rounds[r] === '藍').length;
    const redCount = withRound.filter(g => g.rounds[r] === '紅').length;
    roundProgression[ROUND_LABELS[r]] = {
      bluePct: Math.round((blueCount / withRound.length) * 1000) / 10,
      redPct: Math.round((redCount / withRound.length) * 1000) / 10,
      total: withRound.length,
    };
  }

  // Game states (局勢) - top 20
  const stateGroups = new Map<string, { count: number; redWins: number }>();
  for (const g of games) {
    if (!g.gameState) continue;
    const entry = stateGroups.get(g.gameState) || { count: 0, redWins: 0 };
    entry.count++;
    if (g.redWin) entry.redWins++;
    stateGroups.set(g.gameState, entry);
  }
  const gameStates = [...stateGroups.entries()]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20)
    .map(([state, { count, redWins }]) => ({
      state,
      games: count,
      redWinRate: Math.round((redWins / count) * 1000) / 10,
    }));

  return { visionStats, redInR11, mission1Branch, roundProgression, gameStates };
}

/** Force cache invalidation (e.g. after manual data update). */
export function invalidateCache(): void {
  cache = null;
}

/** Check if the service can connect to Sheets. */
export function isSheetsReady(): boolean {
  try {
    findCredentials();
    return !!findCredentials();
  } catch {
    return false;
  }
}
