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

import type { AvalonAgent, PlayerObservation } from './types';
import {
  lakeDeclareLiePrior,
  lakeDeclareLieRoleRate,
} from './priors/EvActionPriors';
import { AVALON_CONFIG } from '@avalon/shared';
import { getDefaultAgentTuning, type AgentTuning } from './AgentTuning';
import { beliefOptionsFrom, defaultBeliefOptions, isForcedVoteRecord, type BeliefOptions } from './belief/BeliefOptions';
import { beliefFailCards, missionFailed } from './missionFacts';
import { pickGoodLakeTargetInfoMax } from './GoodLakeInfo';
import { claimPossibleForGoodHolder, returnLakeOptions } from './belief/Certainty';

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
 * An agent that makes its own lake decisions (HeuristicAgent does;
 * RandomAgent does not). SelfPlayEngine and the live GameServer bot path
 * both ask the agent through this API so per-agent `AgentTuning` applies.
 */
export interface LakeCapableAgent extends AvalonAgent {
  pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string;
  declareLake(
    obs: PlayerObservation,
    targetId: string,
    trueFaction: Camp | undefined,
  ): Camp | null;
}

export function hasLakeApi(agent: AvalonAgent | undefined): agent is LakeCapableAgent {
  if (!agent) return false;
  const a = agent as Partial<LakeCapableAgent>;
  return typeof a.pickLakeTarget === 'function' && typeof a.declareLake === 'function';
}

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
 * Seats a good holder never lakes (`pickLakeTargetForTeam`, smart path):
 * `knownEvils` — Merlin's visible reds (laking a seat already known red
 * wastes the lake). Before logic-first batch 1E (`percivalBlueLake` off)
 * also both of Percival's thumbs (`knownWizards`). The owner ruled
 * 2026-10-14 that Percival's lake is a blue lake (D4, S1-8): Percival is a
 * loyal with one more fact ("exactly one thumb is red"), so his candidate
 * set is a loyal's and `GoodLakeInfo` scores it with that fact. Exported for
 * the invariant harness (INV-PL, structural: the AuditAgent records the set
 * the deciding agent used).
 */
export function goodLakeAvoidSet(
  obs: PlayerObservation,
  tuning: Pick<AgentTuning, 'percivalBlueLake'> = getDefaultAgentTuning(),
): Set<string> {
  const avoidSet = new Set<string>(obs.knownEvils);
  if (!tuning.percivalBlueLake) {
    for (const wizardId of obs.knownWizards ?? []) avoidSet.add(wizardId);
  }
  return avoidSet;
}

/**
 * Agent-level lake target decision for the holder `obs.myPlayerId`.
 * `validTargets` defaults to `deriveValidLakeTargets(obs)`.
 */
export function pickLakeTarget(
  obs: PlayerObservation,
  validTargets: readonly string[] = deriveValidLakeTargets(obs),
  tuning: AgentTuning = getDefaultAgentTuning(),
): string {
  return pickLakeTargetForTeam(obs.myTeam, obs, [...validTargets], tuning);
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
  tuning: AgentTuning = getDefaultAgentTuning(),
): Camp | null {
  return decideLakeClaimForTeam(obs.myTeam, targetId, obs, trueFaction, tuning);
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
  tuning: AgentTuning = getDefaultAgentTuning(),
): string {
  // ── AgentTuning.returnLake（還湖，Edward 2026-10-26）──
  // The previous lake declared this holder red and a publicly certain-good seat may be laked: return
  // the lake to it (first by seat order). Not doing so admits being red (Certainty A2), so a red holder
  // does it too.
  if (tuning.returnLake) {
    const back = returnLakeOptions(obs, obs.myPlayerId, validTargets);
    if (back.length > 0) return back[0];
  }

  if (!isSmartLakeEnabled()) {
    // Legacy: good picks knownEvils[0] (useless), evil picks random.
    if (holderTeam === 'good') {
      const knownEvilTarget = obs.knownEvils.find(id => validTargets.includes(id));
      return knownEvilTarget ?? validTargets[Math.floor(Math.random() * validTargets.length)];
    }
    return validTargets[Math.floor(Math.random() * validTargets.length)];
  }

  if (holderTeam === 'good') {
    // Edward 2026-04-24 batch 2 fix #7: all good players avoid lake-
    // ing their viewpoint-known bad/ambiguous targets:
    //   • merlin   — knownEvils = assassin+morgana+oberon (only
    //                Mordred invisible per Edward 2026-04-26 spec →
    //                lake-probe still allowed for Mordred)
    //   • percival — knownWizards = [merlin, morgana] (ambiguous — can't
    //                distinguish); avoid both so we never waste the lake.
    //                AgentTuning.percivalBlueLake (logic-first batch 1E,
    //                owner ruling 2026-10-14, S1-8): Percival's lake is a
    //                blue lake — no thumb avoid list; GoodLakeInfo scores
    //                the thumbs with "exactly one of them is red".
    //   • loyal    — knownEvils = [], knownWizards = undefined → no
    //                filter (loyal must rely on suspicion ranking alone).
    // The filter set is knownEvils (∪ knownWizards with the switch off) so
    // each role's view is honoured without branching on myRole.
    const avoidSet = goodLakeAvoidSet(obs, tuning);
    const unknownCandidates = validTargets.filter(id => !avoidSet.has(id));
    if (unknownCandidates.length === 0) {
      return validTargets[0];
    }
    // ── AgentTuning.goodLakeInfoMax (Edward 2026-10-13) ──
    // 「好人湖中的最大原則就是使場上的好人視角能夠更清晰 讓藍方不確定性
    // 最小化 極大化共同資訊」— expected drop of the blues' common
    // uncertainty plus a trust-chain term (GoodLakeInfo.ts). Takes
    // precedence over goodLakeTargetMostSuspicious; falls through to it
    // (or to the legacy rule) only when no evil set is consistent with
    // the record. Deterministic; no Math.random.
    if (tuning.goodLakeInfoMax) {
      const pick = pickGoodLakeTargetInfoMax(obs, unknownCandidates);
      if (pick !== null) return pick;
    }
    // ── AgentTuning.goodLakeTargetMostSuspicious (2026-10-12) ──
    // 一致性基準第 7 節：真人（含 ED）多半湖有失敗紀錄的人；開關打開時
    // 查最可疑的人（同分依座位序）。預設維持下方的「首湖藍」。
    if (tuning.goodLakeTargetMostSuspicious) {
      return rankByDescendingScore(
        unknownCandidates,
        id => estimateSuspicionFromHistory(id, obs, beliefOptionsFrom(tuning)),
        obs.allPlayerIds,
      )[0];
    }
    // ── Edward 2026-04-29 fundamental fix #2 — lake target prefers low red ──
    // Edward 13:35 self-play evidence: R1 任務 130 oox (1 fail) → 1家
    // 紅嫌 ≥ 0.7。R2 通過 2370 oooo → 0 家拿湖。0 家(忠臣) 卻湖了高紅嫌
    // 的 1 家 — wrong direction. 反向 — 優先湖 LOW 紅嫌 (高藍嫌) 玩家，
    // 建信任鏈 (硬規則 4 transitive blue chain)。
    return rankByAscendingScore(
      unknownCandidates,
      id => estimateSuspicionFromHistory(id, obs, beliefOptionsFrom(tuning)),
      obs.allPlayerIds,
    )[0];
  }

  // ── AgentTuning.evilLakeHumanStrategy (Edward 2026-10-13 ruling) ──
  // 「紅方湖中應該是盡量留在隊友身上並說謊」— supersedes the bring-friend
  // heuristic below (and its AVALON_EVIL_LAKE_BRING_FRIEND=0 regression
  // flag) when on. Deterministic; no Math.random calls, so the legacy
  // call order is untouched when the switch is off.
  if (tuning.evilLakeHumanStrategy) {
    return pickEvilLakeTargetHuman(obs, validTargets, evilLakeHumanOptionsFor(tuning), beliefOptionsFrom(tuning));
  }

  return pickEvilLakeTargetLegacy(obs, validTargets, beliefOptionsFrom(tuning));
}

/**
 * The evil holder's target rule before `evilLakeHumanStrategy` (still the
 * rule when the switch is off): wash a pressured ally, else pin the most
 * Merlin-like opponent (see `pickLakeTargetForTeam`). Extracted 2026-10-13
 * so the benchmark-only ablation knobs of the human strategy can fall back
 * to it for one part of the lake (Oberon / last lake / target only).
 */
export function pickEvilLakeTargetLegacy(
  obs: PlayerObservation,
  validTargets: string[],
  belief: Readonly<BeliefOptions> = defaultBeliefOptions(),
): string {
  const knownEvilSet = new Set(obs.knownEvils);
  // Evil branch — Edward 2026-04-22 12:39 +08 correction.
  if (isEvilLakeBringFriendEnabled()) {
    // Consider every valid target (including allies) — do not filter knownEvils.
    const opponents = validTargets.filter(id => !knownEvilSet.has(id));
    const allies    = validTargets.filter(id =>  knownEvilSet.has(id));

    // Rank opponents by Merlin-likeness, allies by how suspected they currently look
    // (allies publicly look risky → washing them with "good" declaration has high payoff).
    const bestOpponent = opponents.length === 0 ? null : rankByDescendingScore(
      opponents,
      id => estimateMerlinLikenessFromHistory(id, obs, belief),
      obs.allPlayerIds,
    )[0];
    const mostPressuredAlly = allies.length === 0 ? null : rankByDescendingScore(
      allies,
      id => estimateSuspicionFromHistory(id, obs, belief),
      obs.allPlayerIds,
    )[0];

    const opponentScore = bestOpponent === null
      ? Number.NEGATIVE_INFINITY
      : estimateMerlinLikenessFromHistory(bestOpponent, obs, belief);
    const allyPressure = mostPressuredAlly === null
      ? Number.NEGATIVE_INFINITY
      : estimateSuspicionFromHistory(mostPressuredAlly, obs, belief);

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
    id => estimateMerlinLikenessFromHistory(id, obs, belief),
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
  tuning: AgentTuning = getDefaultAgentTuning(),
): Camp | null {
  if (holderTeam !== 'good' && holderTeam !== 'evil') return null;

  if (holderTeam === 'good') {
    // Good holder tells the truth when a team is known.
    if (actualTargetTeam === 'good' || actualTargetTeam === 'evil') {
      return actualTargetTeam;
    }
    return null;
  }

  const claim = decideEvilLakeClaim(targetId, obs, actualTargetTeam, tuning);
  // ── AgentTuning.redPossibleClaimsOnly (logic-first batch 1F, S1-10) ──
  // C8 / K5: a claim that cannot be true for a good holder — no public L1
  // world (L0 when A0 leaves none) has the holder good and the target's
  // camp equal to the claim — proves the holder red to every blue (the
  // certainty layer pins it, INV-R2). A red holder never makes one: it
  // takes the other claim. When neither claim is possible the holder is
  // already publicly certain red (every public world has it red), so any
  // declaration would be one that cannot be true — it declares nothing
  // (`null`: the lake ends undeclared, `declaredClaim: 'none'`; the table
  // learns nothing it did not already know). After the claim rule, so the
  // rule's own Math.random draws are unchanged.
  if (
    tuning.redPossibleClaimsOnly &&
    !claimPossibleForGoodHolder(obs, obs.myPlayerId, targetId, claim)
  ) {
    const other: Camp = claim === 'good' ? 'evil' : 'good';
    return claimPossibleForGoodHolder(obs, obs.myPlayerId, targetId, other) ? other : null;
  }
  return claim;
}

/** The evil holder's claim before the batch-1F guard (see `decideLakeClaimForTeam`). */
function decideEvilLakeClaim(
  targetId: string,
  obs: PlayerObservation,
  actualTargetTeam: Camp | undefined,
  tuning: AgentTuning,
): Camp {
  // Evil holder.
  // ── AgentTuning.evilLakeClaimAlwaysGood (2026-10-12) ──
  // 一致性基準第 7 節：ED 當紅方 14 次有 13 次說實話、top 群也偏向宣
  // 「好」；開關打開時紅方一律宣好（隊友洗白、對手也說好）。
  // Precedence: this literal "always good" switch wins over
  // `evilLakeHumanStrategy`'s claim when both are on (the human strategy
  // still picks the target).
  if (tuning.evilLakeClaimAlwaysGood) return 'good';
  // ── AgentTuning.evilLakeHumanStrategy (Edward 2026-10-13 ruling) ──
  if (tuning.evilLakeHumanStrategy) {
    return decideEvilLakeClaimHuman(obs, targetId, actualTargetTeam, evilLakeHumanOptionsFor(tuning), beliefOptionsFrom(tuning));
  }
  return decideEvilLakeClaimLegacy(obs, targetId, actualTargetTeam, beliefOptionsFrom(tuning));
}

/**
 * The evil holder's claim rule before `evilLakeHumanStrategy` (still the
 * rule when the switch is off; see `decideLakeClaimForTeam`). Extracted
 * 2026-10-13 for the benchmark-only ablation knobs of the human strategy.
 * May consume `Math.random` (EV-prior lie nudge), exactly as before.
 */
export function decideEvilLakeClaimLegacy(
  obs: PlayerObservation,
  targetId: string,
  actualTargetTeam: Camp | undefined,
  belief: Readonly<BeliefOptions> = defaultBeliefOptions(),
): Camp {
  const holderTeam: Camp = 'evil';
  const knownEvilSet = new Set(obs.knownEvils);
  if (knownEvilSet.has(targetId)) {
    // Ally → always publicly wash as good.
    return 'good';
  }
  // Opponent branch: score Merlin-likeness; if Merlin-like, call them good to
  // disguise the intel. Otherwise call them evil to muddy the water.
  const merlinScore = estimateMerlinLikenessFromHistory(targetId, obs, belief);
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

// ── Human evil-lake strategy (AgentTuning.evilLakeHumanStrategy) ──

/**
 * Tactic-mix knobs of the human evil-lake strategy. The defaults are the
 * policy behind `evilLakeHumanStrategy`; the alternatives exist for the
 * benchmark scripts only (`AVALON_EVIL_LAKE_HUMAN_VARIANT`, read by the
 * scripts through `evilLakeHumanOptionsFromEnv` + `setEvilLakeHumanOptions`;
 * the server never reads it) and are documented in
 * docs/ai/strength_benchmark.md.
 */
export interface EvilLakeHumanOptions {
  /**
   * Last lake (no lake follows, so keeping the token on the red side has
   * no value):
   *   - 'pressured' — lake a visible teammate only when one has any public
   *     pressure (suspicion > 0) to wash them onto the last mission;
   *     otherwise lake a blue (default). In practice nearly every teammate
   *     has some pressure by then (2-2 after R4): on the 147 human
   *     last-lake states with a legal teammate this still lakes the
   *     teammate 143 times (humans: 26), so it behaves almost like 'always';
   *   - 'always'    — always prefer a teammate (pure 「盡量」);
   *   - 'legacy'    — diagnostic ablation (2026-10-13 round 2): the last
   *                   lake (target and claim) uses the rule from before the
   *                   switch (`pickEvilLakeTargetLegacy` /
   *                   `decideEvilLakeClaimLegacy`).
   */
  lastLake: 'pressured' | 'always' | 'legacy';
  /**
   * Declaration on a blue target (the holder saw 'good'):
   *   - 'frame'  — chaos ('evil') only when the holder and the target sat
   *                on the same failed mission and red needs just one more
   *                fail (frame the co-suspect, shift the blame); otherwise
   *                truthful 'good' (goodwill) (default);
   *   - 'never'  — always truthful 'good' (pure goodwill);
   *   - 'always' — always 'evil' (pure chaos);
   *   - 'humanRate' — (2026-10-13 round 2, switch
   *                `AgentTuning.evilLakeFrameHumanRate`) the target is
   *                never chosen for framing (blue picks follow the vouch
   *                order), and the claim is 'evil' with the human rate of
   *                the state (`HUMAN_FRAME_RATE`: shared failed mission ×
   *                red listening). Consumes one `Math.random` per blue
   *                target;
   *   - 'frameNoHunt' — the 'frame' claim rule, but the target is never
   *                chosen for framing (blue picks follow the vouch order),
   *                so framing only happens when the vouched blue happens
   *                to be a co-suspect while red is listening.
   */
  chaos: 'frame' | 'never' | 'always' | 'humanRate' | 'frameNoHunt';
  /**
   * Whom to vouch for ("blue" claim) when several candidates are legal:
   *   - 'pressured'  — the most publicly suspected teammate (the claim
   *                    washes the most pressure) / the most suspicious
   *                    blue (first cut);
   *   - 'consistent' — first the seat the holder left off the fewest
   *                    teams they led (0 = kept on every one), then the
   *                    order above (default). Vouching for someone you left
   *                    off your own teams is the classic tell (硬3「替 B
   *                    背書」; the bots' `findRule3Violators` pins such a
   *                    holder at ≥ 0.85 suspicion).
   */
  vouch: 'pressured' | 'consistent';
  /**
   * Diagnostic ablations (2026-10-13 round 2, strength_benchmark.md 第 8
   * 節), benchmark scripts only: 'legacy' hands that part of the lake back
   * to the rule from before the switch.
   *   - `oberon` — Oberon's lakes (target and claim);
   *   - `target` — every target choice (the claim stays human);
   *   - `claim`  — every claim (the target stays human).
   */
  oberon: 'human' | 'legacy';
  target: 'human' | 'legacy';
  claim: 'human' | 'legacy';
  /**
   * Oberon's target (2026-10-13 round 2): 'vouch' — the blue branch's
   * vouch order like every red without a teammate (default); 'teammate' —
   * look for an unseen teammate (`oberonTeammateEvidence`), switch
   * `AgentTuning.oberonLakeSeeksTeammates`.
   */
  oberonTarget: 'vouch' | 'teammate';
}

/**
 * The switch's tactic mix (2026-10-13, docs/ai/strength_benchmark.md 第 6
 * 節). On the selection seed 20261012 the first cut (`vouch: 'pressured'`)
 * was −1.6pp [−2.2pp, −1.1pp] as red and this mix −0.4pp [−1.0pp, +0.1pp],
 * but fresh seeds put this mix below 0 too (seed 99 −1.0pp, 4242 −0.8pp,
 * both intervals entirely below 0; `chaos: 'never'` the same). Edward
 * decided on 2026-10-13 to turn the switch on in `DEFAULT_AGENT_TUNING`
 * anyway (human-likeness first) and recover the strength from other red
 * decisions (strength_benchmark.md 第 8 節).
 */
export const DEFAULT_EVIL_LAKE_HUMAN_OPTIONS: Readonly<EvilLakeHumanOptions> = Object.freeze({
  lastLake: 'pressured',
  chaos: 'frame',
  vouch: 'consistent',
  oberon: 'human',
  target: 'human',
  claim: 'human',
  oberonTarget: 'vouch',
});

let activeEvilLakeHumanOptions: Readonly<EvilLakeHumanOptions> = DEFAULT_EVIL_LAKE_HUMAN_OPTIONS;

/**
 * Benchmark scripts only: swap the tactic mix used when the strategy
 * functions get no explicit `options` (`undefined` restores the default).
 * The server never calls this, so the env knob below cannot reach live
 * bots.
 */
export function setEvilLakeHumanOptions(options: EvilLakeHumanOptions | undefined): void {
  activeEvilLakeHumanOptions = Object.freeze({ ...(options ?? DEFAULT_EVIL_LAKE_HUMAN_OPTIONS) });
}

/**
 * The tactic mix for an agent's tuning: the active mix, with the round-2
 * switches layered on top (`evilLakeFrameHumanRate` → `chaos: 'humanRate'`,
 * `oberonLakeSeeksTeammates` → `oberonTarget: 'teammate'`). A knob a
 * benchmark script set explicitly to something other than the default
 * (`AVALON_EVIL_LAKE_HUMAN_VARIANT`, e.g. `chaos=never`) wins over the
 * switch, so re-running an older variant under the new default tuning
 * still measures that variant (review 2026-10-13). To get the default
 * `chaos: 'frame'` back, turn the switch off
 * (`--flag evilLakeFrameHumanRate=0`).
 */
export function evilLakeHumanOptionsFor(tuning: AgentTuning): Readonly<EvilLakeHumanOptions> {
  const active = activeEvilLakeHumanOptions;
  const frameRate = tuning.evilLakeFrameHumanRate && active.chaos === DEFAULT_EVIL_LAKE_HUMAN_OPTIONS.chaos;
  const oberonSeeks = tuning.oberonLakeSeeksTeammates && active.oberonTarget === DEFAULT_EVIL_LAKE_HUMAN_OPTIONS.oberonTarget;
  if (!frameRate && !oberonSeeks) return active;
  return {
    ...active,
    ...(frameRate ? { chaos: 'humanRate' as const } : {}),
    ...(oberonSeeks ? { oberonTarget: 'teammate' as const } : {}),
  };
}

/** The tactic mix currently in effect (the default unless a script set one). */
export function getEvilLakeHumanOptions(): Readonly<EvilLakeHumanOptions> {
  return activeEvilLakeHumanOptions;
}

/**
 * Parses the benchmark-only knob
 * `AVALON_EVIL_LAKE_HUMAN_VARIANT="lastLake=always,chaos=never,vouch=consistent"`.
 * Only the benchmark scripts read it (and hand the result to
 * `setEvilLakeHumanOptions`); the strategy functions do not look at the
 * environment. Unknown keys / values are ignored.
 */
export function evilLakeHumanOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): EvilLakeHumanOptions {
  const out: EvilLakeHumanOptions = { ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS };
  const raw = env.AVALON_EVIL_LAKE_HUMAN_VARIANT;
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k === 'lastLake' && (v === 'pressured' || v === 'always' || v === 'legacy')) out.lastLake = v;
    if (k === 'chaos' && (v === 'frame' || v === 'never' || v === 'always' || v === 'humanRate' || v === 'frameNoHunt')) out.chaos = v;
    if (k === 'vouch' && (v === 'pressured' || v === 'consistent')) out.vouch = v;
    if ((k === 'oberon' || k === 'target' || k === 'claim') && (v === 'human' || v === 'legacy')) out[k] = v;
    if (k === 'oberonTarget' && (v === 'vouch' || v === 'teammate')) out.oberonTarget = v;
  }
  return out;
}

/**
 * Which parts of this lake the diagnostic ablation knobs hand back to the
 * pre-switch rule (always `{ target: false, claim: false }` with the
 * default options). Decided from `obs` alone so the target and the claim
 * of one lake agree.
 */
function legacyParts(
  obs: PlayerObservation,
  options: Readonly<EvilLakeHumanOptions>,
): { target: boolean; claim: boolean } {
  const whole = (options.oberon === 'legacy' && obs.myRole === 'oberon')
    || (options.lastLake === 'legacy' && !nextLakeExists(obs));
  return {
    target: whole || options.target === 'legacy',
    claim: whole || options.claim === 'legacy',
  };
}

/**
 * Whether another Lady-of-the-Lake phase can still follow this one. The
 * lake is used after rounds 2 .. (last − 1), so after round 4 of a
 * 5-round game the next holder never gets to use it.
 */
export function nextLakeExists(obs: PlayerObservation): boolean {
  const rounds = AVALON_CONFIG[obs.playerCount]?.questTeams.length ?? 5;
  return obs.currentRound + 2 <= rounds;
}

/**
 * How often human red holders declare a blue target red, by state (牌譜
 * population, `scripts/evilLakeStudy.ts` (c), strength_benchmark.md 第
 * 6.1 節): holder and target shared a failed mission × red already has
 * two fails. The four cells come from the reds who see their teammates
 * (assassin / Morgana / Mordred): 144/573 = 25.1% of their blue lakes
 * declared red. The same table is applied to Oberon (humans: 28.2%,
 * 53/188); all red holders together 25.9% (197/761). Used by
 * `chaos: 'humanRate'` (`AgentTuning.evilLakeFrameHumanRate`, in the
 * default since 2026-10-13 round 2: self-play framing about 65% → 30%,
 * strength unchanged; strength_benchmark.md 第 8 節).
 */
export const HUMAN_FRAME_RATE: Readonly<{
  sharedListening: number;
  sharedNotListening: number;
  notSharedListening: number;
  notSharedNotListening: number;
}> = Object.freeze({
  sharedListening: 50 / 139,
  sharedNotListening: 24 / 83,
  notSharedListening: 50 / 202,
  notSharedNotListening: 20 / 149,
});

/** `HUMAN_FRAME_RATE` for the holder's current state about `targetId`. */
export function humanFrameRate(obs: PlayerObservation, targetId: string): number {
  const shared = sharedFailedMission(obs, targetId);
  const listening = redListening(obs);
  if (shared) return listening ? HUMAN_FRAME_RATE.sharedListening : HUMAN_FRAME_RATE.sharedNotListening;
  return listening ? HUMAN_FRAME_RATE.notSharedListening : HUMAN_FRAME_RATE.notSharedNotListening;
}

/**
 * Oberon's evidence that `id` is one of his unseen teammates (2026-10-13
 * round 2, `AgentTuning.oberonLakeSeeksTeammates`): fail cards Oberon did
 * not play himself, spread over the team members that could have played
 * them. A failed mission he was not on: all its fails point at its
 * members; one he was on: one fail is (presumably) his own, the rest point
 * at the others. Votes are ignored (they say little about camp from his
 * seat). Higher = more likely a red.
 */
export function oberonTeammateEvidence(
  id: string,
  obs: PlayerObservation,
  belief: Readonly<BeliefOptions> = defaultBeliefOptions(),
): number {
  let score = 0;
  for (const q of obs.questHistory) {
    // S1-1: every fail card points at a red (an R4 success with one included).
    const fails = beliefFailCards(q, belief.certainFacts);
    if (fails === 0 || !q.team.includes(id) || id === obs.myPlayerId) continue;
    const meOn = q.team.includes(obs.myPlayerId);
    const otherFails = meOn ? fails - 1 : fails;
    const others = q.team.length - (meOn ? 1 : 0);
    if (otherFails > 0 && others > 0) score += otherFails / others;
  }
  return score;
}

/** Holder and `targetId` were both on at least one failed mission. */
function sharedFailedMission(obs: PlayerObservation, targetId: string): boolean {
  return obs.questHistory.some(
    (q) => missionFailed(q) && q.team.includes(obs.myPlayerId) && q.team.includes(targetId),
  );
}

/** Red needs only one more failed mission (two fails already). */
function redListening(obs: PlayerObservation): boolean {
  return obs.questResults.filter((r) => r === 'fail').length >= 2;
}

/**
 * Edward 2026-10-13 ruling — red Lady-of-the-Lake target (behind the
 * switch `AgentTuning.evilLakeHumanStrategy`; on in the production default
 * since Edward's decision of the same day, off in legacy):
 *
 *   「紅方湖中應該是盡量留在隊友身上並說謊(湖紅方說藍方), 但看情況依據戰術
 *    可以改變, 例如湖藍方說紅方(不交給隊友但是讓資訊變混亂) 或是湖藍方說
 *    藍方說實話買取好感度讓自己或隊友進任務」
 *
 * The laked player becomes the next holder, so laking a visible teammate
 * keeps the lake on the red side (blue never gets a true inspection).
 *
 *   1. A visible teammate is legal and another lake follows → lake the
 *      teammate. Which one (`vouch`): by default the teammate the holder
 *      left off the fewest of the teams they led (a "blue" claim on
 *      someone you left off your own teams is the classic tell), then the
 *      most publicly suspected (the claim washes the most pressure), then
 *      seat order.
 *   2. Last lake (nothing follows, the token is worthless) → lake a
 *      teammate when any of them has some pressure (suspicion > 0) — the
 *      wash helps them onto the deciding mission; only when every legal
 *      teammate is spotless fall through to a blue (`lastLake: 'always'`
 *      keeps preferring the teammate). At 2-2 after R4 nearly every
 *      teammate has some pressure, so this rarely falls through: on the
 *      147 human last-lake states with a legal teammate the rule lakes the
 *      teammate 143 times, while humans did so 26 times (17.7%).
 *   3. No teammate legal (or rule 2 fell through) → lake a blue. Framing
 *      (`chaos: 'frame'`, red listening): a blue who shared a failed
 *      mission with the holder (most suspicious first), to be declared
 *      red. Otherwise goodwill: the same vouch order as rule 1 (fewest
 *      times left off, then most suspicious, then seat order).
 *
 * Oberon sees no teammate, so he always takes rule 3 with the same order
 * (framing co-suspect when red is listening, else fewest times left off,
 * then most suspicious) and covers a red find with 'good' (see
 * `decideEvilLakeClaimHuman`). This does not find hidden reds: on the 289
 * human Oberon lake states the rule's target is red 27.7% of the time
 * (80/289), below a uniform pick among legal targets (32.8%) and humans
 * (33.6%), probably because Oberon's own fails put suspicion on the
 * blues who went with him, so "most suspicious" is not "most likely red"
 * from his seat.
 *
 * Human data (docs/ai/strength_benchmark.md 第 6 節): humans with a legal
 * teammate lake one only ~24% of the time (≈ the 22% chance level),
 * declare a laked teammate blue 84%, and declare a laked blue truthfully
 * blue 75%; the red claim on a blue peaks (36%; top cohort 52%) when
 * holder and target shared a failed mission and red is listening. The
 * target rule follows the ruling (normative), the claim rule the human
 * majority plus that framing state.
 */
export function pickEvilLakeTargetHuman(
  obs: PlayerObservation,
  validTargets: readonly string[],
  options: Readonly<EvilLakeHumanOptions> = activeEvilLakeHumanOptions,
  belief: Readonly<BeliefOptions> = defaultBeliefOptions(),
): string {
  if (validTargets.length === 0) return '';
  if (legacyParts(obs, options).target) return pickEvilLakeTargetLegacy(obs, [...validTargets], belief);
  const visible = new Set(obs.knownEvils);
  const suspicion = (id: string): number => estimateSuspicionFromHistory(id, obs, belief);
  const ledTeams = obs.voteHistory.filter((v) => v.leader === obs.myPlayerId);
  const leftOff = (id: string): number => ledTeams.filter((v) => !v.team.includes(id)).length;
  // Most suspected first (ties by seat order); with `vouch: 'consistent'`
  // a stable re-sort puts the seats the holder left off the fewest of
  // their own teams first (never left off = 0).
  const vouchOrder = (ids: readonly string[]): string[] => {
    const ranked = rankByDescendingScore([...ids], suspicion, obs.allPlayerIds);
    return options.vouch === 'consistent' ? ranked.sort((a, b) => leftOff(a) - leftOff(b)) : ranked;
  };
  const allies = vouchOrder(validTargets.filter((id) => visible.has(id)));
  const others = validTargets.filter((id) => !visible.has(id));

  // `oberonLakeSeeksTeammates` (2026-10-13 round 2): Oberon sees nobody,
  // so he looks for his teammates — the seat with the most fail cards he
  // did not play himself (ties: the usual vouch order). A red find is
  // covered with "good" (`decideEvilLakeClaimHuman`) and keeps the lake
  // on the red side; a blue one gets the usual blue claim.
  if (options.oberonTarget === 'teammate' && obs.myRole === 'oberon' && others.length > 0) {
    const order = vouchOrder(others);
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...order].sort((a, b) => {
      const diff = oberonTeammateEvidence(b, obs, belief) - oberonTeammateEvidence(a, obs, belief);
      if (diff !== 0) return diff;
      return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
    })[0];
  }

  if (allies.length > 0) {
    if (nextLakeExists(obs) || options.lastLake === 'always') return allies[0];
    const pressured = allies.find((id) => suspicion(id) > 0);
    if (pressured !== undefined) return pressured;
  }
  if (others.length === 0) return allies[0] ?? validTargets[0];

  if (options.chaos === 'frame' && redListening(obs)) {
    const coSuspects = others.filter((id) => sharedFailedMission(obs, id));
    if (coSuspects.length > 0) {
      return rankByDescendingScore(coSuspects, suspicion, obs.allPlayerIds)[0];
    }
  }
  // A blue the holder will vouch for (goodwill) follows the vouch order;
  // under pure chaos the claim is 'evil', so consistency is irrelevant.
  return options.chaos === 'always'
    ? rankByDescendingScore(others, suspicion, obs.allPlayerIds)[0]
    : vouchOrder(others)[0];
}

/**
 * Edward 2026-10-13 ruling — red holder's public claim:
 *   - visible teammate → 'good' (the lie that keeps them clean);
 *   - a red the holder could not see before (the hidden Oberon for the
 *     others, any red for Oberon) → 'good' (cover the newly found ally);
 *   - blue → truthful 'good' (goodwill: looks like an honest blue, helps
 *     the holder / a teammate onto missions), except the chaos tactic:
 *     `chaos: 'frame'` declares 'evil' when the holder and the target sat
 *     on the same failed mission and red is listening (frame the
 *     co-suspect; humans' red-claim rate peaks there); `'never'` /
 *     `'always'` are the pure tactics for the benchmark.
 * Because the target rule seeks out that framing state, bots running the
 * switch declare a blue target red far more often than humans do (self-play
 * seed 20261012: 65.0% of red-held blue lakes, Oberon 78.6%; humans 25.9%),
 * even though the claim agreement — scored on the human's own target —
 * goes up. Deterministic (no Math.random) except `chaos: 'humanRate'`
 * (`AgentTuning.evilLakeFrameHumanRate`, 2026-10-13 round 2), which
 * frames with the human rate of the state instead.
 */
export function decideEvilLakeClaimHuman(
  obs: PlayerObservation,
  targetId: string,
  actualTargetTeam: Camp | undefined,
  options: Readonly<EvilLakeHumanOptions> = activeEvilLakeHumanOptions,
  belief: Readonly<BeliefOptions> = defaultBeliefOptions(),
): Camp {
  if (legacyParts(obs, options).claim) return decideEvilLakeClaimLegacy(obs, targetId, actualTargetTeam, belief);
  if (obs.knownEvils.includes(targetId)) return 'good';
  if (actualTargetTeam === 'evil') return 'good';
  switch (options.chaos) {
    case 'always': return 'evil';
    case 'never': return 'good';
    case 'humanRate': return Math.random() < humanFrameRate(obs, targetId) ? 'evil' : 'good';
    case 'frameNoHunt':
    case 'frame':
    default:
      return redListening(obs) && sharedFailedMission(obs, targetId) ? 'evil' : 'good';
  }
}

// ── Public-history scorers ─────────────────────────────────────

/**
 * Cheap suspicion proxy built only from public history (no HeuristicAgent dep):
 *   +2 per fail-quest appearance
 *   +1 per approve of a team in a round whose quest failed
 *   -0.5 per appearance on a successful quest
 *   -0.3 per reject of a team in a round whose quest failed
 */
export function estimateSuspicionFromHistory(
  playerId: string,
  obs: PlayerObservation,
  belief: Readonly<BeliefOptions> = defaultBeliefOptions(),
): number {
  let score = 0;
  const failedRounds = new Set<number>();
  for (const q of obs.questHistory) {
    // S1-1 (C5): a mission that showed a fail card is not exculpatory.
    if (beliefFailCards(q, belief.certainFacts) > 0) {
      failedRounds.add(q.round);
      if (q.team.includes(playerId)) score += 2;
    } else if (q.team.includes(playerId)) {
      score -= 0.5;
    }
  }
  for (const v of obs.voteHistory) {
    if (!failedRounds.has(v.round)) continue;
    // S1-9a: the forced fifth proposal holds no vote.
    if (belief.forcedVotesZero && isForcedVoteRecord(v)) continue;
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
export function estimateMerlinLikenessFromHistory(
  playerId: string,
  obs: PlayerObservation,
  belief: Readonly<BeliefOptions> = defaultBeliefOptions(),
): number {
  let score = 0;
  const knownEvilSet = new Set(obs.knownEvils);

  // Rejected teams containing knownEvils → Merlin signal
  // (S1-9a: the forced fifth proposal holds no vote).
  for (const v of obs.voteHistory) {
    if (belief.forcedVotesZero && isForcedVoteRecord(v)) continue;
    const teamHasKnownEvil = v.team.some(id => knownEvilSet.has(id));
    if (!teamHasKnownEvil) continue;
    const approved = v.votes[playerId];
    if (approved === false) score += 1.5;
    if (approved === true)  score -= 0.5;
  }

  // Appeared on a mission that showed a fail card → NOT Merlin (S1-1)
  for (const q of obs.questHistory) {
    if (beliefFailCards(q, belief.certainFacts) > 0 && q.team.includes(playerId)) score -= 2;
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
