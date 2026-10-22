/**
 * 模擬瓦（2026-10-14）— 「同位置真人」：題庫裡同樣處境的真人怎麼派，純函式。
 *
 * 分組：第 1、2 局用（角色, 局, 座位），第 3 局起用（角色, 局）。比較時把這一局裡你自己的派票
 * 拿掉（2026-10-22 起只拿你自己的：拿掉別的座位的會洩漏他們的角色，見 aggWithout），n 一定印出來，
 * 少於 SIM_HUMAN_SMALL_SAMPLE 註明樣本少。特徵都相對於隊長自己的資訊：
 *   - 有沒有派自己；
 *   - 私人資訊命中：梅林派了幾個看到的紅；派西派了幾根拇指；刺客／莫甘娜／莫德雷德派了幾個隊友；
 *   - 跟上一次派票重疊幾人（照人數分，不再併成「2 人以上」：4、5 人隊伍時那一格會吃掉全部）；
 *   - 第 3 局起：跟上一局任務隊重疊幾人、有沒有派到失敗任務（任務失敗，第 4 局 1 張失敗不算）的人；
 *   - 派法（shape）：含不含自己＋第 1 局跟上一次派票的關係（延伸／部分／打對邊）、第 2 局起跟上一局
 *     任務隊的關係（N+1／外撒／拆車／全換／原隊）。拿來比「梅林／好人／紅方」誰比較常這樣派——
 *     Avalon.md 的 r1/r2/r3 平衡：三方差不多就不漏角色。
 */

import type { Role } from '@avalon/shared';
import { sightFor, sightSeats, type SimGame } from './scenario';
import { maskOf, seatBit } from './seats';

export interface ProposalFeatures {
  self: boolean;
  /** 私人資訊命中幾個；忠臣、奧伯倫沒有這一項（null）。 */
  hits: number | null;
  /** 跟上一次派票（整局的上一次）重疊幾人；整局第一次是 null。 */
  prevOverlap: number | null;
  /** 第 3 局起：跟上一局任務隊重疊幾人。 */
  missionOverlap: number | null;
  /** 第 3 局起、之前有失敗的任務：有沒有派到那些任務隊的人。 */
  failedMember: boolean | null;
  /** 派法（見檔頭），例如 `1|打對邊`、`0|拆車`、`1|-`。 */
  shape: string;
}

/** 重疊人數的格數（0…5 人）。 */
export const OVERLAP_BUCKETS = 6;

export interface HumanAgg {
  n: number;
  self: number;
  /** hits[k] = 命中 k 個的次數。 */
  hits: number[];
  hitsN: number;
  /** prev[k] = 跟上一次重疊 k 人。 */
  prev: number[];
  prevN: number;
  mission: number[];
  missionN: number;
  failed: number;
  failedN: number;
  /** 派法 → 次數。 */
  shapes: Record<string, number>;
}

export function emptyAgg(): HumanAgg {
  return {
    n: 0,
    self: 0,
    hits: [0, 0, 0, 0, 0, 0],
    hitsN: 0,
    prev: new Array<number>(OVERLAP_BUCKETS).fill(0),
    prevN: 0,
    mission: new Array<number>(OVERLAP_BUCKETS).fill(0),
    missionN: 0,
    failed: 0,
    failedN: 0,
    shapes: {},
  };
}

export function aggKey(role: Role, round: number, seat: number): string {
  return round <= 2 ? `${role}|${round}|${seat}` : `${role}|${round}`;
}

/** 隊長有私人資訊可以「命中」的角色。 */
export function hasHits(role: Role): boolean {
  return role === 'merlin' || role === 'percival' || role === 'assassin' || role === 'morgana' || role === 'mordred';
}

function overlap(a: readonly number[], b: readonly number[]): number {
  const s = new Set(b);
  return a.filter((x) => s.has(x)).length;
}

function claimOverlap(aLeader: number, aTeam: readonly number[], bLeader: number, bTeam: readonly number[]): number {
  const a = maskOf(aTeam) | seatBit(aLeader);
  const b = maskOf(bTeam) | seatBit(bLeader);
  let k = 0;
  for (let x = a & b; x; x &= x - 1) k++;
  return k;
}

/** 派法的關係那一段（見檔頭）。 */
export function shapeRelation(game: SimGame, proposalIndex: number, seats: readonly number[]): string {
  const p = game.proposals[proposalIndex];
  if (p.round === 1) {
    if (proposalIndex === 0) return '-';
    const q = game.proposals[proposalIndex - 1];
    const k = claimOverlap(p.leaderSeat, seats, q.leaderSeat, q.teamSeats);
    return k >= 2 ? '延伸' : k === 1 ? '部分' : '打對邊';
  }
  const m = game.quests.find((x) => x.round === p.round - 1);
  if (!m) return '-';
  const kept = m.teamSeats.filter((s) => seats.includes(s));
  if (kept.length === m.teamSeats.length) {
    const extra = seats.filter((s) => !m.teamSeats.includes(s));
    if (extra.length === 0) return '原隊';
    return extra.length === 1 && extra[0] === p.leaderSeat ? 'N+1' : '外撒';
  }
  return kept.length > 0 ? '拆車' : '全換';
}

export function shapeOf(self: boolean, relation: string): string {
  return `${self ? 1 : 0}|${relation}`;
}

/** 一局每一家看得到的座位（載入題庫時每次派票都要用，算一次就好）。 */
const SIGHT_CACHE = new WeakMap<SimGame, number[][]>();

function sightSeatsOf(game: SimGame, seat: number): number[] {
  let seats = SIGHT_CACHE.get(game);
  if (!seats) {
    seats = Array.from({ length: 10 }, (_, i) => sightSeats(sightFor(game, i + 1)));
    SIGHT_CACHE.set(game, seats);
  }
  return seats[seat - 1];
}

/**
 * proposals[proposalIndex] 這次派票的特徵；`team` 給了就用它（玩家的答案），
 * 沒給就用真人實際的隊伍。
 */
export function proposalFeatures(game: SimGame, proposalIndex: number, team?: readonly number[]): ProposalFeatures {
  const p = game.proposals[proposalIndex];
  const seats = team ?? p.teamSeats;
  const role = game.seatRoles[p.leaderSeat - 1];
  const hits = hasHits(role) ? overlap(seats, sightSeatsOf(game, p.leaderSeat)) : null;
  const prevOverlap = proposalIndex > 0 ? overlap(seats, game.proposals[proposalIndex - 1].teamSeats) : null;
  let missionOverlap: number | null = null;
  let failedMember: boolean | null = null;
  if (p.round >= 3) {
    const lastMission = game.quests.find((q) => q.round === p.round - 1);
    if (lastMission) missionOverlap = overlap(seats, lastMission.teamSeats);
    const failedSeats = new Set(game.quests.filter((q) => q.round < p.round && q.failed).flatMap((q) => q.teamSeats));
    if (failedSeats.size > 0) failedMember = seats.some((s) => failedSeats.has(s));
  }
  const self = seats.includes(p.leaderSeat);
  return { self, hits, prevOverlap, missionOverlap, failedMember, shape: shapeOf(self, shapeRelation(game, proposalIndex, seats)) };
}

export function addFeatures(agg: HumanAgg, f: ProposalFeatures, sign: 1 | -1 = 1): void {
  agg.n += sign;
  if (f.self) agg.self += sign;
  if (f.hits !== null) {
    agg.hits[Math.min(f.hits, agg.hits.length - 1)] += sign;
    agg.hitsN += sign;
  }
  if (f.prevOverlap !== null) {
    agg.prev[Math.min(f.prevOverlap, OVERLAP_BUCKETS - 1)] += sign;
    agg.prevN += sign;
  }
  if (f.missionOverlap !== null) {
    agg.mission[Math.min(f.missionOverlap, OVERLAP_BUCKETS - 1)] += sign;
    agg.missionN += sign;
  }
  if (f.failedMember !== null) {
    if (f.failedMember) agg.failed += sign;
    agg.failedN += sign;
  }
  agg.shapes[f.shape] = (agg.shapes[f.shape] ?? 0) + sign;
}

function keyOf(game: SimGame, proposalIndex: number): string {
  const p = game.proposals[proposalIndex];
  return aggKey(game.seatRoles[p.leaderSeat - 1], p.round, p.leaderSeat);
}

/** 一局的每一次派票加進統計（載入題庫時一局一局做，可以分段讓出 CPU）。 */
export function addGameToAggregates(out: Map<string, HumanAgg>, g: SimGame): void {
  for (const p of g.proposals) {
    const key = keyOf(g, p.globalIndex);
    let agg = out.get(key);
    if (!agg) { agg = emptyAgg(); out.set(key, agg); }
    addFeatures(agg, proposalFeatures(g, p.globalIndex));
  }
}

/** 整個題庫的真人統計（載入時算一次）。 */
export function buildHumanAggregates(games: readonly SimGame[]): Map<string, HumanAgg> {
  const out = new Map<string, HumanAgg>();
  for (const g of games) addGameToAggregates(out, g);
  return out;
}

function copyAgg(base: HumanAgg): HumanAgg {
  return { ...base, hits: [...base.hits], prev: [...base.prev], mission: [...base.mission], shapes: { ...base.shapes } };
}

/**
 * `key` 這一組，扣掉這一局裡**你自己（viewerSeat）**的派票。
 *
 * 2026-10-22 審查修正（main 上就有的洩漏）：以前扣掉這一局裡落在這一組的**每一次**派票，包括別的座位
 * （角色還沒公布）的派票。第 3 局起的組不分座位，所以印出來的次數 = 整個題庫的總數 − 這一局這一局數
 * 同角色隊長的派票數；公布過一題就算得出總數，之後每一題都等於在 /公布 前告訴你這一局有幾個隊長跟你同角色。
 * 現在只扣你自己的派票（你知道自己的角色、座位是公開的），其他座位的照樣留在統計裡：
 * ② 只看得到公開資訊和你自己的資訊。
 */
function aggWithout(aggs: ReadonlyMap<string, HumanAgg>, key: string, game: SimGame, viewerSeat: number): HumanAgg {
  const agg = copyAgg(aggs.get(key) ?? emptyAgg());
  for (const p of game.proposals) {
    if (p.leaderSeat === viewerSeat && keyOf(game, p.globalIndex) === key) addFeatures(agg, proposalFeatures(game, p.globalIndex), -1);
  }
  return agg;
}

/** 這一題要比較的真人：同一組，扣掉這一局裡你自己的派票（見 aggWithout）。 */
export function humanAggFor(aggs: ReadonlyMap<string, HumanAgg>, game: SimGame, proposalIndex: number): { key: string; agg: HumanAgg } {
  const key = keyOf(game, proposalIndex);
  return { key, agg: aggWithout(aggs, key, game, game.proposals[proposalIndex].leaderSeat) };
}

/** 角色的陣營（Avalon.md：r1 梅林、r2 壞人、r3 好人＋派西）。 */
export type Camp = 'merlin' | 'good' | 'red';
export const CAMP_ROLES: Readonly<Record<Camp, readonly Role[]>> = {
  merlin: ['merlin'],
  good: ['loyal', 'percival'],
  red: ['assassin', 'morgana', 'mordred', 'oberon'],
};

export interface CampShare {
  camp: Camp;
  /** 同樣處境這個陣營的派票數。 */
  n: number;
  /** 其中跟你同一個派法的。 */
  same: number;
}

/**
 * 「這樣派會不會漏角色」：同樣處境（同一局、第 1、2 局再加同座位）的梅林／好人／紅方，
 * 各有多少比例派出跟你同一個派法。只扣這一局裡你自己的派票（只會落在你自己角色那一組；見 aggWithout）。
 */
export function campShares(aggs: ReadonlyMap<string, HumanAgg>, game: SimGame, proposalIndex: number, shape: string): CampShare[] {
  const p = game.proposals[proposalIndex];
  return (Object.keys(CAMP_ROLES) as Camp[]).map((camp) => {
    let n = 0;
    let same = 0;
    for (const role of CAMP_ROLES[camp]) {
      const agg = aggWithout(aggs, aggKey(role, p.round, p.leaderSeat), game, p.leaderSeat);
      n += agg.n;
      same += agg.shapes[shape] ?? 0;
    }
    return { camp, n, same };
  });
}
