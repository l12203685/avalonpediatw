/**
 * 玩家條件（「排除某些條件玩家」）的指標登錄表與 PR（r9 設計 §3.4）。
 *
 * 值都是 players 列在評估集上的公開值（一位小數）；資格 = PR 的母體（例：角色理論要角色窗打滿）。
 * PR = 有資格的人之中 (2 × 比他低的人數 + 同值人數) / (2n) × 100，精確分數、五成雙到一位小數
 * （同值含自己；與 scripts/build_archetype_strength.py 的 percentile_rank 同義）。比較一律用一位小數的值。
 */
import { OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, type Role } from '../constants';
import type { GamesDatasetConfig } from '../dataset';
import { Rational } from '../fraction';
import { daysBetween } from '../leaderboard';
import type { PlayerRow } from '../players';
import { pySlice, rate } from '../pyround';
import { theoryKey, type PlayerSeat, type RoleWindows, type TheoryWindow } from '../theory';
import type { CompareOp, MetricId } from './types';

export interface MetricContext {
  config: GamesDatasetConfig;
  asOf: string;
  timelines: ReadonlyMap<string, readonly PlayerSeat[]>;
}

export interface MetricDef {
  id: MetricId;
  label: string;
  labelEn: string;
  needsRole: boolean;
  /** 指標值；沒有值時 null（視同沒資格）。 */
  value(row: PlayerRow, ctx: MetricContext, role?: Role): number | null;
  /** 資格（PR 的母體）；minGames 覆寫預設門檻。 */
  eligible(row: PlayerRow, ctx: MetricContext, role: Role | undefined, minGames: number | undefined): boolean;
  /** 預設資格的說明（中文）。 */
  eligibility: string;
}

function lastWindow(row: PlayerRow, ctx: MetricContext): TheoryWindow | undefined {
  return (row.theory as Record<string, unknown>)[theoryKey(ctx.config.leaderboard.mainGames)] as TheoryWindow | undefined;
}

function assassinAttempts(row: PlayerRow, ctx: MetricContext): PlayerSeat[] {
  const seats = ctx.timelines.get(row.name) ?? [];
  return pySlice(
    seats.filter((s) => s.role === '刺客' && (s.outcome === OUTCOME_BLUE_DEAD || s.outcome === OUTCOME_BLUE_ALIVE)),
    -ctx.config.leaderboard.assassinAttempts,
  );
}

const atLeast = (n: number, min: number | undefined, dflt: number): boolean => n >= (min ?? dflt);

export const METRICS: Readonly<Record<MetricId, MetricDef>> = {
  roleTheory: {
    id: 'roleTheory', label: '角色理論勝率', labelEn: 'Role theory', needsRole: false,
    value: (r) => (r.theory.roleWindows as RoleWindows).roleTheory,
    eligible: (r, _c, _role, min) => (r.theory.roleWindows as RoleWindows).fullWindows
      && (min === undefined || r.totalGames >= min),
    eligibility: '各角色窗打滿（六個特殊角色各 roleWindowGames 場、忠臣 loyalWindowGames 場）',
  },
  positionTheory: {
    id: 'positionTheory', label: '位置理論勝率', labelEn: 'Position theory', needsRole: false,
    value: (r, c) => lastWindow(r, c)?.positionTheory ?? null,
    eligible: (r, c, _role, min) => atLeast(r.totalGames, min, c.config.leaderboard.mainGames),
    eligibility: '生涯至少 mainGames 場',
  },
  overallTheory: {
    id: 'overallTheory', label: '整體理論勝率', labelEn: 'Overall theory', needsRole: false,
    value: (r) => r.theory.career.roleTheory,
    eligible: (r, c, _role, min) => atLeast(r.totalGames, min, c.config.leaderboard.overallMinGames),
    eligibility: '生涯至少 overallMinGames 場',
  },
  finalWinRate: {
    id: 'finalWinRate', label: '最終勝率', labelEn: 'Final win rate', needsRole: false,
    value: (r) => r.finalWinRate,
    eligible: (r, c, _role, min) => atLeast(r.totalGames, min, c.config.minGamesThreshold),
    eligibility: '生涯至少 minGamesThreshold 場',
  },
  missionWinRate: {
    id: 'missionWinRate', label: '任務勝率', labelEn: 'Mission-stage win rate', needsRole: false,
    value: (r) => r.winRate,
    eligible: (r, c, _role, min) => atLeast(r.totalGames, min, c.config.minGamesThreshold),
    eligibility: '生涯至少 minGamesThreshold 場',
  },
  excessWinRate: {
    id: 'excessWinRate', label: '超額勝率', labelEn: 'Excess win rate', needsRole: false,
    value: (r) => r.excessWinRate,
    eligible: (r, c, _role, min) => atLeast(r.totalGames, min, c.config.minGamesThreshold),
    eligibility: '生涯至少 minGamesThreshold 場',
  },
  games: {
    id: 'games', label: '場數', labelEn: 'Games', needsRole: false,
    value: (r) => r.totalGames,
    eligible: (r, _c, _role, min) => atLeast(r.totalGames, min, 0),
    eligibility: '全部',
  },
  roleFinalWinRate: {
    id: 'roleFinalWinRate', label: '角色最終勝率', labelEn: 'Final win rate in a role', needsRole: true,
    value: (r, _c, role) => (role ? r.roleFinalWinRates[role] ?? null : null),
    eligible: (r, c, role, min) => Boolean(role) && atLeast(r.rawRoleGames[role as Role] ?? 0, min, c.config.leaderboard.roleTitleMinGames),
    eligibility: '該角色至少 roleTitleMinGames 場',
  },
  roleGames: {
    id: 'roleGames', label: '角色場數', labelEn: 'Games in a role', needsRole: true,
    value: (r, _c, role) => (role ? r.rawRoleGames[role] ?? 0 : null),
    eligible: (r, _c, role, min) => Boolean(role) && atLeast(r.rawRoleGames[role as Role] ?? 0, min, 0),
    eligibility: '全部',
  },
  merlinSurvivalRate: {
    id: 'merlinSurvivalRate', label: '梅林存活率（藍方三藍）', labelEn: 'Merlin survival (blue, 3 blue)', needsRole: false,
    value: (r) => r.merlinSurvivalRate,
    eligible: (r, c, _role, min) => atLeast(r.rawBlueThreeBlue, min, c.config.minGamesThreshold),
    eligibility: '藍方做到三藍至少 minGamesThreshold 局',
  },
  assassinHitRate: {
    id: 'assassinHitRate', label: '刺客刺中率', labelEn: 'Assassin hit rate', needsRole: false,
    value: (r, c) => {
      const attempts = assassinAttempts(r, c);
      return attempts.length ? rate(attempts.filter((s) => s.outcome === OUTCOME_BLUE_DEAD).length, attempts.length) : null;
    },
    eligible: (r, c, _role, min) => {
      const n = assassinAttempts(r, c).length;
      return n >= 1 && atLeast(n, min, c.config.leaderboard.assassinMinAttempts);
    },
    eligibility: '最近 assassinAttempts 次刺殺中至少 assassinMinAttempts 次',
  },
  daysSinceLastPlayed: {
    id: 'daysSinceLastPlayed', label: '距上次出賽天數', labelEn: 'Days since last game', needsRole: false,
    value: (r, c) => (r.lastPlayed ? daysBetween(r.lastPlayed, c.asOf) : null),
    eligible: (r, _c, _role, min) => Boolean(r.lastPlayed) && atLeast(r.totalGames, min, 0),
    eligibility: '有日期的局',
  },
  daysSinceFirstPlayed: {
    id: 'daysSinceFirstPlayed', label: '距首次出賽天數', labelEn: 'Days since first game', needsRole: false,
    value: (r, c) => (r.firstPlayed ? daysBetween(r.firstPlayed, c.asOf) : null),
    eligible: (r, _c, _role, min) => Boolean(r.firstPlayed) && atLeast(r.totalGames, min, 0),
    eligibility: '有日期的局',
  },
};

/** 有資格者之中的百分等級（0–100，一位小數，五成雙）。`population` 含 value 本人。 */
export function percentileRank(value: number, population: readonly number[]): number {
  if (!population.length) return 0;
  let below = 0;
  let ties = 0;
  for (const v of population) {
    if (v < value) below += 1;
    else if (v === value) ties += 1;
  }
  return Rational.of(BigInt(2 * below + ties) * 100n, BigInt(2 * population.length)).roundTenth();
}

export function compare(x: number, op: CompareOp, threshold: number): boolean {
  switch (op) {
    case 'gt': return x > threshold;
    case 'ge': return x >= threshold;
    case 'lt': return x < threshold;
    case 'le': return x <= threshold;
    default: return false;
  }
}

export interface MetricEvaluation {
  name: string;
  eligible: boolean;
  value: number | null;
  pr: number | null;
}

/** 一個指標在一組列上的值、資格、PR。 */
export function evaluateMetric(
  rows: readonly PlayerRow[],
  metric: MetricId,
  ctx: MetricContext,
  role?: Role,
  minGames?: number,
): MetricEvaluation[] {
  const def = METRICS[metric];
  const evals = rows.map((row) => {
    const value = def.value(row, ctx, role);
    const eligible = value !== null && def.eligible(row, ctx, role, minGames);
    return { name: row.name, eligible, value, pr: null as number | null };
  });
  const population = evals.filter((e) => e.eligible).map((e) => e.value as number);
  for (const e of evals) if (e.eligible) e.pr = percentileRank(e.value as number, population);
  return evals;
}
