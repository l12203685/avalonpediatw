/**
 * Team reuse prior for the ForwardAgent's team proposals (`AgentTuning.teamReuse`,
 * 2026-10-13 round 3, docs/ai/strength_benchmark.md 第 11 節).
 *
 * Human leaders build on the teams already on the table (牌譜, 1970
 * replayable 10-player games, `scripts/teamReuseStudy.ts`):
 *   - first proposal after a successful mission: the mission team is kept
 *     whole 73.8% of the time (plus one seat when the team grows);
 *   - a later proposal of the same round: the rejected team is re-proposed
 *     or changed by one seat ~41%, and an earlier proposal of the round is
 *     re-proposed exactly as often as the immediately previous one
 *     (8.5% vs 7.2%); a leader who was on an earlier team of the round
 *     re-proposes one of those exactly 24.8% of the time;
 *   - after a failed mission they change at least two seats (no reuse).
 * The ForwardAgent did the opposite: `PRIOR_PENALTY` pushed every later
 * leader away from the rejected teams of the round, so its team agreement
 * R2+ (exact 3.8%, Jaccard 41.2%) sat below the plain "re-propose the
 * previous team" baseline (10.5% / 49.0%).
 *
 * With the switch on, from R2 on the penalty is replaced by a bonus for the
 * share of a reference team a candidate keeps:
 *
 *   bonus(T) = max over references R of w(R) · |T ∩ R∖{self}| / |R∖{self}|
 *
 * References: the last mission team when it succeeded (weight `success` on
 * the round's first proposal, `mission` on later ones) and every earlier
 * (rejected) proposal of the round (`reject`). Candidates that reuse a
 * reference — the team itself, the team with self swapped in for one
 * member, the team grown by one seat, one-seat swaps — are added to the
 * usual candidate set (drawn from the same role-filtered pool), so the
 * suspicion-based score still decides which seat makes room (the agreement
 * benchmark's "default" baseline always drops the last-listed one).
 *
 * Safety — the guard (`teamReuseGuard`): a team it refuses gets no bonus
 * and keeps the old `PRIOR_PENALTY`, and reuse candidates it refuses are
 * never added, so a refused team is only chosen where the switch-off agent
 * would score it the same (review 2026-10-13). It refuses a team that
 * breaks 硬1 / 硬2 of any member's lake declaration (the leader's own
 * included — so no new 硬3 exposure) and, for a good leader, a team holding
 * a seat it treats as red: a red it can see (`knownEvils`), a lake-chain /
 * 硬3 violator, a member of a failed mission whose fail cards cover every
 * member but the leader, or a seat the pyramid scores ≥ 0.85. The leader is
 * always on its own team (the ForwardAgent invariant: humans who re-propose
 * a successful team without themselves cannot be matched), red holders
 * still go through `evilVouchFollowUp`. R1 is unchanged (humans hardly
 * reuse there).
 *
 * Weights (`DEFAULT_TEAM_REUSE_OPTIONS`) were fitted on the logs only (70%
 * of the games, fnv1a split; the other 30% agree as well). Good leaders:
 * 3 / 0.45 / 0.6 (success / reject / mission); red leaders (Oberon
 * included) 3× that: their agreement kept rising with the weight, because
 * the red score prefers a visible teammate on the team while human red
 * leaders keep the successful team as often as blue ones (71.1% vs
 * 76.1%); Oberon, who sees no teammate, gained the most (R2+ exact
 * population 0.5% → 18%). After a successful mission the prior dominates
 * and red bots keep that team with themselves swapped in — human red
 * leaders off that team mostly re-propose it without themselves, which the
 * ForwardAgent cannot do (docs 第 11.5 節). Agreement and self-play
 * numbers: docs/ai/strength_benchmark.md 第 11 節. In DEFAULT_AGENT_TUNING
 * since 2026-10-13 round 3.
 *
 * Pure functions of the observation; no `Math.random`.
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { analyzeLakeChain, findTeamHardRuleViolations, findRule3Violators } from './baseline/lakeChainTracker';
import { computePyramidScores, type PyramidScores } from './baseline/pyramidScorer';

/** Weights of the reuse prior for one camp of leaders. */
export interface TeamReuseWeights {
  /** First proposal of a round after a successful mission: keep the mission team. */
  success: number;
  /** Later proposals of a round: keep an earlier (rejected) proposal of the round. */
  reject: number;
  /** Later proposals of a round after a successful mission: keep the mission team. */
  mission: number;
  /** R1 later proposals: keep an earlier R1 proposal (0 = keep the old R1 penalty). */
  r1: number;
}

/**
 * Weights of the reuse prior per leader camp, in score units of
 * `ForwardAgent.scoreCandidate` (swapping one member of a 4-seat team for
 * one 0.4 suspicion lower moves the score by roughly 0.1–0.2; a red
 * leader's score prefers a team with a visible teammate by about 0.6–1.2).
 * A weight of 0 turns that reference off; both camps at 0 = the switch is
 * off for that camp. The defaults are the policy behind the switch; other
 * values exist for the benchmark scripts only (`AVALON_TEAM_REUSE_VARIANT`,
 * read through `teamReuseOptionsFromEnv` + `setTeamReuseOptions`; the
 * server never reads it).
 */
export interface TeamReuseOptions {
  good: TeamReuseWeights;
  evil: TeamReuseWeights;
}

export const DEFAULT_TEAM_REUSE_OPTIONS: Readonly<TeamReuseOptions> = Object.freeze({
  good: Object.freeze({ success: 3, reject: 0.45, mission: 0.6, r1: 0 }),
  evil: Object.freeze({ success: 9, reject: 1.35, mission: 1.8, r1: 0 }),
});

let activeTeamReuseOptions: Readonly<TeamReuseOptions> = DEFAULT_TEAM_REUSE_OPTIONS;

/** Benchmark scripts only (`undefined` restores the default). */
export function setTeamReuseOptions(options: TeamReuseOptions | undefined): void {
  const o = options ?? DEFAULT_TEAM_REUSE_OPTIONS;
  activeTeamReuseOptions = Object.freeze({ good: Object.freeze({ ...o.good }), evil: Object.freeze({ ...o.evil }) });
}

export function getTeamReuseOptions(): Readonly<TeamReuseOptions> {
  return activeTeamReuseOptions;
}

const WEIGHT_KEYS: ReadonlyArray<keyof TeamReuseWeights> = ['success', 'reject', 'mission', 'r1'];

/**
 * Parses `AVALON_TEAM_REUSE_VARIANT` (scripts only), comma-separated:
 * `success=3` sets both camps, `good.success=3` / `evil.reject=0` one camp;
 * `camps=good` (or `evil`) zeroes every weight of the other camp. Unknown
 * keys and bad values are ignored.
 */
export function teamReuseOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TeamReuseOptions {
  const out: TeamReuseOptions = {
    good: { ...DEFAULT_TEAM_REUSE_OPTIONS.good },
    evil: { ...DEFAULT_TEAM_REUSE_OPTIONS.evil },
  };
  let camps: 'both' | 'good' | 'evil' = 'both';
  for (const part of (env.AVALON_TEAM_REUSE_VARIANT ?? '').split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k === 'camps') {
      if (v === 'both' || v === 'good' || v === 'evil') camps = v;
      continue;
    }
    const [scope, key] = k.includes('.') ? k.split('.', 2) : ['both', k];
    if (!WEIGHT_KEYS.includes(key as keyof TeamReuseWeights)) continue;
    const n = Number.parseFloat(v ?? '');
    if (!Number.isFinite(n) || n < 0) continue;
    if (scope === 'both' || scope === 'good') out.good[key as keyof TeamReuseWeights] = n;
    if (scope === 'both' || scope === 'evil') out.evil[key as keyof TeamReuseWeights] = n;
  }
  const zero: TeamReuseWeights = { success: 0, reject: 0, mission: 0, r1: 0 };
  if (camps === 'good') out.evil = { ...zero };
  if (camps === 'evil') out.good = { ...zero };
  return out;
}

/** One reference team and the weight of keeping it. */
export interface TeamReuseRef {
  team: readonly string[];
  weight: number;
  kind: 'mission' | 'proposal';
}

/**
 * The reuse prior for one team decision. `replacesPriorPenalty` = the
 * ForwardAgent drops its `PRIOR_PENALTY` for this decision (R2+, or R1
 * when `r1 > 0`).
 */
export interface TeamReusePlan {
  refs: TeamReuseRef[];
  replacesPriorPenalty: boolean;
}

/** Weights for this leader's camp. */
function weightsFor(obs: PlayerObservation): Readonly<TeamReuseWeights> {
  return obs.myTeam === 'evil' ? activeTeamReuseOptions.evil : activeTeamReuseOptions.good;
}

/**
 * Whether the switch acts for this leader: tuning on and some weight of the
 * leader's camp above 0 (the camp split exists for the benchmark scripts).
 */
export function teamReuseActive(tuning: Pick<AgentTuning, 'teamReuse'>, obs: PlayerObservation): boolean {
  if (!tuning.teamReuse) return false;
  const w = weightsFor(obs);
  return w.success > 0 || w.reject > 0 || w.mission > 0 || w.r1 > 0;
}

/**
 * Reference teams for the current team decision (`null` = no reuse: first
 * proposal of the game, first proposal after a failed mission, or R1 with
 * `r1 = 0`).
 */
export function teamReusePlan(obs: PlayerObservation): TeamReusePlan | null {
  const opts = weightsFor(obs);
  const round = obs.currentRound ?? 1;
  const earlier = obs.voteHistory.filter((v) => v.round === round && !v.approved);
  const refs: TeamReuseRef[] = [];
  if (round === 1) {
    if (opts.r1 <= 0 || earlier.length === 0) return null;
    for (const v of earlier) refs.push({ team: v.team, weight: opts.r1, kind: 'proposal' });
    return { refs, replacesPriorPenalty: true };
  }
  const lastQuest = [...obs.questHistory].reverse().find((q) => q.round === round - 1)
    ?? obs.questHistory[obs.questHistory.length - 1];
  const missionOk = lastQuest !== undefined && lastQuest.result === 'success';
  if (earlier.length === 0) {
    if (missionOk && opts.success > 0) refs.push({ team: lastQuest.team, weight: opts.success, kind: 'mission' });
  } else {
    if (opts.reject > 0) for (const v of earlier) refs.push({ team: v.team, weight: opts.reject, kind: 'proposal' });
    if (missionOk && opts.mission > 0) refs.push({ team: lastQuest.team, weight: opts.mission, kind: 'mission' });
  }
  return { refs, replacesPriorPenalty: true };
}

/** Share of `ref`'s members (other than the leader) that `team` keeps. */
export function keptShare(team: readonly string[], ref: readonly string[], selfId: string): number {
  const others = ref.filter((id) => id !== selfId);
  if (others.length === 0) return 0;
  const set = new Set(team);
  return others.filter((id) => set.has(id)).length / others.length;
}

/**
 * Teams that reuse a reference, built from `pool` (the leader's usual
 * role-filtered candidate pool, self excluded): the reference itself with
 * self swapped in / added, the reference grown or shrunk to the round's
 * size, and every one-seat swap. Every team holds the leader and exactly
 * `teamSize` distinct seats (the caller's team size — ForwardAgent passes
 * its own so both candidate sets always agree; default: `AVALON_CONFIG`);
 * duplicates and teams `accepts` refuses (the guard) are dropped.
 */
export function teamReuseCandidateTeams(
  plan: TeamReusePlan,
  obs: PlayerObservation,
  pool: readonly string[],
  teamSize: number | undefined = AVALON_CONFIG[obs.playerCount]?.questTeams[(obs.currentRound ?? 1) - 1],
  accepts: (team: readonly string[]) => boolean = () => true,
): string[][] {
  if (teamSize === undefined || teamSize <= 0) return [];
  const selfId = obs.myPlayerId;
  const allowed = new Set(pool.filter((id) => id !== selfId));
  const out: string[][] = [];
  const seen = new Set<string>();
  const push = (members: readonly string[]): void => {
    const team = [selfId, ...members.filter((id) => id !== selfId)];
    if (team.length !== teamSize || new Set(team).size !== team.length) return;
    const key = [...team].sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    if (accepts(team)) out.push(team);
  };
  const slots = teamSize - 1;
  for (const ref of plan.refs) {
    const kept = ref.team.filter((id) => id !== selfId && allowed.has(id));
    const outside = [...allowed].filter((id) => !kept.includes(id));
    if (kept.length >= slots) {
      // Keep all but (kept − slots) members: every way of dropping that many.
      for (const combo of combinations(kept, slots)) push(combo);
    } else {
      // Grow the kept part with every combination of outside seats.
      for (const extra of combinations(outside, slots - kept.length)) push([...kept, ...extra]);
    }
    // One-seat swaps of the kept-part teams above (keep all but one, add one).
    if (kept.length >= 1 && kept.length <= slots) {
      for (const drop of kept) {
        const rest = kept.filter((id) => id !== drop);
        const pickFrom = outside;
        for (const extra of combinations(pickFrom, slots - rest.length)) push([...rest, ...extra]);
      }
    }
  }
  return out;
}

/** k-combinations of `items` in order (k ≤ 4 here, items ≤ 9). */
function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k <= 0) return [[]];
  if (k > items.length) return [];
  const out: T[][] = [];
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    out.push(idx.map((i) => items[i]));
    let r = k - 1;
    while (r >= 0 && idx[r] === items.length - k + r) r--;
    if (r < 0) break;
    idx[r]++;
    for (let s = r + 1; s < k; s++) idx[s] = idx[s - 1] + 1;
  }
  return out;
}

/**
 * Seats a good leader treats as red for the guard: the reds it can see
 * (`knownEvils`), the lake-chain / 硬3 violators, every member of a failed
 * mission whose fail cards cover all its members but the leader (certain
 * reds), and any seat the pyramid scores ≥ `GUARD_RED_SUSPICION` (review
 * 2026-10-13: without the last two the bonus could put a deducible red
 * back on the team).
 */
export const GUARD_RED_SUSPICION = 0.85;

function goodLeaderRedSet(obs: PlayerObservation, pyramid: PyramidScores): Set<string> {
  const red = new Set<string>(obs.knownEvils);
  const chain = analyzeLakeChain(obs);
  for (const id of chain.violators) red.add(id);
  for (const id of findRule3Violators(chain, obs).keys()) red.add(id);
  for (const q of obs.questHistory) {
    if (q.result !== 'fail') continue;
    const others = q.team.filter((id) => id !== obs.myPlayerId);
    if (others.length > 0 && q.failCount >= others.length) for (const id of others) red.add(id);
  }
  for (const [id, s] of pyramid.scores) if (s >= GUARD_RED_SUSPICION) red.add(id);
  red.delete(obs.myPlayerId);
  return red;
}

/**
 * The guard for one decision: `true` = the team may get the reuse bonus
 * and is spared `PRIOR_PENALTY`. It refuses a team that breaks 硬1 / 硬2 of
 * any member's lake declaration (the leader's own included) and, for a good
 * leader, a team holding a seat of `goodLeaderRedSet`. `pyramid` defaults
 * to `computePyramidScores(obs)` (what the ForwardAgent uses).
 */
export function teamReuseGuard(
  obs: PlayerObservation,
  pyramid: PyramidScores = computePyramidScores(obs),
): (team: readonly string[]) => boolean {
  const chain = analyzeLakeChain(obs);
  const redSet = obs.myTeam === 'good' ? goodLeaderRedSet(obs, pyramid) : new Set<string>();
  return (team: readonly string[]): boolean =>
    !team.some((id) => redSet.has(id)) && findTeamHardRuleViolations(chain, team).length === 0;
}

/**
 * Bonus function for one decision: `bonus(team)` = max over references of
 * weight × kept share, 0 for a team the guard refuses.
 */
export function teamReuseScorer(
  plan: TeamReusePlan,
  obs: PlayerObservation,
  accepts: (team: readonly string[]) => boolean = teamReuseGuard(obs),
): (team: readonly string[]) => number {
  return (team: readonly string[]): number => {
    if (plan.refs.length === 0) return 0;
    if (!accepts(team)) return 0;
    let best = 0;
    for (const ref of plan.refs) {
      const b = ref.weight * keptShare(team, ref.team, obs.myPlayerId);
      if (b > best) best = b;
    }
    return best;
  };
}
