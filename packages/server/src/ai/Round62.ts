/**
 * 第 62 回合（藍方：2-5 的尾派，第 1 局任務失敗之後的強制局）。
 *
 * 站長 2026-11-23（原話）：
 * > 不能單純看第一局失敗的人有哪些吧 也要看其他人給的資訊 還有1-5 的隊伍組合合理性
 *
 * 所以不做「不帶第 1 局失敗隊的人」這種單一規則，改成一整套公開讀法，疊在後驗的世界上（同第 47 回合 `overlay47` 的做法：
 * 座位是紅的世界乘 e^權重，重新正規化之後再算隊伍乾淨的機率；不改 `BayesBelief.posterior`）。讀的東西（每個座位，只看公開紀錄）：
 *   - 第 1 局失敗隊：在不在隊上（`inR1`）；是不是派那一隊的隊長（`r1Lead`）。
 *   - 1-5 隊的合理性：隊長以外的隊員在 1-1…1-4 有沒有被別人提過——沒被提過的是隊長自己挑的（`r1Pick`）；
 *     隊上有這種人時，派隊的隊長另外記一筆（`r1LeadUnr`，「不合理的隊」的隊長）。
 *   - 誰把那一隊的人帶上檯面：1-1…1-4 自己派的隊放了幾個第 1 局隊員（隊長自己與 1-5 隊長除外，`consSeed`）。
 *   - 其他人給的資訊：1-1…1-4、2-1…2-4 被別人提了幾次（`nPropR1`、`nPropR2`）；
 *     1-1…1-4 不在隊上時對「含第 1 局隊員兩人以上的隊」的贊成率（外白，`apprR1out`，−0.5…+0.5）；
 *     2-1…2-4 對「含第 1 局隊員兩人以上的隊」的贊成率（失敗之後還挺那一隊，`apprR2fail`）；2-1…2-4 自己派了含第 1 局隊員的隊（`r2PropFail`）。
 *
 * 權重 = 真人局（games_cache 嚴格重播）2-5（0:1）忠臣／派西當隊長的決策點，每個座位「是紅」對「真人桌策略層後驗的 logit ＋ 這些特徵」的 logistic 迴歸，
 * 取特徵的殘差係數（後驗已經讀到的部分不重算；`scripts/tailSpot62.ts --features`＋`tailSpot62.py --fit`）。
 *
 * `tailRead62`（0 = 關；值 = 權重的倍數）：只在 2-5、第 1 局任務失敗、忠臣或派西當隊長、走「最乾淨的隊」（`GoodRound5.goodCleanLeadTeam`）時用。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

export const FEATURES_62 = ['inR1', 'r1Lead', 'r1Pick', 'r1LeadUnr', 'consSeed', 'nPropR1', 'nPropR2', 'apprR1out', 'apprR2fail', 'r2PropFail'] as const;
export type Feature62 = (typeof FEATURES_62)[number];
export type SeatFeatures62 = Record<Feature62, number>;

/**
 * 殘差權重（對數勝算，紅 > 0）。真人局 2-5（0:1）忠臣／派西當隊長 784 個決策點裡 667 個、6,003 個（座位 × 決策點）點，
 * 後驗（真人桌策略層）的 logit 係數 1.23；特徵的係數見 docs/ai/optimization_loop.md 第 62 回合。
 */
export const W62: Readonly<SeatFeatures62> = Object.freeze({
  inR1: -0.102,
  r1Lead: -0.148,
  r1Pick: -0.12,
  r1LeadUnr: 0.058,
  consSeed: -0.014,
  nPropR1: -0.013,
  nPropR2: -0.028,
  apprR1out: -0.298,
  apprR2fail: -0.057,
  r2PropFail: -0.333,
});

/** 研究用（`scripts/tailSpot62.ts --w62`，偶數局擬合、奇數局驗證）：暫時換掉權重；null = 回到 `W62`。正式的對局不呼叫。 */
let weightsOverride: Readonly<SeatFeatures62> | null = null;
export function setTailRead62Weights(w: Readonly<SeatFeatures62> | null): void {
  weightsOverride = w;
}

/** 這個決策點適用 `tailRead62` 的公開條件：第 2 局第 5 次提議（強制局）、自己是隊長、第 1 局任務失敗、藍方忠臣／派西。 */
export function tailRead62Applies(obs: PlayerObservation): boolean {
  if (obs.gamePhase !== 'team_select' || obs.myTeam !== 'good') return false;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival') return false;
  if ((obs.currentRound ?? 1) !== 2 || (obs.failCount ?? 0) < 4 || obs.currentLeader !== obs.myPlayerId) return false;
  const q1 = obs.questHistory.find((q) => q.round === 1);
  return q1 !== undefined && (q1.failCount ?? 0) >= 1;
}

/** 每個座位（自己除外）的公開特徵；第 1 局沒有任務紀錄時回傳空的。 */
export function tailRead62Features(obs: PlayerObservation): Map<string, SeatFeatures62> {
  const out = new Map<string, SeatFeatures62>();
  const q1 = obs.questHistory.find((q) => q.round === 1);
  if (!q1) return out;
  const T = new Set(q1.team);
  const r1 = obs.voteHistory.filter((v) => v.round === 1);
  const went = [...r1].reverse().find((v) => v.approved);
  const L1 = went?.leader ?? null;
  const before = went ? r1.filter((v) => v.attempt < went.attempt) : [];
  const r2 = obs.voteHistory.filter((v) => v.round === 2 && v.attempt < 5);
  const ids = obs.allPlayerIds;
  const cnt = (): Map<string, number> => new Map(ids.map((id) => [id, 0]));
  const nprop = cnt();
  const nprop2 = cnt();
  const seed = cnt();
  const pf = cnt();
  const ap1 = new Map(ids.map((id) => [id, [0, 0]]));
  const ap2 = new Map(ids.map((id) => [id, [0, 0]]));
  const overlap = (team: readonly string[]): number => team.filter((id) => T.has(id)).length;
  for (const v of before) {
    for (const id of v.team) if (id !== v.leader) nprop.set(id, (nprop.get(id) ?? 0) + 1);
    seed.set(v.leader, (seed.get(v.leader) ?? 0) + v.team.filter((id) => T.has(id) && id !== v.leader && id !== L1).length);
    if (overlap(v.team) >= 2) {
      for (const id of ids) {
        if (v.team.includes(id)) continue;
        const a = ap1.get(id)!;
        a[1]++;
        if (v.votes[id]) a[0]++;
      }
    }
  }
  for (const v of r2) {
    for (const id of v.team) if (id !== v.leader) nprop2.set(id, (nprop2.get(id) ?? 0) + 1);
    const ov = overlap(v.team);
    if (ov >= 2 && (!T.has(v.leader) || v.team.some((id) => id !== v.leader && T.has(id)))) pf.set(v.leader, (pf.get(v.leader) ?? 0) + 1);
    if (ov >= 2) {
      for (const id of ids) {
        const a = ap2.get(id)!;
        a[1]++;
        if (v.votes[id]) a[0]++;
      }
    }
  }
  const unexplained = [...T].filter((id) => id !== L1 && (nprop.get(id) ?? 0) === 0);
  for (const id of ids) {
    if (id === obs.myPlayerId) continue;
    const a1 = ap1.get(id)!;
    const a2 = ap2.get(id)!;
    out.set(id, {
      inR1: T.has(id) ? 1 : 0,
      r1Lead: id === L1 ? 1 : 0,
      r1Pick: unexplained.includes(id) ? 1 : 0,
      r1LeadUnr: id === L1 && unexplained.length > 0 ? 1 : 0,
      consSeed: Math.min(seed.get(id) ?? 0, 3),
      nPropR1: nprop.get(id) ?? 0,
      nPropR2: nprop2.get(id) ?? 0,
      apprR1out: a1[1] > 0 ? a1[0] / a1[1] - 0.5 : 0,
      apprR2fail: a2[1] > 0 ? a2[0] / a2[1] - 0.5 : 0,
      r2PropFail: Math.min(pf.get(id) ?? 0, 2),
    });
  }
  return out;
}

/** `goodCleanLeadTeam` 要套的每個座位對數勝算調整（`tailRead62` 關或不適用 = 空的）。 */
export function overlay62(tuning: Readonly<AgentTuning>, obs: PlayerObservation): Map<string, number> {
  const k = tuning.tailRead62 ?? 0;
  const out = new Map<string, number>();
  if (k <= 0 || !tailRead62Applies(obs)) return out;
  const w = weightsOverride ?? W62;
  for (const [id, f] of tailRead62Features(obs)) {
    let a = 0;
    for (const name of FEATURES_62) a += w[name] * f[name];
    if (a !== 0) out.set(id, k * a);
  }
  return out;
}
