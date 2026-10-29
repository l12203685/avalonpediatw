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
 * Pure function — no class state, deterministic given an observation
 * and the belief switches (`belief/BeliefOptions.ts`, logic-first batch
 * 1C, 2026-10-22; docs/ai/logic_first.md):
 *
 *   - `certainFacts` (S1-1, INV-B2): layer 1 also pins what the viewer can
 *     *prove* through the certainty layer (`belief/Certainty.ts`): seats
 *     red / good in every world consistent with the rules, the viewer's
 *     own sight, every mission's fail cards and the viewer's own lake
 *     results (L0) are pinned 1 / 0 like a sighted red; seats certain only
 *     under A0 ("a good lake holder tells the truth", L1) are pinned
 *     1 − ε / ε (ε = `CERTAINTY_EPS` = 0.01, GM decision D1 — hard for
 *     vetoes and invariants, a 1% allowance in the probability layer).
 *     Layer 2 counts fail cards (C2): a mission with x cards and r pinned
 *     reds on it spreads x − r unexplained cards over its unpinned
 *     members (+0.45 × share each, same +0.15 as before for a 3-seat team
 *     with one card, cap 0.7), and an R4 success with a fail card counts
 *     (C5). A seat pinned by a certainty is never moved by a lower layer.
 *   - `rule3PostLake` (S1-2, INV-H3a / INV-H3b): the 硬3 flag comes from
 *     post-lake, strictly dominated omissions only
 *     (`lakeChainTracker.findRule3Violators`) and is applied as an odds
 *     update with likelihood ratio `RULE3_LIKELIHOOD_RATIO` (6, the
 *     conservative bound; D10) instead of the fixed 0.85 floor (X5).
 *   - `chainProjection` (S1-3 belief part, INV-B1): after the layers, the
 *     scores of the unpinned seats are projected onto the lake-chain
 *     constraints — s(B) ≤ s(A) for every "A declared B blue" (so
 *     s(C) ≤ s(B) ≤ s(A) along a chain, K1 / K3) and s(A) + s(B) ≥ 1 for
 *     every "A declared B red" (K2) — by alternating Euclidean
 *     projections (each violated pair moves to its nearest satisfying
 *     point; the sets are convex half-spaces, so the sweeps converge).
 *     K5 reversals (B proven red ⇒ A red) arrive through the certainty
 *     pins, which the projection leaves alone.
 *   - `forcedVotesZero` (S1-9a, INV-F0): the forced fifth proposal's
 *     synthetic votes are skipped by every vote reader here (layer 4 and
 *     the H12 declarer vote bias).
 */

import type { PlayerObservation } from '../types';
import {
  getFailedMissionSuspects,
  getOuterWhiteApprovers,
} from './suspectInference';
import {
  analyzeLakeChain,
  findRule3Violators,
  RULE3_LIKELIHOOD_RATIO,
  type LakeChainState,
} from './lakeChainTracker';
import { layer4Score } from './voteInferer';
import {
  bucketDeclarerVoteBias,
} from '../priors/EvActionPriors';
import { CERTAINTY_EPS, buildCertainty, type CertaintyView } from '../belief/Certainty';
import { bayesRedShare } from '../belief/BayesBelief';
import { defaultBeliefOptions, isForcedVoteRecord, type BeliefOptions } from '../belief/BeliefOptions';
import { beliefFailCards } from '../missionFacts';

// ── Score constants ────────────────────────────────────────────
const NEUTRAL = 0.5;
const HARD_RED = 1.0;
const HARD_BLUE = 0.0;

/** Cycle / Rule 3 violator boost target. */
const VIOLATOR_FLOOR = 0.85;

/** Layer 2 (S1-1): suspicion added per unit of unexplained fail-card share; cap of the layer. */
const LAYER2_SHARE_SCALE = 0.45;
const LAYER2_CAP = 0.7;

// ── Output type ────────────────────────────────────────────────
export interface PyramidScores {
  /** Map<playerId, suspicion ∈ [0, 1]>. Higher = more likely red. */
  scores: Map<string, number>;
  /** PlayerIds the agent's built-in knowledge (and, with `certainFacts`, its proofs) pins as red. */
  hardRed: Set<string>;
  /** PlayerIds the agent's built-in knowledge (and, with `certainFacts`, its proofs) pins as blue. */
  hardBlue: Set<string>;
  /** Lake chain state (Wave B 4 hard rules). */
  lakeChain: LakeChainState;
  /** Players violating layer-3 hard rules — caller may apply policy. */
  hardRuleViolators: Set<string>;
  /** S1-1: the certainty view behind the layer-1 pins (`certainFacts` on only). */
  certainty?: CertaintyView;
}

// ── Helper: clamp ──────────────────────────────────────────────
function clamp01(x: number): number {
  if (Number.isNaN(x)) return NEUTRAL;
  return Math.max(0, Math.min(1, x));
}

/** Bayesian odds update of a probability by a likelihood ratio. */
export function oddsUpdate(p: number, likelihoodRatio: number): number {
  const q = clamp01(p);
  const num = likelihoodRatio * q;
  const den = num + (1 - q);
  return den > 0 ? num / den : q;
}

// ── Layer 1 prior (built-in) ───────────────────────────────────
/**
 * Apply role-private ground truth as hard pins.
 *
 * Layer 1 OVERRIDES every lower layer (Q9). A built-in knownEvils
 * pin at 1.0 cannot be lowered by lake / vote / pick signals.
 *
 * S1-1 (`certainFacts`): the certainty layer's proofs are pinned too —
 * L0 facts at 1 / 0, facts that need A0 at 1 − ε / ε.
 */
function applyLayer1(
  obs: PlayerObservation,
  scores: Map<string, number>,
  opts: Readonly<BeliefOptions>,
): { hardRed: Set<string>; hardBlue: Set<string>; certainty?: CertaintyView } {
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

  if (!opts.certainFacts) return { hardRed, hardBlue };

  // S1-1: certain facts (C2 / C4 / C5 / C6, P1 / P2 / P3, M2, Pe1) reach the beliefs.
  const certainty = buildCertainty(obs);
  const l0Red = certainty.certRedMask('L0');
  const l0Good = certainty.certGoodMask('L0');
  const l1Red = certainty.l1Empty ? 0 : certainty.certRedMask('L1');
  const l1Good = certainty.l1Empty ? 0 : certainty.certGoodMask('L1');
  for (const id of obs.allPlayerIds) {
    if (hardRed.has(id) || hardBlue.has(id)) continue;
    const bit = certainty.bitOf(id);
    if (bit === 0) continue;
    if (l0Red & bit) { hardRed.add(id); scores.set(id, HARD_RED); }
    else if (l0Good & bit) { hardBlue.add(id); scores.set(id, HARD_BLUE); }
    else if (l1Red & bit) { hardRed.add(id); scores.set(id, 1 - CERTAINTY_EPS); }
    else if (l1Good & bit) { hardBlue.add(id); scores.set(id, CERTAINTY_EPS); }
  }
  return { hardRed, hardBlue, certainty };
}

// ── Layer 2 prior (quest results) ──────────────────────────────
/**
 * Quest result evidence: failed-mission members get a sub-1.0 boost
 * (because failed-mission only proves AT LEAST k evils, not which
 * exact members).
 *
 * Players covered by Layer 1 are NOT modified here (cross-layer
 * override).
 *
 * S1-1 (`certainFacts`): per mission, the fail cards not explained by
 * the pinned reds on the team are spread over its unpinned members
 * (C2 counting, R4 successes with a card included); off: every member
 * of any failed mission gets the flat +0.15 once.
 */
function applyLayer2(
  obs: PlayerObservation,
  scores: Map<string, number>,
  hardRed: Set<string>,
  hardBlue: Set<string>,
  opts: Readonly<BeliefOptions>,
): void {
  if (!opts.certainFacts) {
    const suspects = getFailedMissionSuspects(obs, opts);
    for (const id of suspects) {
      if (hardRed.has(id) || hardBlue.has(id)) continue;
      const cur = scores.get(id) ?? NEUTRAL;
      // Failed mission member → push toward red but cap at 0.7 so
      // layer 3 / 4 still has room to discriminate.
      scores.set(id, clamp01(Math.max(cur, Math.min(LAYER2_CAP, cur + 0.15))));
    }
    return;
  }
  for (const quest of obs.questHistory) {
    const cards = beliefFailCards(quest, true);
    if (cards === 0) continue;
    const unpinned = quest.team.filter((id) => !hardRed.has(id) && !hardBlue.has(id));
    const pinnedRed = quest.team.filter((id) => hardRed.has(id)).length;
    const unexplained = Math.max(0, cards - pinnedRed);
    if (unexplained === 0 || unpinned.length === 0) continue;
    const share = unexplained / unpinned.length;
    for (const id of unpinned) {
      const cur = scores.get(id) ?? NEUTRAL;
      scores.set(id, clamp01(Math.max(cur, Math.min(LAYER2_CAP, cur + LAYER2_SHARE_SCALE * share))));
    }
  }
}

// ── Layer 3 prior (lake declarations + hard rules) ─────────────
/**
 * Lake-chain analysis. Cycle violators get pinned at ≥0.85.
 * Rule-3 holders that endorsed B but later contradicted themselves
 * get the boost too (per `findRule3Violators`) — with `rule3PostLake`
 * an odds update by `RULE3_LIKELIHOOD_RATIO` instead of the floor.
 */
function applyLayer3(
  obs: PlayerObservation,
  scores: Map<string, number>,
  hardRed: Set<string>,
  hardBlue: Set<string>,
  opts: Readonly<BeliefOptions>,
): { lakeChain: LakeChainState; hardRuleViolators: Set<string> } {
  const lakeChain = analyzeLakeChain(obs);
  const hardRuleViolators = new Set<string>(lakeChain.violators);

  for (const id of lakeChain.violators) {
    if (hardRed.has(id) || hardBlue.has(id)) continue;
    scores.set(id, clamp01(Math.max(scores.get(id) ?? NEUTRAL, VIOLATOR_FLOOR)));
  }

  // Rule 3 violators
  const r3 = findRule3Violators(lakeChain, obs, opts);
  for (const [id, boost] of r3) {
    if (hardRed.has(id) || hardBlue.has(id)) continue;
    hardRuleViolators.add(id);
    const cur = scores.get(id) ?? NEUTRAL;
    scores.set(id, opts.rule3PostLake
      ? clamp01(oddsUpdate(cur, RULE3_LIKELIHOOD_RATIO))
      : clamp01(Math.max(cur, boost)));
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
  // S1-9a (`forcedVotesZero`): the forced fifth proposal's synthetic
  // votes are not votes and are skipped.
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
      if (opts.forcedVotesZero && isForcedVoteRecord(record)) continue;
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
  opts: Readonly<BeliefOptions>,
): void {
  const layer4 = layer4Score(obs, opts);
  // Outer-white approvers (loyal-suspect signature) — keep visible
  // even if layer4Score didn't already weight them.
  const owers = getOuterWhiteApprovers(obs, opts);
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

// ── Projection onto the lake-chain constraints (S1-3) ──────────
/** Sweeps of alternating projections; each halves the remaining violation at least. */
const PROJECTION_MAX_SWEEPS = 200;
const PROJECTION_TOLERANCE = 1e-12;

/**
 * K1 / K3 / K2 as constraints on the unpinned scores: for every public
 * "A declared B blue" s(B) ≤ s(A); for every "A declared B red"
 * s(A) + s(B) ≥ 1. A violated blue pair moves to its mean (the nearest
 * point of the half-space s(B) ≤ s(A)); a violated red pair moves up by
 * half the shortfall each. Pinned seats (layer-1 facts) never move, and a
 * pair with a pinned seat is left to the certainty layer (K5: a declared
 * blue proven red pins the holder red there).
 */
function applyChainProjection(
  scores: Map<string, number>,
  lakeChain: LakeChainState,
  pinned: ReadonlySet<string>,
): void {
  const free = (id: string): boolean => scores.has(id) && !pinned.has(id);
  const blue: Array<[string, string]> = [];
  const red: Array<[string, string]> = [];
  for (const rec of lakeChain.records) {
    if (rec.holderId === rec.targetId || !free(rec.holderId) || !free(rec.targetId)) continue;
    if (rec.declaredClaim === 'good') blue.push([rec.holderId, rec.targetId]);
    else if (rec.declaredClaim === 'evil') red.push([rec.holderId, rec.targetId]);
  }
  if (blue.length === 0 && red.length === 0) return;
  const get = (id: string): number => scores.get(id) ?? NEUTRAL;
  for (let sweep = 0; sweep < PROJECTION_MAX_SWEEPS; sweep++) {
    let moved = 0;
    for (const [a, b] of blue) {
      const sa = get(a);
      const sb = get(b);
      if (sb > sa) {
        const m = clamp01((sa + sb) / 2);
        scores.set(a, m);
        scores.set(b, m);
        moved = Math.max(moved, sb - sa);
      }
    }
    for (const [a, b] of red) {
      const sa = get(a);
      const sb = get(b);
      const shortfall = 1 - (sa + sb);
      if (shortfall > 0) {
        scores.set(a, clamp01(sa + shortfall / 2));
        scores.set(b, clamp01(sb + shortfall / 2));
        moved = Math.max(moved, shortfall);
      }
    }
    if (moved <= PROJECTION_TOLERANCE) break;
  }
}

// ── Public entry ───────────────────────────────────────────────
/**
 * Compute the 5-layer pyramid score for every player visible in
 * `obs.allPlayerIds`, given the agent's POV (`obs.myRole`,
 * `obs.knownEvils`, `obs.knownWizards`, `obs.allEvilIds`) and the
 * belief switches (`opts`; default = the production default plus the
 * `AVALON_TUNING_*` environment).
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
  opts: Readonly<BeliefOptions> = defaultBeliefOptions(),
): PyramidScores {
  // Initialise everyone at NEUTRAL.
  const scores = new Map<string, number>();
  for (const id of obs.allPlayerIds) {
    scores.set(id, NEUTRAL);
  }

  // Layer 1 hard pins.
  const { hardRed, hardBlue, certainty } = applyLayer1(obs, scores, opts);
  // Layer 2 — failed-mission suspects.
  applyLayer2(obs, scores, hardRed, hardBlue, opts);
  // Layer 3 — lake chain.
  const { lakeChain, hardRuleViolators } = applyLayer3(
    obs,
    scores,
    hardRed,
    hardBlue,
    opts,
  );
  // Layer 4 — vote + team-pick patterns.
  applyLayer4(obs, scores, hardRed, hardBlue, opts);
  // S1-3 — the lake-chain order on the unpinned seats.
  if (opts.chainProjection) {
    applyChainProjection(scores, lakeChain, new Set([...hardRed, ...hardBlue]));
  }
  // worldShareBelief: a good viewer's suspicion is its share of the consistent worlds (see BeliefOptions).
  if (opts.bayes && obs.myTeam === 'good') {
    const post = bayesRedShare(obs, { thumbRoles: opts.bayesThumbRoles === true, strictMerlin: opts.percivalThumbLogic === true, merlinMixture: opts.loyalMerlinRead ?? 0, zoneMerlin: opts.merlinZoneSignal === true });
    for (const id of obs.allPlayerIds) scores.set(id, id === obs.myPlayerId ? 0 : post.get(id) ?? 0.5);
  } else if (opts.worldShare && obs.myTeam === 'good') {
    const view = buildCertainty(obs);
    for (const id of obs.allPlayerIds) scores.set(id, id === obs.myPlayerId ? 0 : view.uniformRedShare(id));
  }

  return {
    scores,
    hardRed,
    hardBlue,
    lakeChain,
    hardRuleViolators,
    certainty,
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
