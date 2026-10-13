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
    // ── AgentTuning.goodLakeTargetMostSuspicious (2026-10-12) ──
    // 一致性基準第 7 節：真人（含 ED）多半湖有失敗紀錄的人；開關打開時
    // 查最可疑的人（同分依座位序）。預設維持下方的「首湖藍」。
    if (tuning.goodLakeTargetMostSuspicious) {
      return rankByDescendingScore(
        unknownCandidates,
        id => estimateSuspicionFromHistory(id, obs),
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
      id => estimateSuspicionFromHistory(id, obs),
      obs.allPlayerIds,
    )[0];
  }

  // ── AgentTuning.evilLakeHumanStrategy (Edward 2026-10-13 ruling) ──
  // 「紅方湖中應該是盡量留在隊友身上並說謊」— supersedes the bring-friend
  // heuristic below (and its AVALON_EVIL_LAKE_BRING_FRIEND=0 regression
  // flag) when on. Deterministic; no Math.random calls, so the legacy
  // call order is untouched when the switch is off.
  if (tuning.evilLakeHumanStrategy) {
    return pickEvilLakeTargetHuman(obs, validTargets);
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
    return decideEvilLakeClaimHuman(obs, targetId, actualTargetTeam);
  }
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
   *   - 'always'    — always prefer a teammate (pure 「盡量」).
   */
  lastLake: 'pressured' | 'always';
  /**
   * Declaration on a blue target (the holder saw 'good'):
   *   - 'frame'  — chaos ('evil') only when the holder and the target sat
   *                on the same failed mission and red needs just one more
   *                fail (frame the co-suspect, shift the blame); otherwise
   *                truthful 'good' (goodwill) (default);
   *   - 'never'  — always truthful 'good' (pure goodwill);
   *   - 'always' — always 'evil' (pure chaos).
   */
  chaos: 'frame' | 'never' | 'always';
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
}

/**
 * The switch's tactic mix (2026-10-13, docs/ai/strength_benchmark.md 第 6
 * 節). On the selection seed 20261012 the first cut (`vouch: 'pressured'`)
 * was −1.6pp [−2.2pp, −1.1pp] as red and this mix −0.4pp [−1.0pp, +0.1pp],
 * but fresh seeds put this mix below 0 too (seed 99 −1.0pp, 4242 −0.8pp,
 * both intervals entirely below 0; `chaos: 'never'` the same), so the
 * switch itself is NOT in `DEFAULT_AGENT_TUNING`.
 */
export const DEFAULT_EVIL_LAKE_HUMAN_OPTIONS: Readonly<EvilLakeHumanOptions> = Object.freeze({
  lastLake: 'pressured',
  chaos: 'frame',
  vouch: 'consistent',
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
    if (k === 'lastLake' && (v === 'pressured' || v === 'always')) out.lastLake = v;
    if (k === 'chaos' && (v === 'frame' || v === 'never' || v === 'always')) out.chaos = v;
    if (k === 'vouch' && (v === 'pressured' || v === 'consistent')) out.vouch = v;
  }
  return out;
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

/** Holder and `targetId` were both on at least one failed mission. */
function sharedFailedMission(obs: PlayerObservation, targetId: string): boolean {
  return obs.questHistory.some(
    (q) => q.result === 'fail' && q.team.includes(obs.myPlayerId) && q.team.includes(targetId),
  );
}

/** Red needs only one more failed mission (two fails already). */
function redListening(obs: PlayerObservation): boolean {
  return obs.questResults.filter((r) => r === 'fail').length >= 2;
}

/**
 * Edward 2026-10-13 ruling — red Lady-of-the-Lake target (behind the
 * opt-in switch `AgentTuning.evilLakeHumanStrategy`, off by default):
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
): string {
  if (validTargets.length === 0) return '';
  const visible = new Set(obs.knownEvils);
  const suspicion = (id: string): number => estimateSuspicionFromHistory(id, obs);
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
 * goes up. Deterministic (no Math.random).
 */
export function decideEvilLakeClaimHuman(
  obs: PlayerObservation,
  targetId: string,
  actualTargetTeam: Camp | undefined,
  options: Readonly<EvilLakeHumanOptions> = activeEvilLakeHumanOptions,
): Camp {
  if (obs.knownEvils.includes(targetId)) return 'good';
  if (actualTargetTeam === 'evil') return 'good';
  switch (options.chaos) {
    case 'always': return 'evil';
    case 'never': return 'good';
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
