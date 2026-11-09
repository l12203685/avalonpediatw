/**
 * 投票的 INFL 特徵（資訊流研究原型 (a)，2026-11-04；docs/ai/infl_research.md）。
 *
 * 現行 `BayesBelief` 讀一張票用的是「格子」：P(贊成 | 投票者陣營, 在不在隊上, 隊上有沒有紅（世界裡的真相）, 回合段)，
 * 再加幾個手工格（關鍵局、紅方在隊上有沒有隊友、鐵咬）。格子不看投票者當時知道什麼：藍方投黑一支有失敗紀錄的隊，
 * 格子把它讀成「這隊有紅的證據」——但那個失敗大家都看得到，任務的概似已經算過一次（重複計算）。
 *
 * 這裡改成「j 的投票函數套在 INFL_t 上」：在假設的世界 w 裡，j 的投票 = f_角色(j 在第 t 次提議時看得到的東西)，
 *   - 基本特徵（不隨 w 變，只隨 j 湖到的結果變）：j 座位的忠臣視角（Certainty 的 L1* 世界均分，或 j 座位的貝氏信念）
 *     裡「這隊乾淨」的機率、隊長／隊員的嫌疑、能不能證明有紅、j 自己出過的失敗任務、鐵咬 j、照派成功的隊、
 *     本局重提、第 4 次提議時強制局隊長的嫌疑、關鍵局、j 之前對同一隊的票、j 湖到的人在不在隊上；
 *   - 角色私訊特徵（隨 w 變）：紅方 j 隊上的隊友數、這隊能不能失敗、在隊上落單；梅林 j 看得到的紅（扣掉莫德雷德）。
 *   - 殘差（模型選用）：隊上有沒有紅（真相）。在有 INFL 特徵之後，它只剩「紀錄以外的資訊」（發言、表情）——量它有多大。
 * 每個角色類別（藍方＝忠臣＋派西、梅林、刺客、莫甘娜、莫德雷德、奧伯倫）各擬合一組邏輯迴歸（`policyModel.ts`）。
 */
import { AVALON_CONFIG, type Role } from '@avalon/shared';
import { buildCertainty } from '../belief/Certainty';
import { missionFailed } from '../missionFacts';
import { bayesRedShare, bayesWorlds, type BayesOptions } from '../belief/BayesBelief';
import {
  bitOf,
  lakeSig,
  lakesBefore,
  maskOf,
  nextLeader,
  popcount,
  questsBefore,
  seatViewObs,
  type Flow,
} from './flow';

export const ROLE_CLASSES = ['blue', 'merlin', 'assassin', 'morgana', 'mordred', 'oberon'] as const;
export type RoleClass = (typeof ROLE_CLASSES)[number];
export const RED_CLASSES: readonly RoleClass[] = ['assassin', 'morgana', 'mordred', 'oberon'];

export function roleClassOf(role: Role): RoleClass {
  if (role === 'merlin' || role === 'assassin' || role === 'morgana' || role === 'mordred' || role === 'oberon') return role;
  return 'blue';
}

export const BASE_FEATURES = [
  'bias', 'on', 'leader', 'r2', 'r3', 'r4', 'r5', 'att2', 'att3', 'att4',
  'pClean', 'logitClean', 'provRed', 'failMembers', 'onFailWithOther', 'bite', 'reuseSuccess', 'repeatRound',
  'tailSusp', 'isTail', 'keyRound', 'blueTwo', 'leaderSusp', 'maxSusp', 'lakeRedOnTeam', 'lakeBlueOnTeam',
  'prevSame', 'on×logitClean', 'on×provRed', 'on×keyRound', 'on×r3+', 'on×maxSusp',
  // j 座位的貝氏信念（`useBayesView`；關掉時為 0）
  'bClean', 'bLogit', 'bLeader', 'bMax', 'on×bLogit',
] as const;
export const EXTRA_FEATURES = ['allies', 'allyAny', 'on×allyAny', 'canFail', 'redAlone', 'seenRed', 'on×seenRed', 'hasRed', 'on×hasRed'] as const;
export const FEATURE_NAMES: readonly string[] = [...BASE_FEATURES, ...EXTRA_FEATURES];
export const N_BASE = BASE_FEATURES.length;
export const N_EXTRA = EXTRA_FEATURES.length;

const clip = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const logit = (p: number): number => clip(Math.log(Math.max(p, 1e-4) / Math.max(1 - p, 1e-4)), -4, 4) / 4;

export interface FlowFeatureOptions {
  /** 加 j 座位的貝氏信念特徵（較貴：每個 (提議, 座位, 湖結果) 一次後驗）。 */
  useBayesView?: boolean;
  /** j 座位貝氏信念用的選項（預設 {}：真人表、不讀梅林層——便宜）。 */
  bayesViewOptions?: BayesOptions;
  /**
   * 第 34 回合：共用「不隨第 i 次隊伍變」的座位視角（鍵 = `i|j|湖結果`）。只能在前 i − 1 次提議完全相同的資訊流之間共用
   * （例：同一個決策點上，各種假想的第 i 次提議）。
   */
  sharedViews?: Map<string, SharedSeatView>;
}

/** 座位視角裡不隨第 i 次隊伍變的部分。 */
export interface SharedSeatView {
  view: ReturnType<typeof buildCertainty>;
  worlds: readonly number[];
  susp: Float64Array;
  bSusp: Float64Array | null;
  bPost: SeatPosterior | null;
}

/** j 座位的貝氏後驗（`useBayesView`）：世界（紅方座位遮罩，和 `flow.bitOf` 相同的位元）與權重——第 33 回合遞迴讀人的派隊讀法用它算每支候選隊的乾淨機率。 */
export interface SeatPosterior { worlds: readonly number[]; wts: readonly number[] }
interface SeatView { pClean: number; provRed: boolean; susp: Float64Array; bClean: number; bSusp: Float64Array | null; bPost: SeatPosterior | null }

/**
 * 一局資訊流的特徵快取：同一局的每個觀察者、每個決策點、每個世界都共用（基本特徵只隨 j 的湖結果變）。
 */
export class FlowFeatures {
  readonly flow: Flow;
  readonly opts: Readonly<FlowFeatureOptions>;
  private readonly views = new Map<string, SeatView>();
  private readonly bases = new Map<string, Float64Array>();
  private readonly teamMasks: number[];
  private readonly failsReq: readonly number[];

  constructor(flow: Flow, opts: FlowFeatureOptions = {}) {
    this.flow = flow;
    this.opts = opts;
    this.teamMasks = flow.votes.map((v) => maskOf(flow, v.team));
    this.failsReq = AVALON_CONFIG[flow.playerCount]?.questFailsRequired ?? [1, 1, 1, 2, 1];
  }

  teamMask(i: number): number { return this.teamMasks[i]; }

  /**
   * 第 26 回合（線上讀票）：從同一局較短的資訊流的快取接手第 0 … upTo − 1 次提議的特徵（那些特徵只看到那次提議為止的紀錄，
   * 資訊流變長也不會變）。呼叫端保證兩個資訊流的前 upTo 次提議相同。
   */
  adoptFrom(other: FlowFeatures, upTo: number): void {
    for (const [src, dst] of [[other.views, this.views], [other.bases, this.bases]] as const) {
      for (const [k, v] of src as Map<string, unknown>) {
        if (Number(k.slice(0, k.indexOf('|'))) < upTo) (dst as Map<string, unknown>).set(k, v);
      }
    }
  }

  /** j 座位在第 i 次提議時的忠臣視角（世界 w 只影響 j 湖到的結果）。 */
  private seatView(i: number, j: string, w: number): SeatView {
    const key = `${i}|${j}|${lakeSig(this.flow, i, j, w)}`;
    const hit = this.views.get(key);
    if (hit) return hit;
    // 不隨第 i 次的隊伍變的部分（確定性層的世界、嫌疑、j 的貝氏後驗）；第 34 回合起可以由 `sharedViews` 在「同一個前綴、不同的假想隊伍」之間共用。
    const shared = this.sharedView(i, j, w, key);
    const { view, worlds, susp } = shared;
    const team = this.teamMasks[i];
    let clean = 0;
    for (const x of worlds) if ((x & team) === 0) clean++;
    const tot = Math.max(1, worlds.length);
    let bClean = 0;
    if (shared.bPost) {
      bClean = 0;
      shared.bPost.worlds.forEach((x, k) => { if ((x & team) === 0) bClean += shared.bPost!.wts[k]; });
      if (shared.bPost.worlds.length === 0) bClean = 0.5;
    }
    const out: SeatView = {
      pClean: worlds.length > 0 ? clean / tot : 0.5,
      provRed: worlds.length > 0 && view.minReds(this.flow.votes[i].team) >= 1,
      susp,
      bClean,
      bSusp: shared.bSusp,
      bPost: shared.bPost,
    };
    this.views.set(key, out);
    return out;
  }

  private sharedView(i: number, j: string, w: number, key: string): SharedSeatView {
    const store = this.opts.sharedViews;
    const hit = store?.get(key);
    if (hit) return hit;
    const obs = seatViewObs(this.flow, i, j, w);
    const view = buildCertainty(obs);
    const worlds = view.worlds('L1*');
    const n = this.flow.ids.length;
    const susp = new Float64Array(n);
    for (const x of worlds) for (let k = 0; k < n; k++) if (x & (1 << k)) susp[k]++;
    const tot = Math.max(1, worlds.length);
    for (let k = 0; k < n; k++) susp[k] /= tot;
    let bSusp: Float64Array | null = null;
    let bPost: SeatPosterior | null = null;
    if (this.opts.useBayesView) {
      const bo = this.opts.bayesViewOptions ?? {};
      const share = bayesRedShare(obs, bo);
      bSusp = new Float64Array(n);
      this.flow.ids.forEach((id, k) => { bSusp![k] = share.get(id) ?? 0.5; });
      const bw = bayesWorlds(obs, bo);
      bPost = { worlds: bw.worlds, wts: bw.wts };
    }
    const out: SharedSeatView = { view, worlds, susp, bSusp, bPost };
    store?.set(key, out);
    return out;
  }

  /**
   * 第 33 回合（遞迴讀人）：j 座位在第 i 次提議之前（公開紀錄到第 i − 1 次提議＋j 在世界 w 裡湖到的結果）的貝氏後驗；
   * 只有 `useBayesView` 開著才有，否則 null。第 i 次提議的隊長派隊時看到的就是這個（後驗不看第 i 次的隊伍）。
   */
  seatPosterior(i: number, j: string, w: number): SeatPosterior | null {
    return this.seatView(i, j, w).bPost;
  }

  /** 基本特徵（長度 N_BASE）：j 在第 i 次提議時、世界 w 裡（只看 j 湖到的結果）。 */
  base(i: number, j: string, w: number): Float64Array {
    const key = `${i}|${j}|${lakeSig(this.flow, i, j, w)}`;
    const hit = this.bases.get(key);
    if (hit) return hit;
    const f = this.flow;
    const v = f.votes[i];
    const ids = f.ids;
    const on = v.team.includes(j);
    const sv = this.seatView(i, j, w);
    const x = new Float64Array(N_BASE);
    const quests = questsBefore(f, v.round);
    // INV-B3: the outcome read goes through missionFacts (the one sanctioned definition).
    const failed = quests.filter((q) => missionFailed(q));
    const succeeded = quests.filter((q) => !missionFailed(q));
    const failedMembers = new Set(failed.flatMap((q) => q.team));
    const teamSet = new Set(v.team);
    const sameSet = (a: readonly string[]): boolean => a.length === v.team.length && a.every((id) => teamSet.has(id));
    let k = 0;
    const put = (val: number): void => { x[k++] = val; };
    put(1);
    put(on ? 1 : 0);
    put(v.leader === j ? 1 : 0);
    for (const r of [2, 3, 4, 5]) put(v.round === r ? 1 : 0);
    for (const a of [2, 3, 4]) put(v.attempt === a ? 1 : 0);
    put(sv.pClean);
    put(logit(sv.pClean));
    put(sv.provRed ? 1 : 0);
    put(Math.min(3, v.team.filter((id) => id !== j && failedMembers.has(id)).length) / 3);
    put(failed.some((q) => q.team.includes(j) && q.team.some((id) => id !== j && teamSet.has(id))) ? 1 : 0);
    const lastFail = failed[failed.length - 1];
    const bitten = lastFail ? lastFail.team.filter((id) => !teamSet.has(id)) : [];
    put(bitten.length === 1 && bitten[0] === j && v.leader !== j ? 1 : 0);
    const lastSuccess = succeeded[succeeded.length - 1];
    put(lastSuccess && sameSet(lastSuccess.team) ? 1 : 0);
    put(f.votes.slice(0, i).some((p) => p.round === v.round && sameSet(p.team)) ? 1 : 0);
    const tail = nextLeader(f, i);
    put(v.attempt === 4 && tail !== j ? sv.susp[ids.indexOf(tail)] : 0);
    put(v.attempt === 4 && tail === j ? 1 : 0);
    const keyRound = failed.length >= 2;
    put(keyRound ? 1 : 0);
    put(succeeded.length >= 2 ? 1 : 0);
    put(v.leader === j ? 0 : sv.susp[ids.indexOf(v.leader)]);
    let maxSusp = 0;
    for (const id of v.team) if (id !== j) maxSusp = Math.max(maxSusp, sv.susp[ids.indexOf(id)]);
    put(maxSusp);
    // j 自己湖到的人（這個世界裡的真相）
    let lakeRed = 0;
    let lakeBlue = 0;
    for (const l of lakesBefore(f, v.round)) {
      if (l.holderId !== j || !teamSet.has(l.targetId)) continue;
      if ((w & bitOf(f, l.targetId)) !== 0) lakeRed = 1; else lakeBlue = 1;
    }
    put(lakeRed);
    put(lakeBlue);
    let prev = 0;
    for (let p = i - 1; p >= 0; p--) {
      const pv = f.votes[p];
      if (pv.attempt >= 5 || !sameSet(pv.team) || pv.votes[j] === undefined) continue;
      prev = pv.votes[j] ? 1 : -1;
      break;
    }
    put(prev);
    put(on ? logit(sv.pClean) : 0);
    put(on && sv.provRed ? 1 : 0);
    put(on && keyRound ? 1 : 0);
    put(on && v.round >= 3 ? 1 : 0);
    put(on ? maxSusp : 0);
    if (sv.bSusp) {
      put(sv.bClean);
      put(logit(sv.bClean));
      put(v.leader === j ? 0 : sv.bSusp[ids.indexOf(v.leader)]);
      let bm = 0;
      for (const id of v.team) if (id !== j) bm = Math.max(bm, sv.bSusp[ids.indexOf(id)]);
      put(bm);
      put(on ? logit(sv.bClean) : 0);
    }
    this.bases.set(key, x);
    return x;
  }

  /**
   * 角色私訊特徵（長度 N_EXTRA）：世界 w、j 的角色類別；梅林要知道哪一個紅是莫德雷德（`mordredBit`，他看不到）。
   */
  extras(i: number, j: string, w: number, cls: RoleClass, mordredBit = 0, out = new Float64Array(N_EXTRA)): Float64Array {
    out.fill(0);
    const team = this.teamMasks[i];
    const jb = bitOf(this.flow, j);
    const on = (team & jb) !== 0;
    if (cls !== 'blue' && cls !== 'merlin') {
      const allies = popcount(w & team & ~jb);
      out[0] = Math.min(2, allies) / 2;
      out[1] = allies > 0 ? 1 : 0;
      out[2] = on && allies > 0 ? 1 : 0;
      out[3] = popcount(w & team) >= (this.failsReq[this.flow.votes[i].round - 1] ?? 1) ? 1 : 0;
      out[4] = on && allies === 0 ? 1 : 0;
    } else if (cls === 'merlin') {
      const seen = (w & team & ~mordredBit) !== 0;
      out[5] = seen ? 1 : 0;
      out[6] = on && seen ? 1 : 0;
    }
    // 殘差（真相）：一律算，模型不用時那兩個係數是 0（`policyModel.featureColumns`）。
    const has = (w & team) !== 0;
    out[7] = has ? 1 : 0;
    out[8] = on && has ? 1 : 0;
    return out;
  }

  /** 完整特徵向量（擬合用）。 */
  full(i: number, j: string, w: number, cls: RoleClass, mordredBit = 0): Float64Array {
    const x = new Float64Array(N_BASE + N_EXTRA);
    x.set(this.base(i, j, w), 0);
    x.set(this.extras(i, j, w, cls, mordredBit), N_BASE);
    return x;
  }

  /** 第 i 次提議有沒有真的投票（不是強制局）。 */
  voted(i: number): boolean { return this.flow.votes[i].attempt < 5; }

  /** 擬合用的可信票（重播局：票數和結果相符）。 */
  reliable(i: number): boolean { return this.voted(i) && (this.flow.reliable?.[i] ?? true); }

  /** j 在第 i 次提議之前的湖在世界 w 裡的結果（快取鍵；第 33 回合的派隊讀法用）。 */
  lakeKey(i: number, j: string, w: number): number { return lakeSig(this.flow, i, j, w); }

  /** 只有在 j 座位的湖會改結果時，基本特徵才隨 w 變。 */
  dependsOnWorld(i: number, j: string): boolean {
    return (lakeSig(this.flow, i, j, 0) >> 8) > 0;
  }
}
