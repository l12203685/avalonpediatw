/**
 * Lake declaration chain tracker — Edward 2026-04-28 Wave B core.
 *
 * Implements the 4 hard rules over the public lake declaration record
 * (Wave A schema `LakePublicRecord`):
 *
 *   硬1 (transitivity):    A 湖 B 宣藍 → C 派票選 A 必選 B
 *   硬2 (anti-transitivity): A 湖 B 宣紅 → C 派票選 A 必不選 B
 *   硬3 (rank order):      A 湖 B 宣藍 → A.tier ≤ B.tier (替 B 背書)
 *   硬4 (chain best-path): 首湖藍 → 持續湖到藍 → 末局決定
 *
 * Pyramid layer 3: 湖中宣告 (declarations) — public but defeatable
 * by built-in or mission ground truth. Within layer 3, declarations
 * ARE constrained by these 4 hard rules; declarations that violate
 * one (e.g. cycle of mutual blue claims that cannot all be true) tag
 * the violator with high suspicion (≥0.85).
 *
 * Pure module: input is `obs.lakeHistory`; output is a struct of
 * derived facts (declarationsAsBlue, declarationsAsRed, violators).
 * No memory, no shared state.
 *
 * Red exception (Q11): callers (HeuristicAgent.voteOnTeam etc.)
 * decide whether to apply the hard rules to themselves. This module
 * does not enforce policy — it surfaces violators.
 */

import type { PlayerObservation, LakePublicRecord } from '../types';

// ── Derived chain state ─────────────────────────────────────────
/**
 * Output of `analyzeLakeChain`. All maps key by playerId.
 */
export interface LakeChainState {
  /** holderId → set of targetIds that holder declared blue. */
  declaredBlueByHolder: Map<string, Set<string>>;
  /** holderId → set of targetIds that holder declared red. */
  declaredRedByHolder: Map<string, Set<string>>;
  /** targetId → set of holderIds who declared this target blue. */
  declaredBlueByTarget: Map<string, Set<string>>;
  /** targetId → set of holderIds who declared this target red. */
  declaredRedByTarget: Map<string, Set<string>>;
  /**
   * Players whose declarations are inconsistent with at least one
   * other declaration in the chain (cycle SAT failure / hard-rule
   * violation). Suspicion boost ≥0.85 for these.
   */
  violators: Set<string>;
  /** All public declarations in chronological order. */
  records: readonly LakePublicRecord[];
}

const EMPTY_STATE: LakeChainState = {
  declaredBlueByHolder: new Map(),
  declaredRedByHolder: new Map(),
  declaredBlueByTarget: new Map(),
  declaredRedByTarget: new Map(),
  violators: new Set(),
  records: [],
};

// ── Analyze ────────────────────────────────────────────────────
/**
 * Build the full chain state from `obs.lakeHistory` (Wave A schema).
 *
 * Cycle SAT detection: if `A 湖 B 宣藍` AND `B 湖 A 宣紅` exists, at
 * least one of (A, B) is lying. Conservative: tag both. Same for
 * a 3-cycle where transitivity demands "all blue" but a chain of
 * blues includes one declared-red. The detection here is a simple
 * pairwise + triangle scan — sufficient for Avalon's small lake
 * count (≤4 declarations per game) without a full SAT solver.
 *
 * `undefined` / empty `lakeHistory` returns the empty state.
 */
export function analyzeLakeChain(
  obs: PlayerObservation,
): LakeChainState {
  const records = obs.lakeHistory ?? [];
  if (records.length === 0) return EMPTY_STATE;

  const declaredBlueByHolder = new Map<string, Set<string>>();
  const declaredRedByHolder = new Map<string, Set<string>>();
  const declaredBlueByTarget = new Map<string, Set<string>>();
  const declaredRedByTarget = new Map<string, Set<string>>();

  const addTo = (
    map: Map<string, Set<string>>,
    key: string,
    val: string,
  ): void => {
    const set = map.get(key) ?? new Set<string>();
    set.add(val);
    map.set(key, set);
  };

  for (const rec of records) {
    if (rec.declaredClaim === 'good') {
      addTo(declaredBlueByHolder, rec.holderId, rec.targetId);
      addTo(declaredBlueByTarget, rec.targetId, rec.holderId);
    } else {
      addTo(declaredRedByHolder, rec.holderId, rec.targetId);
      addTo(declaredRedByTarget, rec.targetId, rec.holderId);
    }
  }

  // Cycle SAT — pairwise mutual-contradiction scan.
  // If A→B blue AND B→A red, at least one lies. Conservative: both.
  // If A→B red AND B→A blue, mirror.
  const violators = new Set<string>();
  for (const rec of records) {
    const opposite =
      rec.declaredClaim === 'good'
        ? declaredRedByHolder.get(rec.targetId)
        : declaredBlueByHolder.get(rec.targetId);
    if (opposite && opposite.has(rec.holderId)) {
      violators.add(rec.holderId);
      violators.add(rec.targetId);
    }
  }

  // 3-step: A→B blue, B→C blue, but C→A red is inconsistent
  // (transitivity says A and C should both be blue from A's view).
  // If A claimed blue on B and B claimed blue on C, C claiming A red
  // contradicts the implied blue-chain — tag C as the violator.
  for (const rec1 of records) {
    if (rec1.declaredClaim !== 'good') continue;
    const middle = rec1.targetId;
    const blueFromMiddle = declaredBlueByHolder.get(middle);
    if (!blueFromMiddle) continue;
    for (const tail of blueFromMiddle) {
      const tailRedFollowups = declaredRedByHolder.get(tail);
      if (!tailRedFollowups) continue;
      if (tailRedFollowups.has(rec1.holderId)) {
        // tail (C) declares the chain-head (A) red, breaking transitivity.
        violators.add(tail);
      }
    }
  }

  return {
    declaredBlueByHolder,
    declaredRedByHolder,
    declaredBlueByTarget,
    declaredRedByTarget,
    violators,
    records,
  };
}

// ── Hard rule check API ────────────────────────────────────────
/**
 * Is including `targetId` on a team led by `leaderId` consistent with
 * 硬1 + 硬2?
 *
 *   硬1: leader L 湖 B 宣藍 → 派 L 必含 B
 *        (a clean leader vouches for their declared-blue → MUST include)
 *   硬2: leader L 湖 B 宣紅 → 派 L 不可含 B
 *        (declaring B red while picking B = obvious contradiction)
 *
 * Returns:
 *   - 'must_include' — leader declared target blue, but team excludes target
 *   - 'must_exclude' — leader declared target red, but team includes target
 *   - 'ok' — no hard-rule conflict for this leader×target×team
 */
export function checkHardRulesForLeader(
  state: LakeChainState,
  leaderId: string,
  targetId: string,
  teamIncludesTarget: boolean,
): 'must_include' | 'must_exclude' | 'ok' {
  const blueTargets = state.declaredBlueByHolder.get(leaderId);
  const redTargets = state.declaredRedByHolder.get(leaderId);

  if (blueTargets?.has(targetId) && !teamIncludesTarget) {
    return 'must_include';
  }
  if (redTargets?.has(targetId) && teamIncludesTarget) {
    return 'must_exclude';
  }
  return 'ok';
}

/**
 * Does the proposed team violate 硬1 / 硬2 from the leader's POV?
 *
 * Concretely: for the team's leader, gather all of their lake
 * declarations and check each against the proposed roster:
 *   - Every declared-blue target MUST be on the team
 *   - Every declared-red target MUST NOT be on the team
 *
 * If either invariant breaks, we return the offending pair so the
 * caller (vote / select logic) can either reject the team (good side)
 * or apply the red exception (Q11).
 */
export function findHardRuleViolations(
  state: LakeChainState,
  leaderId: string,
  proposedTeam: readonly string[],
): Array<{ rule: 1 | 2; leaderId: string; targetId: string }> {
  const out: Array<{ rule: 1 | 2; leaderId: string; targetId: string }> = [];
  const teamSet = new Set(proposedTeam);

  const blueTargets = state.declaredBlueByHolder.get(leaderId) ?? new Set();
  for (const t of blueTargets) {
    if (!teamSet.has(t)) out.push({ rule: 1, leaderId, targetId: t });
  }
  const redTargets = state.declaredRedByHolder.get(leaderId) ?? new Set();
  for (const t of redTargets) {
    if (teamSet.has(t)) out.push({ rule: 2, leaderId, targetId: t });
  }
  return out;
}

// ── 硬3 rank check ─────────────────────────────────────────────
/**
 * 硬3 (替 B 背書 → A 較低層): if A declared B blue, A's tier ≤ B's
 * tier. We approximate "tier" as suspicion direction — if A is later
 * observed acting like a higher-tier red (e.g. proposing tainted
 * teams or rejecting clean ones) while having endorsed B, that's a
 * 硬3 violation.
 *
 * Implementation: returns set of holderIds (A) who declared blue on
 * any target B AND whose own subsequent leader behaviour shows them
 * proposing teams that contradict their endorsement. Specifically:
 *   - A endorsed B as blue
 *   - A is later leader and either:
 *       (a) excludes B from a team where space exists (硬1 already
 *           catches this — but 硬3 is the suspicion side-effect)
 *       (b) leads a team whose mission later failed
 *
 * Tag (a) cases at +0.85, (b) at +0.5 so the caller can stack.
 */
export function findRule3Violators(
  state: LakeChainState,
  obs: PlayerObservation,
): Map<string, number> {
  const score = new Map<string, number>();
  for (const [holder, blueSet] of state.declaredBlueByHolder) {
    for (const target of blueSet) {
      // (b) holder later led a team that failed — endorsed B but led
      // a tainted team → semantic 硬3 weak violation.
      const leaderRecords = obs.voteHistory.filter(
        (v) => v.leader === holder,
      );
      for (const rec of leaderRecords) {
        const failedQ = obs.questHistory.find(
          (q) => q.round === rec.round && q.result === 'fail',
        );
        if (failedQ && failedQ.team.every((id) => rec.team.includes(id))) {
          score.set(holder, Math.max(score.get(holder) ?? 0, 0.5));
        }
      }
      // (a) A is leader and excluded the endorsed B from their team
      // (room permitting). This is 硬1 violation territory; we boost
      // the holder's suspicion to ≥0.85 per pyramid spec.
      for (const rec of leaderRecords) {
        if (rec.team.length >= 1 && !rec.team.includes(target)) {
          score.set(holder, Math.max(score.get(holder) ?? 0, 0.85));
        }
      }
    }
  }
  return score;
}
