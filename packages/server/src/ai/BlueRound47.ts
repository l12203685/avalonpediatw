/**
 * 優化迴圈第 47 回合・藍方（2026-11-21）：站長第一則「AI 哪裡想錯」（11/19 SV1Q8-3-5）的五項，加上 `goodCleanLead` 第 4 局兩張失敗的修正。
 *
 * 全部只用在忠臣／派西當隊長的「最乾淨的隊」（`GoodRound5.goodCleanLeadTeam`），而且**不改 `BayesBelief.posterior`**
 * （第 48 回合另一位代理人在重新校準那裡）：先拿 `bayesWorlds` 的世界與權重，再在這裡乘上公開紀錄的特徵概似（每個座位一個對數勝算的加減），
 * 重新正規化後算隊伍乾淨的機率。
 *
 *   - `missedOpp47`：當過強制局（第 5 次提議）隊長、自己在隊上、那一次任務 0 張失敗的人——是紅的話「可以直接拿一局失敗」卻沒拿（權重照資料）。
 *   - `standing47`：桌面地位——別人的提議放他進隊的比例（第 1 局起全部的提議，不算他自己派的）；分三段。
 *   - `respectRead47`：不參考前面提議的隊長（同一局第 2–4 次提議，隊上除了自己沒有任何前面提議過的人）。
 *   - `r1SuccessTrust47`：第 1 局成功的隊員在第 2、3 局的讀法（站長說「不要過度相信」；殘差權重的方向照資料，見 `W47`）。
 *   - `lakePlanLead47`：持湖者當隊長、這局之後還有湖：在「夠乾淨」的隊裡（乾淨機率 ≥ 最乾淨 − ε），挑任務結果出來之後湖的資訊量期望值最高的隊。
 *   - `goodCleanLeadR4Fix47`：第 4 局（10 人局要兩張失敗）「最乾淨」改成「少於兩紅的機率最高」（11/21 百科AI 作答發現：一紅的隊過了也不會失敗）。
 *
 * 權重（對數勝算，紅 > 0）照第 1E 節用真人局擬合：`scripts/fitRound47.ts` 在真人局的忠臣決策點，把真紅對「預設後驗的 logit ＋ 這些特徵」
 * 做 logistic 迴歸，取特徵的**殘差**係數（後驗已經讀到的部分不重算）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesWorlds, type BayesOptions } from './belief/BayesBelief';

/** 每個座位的公開特徵（只看公開紀錄）。 */
export interface SeatFeatures47 {
  /** 當過強制局隊長、自己在隊上、任務 0 張失敗（次數）。 */
  missed: number;
  /** 別人的提議放他進隊的比例。 */
  share: number;
  /** 0 = < 0.25、1 = 0.25–0.4、2 = ≥ 0.4。 */
  shareBucket: number;
  /** 同一局第 2–4 次提議，隊上除了自己沒有前面提議過的人（次數）。 */
  ignore: number;
  /** 在第 1 局成功的任務隊上。 */
  r1succ: boolean;
}

export function publicFeatures47(obs: PlayerObservation): Map<string, SeatFeatures47> {
  const ids = obs.allPlayerIds;
  const inc = new Map(ids.map((id) => [id, 0]));
  const opp = new Map(ids.map((id) => [id, 0]));
  const missed = new Map(ids.map((id) => [id, 0]));
  const ignore = new Map(ids.map((id) => [id, 0]));
  const byRound = new Map<number, PlayerObservation['voteHistory']>();
  for (const v of obs.voteHistory) {
    for (const id of ids) {
      if (id === v.leader) continue;
      opp.set(id, (opp.get(id) ?? 0) + 1);
      if (v.team.includes(id)) inc.set(id, (inc.get(id) ?? 0) + 1);
    }
    const list = byRound.get(v.round) ?? [];
    if (v.attempt >= 2 && v.attempt <= 4 && list.length > 0) {
      const prev = new Set(list.flatMap((x) => x.team));
      if (!v.team.some((id) => id !== v.leader && prev.has(id))) ignore.set(v.leader, (ignore.get(v.leader) ?? 0) + 1);
    }
    list.push(v);
    byRound.set(v.round, list);
  }
  for (const q of obs.questHistory) {
    if ((q.failCount ?? 0) !== 0) continue;
    const forced = obs.voteHistory.find((v) => v.round === q.round && v.approved && v.attempt >= 5);
    if (forced && forced.team.includes(forced.leader)) missed.set(forced.leader, (missed.get(forced.leader) ?? 0) + 1);
  }
  const r1 = obs.questHistory.find((q) => q.round === 1);
  const r1ok = r1 !== undefined && (r1.failCount ?? 0) === 0;
  const out = new Map<string, SeatFeatures47>();
  for (const id of ids) {
    const o = opp.get(id) ?? 0;
    const share = o > 0 ? (inc.get(id) ?? 0) / o : 0;
    out.set(id, {
      missed: missed.get(id) ?? 0,
      share,
      shareBucket: share < 0.25 ? 0 : share < 0.4 ? 1 : 2,
      ignore: ignore.get(id) ?? 0,
      r1succ: r1ok && r1!.team.includes(id),
    });
  }
  return out;
}

/**
 * 殘差權重（對數勝算；紅 > 0）：`scripts/fitRound47.ts`，真人局（games_cache 2,236 局）忠臣座位第 2–4 局第 1 次提議的投票點，
 * logit P(紅) = b0 + a·logit(預設後驗) + Σ w·特徵，強者桌（S ≥ 55）28,039 個（座位 × 目標）點（第 1E 節第 7 條以強者為準）：
 * missed +0.173 ± 0.148、地位低 −0.051 ± 0.070、地位高 −0.049 ± 0.082、不參考 +0.016 ± 0.101、第 1 局成功隊員（第 2、3 局的點）−0.223 ± 0.132；
 * a = 0.818。全部真人 201,036 點：+0.032、+0.086、+0.009、−0.093、−0.062。也就是說，預設後驗已經把「錯過的機會」讀得比真人資料還多，
 * 第 1 局成功的隊員反而讀得**不夠**藍；地位、不參考在後驗之外幾乎沒有資訊。
 */
export const W47 = Object.freeze({
  missed: 0.173,
  standing: [-0.051, 0, -0.049] as readonly number[],
  ignore: 0.016,
  r1succ: -0.223,
});

/** 這一個隊長決策要套的每個座位對數勝算調整（只有開著的開關）；全部關 = 空的。 */
export function overlay47(tuning: Readonly<AgentTuning>, obs: PlayerObservation): Map<string, number> {
  const on = (tuning.missedOpp47 ?? 0) > 0 || (tuning.standing47 ?? 0) > 0 || (tuning.respectRead47 ?? 0) > 0 || (tuning.r1SuccessTrust47 ?? 0) > 0;
  const out = new Map<string, number>();
  if (!on) return out;
  const round = obs.currentRound ?? 1;
  const f = publicFeatures47(obs);
  for (const [id, x] of f) {
    if (id === obs.myPlayerId) continue;
    let a = 0;
    if ((tuning.missedOpp47 ?? 0) > 0) a += tuning.missedOpp47 * W47.missed * x.missed;
    if ((tuning.standing47 ?? 0) > 0) a += tuning.standing47 * W47.standing[x.shareBucket];
    if ((tuning.respectRead47 ?? 0) > 0) a += tuning.respectRead47 * W47.ignore * x.ignore;
    if ((tuning.r1SuccessTrust47 ?? 0) > 0 && x.r1succ && round >= 2 && round <= 3) a += tuning.r1SuccessTrust47 * W47.r1succ;
    if (a !== 0) out.set(id, a);
  }
  return out;
}

/** 世界 × 權重，乘上 `adj`（座位是紅的世界乘 e^adj）後正規化；`adj` 空的就是原本的後驗。 */
export interface Weighted47 { worlds: readonly number[]; wts: readonly number[]; bitOf: (id: string) => number }

export function weightedWorlds47(obs: PlayerObservation, opts: Readonly<BayesOptions>, adj: ReadonlyMap<string, number>): Weighted47 | null {
  const post = bayesWorlds(obs, opts);
  if (post.worlds.length === 0) return null;
  if (adj.size === 0) return { worlds: post.worlds, wts: post.wts, bitOf: post.bitOf };
  const terms = [...adj].map(([id, a]) => ({ b: post.bitOf(id), a }));
  const raw = post.worlds.map((w, i) => {
    let s = 0;
    for (const t of terms) if ((w & t.b) !== 0) s += t.a;
    return post.wts[i] * Math.exp(s);
  });
  const tot = raw.reduce((x, y) => x + y, 0);
  return { worlds: post.worlds, wts: tot > 0 ? raw.map((x) => x / tot) : post.wts, bitOf: post.bitOf };
}

const popcount = (x: number): number => { let c = 0; while (x) { x &= x - 1; c++; } return c; };

/** P(隊上少於 k 紅)；k = 1 就是「乾淨」。 */
export function teamRedsBelow47(ww: Weighted47, team: readonly string[], k: number): number {
  const mask = team.reduce((m, id) => m | ww.bitOf(id), 0);
  let s = 0;
  ww.worlds.forEach((w, i) => { if (popcount(w & mask) < k) s += ww.wts[i]; });
  return s;
}

/** 這一局要幾張失敗才失敗（10 人局第 4 局 = 2）。 */
export function failsRequired47(obs: PlayerObservation): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[(obs.currentRound ?? 1) - 1] ?? 1;
}

/** 現在的持湖者（最後一湖的被驗者；還沒湖過 = 第一個隊長的前一位）。 */
export function currentLakeHolder(obs: PlayerObservation): string | null {
  const h = obs.lakeHistory ?? [];
  if (h.length > 0) return h[h.length - 1].targetId;
  const first = obs.voteHistory[0]?.leader;
  if (!first) return null;
  const ids = obs.allPlayerIds;
  return ids[(ids.indexOf(first) - 1 + ids.length) % ids.length];
}

/** 湖還會不會在這一局之後發生（第 2–4 局之後；10 人局）。 */
export function lakeAfterThisRound(obs: PlayerObservation): boolean {
  const r = obs.currentRound ?? 1;
  return r >= 2 && r <= 4 && obs.playerCount >= 7;
}

const h2 = (p: number): number => (p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)));

/**
 * `lakePlanLead47`：持湖者派這隊、任務結果出來之後，湖能拿到的資訊量期望值。任務結果照「紅都出失敗」近似（失敗張數 = 隊上紅數，
 * 超過一個紅的都算同一種「兩張以上」），每種結果下挑可以湖的人裡最不確定的一個（二元熵最大），對結果的機率加權。
 */
export function lakePlanValue47(ww: Weighted47, obs: PlayerObservation, team: readonly string[]): number {
  const me = obs.myPlayerId;
  const used = new Set<string>([...(obs.lakeHistory ?? []).flatMap((l) => [l.holderId, l.targetId]), me]);
  const first = obs.voteHistory[0]?.leader;
  if (first && (obs.lakeHistory ?? []).length === 0) {
    const ids = obs.allPlayerIds;
    used.add(ids[(ids.indexOf(first) - 1 + ids.length) % ids.length]);
  }
  const targets = obs.allPlayerIds.filter((id) => !used.has(id));
  if (targets.length === 0) return 0;
  const mask = team.reduce((m, id) => m | ww.bitOf(id), 0);
  const groups = new Map<number, { p: number; red: number[] }>();
  ww.worlds.forEach((w, i) => {
    const o = Math.min(popcount(w & mask), 2);
    let g = groups.get(o);
    if (!g) { g = { p: 0, red: targets.map(() => 0) }; groups.set(o, g); }
    g.p += ww.wts[i];
    targets.forEach((t, j) => { if ((w & ww.bitOf(t)) !== 0) g!.red[j] += ww.wts[i]; });
  });
  let v = 0;
  for (const g of groups.values()) {
    if (g.p <= 0) continue;
    v += g.p * Math.max(...g.red.map((r) => h2(r / g.p)));
  }
  return v;
}
