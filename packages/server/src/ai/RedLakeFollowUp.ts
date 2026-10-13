/**
 * Red follow-up on the Lady of the Lake (2026-10-13 round 2,
 * docs/ai/strength_benchmark.md 第 8 節).
 *
 * Edward 2026-10-13: 「紅方新湖法先打開 變弱應該從其他地方調整修正 (先像
 * 真人 再從策略上提高勝率)」. With `evilLakeHumanStrategy` on, red holders
 * vouch ("blue") for a teammate or a blue almost every lake, but the
 * ForwardAgent pipeline (which makes every R3+ team and vote) never looked
 * at its own declarations: a red holder then led teams without the seat it
 * had just vouched for — the inconsistency the good bots' 硬3 rule
 * (`findRule3Violators`) pins at ≥ 0.85 suspicion and that humans avoid
 * (牌譜, `scripts/evilLakeStudy.ts` (e): a red holder who declared a
 * teammate blue puts them on 78.7% of the teams they lead later (top
 * cohort 93.8%), a truthfully vouched blue 92.5%, a framed seat 10.4%; and
 * when not on a later team that leaves the vouched teammate out, rejects it
 * 84.3% of the time — 94.0% outside red's decisive window).
 *
 * `AgentTuning.evilVouchFollowUp` makes the red holder keep its word, the
 * way the baseline `HeuristicAgent` already does for 硬1 / 硬2
 * (`fixupTeamHardRules`, `voteOnTeam`): its own proposals include every
 * seat it declared blue and leave out every seat it declared red, and off
 * the team it rejects teams that break its own declaration — also in
 * red's decisive window (Q11, `mayBreakHardRules`: red listening / R5
 * cleanup), where the baseline's 硬1 / 硬2 are lifted: humans keep their
 * word there too (a vouched teammate on 79.5% of the teams they lead in
 * that window, a vouched blue 90.9%). The first cut lifted the rules in
 * that window like the baseline; after the review fix the window-follow
 * version was stronger on the selection seed and more human-like, and was
 * confirmed on two fresh seeds (strength_benchmark.md 第 8.4 節).
 *
 * The team rule filters the usual ForwardAgent candidates (a team that
 * already keeps the word stays the pick); only when none keeps it are
 * teams built around the vouched seats (review 2026-10-13). It acts only
 * with `evilLakeHumanStrategy` on (`evilVouchFollowUpActive`).
 *
 * In `DEFAULT_AGENT_TUNING` since 2026-10-13 round 2. Against the lake
 * strategy alone, as red: the first cut (window exempt) +0.35pp [+0.14pp,
 * +0.55pp] (seeds 31337 + 8080 + 2718); the default (window follow, with
 * `evilLakeFrameHumanRate`) +0.54pp [+0.25pp, +0.83pp] (31337 + 16180 +
 * 14142), +0.60pp [+0.38pp, +0.83pp] over all five lane seeds — about
 * 60% of the lake strategy's gap to the previous default. Team and R3+
 * vote agreement up in every cohort (strength_benchmark.md 第 8.4 節).
 *
 * Pure functions over the public record (`obs.lakeHistory`); no
 * `Math.random`.
 */

import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { mayBreakHardRules } from './HeuristicAgent';

/**
 * Whether `evilVouchFollowUp` acts for this tuning. It is a follow-up on
 * the human lake strategy, so it needs `evilLakeHumanStrategy` on too:
 * `AVALON_TUNING_EVIL_LAKE_HUMAN_STRATEGY=0` alone then restores the
 * previous default (review 2026-10-13: without the gate the follow-up kept
 * acting on the old lake rule's declarations, a combination never measured
 * against the previous default; seed 99 −0.67pp [−1.15pp, −0.19pp], 4242
 * +0.37pp [−0.09pp, +0.82pp]). Same gate as `evilLakeFrameHumanRate`.
 */
export function evilVouchFollowUpActive(
  tuning: Pick<AgentTuning, 'evilVouchFollowUp' | 'evilLakeHumanStrategy'>,
): boolean {
  return tuning.evilVouchFollowUp && tuning.evilLakeHumanStrategy;
}

/**
 * Tactic knobs of `evilVouchFollowUp`. The default is the policy behind the
 * switch; the alternative exists for the benchmark scripts only
 * (`AVALON_VOUCH_FOLLOW_UP_VARIANT`, read by the scripts through
 * `vouchFollowUpOptionsFromEnv` + `setVouchFollowUpOptions`; the server
 * never reads it).
 *   - `decisiveWindow: 'follow'` (default since the 2026-10-13 review fix)
 *     — keep the word in red's decisive window too (humans do: in that
 *     window a red holder still puts a vouched teammate on 79.5% of the
 *     teams they lead, a vouched blue 90.9%, a framed seat 14.7%;
 *     `scripts/evilLakeStudy.ts` (e));
 *   - `decisiveWindow: 'exempt'` — the first cut: in red's decisive window
 *     (Q11, `mayBreakHardRules`: red listening / R5 cleanup) the rules are
 *     off, like the baseline's 硬1 / 硬2 exception.
 */
export interface VouchFollowUpOptions {
  decisiveWindow: 'exempt' | 'follow';
}

export const DEFAULT_VOUCH_FOLLOW_UP_OPTIONS: Readonly<VouchFollowUpOptions> = Object.freeze({
  decisiveWindow: 'follow',
});

let activeVouchFollowUpOptions: Readonly<VouchFollowUpOptions> = DEFAULT_VOUCH_FOLLOW_UP_OPTIONS;

/** Benchmark scripts only (`undefined` restores the default). */
export function setVouchFollowUpOptions(options: VouchFollowUpOptions | undefined): void {
  activeVouchFollowUpOptions = Object.freeze({ ...(options ?? DEFAULT_VOUCH_FOLLOW_UP_OPTIONS) });
}

/** Parses `AVALON_VOUCH_FOLLOW_UP_VARIANT="decisiveWindow=exempt"` (scripts only). */
export function vouchFollowUpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): VouchFollowUpOptions {
  const out: VouchFollowUpOptions = { ...DEFAULT_VOUCH_FOLLOW_UP_OPTIONS };
  for (const part of (env.AVALON_VOUCH_FOLLOW_UP_VARIANT ?? '').split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k === 'decisiveWindow' && (v === 'exempt' || v === 'follow')) out.decisiveWindow = v;
  }
  return out;
}

function inExemptWindow(obs: PlayerObservation): boolean {
  return activeVouchFollowUpOptions.decisiveWindow === 'exempt' && mayBreakHardRules(obs);
}

export interface OwnLakeDeclarations {
  /** Seats this player publicly declared blue ('good'). */
  blue: string[];
  /** Seats this player publicly declared red ('evil'). */
  red: string[];
}

/** This player's own public lake declarations (chronological, no duplicates). */
export function ownLakeDeclarations(obs: PlayerObservation): OwnLakeDeclarations {
  const blue: string[] = [];
  const red: string[] = [];
  for (const rec of obs.lakeHistory ?? []) {
    if (rec.holderId !== obs.myPlayerId || rec.targetId === obs.myPlayerId) continue;
    const list = rec.declaredClaim === 'good' ? blue : red;
    if (!list.includes(rec.targetId)) list.push(rec.targetId);
  }
  return { blue, red };
}

/**
 * Team constraint for a red leader's own proposal (`evilVouchFollowUp`):
 * seats that must be on it (declared blue) and seats that must stay off
 * (declared red). `null` when the rule does not apply (not red, no own
 * declaration, or red's decisive window with `decisiveWindow: 'exempt'`).
 */
export function evilVouchTeamConstraint(
  obs: PlayerObservation,
): { required: string[]; banned: string[] } | null {
  if (obs.myTeam !== 'evil') return null;
  if (inExemptWindow(obs)) return null;
  const own = ownLakeDeclarations(obs);
  const seated = new Set(obs.allPlayerIds);
  const required = own.blue.filter((id) => seated.has(id));
  const banned = own.red.filter((id) => seated.has(id) && !required.includes(id));
  if (required.length === 0 && banned.length === 0) return null;
  return { required, banned };
}

/**
 * Vote rule (`evilVouchFollowUp`): a red holder who is not on the proposed
 * team rejects it when it leaves out a seat the holder declared blue or
 * includes a seat it declared red. Human red holders off the team reject
 * such a team 84.3% (305/362) of the time when they vouched for a
 * teammate, 83.4% (461/553) for a vouched blue; outside red's decisive
 * window 94.0% (78/83) and 88.9% (152/171) (牌譜, `scripts/evilLakeStudy.ts`
 * (e)). On the team the sample is tiny (teammate n = 4; vouched blue 7
 * rejections of 23), so the rule stays off there. Also off on the forced
 * fifth proposal (everyone approves) and on the holder's own proposal
 * (built to the constraint above); in red's decisive window only with the
 * benchmark knob `decisiveWindow: 'exempt'`.
 */
export function evilVouchVoteRule(obs: PlayerObservation): 'reject' | null {
  if (obs.myTeam !== 'evil') return null;
  if (obs.failCount >= 4) return null;
  if (obs.currentLeader === obs.myPlayerId) return null;
  if ((obs.proposedTeam ?? []).includes(obs.myPlayerId)) return null;
  if (inExemptWindow(obs)) return null;
  const own = ownLakeDeclarations(obs);
  if (own.blue.length === 0 && own.red.length === 0) return null;
  const team = new Set(obs.proposedTeam ?? []);
  if (own.blue.some((id) => !team.has(id))) return 'reject';
  if (own.red.some((id) => team.has(id))) return 'reject';
  return null;
}
