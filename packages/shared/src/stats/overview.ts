/**
 * overview 區塊（generate_cache.compute_overview、compute_seat_position_win_rates、player_game_outcomes、
 * top_players_by_role / position / overall_theory、shrunk_excess 逐行移植）。
 *
 * 局數、紅藍勝率、outcomeBreakdown、seatPositionWinRates 看全部局（含其他結果）；missionStage /
 * assassinationStage / final 看有結果的局；族群率看有名字的座位。`hidden`（篩選的「只是不上榜」）只從
 * 排名清單拿掉人並依原排序補滿，不改任何數字；totalPlayers 照算。
 */
import {
  ALL_ROLES,
  BLUE_ROLES,
  OUTCOME_BLUE_ALIVE,
  OUTCOME_BLUE_DEAD,
  OUTCOME_THREE_RED,
  RED_ROLES,
} from './constants';
import type { Game, GamesDatasetConfig } from './dataset';
import { outcomeSplit, type OutcomeSplit, type PlayerRow } from './players';
import { rate, rnd1, sortByKey } from './pyround';
import { theoryConfig, theoryKey, type RoleWindows, type TheoryConfig, type TheoryWindow } from './theory';

/** overview 結構（鍵與順序同快取 schemaVersion 4；gamesKey 在有資料集時附上）。 */
export interface OverviewSection {
  totalGames: number;
  totalPlayers: number;
  redWinRate: number;
  blueWinRate: number;
  merlinKillRate: number;
  outcomeBreakdown: {
    threeRed: number; threeBlueAlive: number; threeBlueDead: number;
    threeRedPct: number; threeBlueAlivePct: number; threeBlueDeadPct: number;
  };
  topPlayersByTheory: Array<{ name: string; roleTheory: number; winRate: number; games: number }>;
  topPlayersByGames: Array<{
    name: string; games: number; winRate: number; outcomes: Record<string, number>; redGames: number; blueGames: number;
  }>;
  seatPositionWinRates: SeatPositionRow[];
  schemaVersion: number;
  missionStage: { games: number; threeRed: number; threeBlue: number; redPct: number; bluePct: number };
  assassinationStage: { games: number; merlinKilled: number; merlinSurvived: number; killPct: number; survivePct: number };
  final: { games: number; redWins: number; blueWins: number; redPct: number; bluePct: number };
  roleFinalWinRates: Record<string, number>;
  topPlayersByExcess: Array<{
    name: string; excessWinRate: number | null; finalWinRate: number; expectedFinalWinRate: number | null; games: number;
  }>;
  seatFinalWinRates: Record<string, number>;
  topPlayersByRoleTheory: Array<Record<string, number | string>>;
  theoryConfig: TheoryConfig;
  topPlayersByPositionTheory: Array<Record<string, number | string>>;
  topPlayersByOverallTheory: Array<Record<string, number | string>>;
  gamesKey?: string;
}

export interface SeatPositionRow {
  seat: string;
  overallWinRate: number;
  totalGames: number;
  roles: Array<{ role: string; winRate: number; games: number; outcomes: OutcomeSplit }>;
  outcomes: OutcomeSplit;
}

/** overview.schemaVersion（generate_cache.CACHE_SCHEMA_VERSION）。 */
export const CACHE_SCHEMA_VERSION = 4;

const SEAT_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const SEAT_ORDER_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/** generate_cache.compute_seat_position_win_rates（任務階段的勝負，全部局、每個座位）。 */
export function computeSeatPositionWinRates(games: readonly Game[]): SeatPositionRow[] {
  const stats = new Map<string, Map<string, { wins: number; total: number; games: Game[] }>>();
  const seatGames = new Map<string, Game[]>();
  for (const s of SEAT_ORDER) {
    stats.set(s, new Map());
    seatGames.set(s, []);
  }
  for (const g of games) {
    for (const seat of SEAT_ORDER) {
      const role = g.seatRoles.get(seat) ?? '';
      if (!role) continue;
      const bySeat = stats.get(seat) as Map<string, { wins: number; total: number; games: Game[] }>;
      let entry = bySeat.get(role);
      if (!entry) {
        entry = { wins: 0, total: 0, games: [] };
        bySeat.set(role, entry);
      }
      entry.total += 1;
      if ((RED_ROLES.has(role) && g.redWin) || (BLUE_ROLES.has(role) && g.blueWin)) entry.wins += 1;
      entry.games.push(g);
      (seatGames.get(seat) as Game[]).push(g);
    }
  }
  return SEAT_ORDER.map((seat, i) => {
    const roles: SeatPositionRow['roles'] = [];
    let totalWins = 0;
    let totalGames = 0;
    for (const role of ALL_ROLES) {
      const s = stats.get(seat)?.get(role);
      if (!s || s.total === 0) continue;
      roles.push({ role, winRate: rnd1((s.wins / s.total) * 100), games: s.total, outcomes: outcomeSplit(s.games) });
      totalWins += s.wins;
      totalGames += s.total;
    }
    return {
      seat: SEAT_ORDER_LABELS[i],
      overallWinRate: totalGames > 0 ? rnd1((totalWins / totalGames) * 100) : 0,
      totalGames,
      roles,
      outcomes: outcomeSplit(seatGames.get(seat) as Game[]),
    };
  });
}

/** generate_cache.player_game_outcomes：一列的三結果（紅藍兩邊合計）與紅藍場數。 */
export function playerGameOutcomes(p: Partial<PlayerRow>): { outcomes: Record<string, number>; redGames: number; blueGames: number } {
  const raw = (key: keyof PlayerRow): number => {
    const v = p[key];
    return typeof v === 'number' ? Math.trunc(v) : 0;
  };
  return {
    outcomes: {
      [OUTCOME_THREE_RED]: raw('rawRedThreeRed') + raw('rawBlueThreeRed'),
      [OUTCOME_BLUE_DEAD]: raw('rawRedMerlinDead') + raw('rawBlueMerlinDead'),
      [OUTCOME_BLUE_ALIVE]: raw('rawRedMerlinAlive') + raw('rawBlueMerlinAlive'),
    },
    redGames: raw('rawRedGames'),
    blueGames: raw('rawBlueGames'),
  };
}

/** generate_cache.shrunk_excess：excess * games / (games + K)。 */
export function shrunkExcess(excess: number, games: number, shrinkK: number): number {
  return games + shrinkK > 0 ? rnd1((excess * games) / (games + shrinkK)) : 0;
}

type RankedRow = Record<string, number | string> & { name: string; careerGames: number };

/** generate_cache._ranked_overview：依值（高先）、生涯場數、名字。 */
function rankedOverview(rows: Array<[number, RankedRow]>, topN: number): RankedRow[] {
  return sortByKey(rows, ([v, r]) => [-v, -r.careerGames, r.name]).slice(0, topN).map(([, r]) => r);
}

function block<T>(p: PlayerRow, key: string): T | undefined {
  const theory = p.theory as Record<string, unknown> | undefined;
  const b = theory ? theory[key] : undefined;
  return b && typeof b === 'object' ? (b as T) : undefined;
}

/** overview.topPlayersByRoleTheory：角色窗打滿（fullWindows）的人，不管近期有沒有出賽。 */
export function topPlayersByRoleTheory(players: readonly PlayerRow[], cfg: GamesDatasetConfig): RankedRow[] {
  const key = theoryKey(cfg.leaderboard.mainGames);
  const rows: Array<[number, RankedRow]> = [];
  for (const p of players) {
    const rw = block<RoleWindows>(p, 'roleWindows');
    const last = block<TheoryWindow>(p, key);
    const career = block<TheoryWindow>(p, 'career');
    if (!(rw && last && career && rw.fullWindows)) continue;
    rows.push([rw.roleTheory, {
      name: p.name, roleTheory: rw.roleTheory, positionTheory: last.positionTheory, overallTheory: career.roleTheory,
      finalWinRate: last.finalWinRate, games: rw.games, careerGames: Math.trunc(p.totalGames),
    }]);
  }
  return rankedOverview(rows, cfg.leaderboard.topN);
}

/** overview.topPlayersByPositionTheory：生涯至少 mainGames 場。 */
export function topPlayersByPositionTheory(players: readonly PlayerRow[], cfg: GamesDatasetConfig): RankedRow[] {
  const n = cfg.leaderboard.mainGames;
  const rows: Array<[number, RankedRow]> = [];
  for (const p of players) {
    const last = block<TheoryWindow>(p, theoryKey(n));
    if (last === undefined || p.totalGames < n) continue;
    rows.push([last.positionTheory, {
      name: p.name, positionTheory: last.positionTheory, finalWinRate: last.finalWinRate, games: last.games,
      careerGames: Math.trunc(p.totalGames),
    }]);
  }
  return rankedOverview(rows, cfg.leaderboard.topN);
}

/** overview.topPlayersByOverallTheory：生涯至少 overallMinGames 場，整體理論 = 生涯的角色理論。 */
export function topPlayersByOverallTheory(players: readonly PlayerRow[], cfg: GamesDatasetConfig): RankedRow[] {
  const rows: Array<[number, RankedRow]> = [];
  for (const p of players) {
    const career = block<TheoryWindow>(p, 'career');
    if (career === undefined || p.totalGames < cfg.leaderboard.overallMinGames) continue;
    rows.push([career.roleTheory, {
      name: p.name, overallTheory: career.roleTheory, positionTheory: career.positionTheory,
      finalWinRate: career.finalWinRate, games: career.games, careerGames: Math.trunc(p.totalGames),
    }]);
  }
  return rankedOverview(rows, cfg.leaderboard.topN);
}

export interface OverviewOptions {
  /** 只從排名清單拿掉的人（篩選的 hideFromLists）。 */
  hidden?: ReadonlySet<string>;
  gamesKey?: string;
}

/** generate_cache.compute_overview（族群率由呼叫者傳入：compute_role / seat_final_win_rates 的結果）。 */
export function computeOverview(
  games: readonly Game[],
  players: readonly PlayerRow[],
  roleFinalWinRates: Record<string, number>,
  seatFinalWinRates: Record<string, number>,
  cfg: GamesDatasetConfig,
  options: OverviewOptions = {},
): OverviewSection {
  const { hidden } = options;
  const listed = hidden && hidden.size ? players.filter((p) => !hidden.has(p.name)) : players;
  const total = games.length;
  let redWins = 0;
  let blueWins = 0;
  let merlinKills = 0;
  let threeRed = 0;
  let threeBlueAlive = 0;
  let threeBlueDead = 0;
  for (const g of games) {
    if (g.redWin) redWins += 1;
    if (g.blueWin) blueWins += 1;
    if (g.merlinKilled) merlinKills += 1;
    if (g.outcome === OUTCOME_THREE_RED) threeRed += 1;
    else if (g.outcome === OUTCOME_BLUE_ALIVE) threeBlueAlive += 1;
    else if (g.outcome === OUTCOME_BLUE_DEAD) threeBlueDead += 1;
  }
  const significant = listed.filter((p) => p.totalGames >= cfg.minGamesThreshold);
  const topByTheory = sortByKey(significant, (p) => [-p.roleTheory]).slice(0, 10);
  const topByGames = sortByKey(listed, (p) => [-p.totalGames]).slice(0, 10);
  const merlinKillRate = blueWins > 0 ? rnd1((merlinKills / (merlinKills + (blueWins - merlinKills))) * 100) : 0;
  const settled = threeRed + threeBlueDead + threeBlueAlive;
  const threeBlue = threeBlueDead + threeBlueAlive;
  const finalRed = threeRed + threeBlueDead;
  const shrinkK = cfg.excessShrinkK;
  const rankedByExcess = sortByKey(
    significant.filter((p) => typeof p.excessWinRate === 'number'),
    (p) => [-shrunkExcess(p.excessWinRate as number, p.totalGames, shrinkK), -p.totalGames, p.name],
  );
  const pct = (n: number): number => (total > 0 ? rnd1((n / total) * 100) : 0);
  const out: OverviewSection = {
    totalGames: total,
    totalPlayers: players.length,
    redWinRate: pct(redWins),
    blueWinRate: pct(blueWins),
    merlinKillRate,
    outcomeBreakdown: {
      threeRed,
      threeBlueAlive,
      threeBlueDead,
      threeRedPct: pct(threeRed),
      threeBlueAlivePct: pct(threeBlueAlive),
      threeBlueDeadPct: pct(threeBlueDead),
    },
    topPlayersByTheory: topByTheory.map((p) => ({ name: p.name, roleTheory: p.roleTheory, winRate: p.winRate, games: p.totalGames })),
    topPlayersByGames: topByGames.map((p) => ({ name: p.name, games: p.totalGames, winRate: p.winRate, ...playerGameOutcomes(p) })),
    seatPositionWinRates: computeSeatPositionWinRates(games),
    schemaVersion: CACHE_SCHEMA_VERSION,
    missionStage: { games: settled, threeRed, threeBlue, redPct: rate(threeRed, settled), bluePct: rate(threeBlue, settled) },
    assassinationStage: {
      games: threeBlue, merlinKilled: threeBlueDead, merlinSurvived: threeBlueAlive,
      killPct: rate(threeBlueDead, threeBlue), survivePct: rate(threeBlueAlive, threeBlue),
    },
    final: { games: settled, redWins: finalRed, blueWins: threeBlueAlive, redPct: rate(finalRed, settled), bluePct: rate(threeBlueAlive, settled) },
    roleFinalWinRates,
    topPlayersByExcess: rankedByExcess.slice(0, 10).map((p) => ({
      name: p.name, excessWinRate: p.excessWinRate, finalWinRate: p.finalWinRate,
      expectedFinalWinRate: p.expectedFinalWinRate, games: p.totalGames,
    })),
    seatFinalWinRates,
    topPlayersByRoleTheory: topPlayersByRoleTheory(listed, cfg),
    theoryConfig: theoryConfig(cfg.leaderboard),
    topPlayersByPositionTheory: topPlayersByPositionTheory(listed, cfg),
    topPlayersByOverallTheory: topPlayersByOverallTheory(listed, cfg),
  };
  if (options.gamesKey !== undefined) out.gamesKey = options.gamesKey;
  return out;
}
