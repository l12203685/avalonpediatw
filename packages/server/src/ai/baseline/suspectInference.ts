/**
 * Baseline suspect inference — public-information-only deductions
 * shared by EVERY role (Edward 2026-04-28 Wave B Q3=C).
 *
 * Wave B core insight: Loyal baseline = "純 baseline (無額外資訊)"
 * — anything a loyal good can read off the public log is a tool any
 * role can call before layering its private knowledge on top.
 *
 * These functions are PURE (no class state, no side-effects). Each
 * accepts a `PlayerObservation` and returns a fresh result. They live
 * outside `HeuristicAgent` so:
 *   1. Roles can call them in any order (the 7-role layering pattern
 *      composes baseline + role override, not class-method chains).
 *   2. Tests can assert on them without instantiating an agent.
 *   3. Future neural agents can reuse the same suspect-set logic
 *      without inheriting Heuristic's memory model.
 *
 * Cross-references:
 *   - `getFailedMissionSuspects` — Edward 2026-04-24 batch 2 fix #9.
 *   - `getLoyalSuspectSet`       — Edward 2026-04-24 batch 10
 *     ("對於忠臣, 看到異常外白優先視為偏紅方").
 *   - `getOuterWhiteApprovers`   — extracted helper, used by
 *     pyramidScorer to penalise blue-side outer-white anomalies.
 *
 * Wave A schema dependency: none. Wave B does NOT read `lakeHistory`
 * here — lake reasoning lives in `lakeChainTracker.ts`.
 */

import type { PlayerObservation } from '../types';

// ── Failed-mission suspect set (batch 2 fix #9) ─────────────────
/**
 * Core deduction every player can make from the public mission log:
 *   If mission M failed with fail-count k, the team S(M) contained
 *   at least k evil players.
 *
 * Without role information a loyal cannot pinpoint WHICH member of
 * S(M) is evil. The conservative response is to treat the entire
 * S(M) as suspect. Merlin / Percival can overlay knownEvils on top.
 *
 * Returns the union of S(M) across all failed missions in
 * `obs.questHistory`. Empty history → empty set.
 */
export function getFailedMissionSuspects(
  obs: PlayerObservation,
): Set<string> {
  const suspects = new Set<string>();
  for (const quest of obs.questHistory) {
    if (quest.result !== 'fail') continue;
    for (const pid of quest.team) suspects.add(pid);
  }
  return suspects;
}

// ── Outer-white approvers ──────────────────────────────────────
/**
 * Players who cast at least one off-team approve (outer-white) in
 * the recorded vote history. Self is excluded — a player never
 * suspects themselves on baseline reasoning.
 *
 * Outer-white is the textbook Oberon-like signature, also a legal
 * red-cover move when a teammate is on the proposed team.
 *
 * Note: this only flags "appeared as off-team approver at least
 * once". Magnitude (count) is intentionally not surfaced here —
 * pyramidScorer composes this with weights of its own.
 */
export function getOuterWhiteApprovers(
  obs: PlayerObservation,
): Set<string> {
  const approvers = new Set<string>();
  for (const record of obs.voteHistory) {
    for (const [pid, approved] of Object.entries(record.votes)) {
      if (pid === obs.myPlayerId) continue;
      if (approved !== true) continue;
      const onTeam = record.team.includes(pid);
      if (!onTeam) approvers.add(pid);
    }
  }
  return approvers;
}

// ── Loyal-specific suspect expansion (batch 10) ────────────────
/**
 * A loyal good player has no privileged information (no knownEvils,
 * no knownWizards). To compensate, she leans on every public anomaly
 * signal she can observe.
 *
 * Edward 2026-04-24 batch 10 verbatim:
 *   「對於忠臣, 看到異常外白優先視為偏紅方
 *     (放在任務隊伍選擇外)」
 *
 * Union of:
 *   (a) members of publicly-failed missions
 *       (= `getFailedMissionSuspects`)
 *   (b) players who cast an off-team approve at any point
 *       (= `getOuterWhiteApprovers`)
 *
 * Self is explicitly excluded.
 */
export function getLoyalSuspectSet(
  obs: PlayerObservation,
): Set<string> {
  const suspects = getFailedMissionSuspects(obs);
  // Add outer-white approvers — Oberon-like signature.
  for (const pid of getOuterWhiteApprovers(obs)) suspects.add(pid);
  // Self never on the baseline suspect set.
  suspects.delete(obs.myPlayerId);
  return suspects;
}
