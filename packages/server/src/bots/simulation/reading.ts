/**
 * 模擬瓦（2026-10-14）— 派票的解讀與釋放：把世界模型算成各面板要的數字，純函式。
 *
 * 百科模擬題的幾個動作，這裡各有一個機械版本（v1 純邏輯）：
 *   - 區間（「7 8 9 *2」）：座位依「是紅的機率」分組，每組紅數的範圍 → logicPanel().groups；
 *   - 讀前面的派票（「3 的派票不是好人派票」）：全好讀法 = 隊長＋隊員都是好人，
 *     算它在你的世界裡佔幾成、兩兩合起來還剩幾種（「12 *1-2，因為 12 派票不同邊」）→ claims / pairs；
 *   - 派完的最後檢查（「傳遞的資訊是什麼?」「派469較468好，因為468變成跟279打對邊」）
 *     → releasePanel()：用後面的人看得到的公開資訊算；
 *   - 你寫的區間 → evaluateInterval()。
 * 別人湖的宣告當「湖讀法」：若湖的人是好人說實話 → 剩幾種。
 */

import type { IntervalGroup } from './commands';
import { analyze, enumerateWorlds, publicConstraints, viewerConstraints, type Analysis, type SimBeliefModel, type WorldConstraints } from './logic';
import { isRed, type PublicEvent, type SimView } from './scenario';
import { maskOf, seatBit, seatsOfMask } from './seats';
import { popcount } from '../../ai/worlds';

/** 好人總數（10 人 4 紅）。 */
export const GOOD_COUNT = 6;
/** 兩兩合讀、你的派票對照時，剩下幾種以內就把紅方組合列出來。 */
export const LIST_WORLDS_MAX = 3;
/** 讀前面幾次派票（最近的 5 次）。 */
export const READ_PROPOSALS_MAX = 5;

export type ProposalEvent = Extract<PublicEvent, { kind: 'proposal' }>;

/** 全好讀法的集合：隊長＋隊員。 */
export function claimMaskOf(p: Pick<ProposalEvent, 'leaderSeat' | 'teamSeats'>): number {
  return maskOf(p.teamSeats) | seatBit(p.leaderSeat);
}

/** 決定當下要讀的派票：之前最近的 5 次（照時間）。 */
export function readableProposals(view: Pick<SimView, 'events'>): ProposalEvent[] {
  const props = view.events.filter((e): e is ProposalEvent => e.kind === 'proposal');
  return props.slice(-READ_PROPOSALS_MAX);
}

/** 讀法不成立的原因：你自己看到的資訊（拇指／隊友／自己是紅／湖）或任務結果。 */
export type Impossible = 'sight' | 'mission';

export interface ClaimReading {
  proposal: ProposalEvent;
  mask: number;
  weight: number;
  /** weight = 0 時的原因。 */
  impossible?: Impossible;
  /** 原因是視角時，讓它不成立的座位（你知道是紅的人、或派西的兩根拇指）。 */
  sightSeats?: number[];
}

export interface PairReading {
  a: number;
  b: number;
  unionSize: number;
  weight: number;
  /** 合起來超過 6 人：不可能都是好人。 */
  tooMany: boolean;
  /** 剩 LIST_WORLDS_MAX 種以內時列出紅方組合。 */
  worlds?: number[];
}

export interface LakeReading {
  holderSeat: number;
  targetSeat: number;
  claimEvil: boolean;
  weight: number;
}

export interface SeatGroup {
  seats: number[];
  marginal: number;
  /** 這一組在各世界的紅數範圍。 */
  min: number;
  max: number;
}

export interface LogicPanel {
  model: SimBeliefModel;
  analysis: Analysis;
  groups: SeatGroup[];
  claims: ClaimReading[];
  pairs: PairReading[];
  lakes: LakeReading[];
}

/** 你自己知道一定是紅的座位（自己是紅、看到的紅、隊友、湖到紅）。 */
export function knownRedSeats(view: SimView): number[] {
  const c = viewerConstraints(view);
  return seatsOfMask(c.red);
}

/** 只用視角（沒有任務結果）時的世界：判斷「不成立」是視角造成還是任務造成。 */
function sightOnly(view: SimView): WorldConstraints {
  return { ...viewerConstraints(view), missions: [] };
}

function weightUnder(c: WorldConstraints, mask: number): number {
  return enumerateWorlds(c).filter((w) => (w.redMask & mask) === 0).reduce((s, w) => s + w.weight, 0);
}

function minMax(counts: readonly number[]): { min: number; max: number } {
  let min = -1;
  let max = -1;
  counts.forEach((w, k) => {
    if (w > 0) {
      if (min < 0) min = k;
      max = k;
    }
  });
  return { min: Math.max(0, min), max: Math.max(0, max) };
}

/** 其他人依「是紅的機率」分組（同一個機率一組），照機率由高到低。 */
export function seatGroups(analysis: Analysis, viewerSeat: number): SeatGroup[] {
  const byWeight = new Map<number, number[]>();
  for (let s = 1; s <= 10; s++) {
    if (s === viewerSeat) continue;
    const w = analysis.redWeight(s);
    byWeight.set(w, [...(byWeight.get(w) ?? []), s]);
  }
  return [...byWeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([w, seats]) => ({ seats, marginal: analysis.total > 0 ? w / analysis.total : 0, ...minMax(analysis.countWeights(maskOf(seats))) }));
}

export function logicPanel(view: SimView, model: SimBeliefModel): LogicPanel {
  const analysis = analyze(model.worlds(view));
  const readable = readableProposals(view);
  const sightC = sightOnly(view);
  const known = new Set(knownRedSeats(view));
  const claims: ClaimReading[] = readable.map((p) => {
    const mask = claimMaskOf(p);
    const weight = analysis.claimWeight(mask);
    if (weight > 0) return { proposal: p, mask, weight };
    if (weightUnder(sightC, mask) === 0) {
      const reds = seatsOfMask(mask).filter((s) => known.has(s));
      const thumbs = view.sight.kind === 'percival' ? view.sight.thumbs.filter((s) => (mask & seatBit(s)) !== 0) : [];
      return { proposal: p, mask, weight, impossible: 'sight', sightSeats: reds.length > 0 ? reds : thumbs };
    }
    return { proposal: p, mask, weight, impossible: 'mission' };
  });

  const pairs: PairReading[] = [];
  for (let a = 0; a < claims.length; a++) {
    for (let b = a + 1; b < claims.length; b++) {
      if (claims[a].weight === 0 || claims[b].weight === 0) continue;
      const union = claims[a].mask | claims[b].mask;
      const worlds = analysis.claimWorlds(union);
      const weight = worlds.reduce((s, w) => s + w.weight, 0);
      pairs.push({
        a,
        b,
        unionSize: popcount(union),
        weight,
        tooMany: popcount(union) > GOOD_COUNT,
        ...(weight > 0 && worlds.length <= LIST_WORLDS_MAX ? { worlds: worlds.map((w) => w.redMask) } : {}),
      });
    }
  }

  const lakes: LakeReading[] = [];
  for (const e of view.events) {
    if (e.kind !== 'lake' || e.claim === null || e.holderSeat === view.seat) continue;
    const holderGood = seatBit(e.holderSeat);
    const target = seatBit(e.targetSeat);
    const claimEvil = e.claim === 'evil';
    const weight = analysis.worlds
      .filter((w) => (w.redMask & holderGood) === 0 && ((w.redMask & target) !== 0) === claimEvil)
      .reduce((s, w) => s + w.weight, 0);
    lakes.push({ holderSeat: e.holderSeat, targetSeat: e.targetSeat, claimEvil, weight });
  }

  return { model, analysis, groups: seatGroups(analysis, view.seat), claims, pairs, lakes };
}

// ─── 你的派票放出的資訊 ─────────────────────────────────────────────────────

export type OverlapLabel = '延伸' | '部分' | '打對邊';

export function overlapLabel(shared: number): OverlapLabel {
  return shared >= 2 ? '延伸' : shared === 1 ? '部分' : '打對邊';
}

export interface ReleaseVs {
  proposal: ProposalEvent;
  shared: number[];
  label: OverlapLabel;
  weight: number;
  worlds?: number[];
}

export interface ReleaseContrast {
  alternative: number[];
  proposal: ProposalEvent;
  weight: number;
  worlds?: number[];
  /** 你的隊伍跟同一次派票合讀的權重（對照用）。 */
  yourWeight: number;
}

export type PrivateCheck =
  | { kind: 'merlin'; seenOnTeam: number[] }
  | { kind: 'percival'; thumbsOnTeam: number[] }
  | { kind: 'evil'; matesOnTeam: number[]; selfOnTeam: boolean }
  | { kind: 'oberon'; selfOnTeam: boolean }
  | { kind: 'none' };

export interface ReleasePanel {
  team: number[];
  /** 讀你全好的集合：隊員＋你。 */
  claimMask: number;
  /** 後面的人（只有公開資訊）的世界數與你全好時剩幾種。 */
  publicTotal: number;
  weight: number;
  vs: ReleaseVs[];
  /** 各自跟你相容、兩個本身也相容，但跟你合起來不可能的兩次派票。 */
  rejects: { a: ProposalEvent; b: ProposalEvent }[];
  privateCheck: PrivateCheck;
  contrast?: ReleaseContrast;
}

function listIfFew(worlds: { redMask: number }[]): number[] | undefined {
  return worlds.length > 0 && worlds.length <= LIST_WORLDS_MAX ? worlds.map((w) => w.redMask) : undefined;
}

/**
 * `team` 是你派的隊伍。用公開資訊（後面的人看得到的：任務結果）算「讀你全好」會留下什麼，
 * 跟前面每一次派票合起來還剩幾種，以及換一個人會不會變成打對邊（對照）。
 */
export function releasePanel(view: SimView, team: readonly number[]): ReleasePanel {
  const pub = analyze(enumerateWorlds(publicConstraints(view)));
  const claimMask = maskOf(team) | seatBit(view.seat);
  const readable = readableProposals(view);
  const teamSet = new Set(team);

  const vs: ReleaseVs[] = readable.map((p) => {
    const shared = p.teamSeats.filter((s) => teamSet.has(s));
    const worlds = pub.claimWorlds(claimMask | claimMaskOf(p));
    return { proposal: p, shared, label: overlapLabel(shared.length), weight: worlds.length, worlds: listIfFew(worlds) };
  });

  // 「你在說 i、j 至少一個錯」：i、j 各自跟你相容、兩個本身也相容，三個合起來卻不可能。
  // （i、j 本身就互斥的話，誰派都一樣，不算你的派票放出的資訊。）
  const rejects: ReleasePanel['rejects'] = [];
  for (let a = 0; a < readable.length; a++) {
    for (let b = a + 1; b < readable.length; b++) {
      if (vs[a].weight === 0 || vs[b].weight === 0) continue;
      const pair = claimMaskOf(readable[a]) | claimMaskOf(readable[b]);
      if (pub.claimWeight(pair) === 0) continue;
      if (pub.claimWeight(claimMask | pair) === 0) rejects.push({ a: readable[a], b: readable[b] });
    }
  }

  return {
    team: [...team],
    claimMask,
    publicTotal: pub.total,
    weight: pub.claimWeight(claimMask),
    vs,
    rejects,
    privateCheck: privateCheckFor(view, team),
    contrast: contrastFor(view, team, readable, pub),
  };
}

function privateCheckFor(view: SimView, team: readonly number[]): PrivateCheck {
  const on = (seats: readonly number[]): number[] => seats.filter((s) => team.includes(s));
  switch (view.sight.kind) {
    case 'merlin': return { kind: 'merlin', seenOnTeam: on(view.sight.seen) };
    case 'percival': return { kind: 'percival', thumbsOnTeam: on(view.sight.thumbs) };
    case 'evil': return { kind: 'evil', matesOnTeam: on(view.sight.mates), selfOnTeam: team.includes(view.seat) };
    case 'oberon': return { kind: 'oberon', selfOnTeam: team.includes(view.seat) };
    default: return { kind: 'none' };
  }
}

/**
 * 「派469較468好，因為468變成跟279打對邊」的機械版：你的隊伍跟前面某次派票只共用 1 人（部分）時，
 * 把那 1 人換掉（你自己不換）就變成打對邊，看合起來剩幾種。換誰：前面的讀法裡最少出現的人，
 * 同樣少就挑順時針離你最遠的（還沒派過票的人）。
 */
function contrastFor(view: SimView, team: readonly number[], readable: readonly ProposalEvent[], pub: Analysis): ReleaseContrast | undefined {
  const teamSet = new Set(team);
  const appearances = new Array<number>(11).fill(0);
  for (const p of readable) for (const s of seatsOfMask(claimMaskOf(p))) appearances[s]++;
  for (const p of readable) {
    const shared = p.teamSeats.filter((s) => teamSet.has(s));
    if (shared.length !== 1 || shared[0] === view.seat) continue;
    const pClaim = claimMaskOf(p);
    const candidates = Array.from({ length: 10 }, (_, i) => i + 1)
      .filter((y) => !teamSet.has(y) && (pClaim & seatBit(y)) === 0 && y !== view.seat);
    if (candidates.length === 0) continue;
    candidates.sort((x, y) => appearances[x] - appearances[y] || ((y - view.seat + 10) % 10) - ((x - view.seat + 10) % 10));
    const alternative = team.map((s) => (s === shared[0] ? candidates[0] : s)).sort((a, b) => a - b);
    const altClaim = maskOf(alternative) | seatBit(view.seat);
    const worlds = pub.claimWorlds(altClaim | pClaim);
    const yourWeight = pub.claimWeight(maskOf(team) | seatBit(view.seat) | pClaim);
    if (worlds.length >= yourWeight) continue;
    return { alternative, proposal: p, weight: worlds.length, worlds: listIfFew(worlds), yourWeight };
  }
  return undefined;
}

// ─── 你的區間 ─────────────────────────────────────────────────────────────

export interface IntervalGroupEval {
  group: IntervalGroup;
  /** 拿掉你自己之後的座位與紅數（好人：紅數不變；紅方：減 1）。 */
  seats: number[];
  min: number;
  max: number;
  self?: 'good' | 'red';
  weight: number;
  contradiction?: 'sight' | 'mission' | 'self';
}

export interface IntervalEval {
  total: number;
  groups: IntervalGroupEval[];
  /** 全部組都成立的世界。 */
  jointWorlds: number[];
  jointWeight: number;
}

function groupHolds(mask: number, seats: readonly number[], min: number, max: number): boolean {
  const k = popcount(mask & maskOf(seats));
  return k >= min && k <= max;
}

export function evaluateInterval(view: SimView, groups: readonly IntervalGroup[], model: SimBeliefModel): IntervalEval {
  const analysis = analyze(model.worlds(view));
  const sightWorlds = enumerateWorlds(sightOnly(view));
  const viewerRed = isRed(view.role);
  const evals: IntervalGroupEval[] = groups.map((g) => {
    let seats = [...g.seats];
    let min = g.min;
    let max = g.max;
    let self: IntervalGroupEval['self'];
    if (seats.includes(view.seat)) {
      seats = seats.filter((s) => s !== view.seat);
      if (viewerRed) { min -= 1; max -= 1; self = 'red'; } else self = 'good';
    }
    if (max < 0 || min > seats.length) return { group: g, seats, min, max, self, weight: 0, contradiction: 'self' };
    min = Math.max(0, min);
    max = Math.min(max, seats.length);
    const weight = analysis.worlds.filter((w) => groupHolds(w.redMask, seats, min, max)).reduce((s, w) => s + w.weight, 0);
    if (weight > 0) return { group: g, seats, min, max, self, weight };
    const bySight = sightWorlds.some((w) => groupHolds(w.redMask, seats, min, max));
    return { group: g, seats, min, max, self, weight, contradiction: bySight ? 'mission' : 'sight' };
  });
  const joint = analysis.worlds.filter((w) => evals.every((e) => e.contradiction === undefined && groupHolds(w.redMask, e.seats, e.min, e.max)));
  return {
    total: analysis.total,
    groups: evals,
    jointWorlds: joint.map((w) => w.redMask),
    jointWeight: joint.reduce((s, w) => s + w.weight, 0),
  };
}

/** 公布時：這一組對不對（用原本寫的座位和紅數，對真正的紅方）。 */
export function intervalGroupTrue(group: IntervalGroup, redMask: number): boolean {
  return groupHolds(redMask, group.seats, group.min, group.max);
}

