/**
 * LakePolicy — Lady-of-the-Lake target + public-claim decisions.
 *
 * Extracted from `SelfPlayEngine` (2026-10-10) so any harness that holds a
 * `PlayerObservation` — the live GameServer, a third-party-site bot, the
 * agreement benchmark — can ask the AI for its lake decisions without
 * spinning up a SelfPlayEngine. `SelfPlayEngine.pickLadyTarget` /
 * `decideLakeAnnouncement` now delegate here, so self-play behaviour
 * (including the `Math.random` call order) is unchanged.
 *
 * Two layers:
 *   - `pickLakeTargetForTeam` / `decideLakeClaimForTeam` — the exact
 *     legacy signatures (explicit holder team), used by SelfPlayEngine.
 *   - `pickLakeTarget` / `declareLake` — agent-level convenience API that
 *     reads the holder's camp from `obs.myTeam` and derives the legal
 *     target list from the public lake history when none is given.
 *     `HeuristicAgent.pickLakeTarget` / `declareLake` expose the same API
 *     on the agent.
 */

import type { PlayerObservation } from './types';
import {
  lakeDeclareLiePrior,
  lakeDeclareLieRoleRate,
} from './priors/EvActionPriors';

type Camp = 'good' | 'evil';

// ── Feature flags ──────────────────────────────────────────────

/**
 * Feature flag: smart lake targeting (default on).
 *
 * - `true`  → good filters out knownEvils + knownWizards and picks the
 *             lowest-suspicion unknown-camp candidate; evil ranks
 *             opponents by "likely Merlin" and may wash an ally.
 * - `false` → legacy behavior (good picks knownEvils[0]; evil picks random).
 *
 * Read per-call from `process.env.AVALON_USE_SMART_LAKE` so tests can toggle
 * it without re-loading the module.
 */
export function isSmartLakeEnabled(): boolean {
  return process.env.AVALON_USE_SMART_LAKE !== '0';
}

/**
 * Feature flag: evil holder may strategically lake (and publicly clear) an
 * already-suspected ally. Default on per Edward 2026-04-22 12:39 +08:
 *
 *   「紅方湖中女神當然可以湖隊友並宣告隊友是好人 / 不用刻意避開」
 *
 * When off, the evil branch falls back to the Fix #2 commit `9bdff755`
 * behaviour of filtering out `knownEvils` before scoring.
 */
export function isEvilLakeBringFriendEnabled(): boolean {
  return process.env.AVALON_EVIL_LAKE_BRING_FRIEND !== '0';
}

// ── Agent-level API ────────────────────────────────────────────

/**
 * Legal lake targets derivable from public information: every seat except
 * the holder and anyone who already held or was inspected by the lake
 * (both appear in `lakeHistory`). Undeclared lakes are absent from
 * `lakeHistory`, so callers that know the authoritative used-set (the
 * engine's `ladyOfTheLakeUsed`) should pass it via `alsoUsed` or call
 * `pickLakeTarget` with an explicit target list.
 */
export function deriveValidLakeTargets(
  obs: PlayerObservation,
  alsoUsed: readonly string[] = [],
): string[] {
  const used = new Set<string>([obs.myPlayerId, ...alsoUsed]);
  for (const rec of obs.lakeHistory ?? []) {
    used.add(rec.holderId);
    used.add(rec.targetId);
  }
  return obs.allPlayerIds.filter((id) => !used.has(id));
}

/**
 * Agent-level lake target decision for the holder `obs.myPlayerId`.
 * `validTargets` defaults to `deriveValidLakeTargets(obs)`.
 */
export function pickLakeTarget(
  obs: PlayerObservation,
  validTargets: readonly string[] = deriveValidLakeTargets(obs),
): string {
  return pickLakeTargetForTeam(obs.myTeam, obs, [...validTargets]);
}

/**
 * Agent-level public claim after inspecting `targetId`, whose real camp
 * (what the holder privately saw) is `trueFaction`. Returns `null` when no
 * declaration should be made.
 */
export function declareLake(
  obs: PlayerObservation,
  targetId: string,
  trueFaction: Camp | undefined,
): Camp | null {
  return decideLakeClaimForTeam(obs.myTeam, targetId, obs, trueFaction);
}

// ── Core decisions (legacy SelfPlayEngine signatures) ───────────

/**
 * Pick a lady-of-the-lake target for the holder.
 *
 * Good holder  — target MUST NOT be in `knownEvils` (wastes the lake;
 * SSoT §4.3 / §6.9 / §8.3). Edward 2026-04-29 fundamental fix #2 —
 * prefer LOW-suspicion (high-blue) unknown-camp player to build a
 * trust chain (硬規則 4: 首湖藍 → 持續湖到藍). Pre-fix preferred high
 * suspicion to confirm red; that wins one fact but never seeds a
 * transitive blue chain. fallback to any unlaked player.
 *
 * Evil holder  — with `AVALON_EVIL_LAKE_BRING_FRIEND=1` (default) the holder
 * does NOT filter out allies (Edward 2026-04-22 12:39 +08: "不用刻意避開").
 * A strategic choice is made:
 *   1. If any known-evil ally is currently the *most-suspected* non-ally
 *      in public history (`estimateSuspicionFromHistory` exceeds the most
 *      Merlin-like opponent), lake the ally and plan to declare "good" —
 *      this is a proactive wash of pressure. (See `decideLakeClaimForTeam`.)
 *   2. Otherwise lake the most Merlin-like opponent (original Fix #2 heuristic).
 *   3. When the flag is off, restore Fix #2 behaviour of filtering knownEvils
 *      before scoring (preserved for regression comparison).
 *
 * Legacy (pre-smart) path is kept behind `USE_SMART_LAKE === false` for
 * comparison runs.
 */
export function pickLakeTargetForTeam(
  holderTeam: Camp | undefined,
  obs: PlayerObservation,
  validTargets: string[],
): string {
  if (!isSmartLakeEnabled()) {
    // Legacy: good picks knownEvils[0] (useless), evil picks random.
    if (holderTeam === 'good') {
      const knownEvilTarget = obs.knownEvils.find(id => validTargets.includes(id));
      return knownEvilTarget ?? validTargets[Math.floor(Math.random() * validTargets.length)];
    }
    return validTargets[Math.floor(Math.random() * validTargets.length)];
  }

  const knownEvilSet = new Set(obs.knownEvils);

  if (holderTeam === 'good') {
    // Edward 2026-04-24 batch 2 fix #7: all good players avoid lake-
    // ing their viewpoint-known bad/ambiguous targets:
    //   • merlin   — knownEvils = assassin+morgana+oberon (only
    //                Mordred invisible per Edward 2026-04-26 spec →
    //                lake-probe still allowed for Mordred)
    //   • percival — knownWizards = [merlin, morgana] (ambiguous — can't
    //                distinguish); avoid both so we never waste the lake.
    //   • loyal    — knownEvils = [], knownWizards = undefined → no
    //                filter (loyal must rely on suspicion ranking alone).
    // The filter set is knownEvils ∪ knownWizards so each role's view
    // is honoured without branching on myRole.
    const avoidSet = new Set<string>(obs.knownEvils);
    for (const wizardId of obs.knownWizards ?? []) avoidSet.add(wizardId);
    const unknownCandidates = validTargets.filter(id => !avoidSet.has(id));
    if (unknownCandidates.length === 0) {
      return validTargets[0];
    }
    // ── Edward 2026-04-29 fundamental fix #2 — lake target prefers low red ──
    // Edward 13:35 self-play evidence: R1 任務 130 oox (1 fail) → 1家
    // 紅嫌 ≥ 0.7。R2 通過 2370 oooo → 0 家拿湖。0 家(忠臣) 卻湖了高紅嫌
    // 的 1 家 — wrong direction. 反向 — 優先湖 LOW 紅嫌 (高藍嫌) 玩家，
    // 建信任鏈 (硬規則 4 transitive blue chain)。
    return rankByAscendingScore(
      unknownCandidates,
      id => estimateSuspicionFromHistory(id, obs),
      obs.allPlayerIds,
    )[0];
  }

  // Evil branch — Edward 2026-04-22 12:39 +08 correction.
  if (isEvilLakeBringFriendEnabled()) {
    // Consider every valid target (including allies) — do not filter knownEvils.
    const opponents = validTargets.filter(id => !knownEvilSet.has(id));
    const allies    = validTargets.filter(id =>  knownEvilSet.has(id));

    // Rank opponents by Merlin-likeness, allies by how suspected they currently look
    // (allies publicly look risky → washing them with "good" declaration has high payoff).
    const bestOpponent = opponents.length === 0 ? null : rankByDescendingScore(
      opponents,
      id => estimateMerlinLikenessFromHistory(id, obs),
      obs.allPlayerIds,
    )[0];
    const mostPressuredAlly = allies.length === 0 ? null : rankByDescendingScore(
      allies,
      id => estimateSuspicionFromHistory(id, obs),
      obs.allPlayerIds,
    )[0];

    const opponentScore = bestOpponent === null
      ? Number.NEGATIVE_INFINITY
      : estimateMerlinLikenessFromHistory(bestOpponent, obs);
    const allyPressure = mostPressuredAlly === null
      ? Number.NEGATIVE_INFINITY
      : estimateSuspicionFromHistory(mostPressuredAlly, obs);

    // Heuristic: if an ally is visibly under suspicion (positive pressure)
    // and the best opponent does not read strongly as Merlin
    // (≤ ally pressure), wash the ally. Otherwise pin the Merlin-like opponent.
    if (
      mostPressuredAlly !== null &&
      allyPressure > 0 &&
      allyPressure >= opponentScore
    ) {
      return mostPressuredAlly;
    }
    if (bestOpponent !== null) {
      return bestOpponent;
    }
    // Only allies remain (no opponents valid) → wash the most pressured one.
    if (mostPressuredAlly !== null) {
      return mostPressuredAlly;
    }
    // Extremely degenerate: no valid targets after partitioning (shouldn't happen).
    return validTargets[0];
  }

  // Flag off → Fix #2 (`9bdff755`) regression behaviour: filter allies then rank.
  const unknownCandidates = validTargets.filter(id => !knownEvilSet.has(id));
  if (unknownCandidates.length === 0) {
    return validTargets[0];
  }
  return rankByDescendingScore(
    unknownCandidates,
    id => estimateMerlinLikenessFromHistory(id, obs),
    obs.allPlayerIds,
  )[0];
}

/**
 * Decide what (if anything) the holder will publicly claim about the
 * target right after the lake — Edward 2026-04-22 12:39 +08:
 *
 *   「紅方湖中女神當然可以湖隊友並宣告隊友是好人」
 *
 * Good holder  — announce the truth.
 *
 * Evil holder  — always announce "good" for an ally (wash) and for an
 * opponent announce the role that best furthers the evil narrative:
 *   - If the opponent reads strongly as Merlin (positive score), publicly
 *     call them "good" — confirms them as safe and disguises the assassin
 *     intel.
 *   - Otherwise call them "evil" to seed confusion on a clean opponent.
 *   - EV-prior nudge (Hook 5 / v8 H7) may flip close calls toward the
 *     role's historically +EV lie (uses `Math.random`).
 *
 * Returns `null` when no declaration should be made (holderTeam unknown,
 * or a good holder without a known target camp).
 */
export function decideLakeClaimForTeam(
  holderTeam: Camp | undefined,
  targetId: string,
  obs: PlayerObservation,
  actualTargetTeam: Camp | undefined,
): Camp | null {
  if (holderTeam !== 'good' && holderTeam !== 'evil') return null;

  if (holderTeam === 'good') {
    // Good holder tells the truth when a team is known.
    if (actualTargetTeam === 'good' || actualTargetTeam === 'evil') {
      return actualTargetTeam;
    }
    return null;
  }

  // Evil holder.
  const knownEvilSet = new Set(obs.knownEvils);
  if (knownEvilSet.has(targetId)) {
    // Ally → always publicly wash as good.
    return 'good';
  }
  // Opponent branch: score Merlin-likeness; if Merlin-like, call them good to
  // disguise the intel. Otherwise call them evil to muddy the water.
  const merlinScore = estimateMerlinLikenessFromHistory(targetId, obs);
  const baseDecision: Camp = merlinScore > 0 ? 'good' : 'evil';

  // ── EV-prior nudge (2026-04-25 ship · Hook 5 lakeDeclare_lie_Prior) ──
  // When the holder's role has a +EV "lie" pattern (morgana 紅→藍 +16.48pp,
  // oberon 紅→藍 +9.00pp, assassin 藍→紅 +4.57pp), bias the decision in
  // close calls toward the historically winning lie pattern. Strong
  // merlinScore signals (|score| >= 1) keep the evidence-driven decision.
  const lieBonus = lakeDeclareLiePrior(obs.myRole as string, holderTeam);
  // v8 H7: per-role lie rate floor for heavy liars (mordred etc.)
  const roleLieRate = lakeDeclareLieRoleRate(obs.myRole as string);
  const baselineLieFloor = roleLieRate >= 0.4 ? roleLieRate * 0.5 : 0;
  const effectiveLieProb = Math.max(lieBonus, baselineLieFloor);
  if (effectiveLieProb > 0 && Math.abs(merlinScore) < 1) {
    if (actualTargetTeam === 'good') {
      // Lie = announce 'evil'
      if (Math.random() < effectiveLieProb) return 'evil';
    } else if (actualTargetTeam === 'evil') {
      // Lie = announce 'good'
      if (Math.random() < effectiveLieProb) return 'good';
    }
  }
  return baseDecision;
}

// ── Public-history scorers ─────────────────────────────────────

/**
 * Cheap suspicion proxy built only from public history (no HeuristicAgent dep):
 *   +2 per fail-quest appearance
 *   +1 per approve of a team in a round whose quest failed
 *   -0.5 per appearance on a successful quest
 *   -0.3 per reject of a team in a round whose quest failed
 */
export function estimateSuspicionFromHistory(playerId: string, obs: PlayerObservation): number {
  let score = 0;
  const failedRounds = new Set<number>();
  for (const q of obs.questHistory) {
    if (q.result === 'fail') {
      failedRounds.add(q.round);
      if (q.team.includes(playerId)) score += 2;
    } else if (q.result === 'success' && q.team.includes(playerId)) {
      score -= 0.5;
    }
  }
  for (const v of obs.voteHistory) {
    if (!failedRounds.has(v.round)) continue;
    const approved = v.votes[playerId];
    if (approved === true)  score += 1;
    if (approved === false) score -= 0.3;
  }
  return score;
}

/**
 * "Looks like Merlin" proxy from the evil holder's view: players who rejected
 * teams containing knownEvils, and never appeared on fail quests. Higher =
 * stronger Merlin suspicion.
 */
export function estimateMerlinLikenessFromHistory(playerId: string, obs: PlayerObservation): number {
  let score = 0;
  const knownEvilSet = new Set(obs.knownEvils);

  // Rejected teams containing knownEvils → Merlin signal
  for (const v of obs.voteHistory) {
    const teamHasKnownEvil = v.team.some(id => knownEvilSet.has(id));
    if (!teamHasKnownEvil) continue;
    const approved = v.votes[playerId];
    if (approved === false) score += 1.5;
    if (approved === true)  score -= 0.5;
  }

  // Appeared on fail quests → NOT Merlin
  for (const q of obs.questHistory) {
    if (q.result === 'fail' && q.team.includes(playerId)) score -= 2;
  }

  return score;
}

// ── Deterministic ranking helpers ──────────────────────────────

/**
 * Deterministic descending rank: primary by score desc, tiebreak by
 * `tiebreakOrder` ascending index (stable under identical input).
 */
function rankByDescendingScore(
  ids:            string[],
  score:          (id: string) => number,
  tiebreakOrder:  string[],
): string[] {
  const orderIdx = new Map(tiebreakOrder.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0);
  });
}

/**
 * Ascending variant (smallest-first) used by the good-holder branch which
 * prefers LOW red suspicion. Tiebreak follows allPlayerIds order.
 */
function rankByAscendingScore(
  ids:            string[],
  score:          (id: string) => number,
  tiebreakOrder:  string[],
): string[] {
  const orderIdx = new Map(tiebreakOrder.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => {
    const diff = score(a) - score(b);
    if (diff !== 0) return diff;
    return (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0);
  });
}
