/**
 * Pyramid scorer — 5-layer composition (Edward 2026-04-28 Wave B).
 *
 * Information credibility hierarchy (high → low):
 *   1. Built-in (role-private ground truth) — 永遠贏推理 (Q9)
 *   2. Quest results (public ground truth)
 *   3. Lake declarations (public, hard-rule constrained)
 *   4. Team picks + team votes (合成 weighted-sum, 時序 1.5x)
 *   5. Speech (currently not modelled here — handled by LLM prompt)
 *
 * Cross-layer rule (Q9): a higher layer OVERRIDES lower layers for
 * any player it covers. Built-in knownEvils → suspicion = 1.0 hard
 * pin (cannot be lowered by lower layers); built-in knownGood → 0.0
 * hard pin.
 *
 * Within-layer composition (Q10): weighted sum + time-decay (newer
 * 1.5x older). Cross-cycle SAT failures → ≥0.85 boost.
 *
 * Output: a Map<playerId, suspicionScore> in `[0, 1]` where 1 = sure
 * red, 0 = sure blue, 0.5 = no signal. Callers should consume this
 * to drive selectTeam / voteOnTeam decisions.
 *
 * Pure function — no class state, deterministic given an observation.
 */

import type { PlayerObservation } from '../types';
import {
  getFailedMissionSuspects,
  getOuterWhiteApprovers,
} from './suspectInference';
import {
  analyzeLakeChain,
  findRule3Violators,
  type LakeChainState,
} from './lakeChainTracker';
import { layer4Score } from './voteInferer';
import {
  bucketDeclarerVoteBias,
} from '../priors/EvActionPriors';

// ── Score constants ────────────────────────────────────────────
const NEUTRAL = 0.5;
const HARD_RED = 1.0;
const HARD_BLUE = 0.0;

/** Cycle / Rule 3 violator boost target. */
const VIOLATOR_FLOOR = 0.85;

// ── Output type ────────────────────────────────────────────────
export interface PyramidScores {
  /** Map<playerId, suspicion ∈ [0, 1]>. Higher = more likely red. */
  scores: Map<string, number>;
  /** PlayerIds the agent's built-in knowledge pins as red (1.0). */
  hardRed: Set<string>;
  /** PlayerIds the agent's built-in knowledge pins as blue (0.0). */
  hardBlue: Set<string>;
  /** Lake chain state (Wave B 4 hard rules). */
  lakeChain: LakeChainState;
  /** Players violating layer-3 hard rules — caller may apply policy. */
  hardRuleViolators: Set<string>;
}

// ── Helper: clamp ──────────────────────────────────────────────
function clamp01(x: number): number {
  if (Number.isNaN(x)) return NEUTRAL;
  return Math.max(0, Math.min(1, x));
}

// ── Layer 1 prior (built-in) ───────────────────────────────────
/**
 * Apply role-private ground truth as hard pins.
 *
 * Layer 1 OVERRIDES every lower layer (Q9). A built-in knownEvils
 * pin at 1.0 cannot be lowered by lake / vote / pick signals.
 */
function applyLayer1(
  obs: PlayerObservation,
  scores: Map<string, number>,
): { hardRed: Set<string>; hardBlue: Set<string> } {
  const hardRed = new Set<string>();
  const hardBlue = new Set<string>();

  // Self → hardBlue if I'm good, hardRed if I'm evil (POV bookkeeping
  // — never used for own decisions; here for completeness).
  if (obs.myTeam === 'good') hardBlue.add(obs.myPlayerId);
  else hardRed.add(obs.myPlayerId);

  // knownEvils → hard red regardless of layer 4 noise.
  for (const id of obs.knownEvils) {
    hardRed.add(id);
  }

  // allEvilIds (assassin only, assassination phase) — already-evil
  // visibility for the kill phase. Mirror to hardRed.
  if (obs.allEvilIds) {
    for (const id of obs.allEvilIds) hardRed.add(id);
  }

  // Pin
  for (const id of hardRed) scores.set(id, HARD_RED);
  for (const id of hardBlue) scores.set(id, HARD_BLUE);

  return { hardRed, hardBlue };
}

// ── Layer 2 prior (quest results) ──────────────────────────────
/**
 * Quest result evidence: failed-mission members get a sub-1.0 boost
 * (because failed-mission only proves AT LEAST k evils, not which
 * exact members).
 *
 * Players covered by Layer 1 are NOT modified here (cross-layer
 * override).
 */
function applyLayer2(
  obs: PlayerObservation,
  scores: Map<string, number>,
  hardRed: Set<string>,
  hardBlue: Set<string>,
): void {
  const suspects = getFailedMissionSuspects(obs);
  for (const id of suspects) {
    if (hardRed.has(id) || hardBlue.has(id)) continue;
    const cur = scores.get(id) ?? NEUTRAL;
    // Failed mission member → push toward red but cap at 0.7 so
    // layer 3 / 4 still has room to discriminate.
    scores.set(id, clamp01(Math.max(cur, Math.min(0.7, cur + 0.15))));
  }
}

// ── Layer 3 prior (lake declarations + hard rules) ─────────────
/**
 * Lake-chain analysis. Cycle violators get pinned at ≥0.85.
 * Rule-3 holders that endorsed B but later contradicted themselves
 * get the boost too (per `findRule3Violators`).
 */
function applyLayer3(
  obs: PlayerObservation,
  scores: Map<string, number>,
  hardRed: Set<string>,
  hardBlue: Set<string>,
): { lakeChain: LakeChainState; hardRuleViolators: Set<string> } {
  const lakeChain = analyzeLakeChain(obs);
  const hardRuleViolators = new Set<string>(lakeChain.violators);

  for (const id of lakeChain.violators) {
    if (hardRed.has(id) || hardBlue.has(id)) continue;
    scores.set(id, clamp01(Math.max(scores.get(id) ?? NEUTRAL, VIOLATOR_FLOOR)));
  }

  // Rule 3 violators
  const r3 = findRule3Violators(lakeChain, obs);
  for (const [id, boost] of r3) {
    if (hardRed.has(id) || hardBlue.has(id)) continue;
    hardRuleViolators.add(id);
    scores.set(id, clamp01(Math.max(scores.get(id) ?? NEUTRAL, boost)));
  }

  // Lake-chain endorsers (declared blue) that aren't otherwise
  // suspicious get a small blue lean — they staked credibility on
  // their declared-blue target.
  for (const [holder, blueTargets] of lakeChain.declaredBlueByHolder) {
    if (hardRuleViolators.has(holder)) continue;
    if (hardRed.has(holder) || hardBlue.has(holder)) continue;
    if (blueTargets.size === 0) continue;
    const cur = scores.get(holder) ?? NEUTRAL;
    scores.set(holder, clamp01(cur - 0.05));
  }

  // ── H12 · Declarer vote bias (2026-05-05 v9 Phase 5 ship) ─────
  // For each lake declarer who declared a target blue, compute their
  // cumulative vote bias on subsequent teams containing that target.
  //
  //   bias = Σ (vote_observed_approve - 0.5)
  //         summed over voteHistory rounds AFTER the lake round where
  //         declarer cast a vote on a team containing the declared-blue
  //         target. 0.5 = neutral baseline.
  //
  // 3-bucket fallback (Phase 1 §2 spec): reverse / neutral / consistent.
  //
  // Observer is role-blind toward the declarer (pyramid is shared baseline)
  // so we apply a UNIVERSAL signal:
  //   • bucket=reverse (declarer reversed on own declared-blue) → +red
  //     (言行不一 = suspicious, regardless of underlying role).
  //   • bucket=consistent (declarer supported own declared-blue) → mild
  //     blue lean (consistent with truthful endorsement; covers the
  //     red-cover-lie case but at lower magnitude — H8 single-bump
  //     handles the strong case).
  //   • bucket=neutral (no signal) → no nudge.
  //
  // Magnitude (additive on top of layer 3 endorser blue lean above):
  //   reverse: +0.10 → suspicious
  //   consistent: -0.03 → minor extra trust (additive on top of -0.05)
  //   neutral: 0
  for (const [holder, blueTargets] of lakeChain.declaredBlueByHolder) {
    if (hardRuleViolators.has(holder)) continue;
    if (hardRed.has(holder) || hardBlue.has(holder)) continue;
    if (blueTargets.size === 0) continue;

    // Find the lake record(s) where this holder declared blue.
    let lakeRoundForHolder = Number.POSITIVE_INFINITY;
    for (const rec of lakeChain.records) {
      if (rec.holderId !== holder) continue;
      if (rec.declaredClaim !== 'good') continue;
      if (rec.round < lakeRoundForHolder) lakeRoundForHolder = rec.round;
    }
    if (!Number.isFinite(lakeRoundForHolder)) continue;

    // Compute cumulative bias across post-lake votes on teams containing
    // any declared-blue target.
    let bias = 0;
    let observableCount = 0;
    for (const record of obs.voteHistory) {
      if (record.round <= lakeRoundForHolder) continue;
      const voteFromHolder = record.votes[holder];
      if (voteFromHolder === undefined) continue;
      // Does the proposed team include any declared-blue target?
      let teamHasDeclared = false;
      for (const tid of record.team) {
        if (blueTargets.has(tid)) {
          teamHasDeclared = true;
          break;
        }
      }
      if (!teamHasDeclared) continue;
      observableCount++;
      // bias contribution: +0.5 for approve, -0.5 for reject (so total
      // sign reflects net direction; threshold ±0.5 lands on bucket
      // boundaries per bucketDeclarerVoteBias).
      bias += voteFromHolder ? +0.5 : -0.5;
    }

    if (observableCount < 2) continue; // sample-size floor (per spec note)

    const bucket = bucketDeclarerVoteBias(bias);
    if (bucket === 'reverse') {
      const cur = scores.get(holder) ?? NEUTRAL;
      scores.set(holder, clamp01(cur + 0.10));
    } else if (bucket === 'consistent') {
      const cur = scores.get(holder) ?? NEUTRAL;
      scores.set(holder, clamp01(cur - 0.03));
    }
    // neutral → no change.
  }

  return { lakeChain, hardRuleViolators };
}

// ── Layer 4 prior (team votes + team picks) ────────────────────
function applyLayer4(
  obs: PlayerObservation,
  scores: Map<string, number>,
  hardRed: Set<string>,
  hardBlue: Set<string>,
): void {
  const layer4 = layer4Score(obs);
  // Outer-white approvers (loyal-suspect signature) — keep visible
  // even if layer4Score didn't already weight them.
  const owers = getOuterWhiteApprovers(obs);
  for (const id of owers) {
    if (!layer4.has(id)) layer4.set(id, 0.3);
  }

  // Normalise raw layer-4 scores into a delta in [-0.3, +0.3] applied
  // on top of the current score (so layer 4 is the weakest non-speech
  // contributor).
  const maxAbs =
    Math.max(0, ...Array.from(layer4.values()).map((v) => Math.abs(v))) || 1;
  for (const [pid, raw] of layer4) {
    if (hardRed.has(pid) || hardBlue.has(pid)) continue;
    const delta = (raw / maxAbs) * 0.3;
    const cur = scores.get(pid) ?? NEUTRAL;
    scores.set(pid, clamp01(cur + delta));
  }
}

// ── Public entry ───────────────────────────────────────────────
/**
 * Compute the 5-layer pyramid score for every player visible in
 * `obs.allPlayerIds`, given the agent's POV (`obs.myRole`,
 * `obs.knownEvils`, `obs.knownWizards`, `obs.allEvilIds`).
 *
 * Result: a `PyramidScores` struct. Suspicion ∈ [0, 1] for every
 * player — except self, which is always pinned at HARD_BLUE (good)
 * or HARD_RED (evil).
 *
 * The function is a pure projection of `obs` — call it once per
 * decision and reuse the result across selectTeam / voteOnTeam /
 * voteOnQuest within the same observation.
 */
export function computePyramidScores(
  obs: PlayerObservation,
): PyramidScores {
  // Initialise everyone at NEUTRAL.
  const scores = new Map<string, number>();
  for (const id of obs.allPlayerIds) {
    scores.set(id, NEUTRAL);
  }

  // Layer 1 hard pins.
  const { hardRed, hardBlue } = applyLayer1(obs, scores);
  // Layer 2 — failed-mission suspects.
  applyLayer2(obs, scores, hardRed, hardBlue);
  // Layer 3 — lake chain.
  const { lakeChain, hardRuleViolators } = applyLayer3(
    obs,
    scores,
    hardRed,
    hardBlue,
  );
  // Layer 4 — vote + team-pick patterns.
  applyLayer4(obs, scores, hardRed, hardBlue);

  return {
    scores,
    hardRed,
    hardBlue,
    lakeChain,
    hardRuleViolators,
  };
}

/**
 * Convenience: rank players from least suspicious to most.
 * Optionally exclude self.
 */
export function rankBySuspicion(
  pyramid: PyramidScores,
  obs: PlayerObservation,
  excludeSelf = true,
): string[] {
  const ids = obs.allPlayerIds.filter(
    (id) => !excludeSelf || id !== obs.myPlayerId,
  );
  return ids.sort((a, b) => {
    const sa = pyramid.scores.get(a) ?? NEUTRAL;
    const sb = pyramid.scores.get(b) ?? NEUTRAL;
    return sa - sb;
  });
}

// Export constants for callers / tests.
export const PYRAMID_NEUTRAL = NEUTRAL;
export const PYRAMID_HARD_RED = HARD_RED;
export const PYRAMID_HARD_BLUE = HARD_BLUE;
export const PYRAMID_VIOLATOR_FLOOR = VIOLATOR_FLOOR;
