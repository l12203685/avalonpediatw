/**
 * 模擬瓦（2026-10-14）— 世界模型：紅方集合的枚舉與統計，純函式。
 *
 * v1 只用「確定資訊」（純邏輯，還沒算派票行為，回覆會講明）。一個世界 = 4 紅的集合
 * R ⊂ {1..10}（共 210 種），留下符合下面條件的：
 *   H2 視角：好人自己不在 R；梅林看到的紅 ⊆ R；派西兩根拇指剛好一紅；
 *      紅方（非奧伯倫）自己和隊友 ⊆ R；奧伯倫自己 ∈ R；
 *   H1 任務：出 f 張失敗的任務隊至少 f 紅（成功不代表全好；第 4 局 1 張失敗任務仍成功，但證明至少 1 紅）；
 *   H3 自己湖過的人：真相（從角色來）。
 * 別人湖的宣告不是事實，只當「湖讀法」（reading.ts），跟派票一樣。
 * 世界等權重。
 *
 * v2 接口：`SimBeliefModel` 把世界模型包起來，之後的信念引擎（task Z：派票／投票的真人似然、
 * 共同資訊、熵）只要實作 worlds() 就能接上；所有面板都只吃 analyze(worlds)，換模型不用改格式化。
 * 切換：SIM_BELIEF_MODEL=logic|belief（v1 只有 logic）。
 */

import { combinations, evilCountFor, popcount } from '../../ai/worlds';
import type { SimView } from './scenario';
import { maskOf, seatBit } from './seats';

export interface SimWorld {
  redMask: number;
  weight: number;
  /** v2：角色層級的世界（v1 不用）。 */
  roles?: Uint8Array;
}

export interface SimBeliefModel {
  /** 'logic'（v1）。 */
  readonly id: string;
  /** 回覆裡的名稱：「純邏輯」／ v2「派票加權（真人資料）」。 */
  readonly label: string;
  /** false → 回覆說「還沒算派票行為」。 */
  readonly weighsBehaviour: boolean;
  /** 權重 0 的世界不回傳。 */
  worlds(view: SimView): SimWorld[];
}

export const RED_COUNT = evilCountFor(10);

/** 全部 4 紅組合（bit (seat − 1)）。 */
export const ALL_RED_SETS: readonly number[] = combinations([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], RED_COUNT);

/** 世界的條件，全部用遮罩。 */
export interface WorldConstraints {
  /** 一定是好人。 */
  good: number;
  /** 一定是紅。 */
  red: number;
  /** 每一個遮罩裡剛好一紅（派西的拇指）。 */
  exactlyOne: number[];
  /** 任務：隊伍遮罩裡至少 fails 紅。 */
  missions: { mask: number; fails: number }[];
}

export function noConstraints(): WorldConstraints {
  return { good: 0, red: 0, exactlyOne: [], missions: [] };
}

/** 任務事實（H1）：看得到的每一局任務。 */
export function missionConstraints(view: Pick<SimView, 'events'>): WorldConstraints['missions'] {
  const out: WorldConstraints['missions'] = [];
  for (const e of view.events) {
    if (e.kind === 'quest' && e.failCount > 0) out.push({ mask: maskOf(e.teamSeats), fails: e.failCount });
  }
  return out;
}

/** 這一家的視角（H2 + H1 + H3）。 */
export function viewerConstraints(view: SimView): WorldConstraints {
  const c = noConstraints();
  const self = seatBit(view.seat);
  switch (view.sight.kind) {
    case 'loyal':
      c.good |= self;
      break;
    case 'merlin':
      c.good |= self;
      c.red |= maskOf(view.sight.seen);
      break;
    case 'percival':
      c.good |= self;
      if (view.sight.thumbs.length === 2) c.exactlyOne.push(maskOf(view.sight.thumbs));
      break;
    case 'evil':
      c.red |= self | maskOf(view.sight.mates);
      break;
    case 'oberon':
      c.red |= self;
      break;
  }
  c.missions = missionConstraints(view);
  for (const l of view.ownLakes) {
    if (l.evil) c.red |= seatBit(l.targetSeat);
    else c.good |= seatBit(l.targetSeat);
  }
  return c;
}

/** 後面的人看得到的（只有公開的任務事實）：「你的派票放出什麼資訊」用這個。 */
export function publicConstraints(view: Pick<SimView, 'events'>): WorldConstraints {
  return { ...noConstraints(), missions: missionConstraints(view) };
}

export function satisfies(mask: number, c: WorldConstraints): boolean {
  if ((mask & c.good) !== 0) return false;
  if ((mask & c.red) !== c.red) return false;
  for (const m of c.exactlyOne) if (popcount(mask & m) !== 1) return false;
  for (const q of c.missions) if (popcount(mask & q.mask) < q.fails) return false;
  return true;
}

export function enumerateWorlds(c: WorldConstraints): SimWorld[] {
  return ALL_RED_SETS.filter((m) => satisfies(m, c)).map((redMask) => ({ redMask, weight: 1 }));
}

/** v1 模型：純邏輯、等權重。 */
export const logicModel: SimBeliefModel = {
  id: 'logic',
  label: '純邏輯',
  weighsBehaviour: false,
  worlds: (view) => enumerateWorlds(viewerConstraints(view)),
};

/** SIM_BELIEF_MODEL 對應的模型；v1 只有 logic。 */
export function beliefModelFor(_id: string): SimBeliefModel {
  return logicModel;
}

// ─── analyze ──────────────────────────────────────────────────────────────

export interface Analysis {
  worlds: SimWorld[];
  /** 權重總和（v1 = 世界數）。 */
  total: number;
  /** 世界數（權重 > 0）。 */
  count: number;
  /** 第 s 家是紅的權重。 */
  redWeight(seat: number): number;
  /** 第 s 家是紅的機率。 */
  marginal(seat: number): number;
  /** `mask` 裡沒有紅的世界（「這些人都是好人」成立）。 */
  claimWorlds(mask: number): SimWorld[];
  claimWeight(mask: number): number;
  /** 依 `mask` 裡紅的數量分：result[k] = 剛好 k 紅的權重。 */
  countWeights(mask: number): number[];
  /** 聯合熵 −Σ p log2 p（等權重時 = log2 N）。 */
  entropyBits: number;
}

export function analyze(worlds: readonly SimWorld[]): Analysis {
  const list = worlds.filter((w) => w.weight > 0);
  const total = list.reduce((s, w) => s + w.weight, 0);
  const redW = new Array<number>(11).fill(0);
  for (const w of list) for (let s = 1; s <= 10; s++) if (w.redMask & seatBit(s)) redW[s] += w.weight;
  let entropy = 0;
  for (const w of list) {
    const p = w.weight / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const claimWorlds = (mask: number): SimWorld[] => list.filter((w) => (w.redMask & mask) === 0);
  return {
    worlds: list,
    total,
    count: list.length,
    redWeight: (seat) => redW[seat],
    marginal: (seat) => (total > 0 ? redW[seat] / total : 0),
    claimWorlds,
    claimWeight: (mask) => claimWorlds(mask).reduce((s, w) => s + w.weight, 0),
    countWeights: (mask): number[] => {
      const out = new Array<number>(popcount(mask) + 1).fill(0);
      for (const w of list) out[popcount(w.redMask & mask)] += w.weight;
      return out;
    },
    entropyBits: entropy,
  };
}
