/**
 * Theory-of-Mind Reverse Engine — Wave E PR1.
 *
 * Edward Round 6 grill verbatim:
 *   遞迴: 我的「解讀」= 反推他人 (解讀→邏輯→目的→動作), 用 pyramid 反向工程
 *
 * Symmetric assumption:
 *   Every other player is ALSO running forward reasoning. Therefore I
 *   can predict what THEY likely think about the table by feeding the
 *   PUBLIC observation back through the same baseline tools — but from
 *   THEIR seat (myPlayerId = them, knownEvils = empty unless I privately
 *   know they're evil and can deduce their teammates).
 *
 * Determinism (Q2=A):
 *   No RNG anywhere. Same `obs` × same `targetId` → same `MindState`.
 *
 * Trace-source (Q3=A):
 *   The output of this engine IS the trace's "解讀" column for the
 *   target player. PR3 wires the trace; PR1 keeps the contract clean.
 *
 * Internal log only (Q4=A):
 *   Pure function — no Discord / Edward / IO. Caller decides what to
 *   surface (debug log, internal trace).
 *
 * Pyramid reuse:
 *   We DO call `computePyramidScores` from baseline — but with a
 *   MUTATED observation where myPlayerId = target. That gives us the
 *   target's POV pyramid. We do NOT recreate scoring logic here. This
 *   is the "B wrap" choice (Q1=B): wrap baseline, do not re-implement.
 */

import type { PlayerObservation } from '../types';
import type { Role } from '@avalon/shared';
import {
  computePyramidScores,
  PYRAMID_HARD_RED,
  PYRAMID_HARD_BLUE,
  PYRAMID_VIOLATOR_FLOOR,
} from '../baseline';
import type { Facts, MindState, RoleProbDistribution } from './types';

// ── Constants ───────────────────────────────────────────────────
/** All 7 canonical roles — keep in sync with `@avalon/shared` Role union. */
const ALL_ROLES: readonly Role[] = [
  'merlin',
  'percival',
  'loyal',
  'assassin',
  'morgana',
  'oberon',
  'mordred',
];

/** Tiny epsilon to keep the role distribution from collapsing to zeros. */
const ROLE_PRIOR_EPSILON = 1e-6;

// ── Utility: clamp a probability vector and renormalise to 1 ───
/**
 * Renormalise a partial role->mass map into a `RoleProbDistribution`.
 *
 * Invariant: every role gets at least `ROLE_PRIOR_EPSILON` mass so the
 * resulting distribution is strictly positive. Caller-provided pinned
 * zeros are honoured first (set the role's mass to 0) and the remaining
 * mass renormalises across the unpinned roles.
 */
export function normalizeRoleDist(
  raw: ReadonlyMap<Role, number>,
  pinnedZeros?: ReadonlySet<Role>,
): RoleProbDistribution {
  const out: Partial<Record<Role, number>> = {};

  // Step 1: respect pinned zeros, otherwise floor at epsilon.
  let total = 0;
  for (const role of ALL_ROLES) {
    if (pinnedZeros?.has(role)) {
      out[role] = 0;
      continue;
    }
    const v = Math.max(ROLE_PRIOR_EPSILON, raw.get(role) ?? ROLE_PRIOR_EPSILON);
    out[role] = v;
    total += v;
  }

  // Step 2: renormalise so unpinned roles sum to 1.
  if (total <= 0) {
    // Fully pinned to zero — degenerate; fall back to uniform on unpinned.
    const unpinned = ALL_ROLES.filter((r) => !pinnedZeros?.has(r));
    const u = unpinned.length === 0 ? 1 : 1 / unpinned.length;
    for (const role of ALL_ROLES) {
      out[role] = pinnedZeros?.has(role) ? 0 : u;
    }
    return out as RoleProbDistribution;
  }

  for (const role of ALL_ROLES) {
    out[role] = (out[role] ?? 0) / total;
  }
  return out as RoleProbDistribution;
}

// ── Build the target's POV observation ─────────────────────────
/**
 * Construct a hypothetical observation FROM the target player's seat
 * using ONLY information that target can see publicly + the agent's
 * privately-known constraints.
 *
 * Key rule (symmetric assumption, public-only):
 *   - target's `knownEvils` = empty set (we cannot assume they know what
 *     we know unless we explicitly inject; PR1 keeps it strict-public)
 *   - target's `myRole` = 'loyal' as a placeholder; the role distribution
 *     output handles the actual role uncertainty
 *   - target's `myTeam` = 'good' placeholder for the same reason
 *   - All public history fields (voteHistory, questHistory, lakeHistory)
 *     are SHARED — they are public by definition.
 *
 * This intentionally yields an observation that is consistent with the
 * weakest possible role (loyal good) so the resulting pyramid scores
 * represent the BASELINE inference any non-privileged seat would make.
 * Roles with private info (Merlin, Percival, evils) layer their private
 * knowledge ON TOP — but PR1 confines itself to the public substrate
 * because the symmetry can only be established at that level.
 */
function projectObsFromSeat(
  obs: PlayerObservation,
  targetId: string,
): PlayerObservation {
  return {
    myPlayerId: targetId,
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: obs.playerCount,
    allPlayerIds: obs.allPlayerIds,
    knownEvils: [],
    knownWizards: undefined,
    allEvilIds: undefined,
    currentRound: obs.currentRound,
    currentLeader: obs.currentLeader,
    failCount: obs.failCount,
    questResults: obs.questResults,
    gamePhase: obs.gamePhase,
    voteHistory: obs.voteHistory,
    questHistory: obs.questHistory,
    proposedTeam: obs.proposedTeam,
    lakeHistory: obs.lakeHistory,
  };
}

// ── Predicted role distribution ────────────────────────────────
/**
 * Map the target's public-baseline suspicion (own self-score in their
 * pyramid is 0 since they think they're loyal good — but ours of THEM
 * is more informative). We use the agent's own pyramid score for the
 * target as the headline signal:
 *
 *   - score ≥ VIOLATOR_FLOOR (0.85): high evil weight → assassin /
 *     morgana / mordred / oberon balanced; merlin/percival/loyal at
 *     epsilon. (We never rule out loyal entirely — pinning is reserved
 *     for our own knownEvils.)
 *   - score in (0.5, 0.85): leans evil but uncertain → balanced spread
 *     across all 7 roles biased toward evil camp.
 *   - score == 0.5: no signal → uniform over 7.
 *   - score in (0.0, 0.5): leans good → biased toward merlin / percival
 *     / loyal.
 *   - score == 0.0 (HARD_BLUE): pinned good → assassin / morgana /
 *     oberon / mordred at epsilon, weight on good roles.
 *
 * Edward's privately-known evils (`obs.knownEvils`) DO let us pin the
 * target's good roles to zero. Edward's `knownWizards` (Percival POV)
 * lets us split the wizard probability mass across merlin/morgana only.
 */
function predictRoleDist(
  obs: PlayerObservation,
  targetId: string,
): RoleProbDistribution {
  const myPyramid = computePyramidScores(obs);
  const targetScore = myPyramid.scores.get(targetId) ?? 0.5;

  const raw = new Map<Role, number>();
  const pinnedZeros = new Set<Role>();

  // Privately-known evil → pin good roles to zero.
  if (obs.knownEvils.includes(targetId)) {
    pinnedZeros.add('merlin');
    pinnedZeros.add('percival');
    pinnedZeros.add('loyal');
  }

  // Privately-known wizard candidate (Percival POV) → only merlin or
  // morgana plausible. All others pinned zero.
  if (obs.knownWizards?.includes(targetId)) {
    for (const r of ALL_ROLES) {
      if (r !== 'merlin' && r !== 'morgana') pinnedZeros.add(r);
    }
  }

  // Allocate mass based on the suspicion score.
  if (targetScore >= PYRAMID_VIOLATOR_FLOOR) {
    // Strong evil lean.
    raw.set('assassin', 1.5);
    raw.set('morgana', 1.5);
    raw.set('mordred', 1.5);
    raw.set('oberon', 1.5);
    raw.set('merlin', 0.1);
    raw.set('percival', 0.1);
    raw.set('loyal', 0.5);
  } else if (targetScore > 0.5) {
    // Moderate evil lean.
    raw.set('assassin', 1.0);
    raw.set('morgana', 1.0);
    raw.set('mordred', 1.0);
    raw.set('oberon', 1.0);
    raw.set('merlin', 0.5);
    raw.set('percival', 0.5);
    raw.set('loyal', 1.0);
  } else if (targetScore === PYRAMID_HARD_BLUE || targetScore < 0.4) {
    // Strong good lean.
    raw.set('merlin', 1.5);
    raw.set('percival', 1.5);
    raw.set('loyal', 2.0);
    raw.set('assassin', 0.1);
    raw.set('morgana', 0.1);
    raw.set('mordred', 0.1);
    raw.set('oberon', 0.1);
  } else if (targetScore === PYRAMID_HARD_RED) {
    // Pinned evil — same shape as VIOLATOR_FLOOR but stronger.
    raw.set('assassin', 2.0);
    raw.set('morgana', 2.0);
    raw.set('mordred', 2.0);
    raw.set('oberon', 2.0);
    raw.set('merlin', ROLE_PRIOR_EPSILON);
    raw.set('percival', ROLE_PRIOR_EPSILON);
    raw.set('loyal', ROLE_PRIOR_EPSILON);
  } else {
    // Neutral or near-neutral → uniform.
    for (const r of ALL_ROLES) raw.set(r, 1.0);
  }

  return normalizeRoleDist(raw, pinnedZeros);
}

// ── Predicted logic / purpose summaries ────────────────────────
/**
 * One-line description of how the target probably reasons given the
 * baseline tools they have access to. Deterministic: same `Facts` ×
 * same `targetId` → same string.
 */
function describePredictedLogic(
  facts: Facts,
  targetId: string,
): string {
  const parts: string[] = [];
  if (facts.failedMissionMembers.has(targetId)) {
    parts.push('on failed mission roster');
  }
  if (facts.outerWhiteApprovers.has(targetId)) {
    parts.push('cast off-team approve');
  }
  if (facts.lakeViolators.has(targetId)) {
    parts.push('lake-chain violator');
  }
  if (parts.length === 0) {
    return `${targetId}: no public anomaly — reasons from neutral baseline`;
  }
  return `${targetId}: ${parts.join('; ')} — likely treated as suspect by other goods`;
}

/**
 * Role-conditioned purpose summary. Picks the highest-probability role
 * and describes that role's typical Avalon goal. Deterministic.
 */
function describePredictedPurpose(
  dist: RoleProbDistribution,
): string {
  let best: Role = 'loyal';
  let bestP = -Infinity;
  for (const role of ALL_ROLES) {
    const p = dist[role] ?? 0;
    if (p > bestP) {
      best = role;
      bestP = p;
    }
  }

  switch (best) {
    case 'merlin':
      return 'most likely merlin → push toward known-clean teams without exposing self';
    case 'percival':
      return 'most likely percival → protect merlin candidate, watch wizard pair';
    case 'loyal':
      return 'most likely loyal → follow public anomaly signals, lean conservative';
    case 'assassin':
      return 'most likely assassin → identify merlin while sabotaging quests';
    case 'morgana':
      return 'most likely morgana → mimic merlin to confuse percival';
    case 'oberon':
      return 'most likely oberon → solo evil, no teammate coordination';
    case 'mordred':
      return 'most likely mordred → hidden from merlin, push tainted teams';
    case 'minion':
      return 'most likely minion → coordinate with evil camp on quests';
  }
}

// ── Public entry: reverse engineer ONE target ──────────────────
/**
 * Reverse-engineer the mental state of `targetId` from the agent's
 * observation `obs` and the pre-computed public Facts.
 *
 * Determinism: pure function. No RNG, no IO, no class state.
 *
 * @param obs       The agent's full observation (private + public).
 * @param facts     The public-only Facts list (Step 1 of the pipeline).
 * @param targetId  The other player whose mind we are reverse engineering.
 * @returns         A `MindState` representing what the target likely thinks.
 */
export function reverseEngineerMind(
  obs: PlayerObservation,
  facts: Facts,
  targetId: string,
): MindState {
  // Pyramid from the target's POV (public-only seat).
  const targetObs = projectObsFromSeat(obs, targetId);
  const targetPyramid = computePyramidScores(targetObs);

  // The target's interpretation = their pyramid suspicion map.
  const interpretation = new Map<string, number>(targetPyramid.scores);

  // Plain-text reasoning summary.
  const predictedLogic = describePredictedLogic(facts, targetId);

  // Role probability distribution from agent's POV.
  const predictedRoleProb = predictRoleDist(obs, targetId);

  // Role-conditioned purpose summary.
  const predictedPurpose = describePredictedPurpose(predictedRoleProb);

  return {
    interpretation,
    predictedLogic,
    predictedPurpose,
    predictedRoleProb,
  };
}

// ── Re-exports for testing / debug log ─────────────────────────
export {
  ALL_ROLES,
  ROLE_PRIOR_EPSILON,
  // Used by tests to assert symmetry / projection invariants.
  projectObsFromSeat,
  predictRoleDist,
};
