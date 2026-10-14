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
 * With the switch on, in R1 of a 10-player game Percival as captain:
 *   - ForwardAgent: both thumbs leave the candidate pool (same severity as
 *     the inferred-Morgana thumb; the 2026-10-10 backfill restores seats only
 *     when the pool cannot fill a team), and the Percival bias gives no bonus
 *     to a team with thumb A only;
 *   - baseline (`selectPercivalTeam`, fallback / forward reasoning off): the
 *     R1-P1 no-thumb branch covers R1-P2..P5 too.
 * From R2 on nothing changes (the current identification: inferred Morgana
 * excluded, inferred Merlin rewarded), never both thumbs, and Percival's lake
 * still avoids the thumbs (`LakePolicy.pickLakeTargetForTeam`).
 *
 * 10-player games only (`PERCIVAL_NO_THUMBS_R1_PLAYER_COUNT`), as
 * `redR1Teammate`: the human data and every benchmark are 10-player games,
 * and in a 5-player game the R1-P1 banned seat pairs could be the only
 * no-thumb teams left.
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
 */

import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';

/** The only player count the switch acts in (the data and the benchmarks are 10p). */
export const PERCIVAL_NO_THUMBS_R1_PLAYER_COUNT = 10;

/**
 * Whether `percivalNoThumbsR1` acts on this observation: switch on, Percival
 * who sees thumbs, 10-player game, R1 (no mission result yet). The callers
 * are Percival's team-selection paths.
 */
export function percivalNoThumbsR1Active(
  tuning: Pick<AgentTuning, 'percivalNoThumbsR1'>,
  obs: PlayerObservation,
): boolean {
  return (
    tuning.percivalNoThumbsR1 &&
    obs.myRole === 'percival' &&
    obs.playerCount === PERCIVAL_NO_THUMBS_R1_PLAYER_COUNT &&
    (obs.currentRound ?? 1) === 1 &&
    (obs.knownWizards?.length ?? 0) > 0
  );
}
