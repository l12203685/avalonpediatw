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
  /**
   * Raw three-outcome counts per side (written by generate_cache.py since the
   * 三結果 rebuild; absent in older caches). `withFinalFields` derives the
   * two-stage fields below from these when the cache predates them.
   */
  rawRedThreeRed?: number;
  rawRedMerlinDead?: number;
  rawRedMerlinAlive?: number;
  rawBlueThreeRed?: number;
  rawBlueMerlinDead?: number;
  rawBlueMerlinAlive?: number;
  /**
   * Edward 2026-04-27 — per-seat three-outcome distribution. Optional for
   * cache backward compatibility; UI uses fallback when missing.
   */
  seatOutcomes?: Record<string, OutcomeBreakdown>;

  // --- Two-stage outcome contract (docs/stats/two_stage_outcome.md, 2026-10-12) ---
  // 任務結算 = 三紅 vs 三藍; 刺殺結算 = 三藍局是否刺中梅林;
  // 最終: 紅勝 = 三紅 + 三藍死, 藍勝 = 三藍活.
  // The legacy fields above (winRate / redWin / blueWin / roleWinRates /
  // seat*WinRates / roleTheory) keep the 任務結算 meaning (三藍死 counts as a
  // blue win) and are never reinterpreted.
  // Optional because a cache produced before schemaVersion 2 lacks them; the
  // served players always go through `withFinalFields`, which fills in every
  // field it can compute from the raw counts.

  /** (紅方場三紅 + 紅方場三藍死 + 藍方場三藍活) / 總場數, %. */
  finalWinRate?: number;
  /** (三紅 + 三藍死) / 紅方場數, %. 0 when the player never played red. */
  finalRedWinRate?: number;
  /** 三藍活 / 藍方場數, %. 0 when the player never played blue. */
  finalBlueWinRate?: number;
  /** (紅方場三紅 + 藍方場三藍死 + 藍方場三藍活) / 總場數, % — the old `winRate` semantics. */
  missionWinRate?: number;
  /** 藍方場且到達三藍時 三藍活 / (三藍活 + 三藍死), %; 0 when the denominator is 0 (see rawBlueThreeBlue). */
  merlinSurvivalRate?: number;
  /** Denominator of merlinSurvivalRate: 藍方場到達三藍的場數. */
  rawBlueThreeBlue?: number;
  /** Per-role final win rate (紅角 = 三紅 + 三藍死; 藍角 = 三藍活). Generator only. */
  roleFinalWinRates?: Record<string, number>;
  /** Σ_角色 本人該角色出現比例 × 全體該角色最終勝率. null when it cannot be computed. */
  expectedFinalWinRate?: number | null;
  /** finalWinRate − expectedFinalWinRate (may be negative). null when it cannot be computed; shown as "—". */
  excessWinRate?: number | null;
  /** Earliest / latest parsed game date, YYYY-MM-DD; "" when unknown. Generator only. */
  firstPlayed?: string;
  lastPlayed?: string;
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
  /**
   * Edward 2026-04-27 — outcomePair matrix only.
   * Optional aux matrices used to render the three-outcome split tooltip.
   * `values` holds threeRedPct; `threeBlueDeadPct` / `threeBlueAlivePct`
   * carry the remaining two outcomes for each pair cell.
   */
  threeBlueDeadPct?: (number | null)[][];
  threeBlueAlivePct?: (number | null)[][];
}

export interface ChemistryData {
  coWin: ChemistryMatrix;
  coLose: ChemistryMatrix;
  winCorr: ChemistryMatrix;
  coWinMinusLose: ChemistryMatrix;
  /**
   * Edward 2026-04-27 — 5th matrix added to the deep-analytics chemistry tab.
   * Per-pair outcome distribution (三紅 / 三藍死 / 三藍活) projected from the
   * coWin matrix. Optional for cache backward compatibility — older caches
   * predating this field still serve.
   */
  outcomePair?: ChemistryMatrix;
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

/** 任務結算: 三紅 = 紅方, 三藍 (死或活) = 藍方. */
export interface MissionStageSummary {
  games: number;
  threeRed: number;
  threeBlue: number;
  redPct: number;
  bluePct: number;
}

/** 刺殺結算 — only the 三藍 games: 三藍死 = 刺中, 三藍活 = 沒刺中. */
export interface AssassinationStageSummary {
  games: number;
  merlinKilled: number;
  merlinSurvived: number;
  killPct: number;
  survivePct: number;
}

/** 最終: 紅勝 = 三紅 + 三藍死, 藍勝 = 三藍活. */
export interface FinalOutcomeSummary {
  games: number;
  redWins: number;
  blueWins: number;
  redPct: number;
  bluePct: number;
}

export interface OverviewData {
  totalGames: number;
  totalPlayers: number;
  /** 任務結算 red share (三紅 / all), % — legacy meaning, kept. */
  redWinRate: number;
  /** 任務結算 blue share (三藍死 + 三藍活) / all, % — legacy meaning, kept. */
  blueWinRate: number;
  /** 三藍局刺中率, %. */
  merlinKillRate: number;
  outcomeBreakdown: OutcomeBreakdown;
  topPlayersByTheory: Array<{ name: string; roleTheory: number; winRate: number; games: number }>;
  topPlayersByGames: Array<{ name: string; games: number; winRate: number }>;
  /**
   * Two-stage outcome contract (schemaVersion 2, docs/stats/two_stage_outcome.md).
   * All optional: a cache written before the contract has none of them and the
   * consumers derive what they need from `outcomeBreakdown` / the legacy rates.
   */
  schemaVersion?: number;
  missionStage?: MissionStageSummary;
  assassinationStage?: AssassinationStageSummary;
  final?: FinalOutcomeSummary;
  /** 全體 per-role final win rate, % (紅角 = 三紅 + 三藍死; 藍角 = 三藍活). */
  roleFinalWinRates?: Record<string, number>;
  /** 全期 excess-win-rate ranking, same MIN_GAMES_THRESHOLD (30) as topPlayersByTheory. */
  topPlayersByExcess?: Array<{ name: string; excessWinRate: number; finalWinRate: number; games: number }>;
  /**
   * Edward 2026-04-27 — `outcomes` (per-seat 三結果 distribution) and
   * `roles[].outcomes` (per-role 三結果 distribution) added so the deep
   * analytics overview tooltip can show the seat outcome split. Optional for
   * cache backward compatibility.
   */
  seatPositionWinRates: Array<{
    seat: string;
    overallWinRate: number;
    totalGames: number;
    outcomes?: OutcomeBreakdown;
    roles: Array<{ role: string; winRate: number; games: number; outcomes?: OutcomeBreakdown }>;
  }>;
}

// ---------------------------------------------------------------------------
// Leaderboard (cache section `leaderboard`, docs/stats/two_stage_outcome.md)
// ---------------------------------------------------------------------------
// Computed entirely by generate_cache.py (LEADERBOARD_CONFIG); the server only
// reads it. Boards are identified by a fixed `id`; a board the generator could
// not build (rows would be empty) is omitted from `boards` altogether.

/** Fixed board ids the generator may emit. */
export type LeaderboardBoardId = 'main' | 'online' | 'recent' | 'improved' | 'assassin' | 'newcomers' | 'roleTitles';

export interface LeaderboardRow {
  rank: number;
  name: string;
  /**
   * The board's SORT value: main / online / recent / newcomers = the shrunk
   * excess win rate (excess × games / (games + shrinkK)); improved = the two
   * spans' final-win-rate difference; assassin = 刺中率; roleTitles = that
   * role's final win rate. On the excess boards the number shown is
   * `excessWinRate`, never this.
   */
  value: number;
  /** main / online / recent / newcomers: the unshrunk excess win rate (what the site and the bots print). */
  excessWinRate?: number;
  /** main / online / recent / newcomers: final win rate within the board's period, %. Absent on improved / assassin / roleTitles. */
  finalWinRate?: number;
  expectedFinalWinRate?: number;
  /** Games within the board's period (assassin: games as 刺客; roleTitles: games as that role). */
  games: number;
  // improved
  recentFinalWinRate?: number;
  priorFinalWinRate?: number;
  recentGames?: number;
  priorGames?: number;
  // assassin
  hits?: number;
  attempts?: number;
  // newcomers
  firstPlayed?: string;
  // roleTitles
  /** `roleTitles` only: the role this row is the title holder of. */
  role?: string;
  wins?: number;
}

export interface LeaderboardBoard {
  /** One of LeaderboardBoardId; typed as string so an unknown board from a newer generator still parses. */
  id: LeaderboardBoardId | (string & Record<never, never>);
  title: string;
  /** e.g. "2025-10-13 ～ 2026-10-12". */
  period: string;
  /** Window actually used (after fallback widening); 0 = 全期. */
  windowDays?: number;
  minGames?: number;
  /**
   * Qualifier for the title, e.g. "近 90 天內有出賽、近 365 天至少 20 場". On the
   * excess boards the generator appends the excess legend after a "；"; the
   * bots print only the clause before it (the site shows the whole note).
   */
  note?: string;
  rows: LeaderboardRow[];
}

export interface LeaderboardSection {
  /** YYYY-MM-DD the boards were computed for. */
  asOf: string;
  dates?: { parsed: number; unparsed: number; earliest: string; latest: string };
  config?: {
    windowDays: number;
    activeDays: number;
    minGames: number;
    shrinkK: number;
    fallbackWindowDays: number[];
    minBoardRows: number;
    topN: number;
  };
  boards: LeaderboardBoard[];
}

/**
 * Shape served by /api/analysis/seat-order (and read by the web
 * SeatOrderAnalysis panel). Keys: 三藍梅活 / 三藍梅死 / 三紅 (+ `pct`),
 * 穿插任務, 穿插率, 穿插紅勝率, 無穿插紅勝率.
 */
export interface SeatOrderPermutation {
  order: string;
  total: number;
  '\u4e09\u85cd\u6885\u6d3b': number;
  '\u4e09\u85cd\u6885\u6b7b': number;
  '\u4e09\u7d05': number;
  '\u4e09\u85cd\u6885\u6d3bpct': number;
  '\u4e09\u85cd\u6885\u6b7bpct': number;
  '\u4e09\u7d05pct': number;
  '\u7a7f\u63d2\u4efb\u52d9': number;
  redWinRate: number;
  blueWinRate: number;
  merlinKillRate: number;
  '\u7a7f\u63d2\u7387': number;
  /** 穿插紅勝率 / 無穿插紅勝率 — absent in the raw-牌譜 rebuild (61b7398). */
  '\u7a7f\u63d2\u7d05\u52dd\u7387'?: number;
  '\u7121\u7a7f\u63d2\u7d05\u52dd\u7387'?: number;
}

/**
 * Permutation as stored in analysis_cache.json. generate_cache.py writes the
 * full served shape; the raw-牌譜 rebuild (61b7398) writes counts only, under
 * the short keys 三藍活 / 三藍死, with no `pct` fields.
 */
type CachedSeatOrderPermutation = Omit<
  SeatOrderPermutation,
  | '\u4e09\u85cd\u6885\u6d3b' | '\u4e09\u85cd\u6885\u6b7b'
  | '\u4e09\u85cd\u6885\u6d3bpct' | '\u4e09\u85cd\u6885\u6b7bpct' | '\u4e09\u7d05pct'
> & Partial<Pick<
  SeatOrderPermutation,
  | '\u4e09\u85cd\u6885\u6d3b' | '\u4e09\u85cd\u6885\u6b7b'
  | '\u4e09\u85cd\u6885\u6d3bpct' | '\u4e09\u85cd\u6885\u6b7bpct' | '\u4e09\u7d05pct'
>> & {
  '\u4e09\u85cd\u6d3b'?: number;
  '\u4e09\u85cd\u6b7b'?: number;
};

export interface SeatOrderData {
  permutations: SeatOrderPermutation[];
  totalGames: number;
  overallRedWinRate: number;
}

type CachedSeatOrderData = Omit<SeatOrderData, 'permutations'> & {
  permutations: CachedSeatOrderPermutation[];
};

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

// ---------------------------------------------------------------------------
// 特徵研究 (Feature Studies) — AnalyticsPage 第三 tab
// ---------------------------------------------------------------------------
// 5 個高訊號 v7 features 萃取自 staging/selfplay/*.md 報告。
// build_feature_studies.py hardcode 這 5 個 features → cache.featureStudies。
// 結構是「open envelope」: data 內部 schema 隨 visualType 變化，前端 panel
// 會 dispatch 不同 renderer (bar / table / divergent / line)。

export type FeatureVisualType = 'bar' | 'table' | 'divergent' | 'line' | 'lakeClaim';

/**
 * L141 (`visualType: "lakeClaim"`, generate_cache.py since 2026-10-12): when the
 * lake holder declares the target 紅 / 藍, how often the target really is.
 * One row per (lake, declared); `lowSample` = n < minSample.
 */
export interface LakeClaimRow {
  lake: string;
  lakeEn: string;
  declared: string;
  declaredEn: string;
  n: number;
  hitRate: number;
  /** Wilson 95% interval bounds, %. */
  ciLow: number;
  ciHigh: number;
  lowSample: boolean;
}

/** Same shape as LakeClaimRow but split by the holder's faction instead of the lake index. */
export interface LakeClaimHolderRow {
  holder: string;
  holderEn: string;
  declared: string;
  declaredEn: string;
  n: number;
  hitRate: number;
  ciLow: number;
  ciHigh: number;
  lowSample: boolean;
}

export interface LakeClaimData {
  minSample: number;
  rows: LakeClaimRow[];
  /** Holder faction × declaration (4 cells); optional for older caches. */
  holderRows?: LakeClaimHolderRow[];
  /** Lake lines without an x/o declaration (counted, not in `rows`). */
  undeclared?: number;
}

interface FeatureStudyEntryBase {
  loopId: string;
  title: string;
  titleEn: string;
  oneLineHook: string;
  oneLineHookEn: string;
  sampleSize: { games: number; links?: number; attempts?: number; chances?: number; leaderEvents?: number };
  takeaway: string;
  takeawayEn: string;
  sourceReport: string;
}

/** Open envelope: `data` depends on `visualType`; only lakeClaim is typed server-side. */
export type FeatureStudyEntry =
  | (FeatureStudyEntryBase & { visualType: 'lakeClaim'; data: LakeClaimData })
  | (FeatureStudyEntryBase & {
      visualType: Exclude<FeatureVisualType, 'lakeClaim'>;
      /** Visual-type-specific payload; consumer dispatches by visualType. */
      data: Record<string, unknown>;
    });

export interface FeatureStudiesData {
  generatedAt: string;
  sampleSize: { games: number; lakeLinks: number };
  features: FeatureStudyEntry[];
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
    /** generate_cache.py only — absent in the raw-牌譜 rebuild (61b7398). */
    missionOutcomeCorrelation?: Array<{
      round: number;
      passedGames: number;
      passedThenBlueWin: number;
      passedBlueWinRate: number;
      passedOutcomes: OutcomeBreakdown;
      failedGames: number;
      failedThenRedWin: number;
      failedRedWinRate: number;
      failedOutcomes: OutcomeBreakdown;
    }>;
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
  /**
   * `outcomes` (三結果) is written by generate_cache.py but not by the
   * raw-牌譜 rebuild (61b7398), so it is optional throughout.
   */
  rounds: {
    visionStats: {
      merlinInTeam: { games: number; mission1PassRate: number; redWinRate: number; blueWinRate: number; outcomes?: OutcomeBreakdown };
      merlinNotInTeam: { games: number; mission1PassRate: number; redWinRate: number; blueWinRate: number; outcomes?: OutcomeBreakdown };
      percivalInTeam: { games: number; mission1PassRate: number; redWinRate: number; outcomes?: OutcomeBreakdown };
      percivalNotInTeam: { games: number; mission1PassRate: number; redWinRate: number; outcomes?: OutcomeBreakdown };
    };
    redInR11: Array<{ redCount: number; games: number; mission1PassRate: number; redWinRate: number; outcomes?: OutcomeBreakdown }>;
    mission1Branch: Array<{ passed: boolean; games: number; redWinRate: number; merlinKillRate: number; outcomes?: OutcomeBreakdown }>;
    roundProgression: Record<string, { bluePct: number; redPct: number; total: number }>;
    gameStates: Array<{ state: string; games: number; redWinRate: number; outcomes?: OutcomeBreakdown }>;
  };
  seatOrder?: CachedSeatOrderData;
  captainAnalysis?: CaptainAnalysisData;
  archetype?: ArchetypeData;
  strength?: StrengthData;
  playstyle?: PlaystyleData;
  featureStudies?: FeatureStudiesData;
  /** Written by generate_cache.py since 2026-10-12; absent in older caches. */
  leaderboard?: LeaderboardSection;
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

/**
 * Own-property lookup for name-keyed cache maps. Player names come straight
 * from the URL, so a plain `record[name]` would resolve "constructor" /
 * "__proto__" / "toString" to Object.prototype members and the accessors
 * below would then throw on `.player.totalGames` (→ 500 instead of 404).
 */
function byName<T>(record: Record<string, T>, name: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
}

/**
 * Round to one decimal with ties to even, exactly like Python's round() in
 * generate_cache.py (rnd1): 56.25 → 56.2, 56.35 → 56.4. Math.round would give
 * 56.3 and make the fallback differ from the cache by 0.1 on exact ties.
 */
export function rnd1(n: number): number {
  const scaled = n * 10;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  if (frac === 0.5) return (floor % 2 === 0 ? floor : floor + 1) / 10;
  return Math.round(scaled) / 10;
}

/**
 * Bring a cached permutation to the served shape: canonical 三藍梅活/三藍梅死
 * counts plus the three `pct` fields, derived from the counts when the cache
 * only carries counts (raw-牌譜 rebuild). Interleave red-win rates cannot be
 * derived and stay absent; the UI hides that table.
 */
function normalizeSeatOrderPermutation(p: CachedSeatOrderPermutation): SeatOrderPermutation {
  const blueAlive = p['三藍梅活'] ?? p['三藍活'] ?? 0;
  const blueDead = p['三藍梅死'] ?? p['三藍死'] ?? 0;
  const threeRed = p['三紅'] ?? 0;
  const pct = (n: number): number => (p.total > 0 ? rnd1((n / p.total) * 100) : 0);
  return {
    ...p,
    '三藍梅活': blueAlive,
    '三藍梅死': blueDead,
    '三紅': threeRed,
    '三藍梅活pct': p['三藍梅活pct'] ?? pct(blueAlive),
    '三藍梅死pct': p['三藍梅死pct'] ?? pct(blueDead),
    '三紅pct': p['三紅pct'] ?? pct(threeRed),
  };
}

// ---------------------------------------------------------------------------
// Two-stage outcome fallback (docs/stats/two_stage_outcome.md)
// ---------------------------------------------------------------------------

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** n / d as a 1-decimal percentage; 0 when d is 0 (same convention as generate_cache.py). */
function pctOf(n: number, d: number): number {
  return d > 0 ? rnd1((n / d) * 100) : 0;
}

/**
 * Contract formula (docs/stats/two_stage_outcome.md, generate_cache.py):
 * rnd1(Σ rawRoleGames[r] × roleFinalWinRates[r] / totalGames). The 0.1%-rounded
 * `roleDistribution` is only a fallback for a player without raw role counts —
 * weighting by it drifts 0.1 from the generator. null when no role is covered.
 */
function expectedFinalWinRateOf(p: PlayerStats, roleFinalWinRates: Record<string, number>): number | null {
  const total = isNum(p.totalGames) && p.totalGames > 0 ? p.totalGames : 0;
  const rawRoleGames = p.rawRoleGames;
  if (total > 0 && rawRoleGames && typeof rawRoleGames === 'object') {
    let weighted = 0;
    let covered = 0;
    for (const [role, games] of Object.entries(rawRoleGames)) {
      const rate = roleFinalWinRates[role];
      if (!isNum(games) || !isNum(rate)) continue;
      weighted += games * rate;
      covered += games;
    }
    if (covered > 0) return rnd1(weighted / total);
  }
  const dist = p.roleDistribution;
  if (dist && typeof dist === 'object') {
    let expected = 0;
    let covered = 0;
    for (const [role, share] of Object.entries(dist)) {
      const rate = roleFinalWinRates[role];
      if (!isNum(share) || !isNum(rate)) continue;
      expected += (share / 100) * rate;
      covered += share;
    }
    if (covered > 0) return rnd1(expected);
  }
  return null;
}

/**
 * Fill in the two-stage contract fields a cache may lack (anything produced
 * before overview.schemaVersion 2), computed from the raw three-outcome
 * counts. Fields the cache already carries are kept as-is; fields that
 * cannot be derived (per-role final rates, first/last played) stay absent,
 * and `expectedFinalWinRate` / `excessWinRate` become null when the cohort
 * role rates needed for them are unavailable. Pure — returns a new object.
 */
export function withFinalFields(p: PlayerStats, roleFinalWinRates?: Record<string, number>): PlayerStats {
  const out: PlayerStats = { ...p };
  const raw = [p.rawRedThreeRed, p.rawRedMerlinDead, p.rawRedMerlinAlive, p.rawBlueThreeRed, p.rawBlueMerlinDead, p.rawBlueMerlinAlive];
  const hasRaw = raw.every(isNum);

  if (hasRaw) {
    const redThreeRed = p.rawRedThreeRed as number;
    const redDead = p.rawRedMerlinDead as number;
    const blueThreeRed = p.rawBlueThreeRed as number;
    const blueDead = p.rawBlueMerlinDead as number;
    const blueAlive = p.rawBlueMerlinAlive as number;
    const total = isNum(p.totalGames) && p.totalGames > 0 ? p.totalGames : raw.reduce((a, b) => a + (b as number), 0);
    const redGames = isNum(p.rawRedGames) ? p.rawRedGames : redThreeRed + redDead + (p.rawRedMerlinAlive as number);
    const blueGames = isNum(p.rawBlueGames) ? p.rawBlueGames : blueThreeRed + blueDead + blueAlive;
    const blueThreeBlue = blueDead + blueAlive;

    if (!isNum(out.finalWinRate)) out.finalWinRate = pctOf(redThreeRed + redDead + blueAlive, total);
    if (!isNum(out.finalRedWinRate)) out.finalRedWinRate = pctOf(redThreeRed + redDead, redGames);
    if (!isNum(out.finalBlueWinRate)) out.finalBlueWinRate = pctOf(blueAlive, blueGames);
    if (!isNum(out.missionWinRate)) out.missionWinRate = pctOf(redThreeRed + blueDead + blueAlive, total);
    if (!isNum(out.rawBlueThreeBlue)) out.rawBlueThreeBlue = blueThreeBlue;
    if (!isNum(out.merlinSurvivalRate)) out.merlinSurvivalRate = pctOf(blueAlive, blueThreeBlue);
  }

  if (!isNum(out.expectedFinalWinRate)) {
    out.expectedFinalWinRate = roleFinalWinRates ? expectedFinalWinRateOf(p, roleFinalWinRates) : null;
  }
  if (!isNum(out.excessWinRate)) {
    out.excessWinRate =
      isNum(out.finalWinRate) && isNum(out.expectedFinalWinRate) ? rnd1(out.finalWinRate - out.expectedFinalWinRate) : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API (matching existing function signatures)
// ---------------------------------------------------------------------------

export async function getOverview(): Promise<OverviewData> {
  return loadCache().overview;
}

/** Every player, with the two-stage fields filled in (see withFinalFields). */
export async function getAllPlayerStats(): Promise<PlayerStats[]> {
  const c = loadCache();
  const roleFinal = c.overview?.roleFinalWinRates;
  return c.players.players.map((p) => withFinalFields(p, roleFinal));
}

export async function getPlayerByName(name: string): Promise<PlayerStats | null> {
  const c = loadCache();
  const detail = byName(c.playerDetails, name);
  return detail ? withFinalFields(detail.player, c.overview?.roleFinalWinRates) : null;
}

/**
 * Leaderboard section (boards computed by generate_cache.py). Returns null
 * when the cache predates it; the route answers 503 then, like feature-studies.
 */
export async function getLeaderboard(): Promise<LeaderboardSection | null> {
  return loadCache().leaderboard ?? null;
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
  return {
    ...c.seatOrder,
    permutations: c.seatOrder.permutations.map(normalizeSeatOrderPermutation),
  };
}

export async function getCaptainAnalysis(): Promise<CaptainAnalysisData> {
  const c = loadCache();
  if (!c.captainAnalysis) {
    return { perMission: [], captainFactionVsOutcome: [], captainMissionGameWinRates: [] };
  }
  return c.captainAnalysis;
}

/**
 * Feature Studies — 5 ranked v7 features for AnalyticsPage 3rd tab.
 * Returns null when cache section missing (e.g. cache predates build script).
 */
export async function getFeatureStudies(): Promise<FeatureStudiesData | null> {
  const c = loadCache();
  return c.featureStudies ?? null;
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
  const data = byName(c.archetype.perPlayer, name);
  if (!data) return null;
  const detail = byName(c.playerDetails, name);
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
  const data = byName(c.strength.perPlayer, name);
  if (!data) return null;
  const detail = byName(c.playerDetails, name);
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
  const data = byName(c.playstyle.perPlayer, name);
  if (!data) return null;
  const detail = byName(c.playerDetails, name);
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
