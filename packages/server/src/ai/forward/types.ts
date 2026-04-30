/**
 * Wave E PR1 — Forward Reasoning module shared types.
 *
 * Edward Round 6 grill (2026-04-29) decisions:
 *   forward reasoning = THINKING MODE built on baseline building blocks.
 *
 *   AI decision flow (4 steps):
 *     step 1 解讀  — interpret using baseline tools + ToM reverse engine
 *     step 2 邏輯  — derive logic from interpretation
 *     step 3 目的  — role-aware purpose layer
 *     step 4 動作  — final action (PR2 wires this; PR1 is read-side only)
 *
 *   Recursion: 我的「解讀」= 反推他人 (their interpret→logic→purpose→action),
 *   using the pyramid in reverse — assume opponents are also using forward
 *   reasoning, then reverse-engineer their mind from public history alone.
 *
 * Locked answers (Round 6):
 *   Q1=B  Wrap a NEW class around baseline (no fork of HeuristicAgent here)
 *   Q2=A  Deterministic (no RNG)
 *   Q3=A  Trace == forward output (no two sources of truth)
 *   Q4=A  Internal log only (no Discord / Edward notification)
 *   Q5=B  Split into 3 PRs (PR1 read-side only, this file lives here)
 *
 * PR1 scope (this directory):
 *   - InterpretationModule  — extract Facts, run ToM per other player
 *   - ToMReverseEngine      — symmetric reverse engine (single-player)
 *   - types                 — Facts / MindState / RoleProbDistribution
 *
 * Out of scope for PR1 (PR2 / PR3 will own):
 *   - HeuristicAgent.selectTeam / voteOnTeam etc. (still untouched)
 *   - Existing baseline tools (pyramidScorer / suspectInference / etc.)
 *   - 4 lake hard rules / 7-role layering / Oberon 5-point rules
 */

import type { Role } from '@avalon/shared';
import type { LakePublicRecord } from '../types';

// ── Public-only Facts list ─────────────────────────────────────
/**
 * The full list of public observations a forward-reasoning agent can
 * read off the table. This is the input to BOTH:
 *   1. Self-interpretation (own decision pipeline)
 *   2. ToM reverse engine (what the OTHER player can also see)
 *
 * Self never appears in `outerWhiteApprovers` / `failedMissionMembers` —
 * baseline tools already filter self.
 *
 * Note: deliberately omits anything role-private (knownEvils, knownWizards,
 * allEvilIds). Those layer ON TOP of Facts in the role-aware purpose step
 * — PR1 builds the public substrate that the symmetry assumption rests on.
 */
export interface Facts {
  /** Players who appeared on at least one publicly-failed mission. */
  failedMissionMembers: ReadonlySet<string>;
  /** Players who cast at least one off-team approve in vote history. */
  outerWhiteApprovers: ReadonlySet<string>;
  /** Players whose lake declarations create cycle / hard-rule conflicts. */
  lakeViolators: ReadonlySet<string>;
  /** All public lake declarations in chronological order. */
  lakeChain: readonly LakePublicRecord[];
  /** All players the perspective agent privately knows are evil. */
  knownEvils: ReadonlySet<string>;
  /** Percival-only: which IDs look like Merlin/Morgana (can't tell which). */
  knownWizards: ReadonlySet<string>;
  /** All players visible in the game (including self). */
  allPlayerIds: readonly string[];
  /** Round at which Facts were captured. */
  currentRound: number;
}

// ── Role probability distribution ──────────────────────────────
/**
 * A discrete probability distribution over the 7 canonical roles.
 *
 * Invariant (enforced by `normalizeRoleDist`): values sum to 1.0 ± epsilon.
 * Empty distribution (all zeros) is NOT allowed — at minimum every role
 * carries a small uniform prior so logsum / KL stays finite.
 *
 * Normalisation rule (PR1, deterministic): if a role is hard-pinned (e.g.
 * built-in knownEvils → impossible to be merlin) the pinned probability
 * collapses to 0 and the remaining mass renormalises uniformly across
 * unpinned roles.
 */
export type RoleProbDistribution = Readonly<Record<Role, number>>;

// ── Predicted mental state of another player ───────────────────
/**
 * The reverse-engineered mind of ONE other player from the perspective
 * of the agent.
 *
 * Symmetric assumption (Round 6, decision flow):
 *   I assume the other player is ALSO running 解讀→邏輯→目的→動作.
 *   I reverse-engineer their interpretation by applying baseline tools
 *   to the same public Facts they can see.
 *
 * Fields:
 *   - interpretation     — what suspicion structure THEY likely hold
 *                          (suspicion map ∈ [0,1] from their POV)
 *   - predictedLogic     — one-line summary of how they likely reason
 *                          ("treats failed-mission members as ≥0.7 red")
 *   - predictedPurpose   — what their role-conditioned goal probably is
 *                          ("if loyal, push to clean missions";
 *                           "if evil, sabotage R4 quest")
 *   - predictedRoleProb  — distribution over what role they likely hold
 *
 * `predictedRoleProb` is the keystone — every higher-level forward
 * reasoning lookup conditions on this distribution.
 */
export interface MindState {
  /** Other player's POV suspicion map ∈ [0,1] keyed by playerId. */
  interpretation: ReadonlyMap<string, number>;
  /** Plain-text summary of the inferred reasoning chain. */
  predictedLogic: string;
  /** Plain-text summary of the inferred role-conditioned purpose. */
  predictedPurpose: string;
  /** Probability distribution over the 7 canonical roles. */
  predictedRoleProb: RoleProbDistribution;
}

// ── Aggregate interpretation across all other players ──────────
/**
 * Output of `InterpretationModule.interpret(obs)` — the full read-side
 * snapshot:
 *   - facts:    the public substrate (deterministic projection of obs)
 *   - mindBy:   playerId → MindState for each OTHER player
 *
 * Self never appears in `mindBy`. Pure function output — no class state.
 */
export interface InterpretationResult {
  facts: Facts;
  mindBy: ReadonlyMap<string, MindState>;
}
