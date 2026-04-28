/**
 * Vote / team-pick inference — Pyramid layer 4 (派票 + 投票).
 *
 * Edward 2026-04-28 Wave B Q10 = A:
 *   同層合成 = weighted sum + 時序遞增權重 (新 1.5x 舊).
 *   派票 vs 投票同人衝突 → 投票權重 > 派票.
 *
 * Pure functions: input observation, output a per-player score map.
 * No memory, no class state. Composable with other layers via
 * `pyramidScorer.ts`.
 *
 * Time-decay weight: the most recent record gets weight `1.5^N` where
 * N = (totalRecords - 1 - index). Older records get smaller weight.
 * This implements「新 1.5x 舊」as a geometric decay so a single recent
 * signal can outweigh multiple stale signals from R1-R2.
 *
 * Vote-vs-pick conflict: when both layer-4 sub-signals (vote behaviour
 * and team-pick behaviour) flag a player, the vote signal weighs 1.5x
 * the pick signal (Q10 verbatim).
 */

import type { PlayerObservation } from '../types';

// ── Constants ──────────────────────────────────────────────────
/** Time-decay base (newer / older). Edward 2026-04-28: 1.5. */
const TIME_DECAY = 1.5;

/** When pick + vote signals on the same player conflict, vote wins. */
const VOTE_VS_PICK_PRIORITY = 1.5;

/** Outer-white per-occurrence base score. */
const OUTER_WHITE_BASE = 0.6;
/** Inner-black per-occurrence base score (negative = trustworthy). */
const INNER_BLACK_BASE = -0.5;

/** Tainted-team-as-leader per-occurrence score. */
const LEADER_TAINTED_BASE = 1.0;

// ── Per-record weight ──────────────────────────────────────────
/**
 * Weight a record by its position in chronological order.
 * Most-recent record gets weight 1.0; second-most 1/1.5; etc.
 *
 * Returns the geometric decay factor that, summed over all records,
 * forms the time-weighted aggregate.
 */
function timeWeight(indexFromOldest: number, total: number): number {
  if (total <= 1) return 1;
  const ageFromNewest = total - 1 - indexFromOldest;
  return Math.pow(TIME_DECAY, -ageFromNewest);
}

// ── Vote-pattern signals ───────────────────────────────────────
/**
 * Score a player's vote pattern. Higher = more red-suspicious.
 *
 * Per record:
 *   - Off-team approve (outer-white) → +OUTER_WHITE_BASE
 *   - On-team reject  (inner-black) → +INNER_BLACK_BASE (negative)
 *
 * Multiplied by the time-decay weight so newer records dominate.
 */
export function scoreFromVotePattern(
  obs: PlayerObservation,
): Map<string, number> {
  const score = new Map<string, number>();
  const total = obs.voteHistory.length;
  if (total === 0) return score;

  obs.voteHistory.forEach((record, idx) => {
    const w = timeWeight(idx, total);
    for (const [pid, approved] of Object.entries(record.votes)) {
      if (pid === obs.myPlayerId) continue;
      const onTeam = record.team.includes(pid);
      let delta = 0;
      if (approved && !onTeam) delta = OUTER_WHITE_BASE;
      else if (!approved && onTeam) delta = INNER_BLACK_BASE;
      if (delta === 0) continue;
      score.set(pid, (score.get(pid) ?? 0) + delta * w);
    }
  });
  return score;
}

// ── Team-pick signals ──────────────────────────────────────────
/**
 * Score a player's team-pick (leader proposal) pattern. Higher = red.
 *
 * Per leader record:
 *   - Led team that later failed → +LEADER_TAINTED_BASE
 *   - Repeated R1-P1 banned combos (already filtered upstream — not
 *     scored here to avoid double-penalty)
 *
 * Time-decay applied identically.
 */
export function scoreFromTeamPick(
  obs: PlayerObservation,
): Map<string, number> {
  const score = new Map<string, number>();
  const total = obs.voteHistory.length;
  if (total === 0) return score;

  obs.voteHistory.forEach((record, idx) => {
    const w = timeWeight(idx, total);
    const failedQ = obs.questHistory.find(
      (q) => q.round === record.round && q.result === 'fail',
    );
    if (!failedQ) return;
    if (!failedQ.team.every((id) => record.team.includes(id))) return;
    if (record.leader === obs.myPlayerId) return;
    score.set(
      record.leader,
      (score.get(record.leader) ?? 0) + LEADER_TAINTED_BASE * w,
    );
  });
  return score;
}

// ── Same-layer composition ─────────────────────────────────────
/**
 * Combine vote + pick signals per Q10:
 *   weighted_sum where vote weighs 1.5x pick on conflicts.
 *
 * Implementation: vote score is multiplied by VOTE_VS_PICK_PRIORITY
 * before summing with pick score so vote wins ties.
 */
export function combineLayer4(
  voteScore: Map<string, number>,
  pickScore: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [pid, s] of voteScore) {
    out.set(pid, s * VOTE_VS_PICK_PRIORITY);
  }
  for (const [pid, s] of pickScore) {
    out.set(pid, (out.get(pid) ?? 0) + s);
  }
  return out;
}

/**
 * Convenience entry: compute the full layer-4 score for an
 * observation. Used by `pyramidScorer.ts`.
 */
export function layer4Score(obs: PlayerObservation): Map<string, number> {
  const v = scoreFromVotePattern(obs);
  const p = scoreFromTeamPick(obs);
  return combineLayer4(v, p);
}
