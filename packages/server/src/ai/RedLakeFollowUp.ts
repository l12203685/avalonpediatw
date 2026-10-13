/**
 * Red follow-up on the Lady of the Lake (2026-10-13 round 2,
 * docs/ai/strength_benchmark.md 第 7 節).
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
 * off the team rejects 94.0% of later teams without the vouched teammate).
 *
 * `AgentTuning.evilVouchFollowUp` makes the red holder keep its word, the
 * way the baseline `HeuristicAgent` already does for 硬1 / 硬2
 * (`fixupTeamHardRules`, `voteOnTeam`): its own proposals include every
 * seat it declared blue and leave out every seat it declared red, and off
 * the team it rejects teams that break its own declaration. Same red
 * exception as the baseline (Q11, `mayBreakHardRules`: red listening / R5
 * cleanup) — then winning the mission comes first.
 *
 * Pure functions over the public record (`obs.lakeHistory`); no
 * `Math.random`.
 */

import type { PlayerObservation } from './types';
import { mayBreakHardRules } from './HeuristicAgent';

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
 * declaration, or red's decisive window).
 */
export function evilVouchTeamConstraint(
  obs: PlayerObservation,
): { required: string[]; banned: string[] } | null {
  if (obs.myTeam !== 'evil') return null;
  if (mayBreakHardRules(obs)) return null;
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
 * such a team 81–94% of the time (牌譜; teammate vouched 94.0% 78/83, a
 * vouched blue 88.9% 152/171); on the team they mostly approve (n < 15),
 * so the rule stays off there. Also off on the forced fifth proposal
 * (everyone approves), on the holder's own proposal (built to the
 * constraint above) and in red's decisive window (Q11).
 */
export function evilVouchVoteRule(obs: PlayerObservation): 'reject' | null {
  if (obs.myTeam !== 'evil') return null;
  if (obs.failCount >= 4) return null;
  if (obs.currentLeader === obs.myPlayerId) return null;
  if ((obs.proposedTeam ?? []).includes(obs.myPlayerId)) return null;
  if (mayBreakHardRules(obs)) return null;
  const own = ownLakeDeclarations(obs);
  if (own.blue.length === 0 && own.red.length === 0) return null;
  const team = new Set(obs.proposedTeam ?? []);
  if (own.blue.some((id) => !team.has(id))) return 'reject';
  if (own.red.some((id) => team.has(id))) return 'reject';
  return null;
}
