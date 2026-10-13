/**
 * Red R1 leaders sometimes put a visible teammate on their team, like
 * humans (`AgentTuning.redR1Teammate`, 2026-10-13 round 3,
 * docs/ai/strength_benchmark.md 第 12 節).
 *
 * The ForwardAgent's R1 "裝忠臣" (mimic-loyal) bias in `RoleStrategy`
 * (assassin / Morgana / Mordred: −1.5 on any R1 team with a visible
 * teammate) makes a red leader who sees teammates leave them out of every
 * R1 team — 0% in self-play, while from R2 on it includes one on 98–100%
 * of its teams. Humans do neither (牌譜, `scripts/redR1TeammateStudy.ts`
 * (a), 1970 replayable 10-player games, every proposal led by a red who
 * sees teammates):
 *   - R1 overall 43.9% (1280/2919) — the level of a random team (41.7%:
 *     2 of the 9 other seats, 2 of them teammates) and of teams built like
 *     a blue leader's at the same attempt (43.6%): an R1 red leader picks
 *     seats the way a loyal does;
 *   - on the four "talk" proposals of R1 (attempts 1–4; in the local
 *     convention R1 goes to the forced fifth proposal, and only 0.2–0.7% of
 *     these pass) 48.0% (1115/2323); top cohort 51.8%, ED 55.8%, Sin 66.4%;
 *   - on the forced fifth proposal, the one that goes on the mission,
 *     27.7% (165/596); top 29.7%, ED 1/6, Sin 30.4%.
 * Being on the leader's R1 team changes nothing visible later: R1 votes
 * are the same (3.2 approvals of 10 either way), and the R1 red leader is
 * put on R2–R3 teams by blue leaders as often (23.9% vs 23.5%).
 *
 * In bot games the R1 talk proposals never pass (R1 votes are pinned to the
 * normal vote: 3 approvals of 10), so on them the teammate only changes
 * what the record shows — including the good bots' 硬3 rule
 * (`lakeChainTracker.findRule3Violators`: a holder who vouches for a seat
 * he left out of a team he led is flagged ≥ 0.85, R1 teams included).
 *
 * `redR1TeamPlan` decides, for one R1 `team_select` of a red who sees
 * teammates, whether this team carries a teammate; the ForwardAgent then
 * keeps only candidate teams with exactly one visible teammate
 * ('withTeammate'), or proposes the team a loyal in its seat would
 * ('asLoyal'), or leaves the old rule alone (`null`). Oberon sees nobody
 * and is never covered; R2+ is unchanged.
 *
 * In `DEFAULT_AGENT_TUNING` since 2026-10-13 round 3 (talk proposals at the
 * human rate, forced proposal unchanged): on the R1 red-leader proposals of
 * the 牌譜 the agent now makes the human's choice (teammate or not) more
 * often for ED 49.0 → 61.2%, Sin 39.4 → 58.5%, top 52.2 → 52.8% (population
 * 56.1 → 54.2%), every other decision unchanged; red stance in self-play
 * +0.32pp on the selection seed 77777, +0.24pp / −0.22pp on the fresh seeds
 * 88888 / 99999, pooled +0.10pp [−0.19pp, +0.39pp]; blue stance 0.
 *
 * Tactic knobs for the benchmark scripts only
 * (`AVALON_RED_R1_TEAMMATE_VARIANT`, e.g. "talk=always,forced=humanRate";
 * the server never reads it): see `RedR1TeammateOptions`.
 */

import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

/** Reds who see their teammates (Oberon sees nobody). */
export const SEEING_RED_ROLES: ReadonlySet<string> = new Set(['assassin', 'morgana', 'mordred']);

/**
 * Human rate of a visible teammate on the team of an R1 red leader who sees
 * teammates (population, `scripts/redR1TeammateStudy.ts` (a)).
 */
export const HUMAN_R1_TEAMMATE_RATE = Object.freeze({
  /** Attempts 1–4 ("talk" proposals): 1115 / 2323. */
  talk: 1115 / 2323,
  /** The forced fifth proposal: 165 / 596. */
  forced: 165 / 596,
});

/**
 * - `talk`   — attempts 1–4 of R1:
 *     `humanRate` include one teammate with probability
 *                 `HUMAN_R1_TEAMMATE_RATE.talk` (`Math.random`, seeded per
 *                 decision in the benchmarks);
 *     `always`    always include one;
 *     `loyal`     propose exactly the team a loyal in this seat would (the
 *                 red identity of the other seats ignored);
 *     `never`     the old rule (no teammate).
 * - `forced` — the forced fifth R1 proposal: `never` (old rule) or
 *     `humanRate` (`HUMAN_R1_TEAMMATE_RATE.forced`).
 */
export interface RedR1TeammateOptions {
  talk: 'humanRate' | 'always' | 'loyal' | 'never';
  forced: 'never' | 'humanRate';
}

export const DEFAULT_RED_R1_TEAMMATE_OPTIONS: Readonly<RedR1TeammateOptions> = Object.freeze({
  talk: 'humanRate',
  forced: 'never',
});

let activeOptions: Readonly<RedR1TeammateOptions> = DEFAULT_RED_R1_TEAMMATE_OPTIONS;

/** Benchmark scripts only (`undefined` restores the default). */
export function setRedR1TeammateOptions(options: RedR1TeammateOptions | undefined): void {
  activeOptions = Object.freeze({ ...(options ?? DEFAULT_RED_R1_TEAMMATE_OPTIONS) });
}

/** Parses `AVALON_RED_R1_TEAMMATE_VARIANT="talk=always,forced=humanRate"` (scripts only). */
export function redR1TeammateOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RedR1TeammateOptions {
  const out: RedR1TeammateOptions = { ...DEFAULT_RED_R1_TEAMMATE_OPTIONS };
  for (const part of (env.AVALON_RED_R1_TEAMMATE_VARIANT ?? '').split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k === 'talk' && (v === 'humanRate' || v === 'always' || v === 'loyal' || v === 'never')) out.talk = v;
    if (k === 'forced' && (v === 'never' || v === 'humanRate')) out.forced = v;
  }
  return out;
}

export type RedR1TeamPlan = 'withTeammate' | 'asLoyal';

/** The rule covers this decision: switch on, an R1 team pick of a red who sees teammates. */
function covers(obs: PlayerObservation, tuning: Pick<AgentTuning, 'redR1Teammate'>): boolean {
  return tuning.redR1Teammate
    && obs.gamePhase === 'team_select'
    && (obs.currentRound ?? 1) === 1
    && obs.myTeam === 'evil'
    && SEEING_RED_ROLES.has(obs.myRole as string)
    && obs.knownEvils.length > 0;
}

/** The forced fifth proposal of the round (no vote; it goes on the mission). */
function isForced(obs: PlayerObservation): boolean {
  return obs.failCount >= 4;
}

/**
 * Plan for an R1 team of a red leader who sees teammates, or `null` when
 * the old rule stands (switch off, not R1 / not a team pick, Oberon or
 * blue, or the draw / mode says no teammate). Consumes one `Math.random`
 * draw only for a `humanRate` mode that applies.
 */
export function redR1TeamPlan(
  obs: PlayerObservation,
  tuning: Pick<AgentTuning, 'redR1Teammate'>,
  options: Readonly<RedR1TeammateOptions> = activeOptions,
): RedR1TeamPlan | null {
  if (!covers(obs, tuning)) return null;
  const forced = isForced(obs);
  const mode = forced ? options.forced : options.talk;
  switch (mode) {
    case 'never':
      return null;
    case 'always':
      return 'withTeammate';
    case 'loyal':
      return 'asLoyal';
    case 'humanRate': {
      const p = forced ? HUMAN_R1_TEAMMATE_RATE.forced : HUMAN_R1_TEAMMATE_RATE.talk;
      return Math.random() < p ? 'withTeammate' : null;
    }
  }
}

/** The observation a loyal in this seat would have (red identities dropped). */
export function loyalViewOf(obs: PlayerObservation): PlayerObservation {
  return {
    ...obs,
    myRole: 'loyal',
    myTeam: 'good',
    knownEvils: [],
    knownWizards: undefined,
    allEvilIds: undefined,
  };
}

/** Number of this red's visible teammates on `team`. */
export function visibleTeammatesOn(obs: PlayerObservation, team: readonly string[]): number {
  const mates = new Set(obs.knownEvils);
  return team.filter((id) => id !== obs.myPlayerId && mates.has(id)).length;
}

/**
 * Whether `redR1TeamPlan` would draw for this decision (the rule applies in a
 * `humanRate` mode). Pure: no draw.
 */
export function redR1TeamPlanDraws(
  obs: PlayerObservation,
  tuning: Pick<AgentTuning, 'redR1Teammate'>,
  options: Readonly<RedR1TeammateOptions> = activeOptions,
): boolean {
  return covers(obs, tuning) && (isForced(obs) ? options.forced : options.talk) === 'humanRate';
}

/**
 * Post-game review (`explain.replayRule`): re-run a decision that draws the
 * R1 teammate under both outcomes — `Math.random` pinned low (teammate) and
 * high (no teammate) — so a replay can be matched against the real team.
 * The rest of the ForwardAgent team pick is deterministic.
 */
export function replayBothDraws<T>(decide: () => T): { withTeammate: T; without: T } {
  const original = Math.random;
  try {
    Math.random = (): number => 0;
    const withTeammate = decide();
    Math.random = (): number => 1 - Number.EPSILON;
    const without = decide();
    return { withTeammate, without };
  } finally {
    Math.random = original;
  }
}
