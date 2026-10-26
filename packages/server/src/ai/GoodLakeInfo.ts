/**
 * GoodLakeInfo — good Lady-of-the-Lake holder target model behind
 * `AgentTuning.goodLakeInfoMax` (2026-10-13).
 *
 * Edward 2026-10-13（原文）:
 *   「信任鏈的湖中選擇對於一紅一藍時幾乎成立
 *    但如果是兩紅時湖中不一定要湖好人, 因為只要任務過了就有鐵四好, 再加上
 *    第四局的任務派隊或許能驗證出第五個好人
 *    但其實好人湖中的最大原則就是使場上的好人視角(紅方已經相認 沒有視角更
 *    清晰的問題 除了奧伯倫) 能夠更清晰 讓藍方不確定性最小化 極大化共同資訊
 *    你說我的湖法 不只是出過任務失敗 應該是 "出過任務" & 最有可能是好人/湖
 *    下去最有可能讓共同資訊極大化的人」
 *
 * Model (docs/ai/strength_benchmark.md 第 7 節):
 *
 *   1. **Worlds.** Every evil set E (|E| = evil count, holder ∉ E) is a
 *      world. Two weightings over the same worlds:
 *        - *holder belief* — adds the holder's private knowledge: known evils
 *          ⊆ E (Merlin sees every red but Mordred), Percival's two thumbs
 *          contain exactly one red (Morgana);
 *        - *common picture* — public information only, plus "the holder is
 *          good" (the declaration only becomes shared knowledge among the
 *          blues who trust the holder — that is the trust chain).
 *      Both multiply in the mission likelihood P(fail cards | reds on the
 *      team, round) — an empirical table from the 1970 replayable human
 *      10-player games (`MISSION_FAIL_COUNTS`; more fails than reds on the
 *      team is impossible) — and the earlier public lake declarations: a
 *      good earlier holder told the truth (worlds that contradict it are
 *      dropped), an evil earlier holder's claim carries no information
 *      (likelihood ½ either way).
 *   2. **Information.** Uncertainty of a picture = Σ_j h(q_j) over every
 *      seat but the holder, q_j = P(j is red), h = binary entropy (bits).
 *      For a candidate c the holder forecasts the result with its own
 *      belief, and the gain is the expected drop of the common picture's
 *      uncertainty once the (truthful) result is announced:
 *        ΔH(c) = U(common) − Σ_x P_holder(c = x) · U(common | c = x).
 *      Seats that went on missions are coupled to the other members
 *      through the fail counts, so learning one of them also moves the
 *      others — this is where "出過任務" comes from in the model.
 *      For a loyal holder (belief = common picture) ΔH is a mutual
 *      information and never negative. For Merlin / Percival the forecast
 *      uses private knowledge the common picture lacks, so ΔH can be
 *      slightly negative (a result that is likely to the holder but
 *      surprising to the blues can leave them less sure; seen down to
 *      about −0.05 bits on candidates the holder already rates likely red).
 *   3. **Trust chain.** The laked seat holds the next lake. When another
 *      lake follows, a good target becomes a trusted next holder (its
 *      truthful result is worth one more lake, V):
 *        T(c) = λ · (1 − 2·P_holder(c red)) · V,   V = max(0, max_c' ΔH(c'))
 *      (the value of one more trusted lake ≈ the best lake available now).
 *      V is the same for every candidate, so T(c) = 2λ·P_holder(c good)·V
 *      − λV and the constant −λV never changes the pick: this is ONE
 *      choice, a weight of 2λ on "P(good) × V". (It was first written as
 *      "+V for a trusted holder, −V for a lying one", but that is not a
 *      separate ingredient.) λ = 1 (effective weight 2), except when red
 *      already has two missions (「兩紅」: a passed next mission proves its
 *      whole team good — 鐵四好 — so the lake need not seed the chain) and
 *      at the last lake (nothing follows): λ = 0. At 2:0 / 2:1 the next
 *      lake only happens if red wins the next mission; λ is not scaled by
 *      that chance (docs/ai/strength_benchmark.md 7.5, open item).
 *   4. **Pick.** argmax ΔH(c) + T(c) over the legal candidates the caller
 *      passes (the existing avoid-set — Merlin never lakes a known red;
 *      before logic-first batch 1E Percival also skipped both thumbs, now
 *      his lake is a blue lake, `AgentTuning.percivalBlueLake` — is applied
 *      by the caller); ties
 *      (|diff| < 1e-9) by seat order. Deterministic, no Math.random.
 *
 * Returns `null` when no world is consistent with the record (inconsistent
 * data even after dropping the lake declarations); the caller then falls
 * back to the previous rule.
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';
import { certaintyParamsFor, declaredLakes, enumerateWorlds } from './belief/Certainty';
import { evilCountFor, popcount } from './worlds';

export { evilCountFor };

// ── Mission likelihood (human 10-player data) ─────────────────

/**
 * MISSION_FAIL_COUNTS[round - 1][k] = counts of missions with k reds on the
 * team that showed 0, 1, …, k fail cards, from the 1970 replayable 10-player
 * games of `sheets_cache.json` (牌譜, 2026-10-13 snapshot; the same strict
 * replay as the agreement benchmark). Round 4 needs two fails in 10-player
 * games, which is why a lone red often plays success there.
 */
export const MISSION_FAIL_COUNTS: readonly (readonly (readonly number[])[])[] = [
  /* R1 */ [[444], [251, 739], [104, 259, 112], [14, 34, 13], []],
  /* R2 */ [[397], [103, 802], [51, 298, 186], [11, 64, 40, 7], [1, 1, 8, 1, 0]],
  /* R3 */ [[818], [45, 636], [25, 147, 132], [7, 20, 8, 43], [0, 3, 1, 0, 85]],
  /* R4 */ [[474], [271, 202], [32, 16, 99], [0, 1, 20, 30], [0, 0, 0, 4, 28]],
  /* R5 */ [[436], [7, 143], [0, 5, 20], [0, 1, 0, 3], [0, 0, 0, 0, 12]],
];

/**
 * P(f fail cards | k reds on the team, round), add-½ smoothed over
 * f ∈ 0..k. f > k is impossible (0); k = 0 ⇒ f = 0 with certainty.
 */
export function missionLikelihood(round: number, k: number, f: number): number {
  if (f < 0 || f > k) return 0;
  if (k === 0) return 1;
  const row = MISSION_FAIL_COUNTS[Math.min(Math.max(round, 1), 5) - 1]?.[k] ?? [];
  let total = 0;
  for (let i = 0; i <= k; i++) total += (row[i] ?? 0) + 0.5;
  return ((row[f] ?? 0) + 0.5) / total;
}

// ── Worlds ─────────────────────────────────────────────────────

// evilCountFor / combinations / popcount 住在 ./worlds.ts（2026-10-14，模擬瓦共用）；
// 世界列舉在 ./belief/Certainty.ts（第 1 階段確定性層）。行為不變。
interface World {
  /** Bit i set ⇔ allPlayerIds[i] is red. */
  mask: number;
  w: number;
}

/**
 * Weighted worlds for the good holder `obs.myPlayerId`. `usePrivate` adds
 * the holder's role knowledge (holder belief); without it the worlds are the
 * common picture (public record + "the holder is good"). `useLakes` = false
 * drops the earlier lake declarations (fallback for inconsistent records).
 *
 * 2026-10-14 (S1-0): the 0/1 part — which red sets are possible at all — now
 * comes from the shared certainty layer (`belief/Certainty.enumerateWorlds`,
 * holder assumed good, role sight when `usePrivate`, A0 on the declared
 * lakes when `useLakes`). The holder belief also reads the holder's own
 * private lake results (`myLakeResults`, logic-first batch 1E / S1-8: a
 * Percival who laked a thumb knows both thumbs). Under the lake rule a seat
 * holds the lake at most once, so a holder has no own result yet when it
 * picks and this changes no pick; it keeps the belief right for any variant
 * that lets a seat hold twice. This function only adds the weights: the mission likelihood and
 * ½ for an earlier red holder's claim. Same worlds in the same order with
 * the same weights as before, so every pick is unchanged
 * (`GoodLakeInfo.identical.test.ts`, all lake-legal replays).
 */
function buildWorlds(obs: PlayerObservation, usePrivate: boolean, useLakes: boolean): World[] {
  const ids = obs.allPlayerIds;
  const idx = new Map(ids.map((id, i) => [id, i]));
  if (idx.get(obs.myPlayerId) === undefined || ids.length > 30) return [];
  const bit = (id: string): number => {
    const i = idx.get(id);
    return i === undefined ? 0 : 1 << i;
  };
  const masks = enumerateWorlds(
    obs,
    { self: 'good', sight: usePrivate, ownLakeResults: usePrivate, lakes: useLakes },
    certaintyParamsFor(obs),
  );
  const quests = obs.questHistory.map((q) => ({
    round: q.round,
    mask: q.team.reduce((m, id) => m | bit(id), 0),
    fails: q.failCount ?? 0,
  }));
  const lakes = useLakes
    ? declaredLakes(obs.lakeHistory).map((l) => ({ holder: bit(l.holderId), target: bit(l.targetId) }))
    : [];

  const out: World[] = [];
  for (const mask of masks) {
    let w = 1;
    for (const q of quests) w *= missionLikelihood(q.round, popcount(mask & q.mask), q.fails);
    for (const l of lakes) {
      if (l.holder === 0 || l.target === 0) continue;
      if ((mask & l.holder) !== 0) w *= 0.5;
    }
    if (w > 0) out.push({ mask, w });
  }
  return out;
}

function marginals(worlds: readonly World[], n: number, filter?: (mask: number) => boolean): { q: number[]; total: number } {
  const q = new Array<number>(n).fill(0);
  let total = 0;
  for (const { mask, w } of worlds) {
    if (filter && !filter(mask)) continue;
    total += w;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) q[i] += w;
  }
  if (total > 0) for (let i = 0; i < n; i++) q[i] /= total;
  return { q, total };
}

function h2(p: number): number {
  if (p <= 1e-12 || p >= 1 - 1e-12) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

// ── Scores ─────────────────────────────────────────────────────

export interface GoodLakeInfoOptions {
  /**
   * Weight λ of the trust-chain term λ·(1 − 2·P(red))·V when another lake
   * follows — the same picks as a weight of 2λ on P(good)·V, since the
   * −λV part is common to every candidate; red-has-two and the last lake
   * force 0.
   */
  trustWeight: number;
}

export const DEFAULT_GOOD_LAKE_INFO_OPTIONS: Readonly<GoodLakeInfoOptions> = Object.freeze({
  trustWeight: 1,
});

export interface GoodLakeCandidateScore {
  id: string;
  /** Holder's belief that the candidate is red. */
  pEvil: number;
  /** Common picture's prior that the candidate is red. */
  pEvilCommon: number;
  /**
   * Expected uncertainty drop of the common picture (bits); ≥ 0 for a loyal
   * holder, can be slightly negative for Merlin / Percival (see module comment).
   */
  infoGain: number;
  /** Trust-chain term (bits; negative for a likely-red candidate). */
  trust: number;
  /** infoGain + trust. */
  score: number;
  /** The candidate went on at least one mission. */
  wentOnMission: boolean;
}

export interface GoodLakeInfoAnalysis {
  /** Candidates in the caller's order. */
  candidates: GoodLakeCandidateScore[];
  /** Effective trust weight λ after the score-state rules. */
  trustWeight: number;
  /** Common picture's total uncertainty before the lake (bits). */
  uncertainty: number;
  /** The earlier lake declarations had to be dropped (inconsistent record). */
  droppedLakes: boolean;
}

/** Another lake follows this one (lakes run after rounds 2 .. last − 1). */
function anotherLakeFollows(obs: PlayerObservation): boolean {
  const rounds = AVALON_CONFIG[obs.playerCount]?.questTeams.length ?? 5;
  return obs.currentRound + 2 <= rounds;
}

/**
 * Score every candidate (see the module comment). `null` when no world is
 * consistent with the record.
 */
export function analyzeGoodLake(
  obs: PlayerObservation,
  candidates: readonly string[],
  options: Readonly<GoodLakeInfoOptions> = DEFAULT_GOOD_LAKE_INFO_OPTIONS,
): GoodLakeInfoAnalysis | null {
  if (candidates.length === 0) return null;
  let droppedLakes = false;
  let belief = buildWorlds(obs, true, true);
  let common = buildWorlds(obs, false, true);
  if (belief.length === 0 || common.length === 0) {
    droppedLakes = true;
    belief = buildWorlds(obs, true, false);
    common = buildWorlds(obs, false, false);
  }
  if (belief.length === 0 || common.length === 0) return null;

  const ids = obs.allPlayerIds;
  const n = ids.length;
  const holder = ids.indexOf(obs.myPlayerId);
  const uncertaintyOf = (q: readonly number[]): number => {
    let u = 0;
    for (let i = 0; i < n; i++) if (i !== holder) u += h2(q[i]);
    return u;
  };
  const beliefQ = marginals(belief, n).q;
  const commonQ = marginals(common, n).q;
  const u0 = uncertaintyOf(commonQ);
  const onMission = new Set(obs.questHistory.flatMap((q) => q.team));

  const raw = candidates.map((id) => {
    const i = ids.indexOf(id);
    if (i < 0) {
      return { id, pEvil: 0.5, pEvilCommon: 0.5, infoGain: 0, wentOnMission: false };
    }
    const b = 1 << i;
    const pEvil = beliefQ[i];
    let expected = 0;
    for (const [isEvil, p] of [[true, pEvil], [false, 1 - pEvil]] as Array<[boolean, number]>) {
      if (p <= 1e-12) continue;
      const cond = marginals(common, n, (mask) => ((mask & b) !== 0) === isEvil);
      expected += p * (cond.total > 0 ? uncertaintyOf(cond.q) : u0);
    }
    return { id, pEvil, pEvilCommon: commonQ[i], infoGain: u0 - expected, wentOnMission: onMission.has(id) };
  });

  const redHasTwo = obs.questResults.filter((r) => r === 'fail').length >= 2;
  const trustWeight = anotherLakeFollows(obs) && !redHasTwo ? options.trustWeight : 0;
  const best = Math.max(...raw.map((c) => c.infoGain));
  const value = Math.max(0, best);
  const scored: GoodLakeCandidateScore[] = raw.map((c) => {
    const trust = trustWeight * (1 - 2 * c.pEvil) * value;
    return { ...c, trust, score: c.infoGain + trust };
  });
  return { candidates: scored, trustWeight, uncertainty: u0, droppedLakes };
}

/**
 * The `goodLakeInfoMax` pick among `candidates` (already filtered by the
 * caller's avoid-set). `null` when the model has no consistent world.
 */
export function pickGoodLakeTargetInfoMax(
  obs: PlayerObservation,
  candidates: readonly string[],
  options: Readonly<GoodLakeInfoOptions> = DEFAULT_GOOD_LAKE_INFO_OPTIONS,
): string | null {
  const analysis = analyzeGoodLake(obs, candidates, options);
  if (!analysis) return null;
  const order = new Map(obs.allPlayerIds.map((id, i) => [id, i]));
  const ranked = [...analysis.candidates].sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) > 1e-9) return diff;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
  return ranked[0]?.id ?? null;
}
