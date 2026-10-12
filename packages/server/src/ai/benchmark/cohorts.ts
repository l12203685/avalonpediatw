/**
 * Per-role "top performer" cohort for the agreement benchmark (2026-10-10).
 *
 * Rule (stated in docs/ai/agreement_benchmark.md):
 *   - population: every named seat in the replayable 10-player games;
 *   - eligible: a (player, role) pair with ≥ `minGames` games in that role
 *     (default 30);
 *   - score: Bayesian-shrunk win rate
 *       adj = (wins + K · p_role) / (games + K)
 *     where p_role is the population win rate of that role and K is the
 *     strength of a Beta(K·p, K·(1−p)) prior. Default `'auto'` fits K per
 *     role by empirical Bayes (method of moments over the eligible players:
 *     K = p(1−p) / σ²_true − 1 with σ²_true = observed variance of win
 *     rates − mean binomial variance), clamped to [20, 300]. A small
 *     between-player variance ⇒ large K ⇒ heavy shrinkage, so a hot streak
 *     over a few dozen games cannot outrank a long solid record;
 *   - cohort: the top `perRole` (default 10) eligible players per role by
 *     adj (ties: raw win rate, then games, then name).
 */

import type { Role } from '@avalon/shared';
import { campOf, type ReplayGame } from './sheetsReplay';

/** Locale-independent string order (deterministic output). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface RoleRecord {
  name: string;
  role: Role;
  games: number;
  wins: number;
  rawWinRate: number;
  adjWinRate: number;
}

export interface TopPerformerOptions {
  minGames?: number;
  perRole?: number;
  /** Fixed pseudo-game count, or 'auto' (empirical Bayes per role). */
  priorStrength?: number | 'auto';
}

export const TOP_PERFORMER_DEFAULTS: Required<TopPerformerOptions> = {
  minGames: 30,
  perRole: 10,
  priorStrength: 'auto',
};

export const AUTO_PRIOR_MIN = 20;
export const AUTO_PRIOR_MAX = 300;

/**
 * Method-of-moments Beta prior strength for per-player win rates.
 * Returns AUTO_PRIOR_MAX when the observed spread is no larger than
 * binomial noise (no detectable skill differences).
 */
export function empiricalPriorStrength(records: ReadonlyArray<{ games: number; wins: number }>): number {
  if (records.length < 3) return AUTO_PRIOR_MAX;
  const totalGames = records.reduce((a, r) => a + r.games, 0);
  const p = records.reduce((a, r) => a + r.wins, 0) / totalGames;
  const rates = records.map((r) => r.wins / r.games);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const observedVar = rates.reduce((a, r) => a + (r - mean) ** 2, 0) / (rates.length - 1);
  const noiseVar = records.reduce((a, r) => a + (p * (1 - p)) / r.games, 0) / records.length;
  const trueVar = observedVar - noiseVar;
  if (trueVar <= 0) return AUTO_PRIOR_MAX;
  const k = (p * (1 - p)) / trueVar - 1;
  return Math.min(AUTO_PRIOR_MAX, Math.max(AUTO_PRIOR_MIN, k));
}

export const BENCHMARK_ROLES: readonly Role[] = [
  'merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon',
];

export interface TopPerformerCohort {
  options: Required<TopPerformerOptions>;
  /** Population win rate per role (named seats). */
  roleWinRate: Record<string, number>;
  /** Prior strength K actually used per role. */
  priorStrengthByRole: Record<string, number>;
  /** Top players per role, best first. */
  byRole: Record<string, RoleRecord[]>;
  /** `${name}|${role}` membership. */
  members: Set<string>;
}

export function cohortKey(name: string, role: string): string {
  return `${name}|${role}`;
}

export function computeTopPerformers(
  games: readonly ReplayGame[],
  options: TopPerformerOptions = {},
): TopPerformerCohort {
  const opts = { ...TOP_PERFORMER_DEFAULTS, ...options };
  const tally = new Map<string, { name: string; role: Role; games: number; wins: number }>();
  const roleTotals = new Map<string, { games: number; wins: number }>();
  for (const g of games) {
    for (let seat = 1; seat <= g.playerCount; seat++) {
      const name = g.names[seat - 1];
      if (!name) continue;
      const role = g.seatRoles[seat - 1];
      const won = campOf(role) === g.winner;
      const key = cohortKey(name, role);
      const t = tally.get(key) ?? { name, role, games: 0, wins: 0 };
      t.games += 1;
      if (won) t.wins += 1;
      tally.set(key, t);
      const rt = roleTotals.get(role) ?? { games: 0, wins: 0 };
      rt.games += 1;
      if (won) rt.wins += 1;
      roleTotals.set(role, rt);
    }
  }
  const roleWinRate: Record<string, number> = {};
  for (const [role, t] of roleTotals) roleWinRate[role] = t.games > 0 ? t.wins / t.games : 0.5;

  const byRole: Record<string, RoleRecord[]> = {};
  const priorStrengthByRole: Record<string, number> = {};
  const members = new Set<string>();
  for (const role of BENCHMARK_ROLES) {
    const p = roleWinRate[role] ?? 0.5;
    const eligible = [...tally.values()].filter((t) => t.role === role && t.games >= opts.minGames);
    const k = opts.priorStrength === 'auto' ? empiricalPriorStrength(eligible) : opts.priorStrength;
    priorStrengthByRole[role] = k;
    const ranked = eligible
      .map((t): RoleRecord => ({
        name: t.name,
        role: t.role,
        games: t.games,
        wins: t.wins,
        rawWinRate: t.wins / t.games,
        adjWinRate: (t.wins + k * p) / (t.games + k),
      }))
      .sort((a, b) =>
        b.adjWinRate - a.adjWinRate
        || b.rawWinRate - a.rawWinRate
        || b.games - a.games
        || cmpStr(a.name, b.name));
    byRole[role] = ranked.slice(0, opts.perRole);
    for (const r of byRole[role]) members.add(cohortKey(r.name, r.role));
  }
  return { options: opts, roleWinRate, priorStrengthByRole, byRole, members };
}
