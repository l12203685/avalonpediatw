/**
 * Percival leaves both thumbs off his R1 teams (`AgentTuning.percivalNoThumbsR1`,
 * 2026-10-14, docs/ai/percival_thumbs.md 第 9 節).
 *
 * Percival sees two "thumbs" — Merlin and Morgana — and cannot tell them
 * apart. Edward 2026-10-14 (原文): 「一開始在沒任何資訊時先預設不派」, then
 * check the human games split by how many thumbs lead a proposal before
 * Percival's first captain turn (C2 / C1 / C0) and by the seats.
 *
 * Human data (`scripts/percivalThumbsStudy.ts`, the agreement benchmark's
 * strict replay, 1970 ten-player games):
 *   - R1 (before the first mission result) Percival's own teams carry no
 *     thumb 83.3% [80.8%, 85.6%] (784/941; a random team 57.3%): talk
 *     proposals (P1–P4) 87.7%, the forced fifth proposal 63.1%.
 *   - No R1 cell (talk / forced × C2 / C1 / C0) has a human majority for a
 *     thumb — highest forced C1 47.9% [38.2%, 57.8%] — and no cell shows a
 *     better game outcome (三藍活) with a thumb on the team; no Percival seat
 *     1–5 either (highest seat 5, 37.2%). So one rule for all of R1, with no
 *     configuration- or seat-specific branch (thresholds T1 / T2 in the doc).
 *
 * The production bot did the opposite: the ForwardAgent only moved the
 * "B" thumb to the end of its R1-P1 pool (still a candidate) and the
 * `RoleStrategy` Percival bias rewarded a team with thumb "A" only; with no
 * vote yet both thumbs score 0.5 and A = the lower-seated thumb, so the
 * R1-P1 team always held the lower-seated thumb (186/186 on the replay) and
 * 70.1% of R1 teams held a thumb (humans 16.7%), Merlin only half the time.
 * The baseline's "R1-P1: self + two non-thumbs" rule
 * (`HeuristicAgent.selectPercivalTeam`) only ran on the fallback path.
 *
 * With the switch on, in R1 of a 6–10-player game Percival (two thumbs) as
 * captain:
 *   - ForwardAgent: both thumbs leave the candidate pool (same severity as
 *     the inferred-Morgana thumb; the 2026-10-10 backfill restores seats only
 *     when the pool cannot fill a team), and the Percival bias gives no bonus
 *     to a team with thumb A only — except the thumb-on-thumb exception
 *     below, which keeps the included thumb in the pool and treats it as A;
 *   - baseline (`selectPercivalTeam`, fallback / forward reasoning off): the
 *     R1-P1 no-thumb branch covers R1-P2..P5 too.
 * From R2 on nothing changes here (the identification: inferred Merlin
 * rewarded; since logic-first batch 1E the inferred Morgana is hard-excluded
 * only when certainly red, `AgentTuning.percivalCertainExclusion`), and
 * Percival's lake is a blue lake (`AgentTuning.percivalBlueLake`).
 *
 * Player counts 6–10 (`PERCIVAL_NO_THUMBS_R1_MIN_PLAYERS`..`_MAX_PLAYERS`;
 * 2026-10-14 GM decision D5, `docs/ai/logic_first.md`): the first version
 * acted in 10-player games only, but the stated reason — the banned R1-P1
 * seat pairs — exists only in 5-player games (`ForwardAgent.
 * bannedComboSetFor5p` is empty for 6–9), so 6–9-player rooms now follow
 * the owner ruling too; 5-player games keep the old behaviour.
 *
 * Gate on two thumbs (`knownWizards.length === 2`, D5): with Morgana turned
 * off in the lobby Percival sees one wizard, who is certainly Merlin
 * (`GameEngine.assignRoles` maps Morgana to a minion) — there is nothing to
 * tell apart, so the rule does not apply and Merlin may be sent.
 *
 * The thumb-on-thumb exception (`AgentTuning.percivalR1ThumbOnThumb`, D5 (b)):
 * if, earlier in R1, one thumb as captain put the other thumb on its own
 * team, that included thumb may go on Percival's team. Human data
 * (percival_followups, 1970 games): a Morgana captain puts Merlin on her R1
 * team 153/750, a Merlin captain puts Morgana on hers 21/773, so the
 * included thumb is Merlin 87.9% [82.3%, 92.0%] (153/174); human Percivals
 * put it on their team 34/46 = 73.9% [59.7%, 84.4%]. This is information,
 * so the owner's "no information → no thumbs" default does not cover it.
 * When both thumbs included each other the signal cancels → no exception.
 *
 * In `DEFAULT_AGENT_TUNING` since 2026-10-14 (rule and thresholds registered
 * before any seed ran; docs/ai/percival_thumbs.md 第 11 節,
 * strength_benchmark.md 第 14 節): on every Percival-led proposal of the
 * 牌譜 the thumb set (none / Merlin / Morgana / both) matches the human's
 * 40.4 → 58.4% (population; top 40.7 → 59.0%, Sin 40.8 → 57.0%); the
 * agreement benchmark changes only the R1 Percival-leader team rows (R2+
 * teams, votes, quest cards, lake and assassination identical). Self-play
 * blue stance +0.16pp (515151), +0.02pp / −0.18pp on the fresh seeds 626262 /
 * 737373, pooled +0.01pp [−0.31pp, +0.32pp]; red stance 0; 0 fallbacks.
 * The D5 fixes (gate, 6–9 players, exception) are measured in
 * strength_benchmark.md 第 15 節.
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';

/** Smallest player count the switch acts in (5p: banned R1-P1 pairs could collide). */
export const PERCIVAL_NO_THUMBS_R1_MIN_PLAYERS = 6;
/** Largest player count (the standard games end at 10). */
export const PERCIVAL_NO_THUMBS_R1_MAX_PLAYERS = 10;

/**
 * Whether `percivalNoThumbsR1` acts on this observation: switch on, Percival
 * who sees exactly two thumbs, 6–10-player game, R1 (no mission result
 * yet). The callers are Percival's team-selection paths.
 */
export function percivalNoThumbsR1Active(
  tuning: Pick<AgentTuning, 'percivalNoThumbsR1'>,
  obs: PlayerObservation,
): boolean {
  return (
    tuning.percivalNoThumbsR1 &&
    obs.myRole === 'percival' &&
    obs.playerCount >= PERCIVAL_NO_THUMBS_R1_MIN_PLAYERS &&
    obs.playerCount <= PERCIVAL_NO_THUMBS_R1_MAX_PLAYERS &&
    (obs.currentRound ?? 1) === 1 &&
    (obs.knownWizards?.length ?? 0) === 2
  );
}

/**
 * The thumb that the other thumb, as captain of an earlier R1 proposal, put
 * on its own team — `null` when no thumb did, or when both did (the signal
 * cancels). Pure function of the public R1 record plus Percival's two thumbs.
 */
export function percivalR1IncludedThumb(obs: PlayerObservation): string | null {
  const thumbs = obs.knownWizards ?? [];
  if (thumbs.length !== 2) return null;
  const [a, b] = thumbs;
  const included = new Set<string>();
  for (const v of obs.voteHistory) {
    if (v.round !== 1) continue;
    if (v.leader === a && v.team.includes(b)) included.add(b);
    if (v.leader === b && v.team.includes(a)) included.add(a);
  }
  return included.size === 1 ? [...included][0] : null;
}

/**
 * The thumb exempted from the R1 no-thumb rule by `percivalR1ThumbOnThumb`
 * (D5 (b)), or `null` (switch off, rule not active, or no unique included
 * thumb).
 */
export function percivalR1ThumbException(
  tuning: Pick<AgentTuning, 'percivalNoThumbsR1' | 'percivalR1ThumbOnThumb'>,
  obs: PlayerObservation,
): string | null {
  if (!tuning.percivalR1ThumbOnThumb || !percivalNoThumbsR1Active(tuning, obs)) return null;
  return percivalR1IncludedThumb(obs);
}

/**
 * Logic-first batch 1E (`AgentTuning.percivalLoyalVote`, S1-6, Pe1): Percival
 * is a loyal with one more fact — exactly one of his two thumbs is red. Both
 * thumbs on a team therefore put a certain red on it, so when one fail card
 * decides the round the team must fail: reject it. Non-forced R3+ proposals
 * only — R1–R2 keep the normal-vote table rule (owner's final ruling on D3:
 * Percival's only R1–R2 certainty is exactly this, and rejecting it would sell
 * Merlin), the forced fifth proposal holds no vote, and a round needing two
 * fails (R4 of 7+ players) goes to the probability layer (D2). The 1D
 * must-fail gate reaches the same verdict through the certainty layer; this
 * rule is Percival's own reading of the fact, so the switch stands alone.
 */
export function percivalBothThumbsReject(
  tuning: Pick<AgentTuning, 'percivalLoyalVote'>,
  obs: PlayerObservation,
): boolean {
  if (!tuning.percivalLoyalVote || obs.myRole !== 'percival' || obs.myTeam !== 'good') return false;
  const round = obs.currentRound ?? 1;
  if (round <= 2 || obs.failCount >= 4) return false;
  const thumbs = obs.knownWizards ?? [];
  if (thumbs.length !== 2) return false;
  const team = obs.proposedTeam ?? [];
  if (!thumbs.every((id) => team.includes(id))) return false;
  const failsRequired = AVALON_CONFIG[obs.playerCount]?.questFailsRequired[round - 1] ?? 1;
  return failsRequired === 1;
}
