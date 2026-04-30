/**
 * Interpretation Module — Wave E PR1 (Step 1 of the forward pipeline).
 *
 * Edward Round 6 grill verbatim:
 *   AI decision flow (4 steps):
 *     step 1 解讀  ← THIS MODULE
 *     step 2 邏輯  (PR2)
 *     step 3 目的  (PR2)
 *     step 4 動作  (PR2)
 *
 *   遞迴: 我的「解讀」= 反推他人 (解讀→邏輯→目的→動作), 用 pyramid 反向工程.
 *
 * Wrap-not-fork (Q1=B):
 *   This module is a NEW class that WRAPS existing baseline tools. It
 *   never modifies HeuristicAgent / pyramidScorer / suspectInference /
 *   lakeChainTracker / voteInferer. Those remain the canonical Wave B
 *   baseline; PR2 (decision side) will compose this Step 1 output with
 *   the existing HeuristicAgent action logic.
 *
 * Pure module (Q2=A deterministic, Q4=A internal-only):
 *   `interpret(obs)` is a pure function — no class state outside the
 *   wrapper, no IO, no RNG. Given the same observation it always returns
 *   the same `InterpretationResult`. No Discord / Edward notification.
 *
 * Trace-source (Q3=A):
 *   The output of `interpret(obs)` IS the trace's "解讀" column. PR3
 *   wires the trace; PR1 keeps the contract clean and read-only.
 */

import type { PlayerObservation } from '../types';
import {
  getFailedMissionSuspects,
  getOuterWhiteApprovers,
  analyzeLakeChain,
} from '../baseline';
import {
  reverseEngineerMind,
} from './ToMReverseEngine';
import type {
  Facts,
  InterpretationResult,
  MindState,
} from './types';

// ── Step 1a: extract public-only Facts ─────────────────────────
/**
 * Extract the public Facts list from an observation.
 *
 * Public-only by construction:
 *   - failedMissionMembers / outerWhiteApprovers / lakeViolators / lakeChain
 *     come straight from baseline tools that ignore role-private data.
 *   - knownEvils / knownWizards mirror the agent's own private knowledge
 *     and are kept here so callers (and unit tests) can audit what the
 *     agent privately knew at the time of interpretation.
 *
 * Self-filter:
 *   `outerWhiteApprovers` already filters self (baseline contract), so
 *   we don't double-filter here.
 */
export function extractFacts(obs: PlayerObservation): Facts {
  const failedMissionMembers = getFailedMissionSuspects(obs);
  const outerWhiteApprovers = getOuterWhiteApprovers(obs);
  const lakeChainState = analyzeLakeChain(obs);

  return {
    failedMissionMembers,
    outerWhiteApprovers,
    lakeViolators: lakeChainState.violators,
    lakeChain: lakeChainState.records,
    knownEvils: new Set(obs.knownEvils),
    knownWizards: new Set(obs.knownWizards ?? []),
    allPlayerIds: obs.allPlayerIds,
    currentRound: obs.currentRound,
  };
}

// ── Step 1b: ToM reverse engine for every other player ────────
/**
 * Run the ToM reverse engine for every player except self.
 *
 * Pure projection over `obs.allPlayerIds`. Self is skipped because we
 * never reverse-engineer ourselves (we have full private knowledge).
 *
 * Determinism: iteration order matches `obs.allPlayerIds`, baseline
 * tools are pure → output Map iteration order is stable.
 */
function buildMindMap(
  obs: PlayerObservation,
  facts: Facts,
): Map<string, MindState> {
  const mindBy = new Map<string, MindState>();
  for (const pid of obs.allPlayerIds) {
    if (pid === obs.myPlayerId) continue;
    mindBy.set(pid, reverseEngineerMind(obs, facts, pid));
  }
  return mindBy;
}

// ── Public entry: full Step 1 interpretation ───────────────────
/**
 * Run the full Step 1 解讀 pipeline:
 *   1. Extract public Facts
 *   2. Reverse-engineer every other player's MindState
 *   3. Return both as a single `InterpretationResult`
 *
 * Pure function — no side effects. Caller can log the result internally
 * (Q4=A internal log only) or feed it into PR2's decision pipeline.
 *
 * @param obs Agent's full private observation.
 * @returns   `InterpretationResult` carrying Facts + per-other-player MindState.
 */
export function interpret(obs: PlayerObservation): InterpretationResult {
  const facts = extractFacts(obs);
  const mindBy = buildMindMap(obs, facts);
  return { facts, mindBy };
}

// ── Wrapper class (optional) ───────────────────────────────────
/**
 * Class-shaped wrapper for callers that prefer instance APIs (e.g. PR2
 * may instantiate one per agent for debug-trace bookkeeping).
 *
 * The wrapper holds NO state — every call re-projects from the input
 * observation. This matches Q1=B "wrap baseline" without recreating any
 * scoring logic.
 */
export class InterpretationModule {
  /**
   * Run Step 1 interpretation. Same as the free function `interpret`.
   *
   * Static-equivalent: `new InterpretationModule().interpret(obs)` ===
   * `interpret(obs)` for any `obs`.
   */
  interpret(obs: PlayerObservation): InterpretationResult {
    return interpret(obs);
  }
}
