/**
 * 模擬瓦（2026-10-14）— 「同位置真人」：題庫裡同樣處境的真人怎麼派，純函式。
 *
 * 分組：第 1、2 局用（角色, 局, 座位），第 3 局起用（角色, 局）。比較時把這一題這一局
 * 本身拿掉，n 一定印出來，少於 SIM_HUMAN_SMALL_SAMPLE 註明樣本少。特徵都相對於隊長自己的資訊：
 *   - 有沒有派自己；
 *   - 私人資訊命中：梅林派了幾個看到的紅；派西派了幾根拇指；刺客／莫甘娜／莫德雷德派了幾個隊友；
 *   - 跟上一次派票重疊幾人（0 / 1 / 2 以上）；
 *   - 第 3 局起：跟上一局任務隊重疊幾人、有沒有派到失敗任務的人（之前沒有失敗任務就不算）。
 */

import type { Role } from '@avalon/shared';
import { sightFor, sightSeats, type SimGame } from './scenario';

export interface ProposalFeatures {
  self: boolean;
  /** 私人資訊命中幾個；忠臣、奧伯倫沒有這一項（null）。 */
  hits: number | null;
  /** 跟上一次派票（整局的上一次）重疊幾人；整局第一次是 null。 */
  prevOverlap: number | null;
  /** 第 3 局起：跟上一局任務隊重疊幾人。 */
  missionOverlap: number | null;
  /** 第 3 局起、之前有失敗任務：有沒有派到失敗任務的人。 */
  failedMember: boolean | null;
}

export interface HumanAgg {
  n: number;
  self: number;
  /** hits[k] = 命中 k 個的次數。 */
  hits: number[];
  hitsN: number;
  /** prev[0|1|2] = 重疊 0 / 1 / 2 人以上。 */
  prev: number[];
  prevN: number;
  mission: number[];
  missionN: number;
  failed: number;
  failedN: number;
}

export function emptyAgg(): HumanAgg {
  return { n: 0, self: 0, hits: [0, 0, 0, 0, 0, 0], hitsN: 0, prev: [0, 0, 0], prevN: 0, mission: [0, 0, 0], missionN: 0, failed: 0, failedN: 0 };
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

/**
 * proposals[proposalIndex] 這次派票的特徵；`team` 給了就用它（玩家的答案），
 * 沒給就用真人實際的隊伍。
 */
export function proposalFeatures(game: SimGame, proposalIndex: number, team?: readonly number[]): ProposalFeatures {
  const p = game.proposals[proposalIndex];
  const seats = team ?? p.teamSeats;
  const role = game.seatRoles[p.leaderSeat - 1];
  const hits = hasHits(role) ? overlap(seats, sightSeats(sightFor(game, p.leaderSeat))) : null;
  const prevOverlap = proposalIndex > 0 ? overlap(seats, game.proposals[proposalIndex - 1].teamSeats) : null;
  let missionOverlap: number | null = null;
  let failedMember: boolean | null = null;
  if (p.round >= 3) {
    const lastMission = game.quests.find((q) => q.round === p.round - 1);
    if (lastMission) missionOverlap = overlap(seats, lastMission.teamSeats);
    const failedSeats = new Set(game.quests.filter((q) => q.round < p.round && q.failCount > 0).flatMap((q) => q.teamSeats));
    if (failedSeats.size > 0) failedMember = seats.some((s) => failedSeats.has(s));
  }
  return { self: seats.includes(p.leaderSeat), hits, prevOverlap, missionOverlap, failedMember };
}

function bucket3(k: number): number {
  return k >= 2 ? 2 : k;
}

export function addFeatures(agg: HumanAgg, f: ProposalFeatures, sign: 1 | -1 = 1): void {
  agg.n += sign;
  if (f.self) agg.self += sign;
  if (f.hits !== null) {
    agg.hits[Math.min(f.hits, agg.hits.length - 1)] += sign;
    agg.hitsN += sign;
  }
  if (f.prevOverlap !== null) {
    agg.prev[bucket3(f.prevOverlap)] += sign;
    agg.prevN += sign;
  }
  if (f.missionOverlap !== null) {
    agg.mission[bucket3(f.missionOverlap)] += sign;
    agg.missionN += sign;
  }
  if (f.failedMember !== null) {
    if (f.failedMember) agg.failed += sign;
    agg.failedN += sign;
  }
}

function keyOf(game: SimGame, proposalIndex: number): string {
  const p = game.proposals[proposalIndex];
  return aggKey(game.seatRoles[p.leaderSeat - 1], p.round, p.leaderSeat);
}

/** 整個題庫的真人統計（載入時算一次）。 */
export function buildHumanAggregates(games: readonly SimGame[]): Map<string, HumanAgg> {
  const out = new Map<string, HumanAgg>();
  for (const g of games) {
    for (const p of g.proposals) {
      const key = keyOf(g, p.globalIndex);
      let agg = out.get(key);
      if (!agg) { agg = emptyAgg(); out.set(key, agg); }
      addFeatures(agg, proposalFeatures(g, p.globalIndex));
    }
  }
  return out;
}

/** 這一題要比較的真人：同一組，扣掉這一局本身。 */
export function humanAggFor(aggs: ReadonlyMap<string, HumanAgg>, game: SimGame, proposalIndex: number): { key: string; agg: HumanAgg } {
  const key = keyOf(game, proposalIndex);
  const base = aggs.get(key) ?? emptyAgg();
  const agg: HumanAgg = { ...base, hits: [...base.hits], prev: [...base.prev], mission: [...base.mission] };
  for (const p of game.proposals) {
    if (keyOf(game, p.globalIndex) === key) addFeatures(agg, proposalFeatures(game, p.globalIndex), -1);
  }
  return { key, agg };
}
