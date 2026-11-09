/**
 * 第 33 回合：遞迴讀人（第 1 層；`BayesOptions.recursive`，`AgentTuning.beliefRecursive`，預設關）。docs/ai/infl_research.md 第 8 節。
 *
 * Edward 2026-11-09：「我說的資訊流遞迴調整與修正怎麼好像還沒做到?」——讀 j 的每一個動作，要把它讀成 j 自己的決策函數的輸出：
 * 輸入是 j 在那一刻的資訊流（公開紀錄的前綴）加上 j 在每個假設世界裡的私訊；而且解讀要沿著歷史一層一層傳下去：前面的動作怎麼讀，
 * 會改變後面的動作怎麼讀。
 *
 * 做法（第 1 層）：對每一次提議 i、每個座位 j、每個世界 w——
 *   1. j 自己的信念 = 第 0 層的後驗（現行的貝氏後驗：強者表、取次方、忠臣的梅林層），站在 j 的座位、只用第 i 次提議之前的公開紀錄
 *      ＋ j 在 w 裡湖到的結果（`FlowFeatures.seatPosterior`；快取在 (i, j, j 的湖結果)，同一局只會往後長，過去的提議不重算）。
 *      第 0 層的後驗本身就讀了第 i 次之前所有人的票與派隊，所以 j 在第 i 次的信念已經吃進了前面每一個動作的解讀——這就是「遞迴」：
 *      前面的動作改變 j 的信念，j 的信念改變我們怎麼讀 j 在第 i 次的動作。
 *   2. 角色的私訊隨 w 變：紅方 j 知道隊友（隊上幾個隊友、這隊能不能失敗）；梅林 j 看得到除了莫德雷德以外的紅（投票的梅林類別）；
 *      忠臣／派西 j 只有自己的湖（已經在步驟 1 的後驗裡）。
 *   3. 動作的機率 = j 的決策函數在這些輸入下產生這個動作的機率：
 *      - 投票：以策略為本的讀票模型（`policyModel.ts`，邏輯迴歸，每個角色類別一組），特徵加上「j 自己後驗」的四個欄位
 *        （這隊乾淨的機率、logit、隊長嫌疑、隊員最高嫌疑；`voteFeatures.ts` 的 b* 欄），用強者分面的票擬合、向全體真人收縮；
 *      - 派隊：條件 logit——P(隊伍 T | 隊長角色類別, w) ∝ exp(θ·φ(T))，在所有同樣人數的隊上正規化（10 人局最多 C(10, 5) = 252 隊）；
 *        φ = log P_j(T 乾淨)（j 自己的後驗）、j 在不在隊上、照派（整支最近一次成功的任務都在隊上）；紅方隊長再加隊上幾個隊友、這隊能不能失敗（w 裡的真相）。
 *        藍方隊長的機率不隨 w 變（只隨他的湖）：他只能照自己看到的派，所以一支藍隊長派的隊不再替隊上的人加減分，只在「隊長是藍還是紅」上有資訊
 *        （資訊流研究第 1.2 節的重複計算）。
 *   4. 這個機率當成後驗裡那個動作的概似（取代票格與派隊格；取次方照舊）。
 *
 * 遞迴只到第 1 層：j 的信念用第 0 層（不再用第 1 層讀別人），所以不會無限遞迴；第 2 層＝j 的信念也用第 1 層，成本乘上座位數。
 */
import { AVALON_CONFIG, type Role } from '@avalon/shared';
import type { PlayerObservation } from '../types';
import type { BayesOptions } from '../belief/BayesBelief';
import { missionFailed } from '../missionFacts';
import { bitOf, flowOfObs, maskOf, popcount, questsBefore, type Flow } from './flow';
import { FEATURE_NAMES, FlowFeatures, N_BASE, N_EXTRA, ROLE_CLASSES, type RoleClass } from './voteFeatures';
import { P_CLIP, PolicyVoteReader, type PolicyModel } from './policyModel';
import { sigmoid } from './logistic';
import MODEL from './recursive_strong.json';

// 熱迴圈裡用的常數取成區域常數（匯出的常數經過模組的 getter，每次讀都要一次函數呼叫）。
const NB = N_BASE;
const NX = N_EXTRA;

// ── 派隊的條件 logit ─────────────────────────────────────────────

/**
 * 第 33 回合的三類（藍＝忠臣＋派西、紅、奧伯倫）＋第 34 回合的角色混合（Edward 11/09「每個角色的視角分開讀」）：忠臣、派西、梅林分開
 * （`loyal`、`percival`、`merlin`；紅方仍是 `evil`／`oberon`）。
 */
export const PROPOSAL_CLASSES = ['blue', 'evil', 'oberon', 'loyal', 'percival', 'merlin', 'loyalF', 'percivalF', 'merlinF', 'evilF', 'oberonF'] as const;
export type ProposalClass = (typeof PROPOSAL_CLASSES)[number];
/**
 * 前 3 個是公開（j 自己後驗）的特徵；allies1／allies2／canFail 是紅方隊長的私訊（w 裡的真相）；seen1／seen2 是梅林看得到的紅（莫德雷德以外、
 * 隊長自己以外）在隊上 1／≥ 2 個；thumb1／thumb2 是派西的拇指（梅林＋莫甘娜）在隊上 1／2 根。不屬於那個類別的欄係數是 0。
 */
export const PROPOSAL_FEATURES = [
  'logClean', 'selfOn', 'reuse', 'allies1', 'allies2', 'canFail', 'seen1', 'seen2', 'thumb1', 'thumb2',
  // 第 34 回合（Edward 11/09「後面的提議讓前面的提議有意義」；定義照百科〈解讀前人派票 - 延伸、修正、尊重…〉）：相對於同一局前面的提議
  'extendPrev', 'correctPrev', 'oppositeAll', 'sameEarlier', 'tailIn', 'lakeIn',
] as const;
/** 每個派隊類別用到的欄（…F = 同一個角色再加資訊流的六欄，`beliefRecursive=5`）。 */
const FLOW_COLS = [10, 11, 12, 13, 14, 15] as const;
const N_FLOW = FLOW_COLS.length;
export const PROPOSAL_COLS: Record<ProposalClass, readonly number[]> = {
  blue: [0, 1, 2], loyal: [0, 1, 2], oberon: [0, 1, 2], evil: [0, 1, 2, 3, 4, 5], merlin: [0, 1, 2, 6, 7], percival: [0, 1, 2, 8, 9],
  loyalF: [0, 1, 2, ...FLOW_COLS], oberonF: [0, 1, 2, ...FLOW_COLS], evilF: [0, 1, 2, 3, 4, 5, ...FLOW_COLS],
  merlinF: [0, 1, 2, 6, 7, ...FLOW_COLS], percivalF: [0, 1, 2, 8, 9, ...FLOW_COLS],
};
/** 角色混合的派隊類別（`flow` = 用資訊流特徵的那一組）。 */
export function mixClass(base: 'loyal' | 'percival' | 'merlin' | 'evil' | 'oberon', flow: boolean): ProposalClass {
  return (flow ? `${base}F` : base) as ProposalClass;
}
export const N_PROP = PROPOSAL_FEATURES.length;
/** log P(乾淨) 的下限（一支隊在 j 的後驗裡不可能乾淨時，條件 logit 仍然有限）。 */
const LOG_FLOOR = Math.log(1e-4);

/** 派隊模型的角色類別：忠臣／派西 → 藍；刺客、莫甘娜、莫德雷德（知道隊友）→ 紅；奧伯倫（不知道隊友）自己一類；梅林不擬合（線上當藍讀，梅林層另外讀）。 */
export function proposalClassOf(role: Role): ProposalClass | null {
  if (role === 'loyal' || role === 'percival') return 'blue';
  if (role === 'assassin' || role === 'morgana' || role === 'mordred' || role === 'minion') return 'evil';
  if (role === 'oberon') return 'oberon';
  return null;
}

/** 第 34 回合的角色混合：每個角色各自的派隊類別。 */
export function mixProposalClassOf(role: Role): 'loyal' | 'percival' | 'merlin' | 'evil' | 'oberon' | null {
  if (role === 'loyal') return 'loyal';
  if (role === 'percival') return 'percival';
  if (role === 'merlin') return 'merlin';
  const c = proposalClassOf(role);
  return c === 'evil' || c === 'oberon' ? c : null;
}

const teamCache = new Map<string, Int32Array>();
/** n 人裡挑 k 人的所有隊（位元遮罩）。 */
export function allTeams(n: number, k: number): Int32Array {
  const key = `${n}|${k}`;
  let t = teamCache.get(key);
  if (t) return t;
  const out: number[] = [];
  const rec = (start: number, mask: number, left: number): void => {
    if (left === 0) { out.push(mask); return; }
    for (let s = start; s <= n - left; s++) rec(s + 1, mask | (1 << s), left - 1);
  };
  rec(0, 0, k);
  t = Int32Array.from(out);
  teamCache.set(key, t);
  return t;
}

/** 一次提議、隊長 j、j 的湖結果之下，每支候選隊的公開特徵（不隨 w 變）。 */
export interface ProposalCandidates {
  teams: Int32Array;
  /** 觀察到的那支隊在 `teams` 裡的位置。 */
  chosen: number;
  logClean: Float64Array;
  selfOn: Uint8Array;
  reuse: Uint8Array;
  /**
   * 第 34 回合的資訊流特徵（每支隊；百科〈解讀前人派票〉的定義）：相對於同一局上一個（別人的）提議 P，隊長以外——
   * 延伸（認同 P 的隊伍資訊：P 裡隊長以外的人留下至少兩個）、修正（反對：P 裡隊長以外的人一個都不留）、其餘＝尊重（基準）；
   * 和這一局前面所有提議完全相反（前面派過的人一個都不留，例：168 之後 279）；和這一局前面某個提議一模一樣（照派）；
   * 強制局隊長（尾家）在隊上；現在的持湖者在隊上（旁因：給尾家更多資訊、先不派持湖者）。
   */
  flow: Float32Array[];
  leaderBit: number;
  failsRequired: number;
}

/** 第 i 次提議的候選隊與公開特徵；隊長的後驗沒有（`useBayesView` 關）時 null。 */
export function proposalCandidates(ff: FlowFeatures, i: number, w: number): ProposalCandidates | null {
  const flow = ff.flow;
  const v = flow.votes[i];
  const post = ff.seatPosterior(i, v.leader, w);
  if (!post || post.worlds.length === 0) return null;
  const n = flow.ids.length;
  const teams = allTeams(n, v.team.length);
  const chosenMask = maskOf(flow, v.team);
  const leaderBit = bitOf(flow, v.leader);
  const logClean = new Float64Array(teams.length);
  const selfOn = new Uint8Array(teams.length);
  const reuse = new Uint8Array(teams.length);
  // 最近一次成功的任務（第 i 次提議那一局之前）：照派＝整支隊都留下（人數相同就是同一支隊；人數多就是那一隊＋別人）。
  // INV-B3: the outcome read goes through missionFacts (the one sanctioned definition).
  const done = questsBefore(flow, v.round).filter((q) => !missionFailed(q));
  const last = done[done.length - 1];
  const lastMask = last ? maskOf(flow, last.team) : -1;
  let chosen = -1;
  for (let t = 0; t < teams.length; t++) {
    const m = teams[t];
    let c = 0;
    for (let x = 0; x < post.worlds.length; x++) if ((post.worlds[x] & m) === 0) c += post.wts[x];
    logClean[t] = c > 1e-4 ? Math.log(c) : LOG_FLOOR;
    selfOn[t] = (m & leaderBit) !== 0 ? 1 : 0;
    reuse[t] = lastMask > 0 && (m & lastMask) === lastMask ? 1 : 0;
    if (m === chosenMask) chosen = t;
  }
  if (chosen < 0) return null;
  const req = AVALON_CONFIG[flow.playerCount]?.questFailsRequired?.[v.round - 1] ?? 1;
  // 資訊流：同一局前面的提議（Edward 11/09：後面的人把前面的提議延伸、修正或尊重；百科〈解讀前人派票〉）。
  const earlier = flow.votes.slice(0, i).filter((p) => p.round === v.round);
  const prevs = earlier.filter((p) => p.leader !== v.leader);
  const prev = prevs[prevs.length - 1];
  const prevMask = prev ? maskOf(flow, prev.team) & ~leaderBit : 0;
  let seenMask = 0;
  for (const p of earlier) seenMask |= maskOf(flow, p.team);
  seenMask &= ~leaderBit;
  const earlierMasks = new Set(earlier.map((p) => maskOf(flow, p.team)));
  const firstLeader = flow.votes.find((p) => p.round === v.round)?.leader ?? v.leader;
  const ids = flow.ids;
  const tail = ids[(ids.indexOf(firstLeader) + 4) % ids.length];
  const tailBit = tail !== v.leader ? bitOf(flow, tail) : 0;
  // 現在的持湖者：最近一次湖的被湖者（湖交給他），第 2 局起。
  const lakes = flow.lakes.filter((l) => l.round < v.round);
  const lakeHolder = lakes.length > 0 ? lakes[lakes.length - 1].targetId : null;
  const lakeBit = lakeHolder && lakeHolder !== v.leader ? bitOf(flow, lakeHolder) : 0;
  const fl = Array.from({ length: N_FLOW }, () => new Float32Array(teams.length));
  for (let t = 0; t < teams.length; t++) {
    const m = teams[t] & ~leaderBit;
    if (prev) {
      const inP = popcount(m & prevMask);
      fl[0][t] = inP >= 2 ? 1 : 0;
      fl[1][t] = inP === 0 ? 1 : 0;
    }
    if (seenMask !== 0) fl[2][t] = (m & seenMask) === 0 ? 1 : 0;
    fl[3][t] = earlierMasks.has(teams[t]) ? 1 : 0;
    fl[4][t] = (teams[t] & tailBit) !== 0 ? 1 : 0;
    fl[5][t] = (teams[t] & lakeBit) !== 0 ? 1 : 0;
  }
  return { teams, chosen, logClean, selfOn, reuse, flow: fl, leaderBit, failsRequired: req };
}

/**
 * 一支隊的完整特徵（擬合用；`out` 長度 N_PROP）。紅方隊長的私訊欄只在 `cls === 'evil'` 時填；梅林的欄要知道哪一個紅是莫德雷德（`mordredBit`，
 * 他看不到），派西的欄要知道兩根拇指（`thumbMask` = 梅林＋莫甘娜的座位）。
 */
export function proposalFeatures(c: ProposalCandidates, t: number, w: number, cls: ProposalClass, out: Float64Array, mordredBit = 0, thumbMask = 0): Float64Array {
  out.fill(0);
  out[0] = c.logClean[t];
  out[1] = c.selfOn[t];
  out[2] = c.reuse[t];
  const flowCls = cls.endsWith('F');
  if (flowCls) for (let k = 0; k < N_FLOW; k++) out[10 + k] = c.flow[k][t];
  const base = flowCls ? cls.slice(0, -1) : cls;
  if (base === 'merlin') {
    const seen = popcount(w & c.teams[t] & ~mordredBit & ~c.leaderBit);
    out[6] = seen === 1 ? 1 : 0;
    out[7] = seen >= 2 ? 1 : 0;
  } else if (base === 'percival') {
    const th = popcount(thumbMask & c.teams[t] & ~c.leaderBit);
    out[8] = th === 1 ? 1 : 0;
    out[9] = th >= 2 ? 1 : 0;
  } else if (base === 'evil') {
    const m = c.teams[t];
    const allies = popcount(w & m & ~c.leaderBit);
    out[3] = allies === 1 ? 1 : 0;
    out[4] = allies >= 2 ? 1 : 0;
    out[5] = popcount(w & m) >= c.failsRequired ? 1 : 0;
  }
  return out;
}

function logSumExp(xs: Float64Array, n: number): number {
  let mx = -Infinity;
  for (let k = 0; k < n; k++) if (xs[k] > mx) mx = xs[k];
  let s = 0;
  for (let k = 0; k < n; k++) s += Math.exp(xs[k] - mx);
  return mx + Math.log(s);
}

/** log P(觀察到的隊 | 類別, w)。 */
export function proposalLogProb(beta: Float64Array, c: ProposalCandidates, w: number, cls: ProposalClass, scratch: Float64Array, mordredBit = 0, thumbMask = 0): number {
  const x = new Float64Array(N_PROP);
  const n = c.teams.length;
  for (let t = 0; t < n; t++) {
    proposalFeatures(c, t, w, cls, x, mordredBit, thumbMask);
    let z = 0;
    for (let k = 0; k < N_PROP; k++) z += beta[k] * x[k];
    scratch[t] = z;
  }
  return scratch[c.chosen] - logSumExp(scratch, n);
}

export interface ProposalModel { beta: Record<ProposalClass, Float64Array> }

/** 一局資訊流上的派隊讀法（快取在 (提議, 隊長的湖結果) 與 (提議, w)）。 */
export class RecursiveProposalReader {
  private readonly cands = new Map<string, ProposalCandidates | null>();
  private readonly fixed = new Map<string, number>();
  private readonly byWorld = new Map<string, number>();
  private scratch = new Float64Array(256);

  constructor(readonly model: ProposalModel, readonly features: FlowFeatures) {}

  private candidates(i: number, w: number): ProposalCandidates | null {
    const v = this.features.flow.votes[i];
    const key = `${i}|${this.features.lakeKey(i, v.leader, w)}`;
    if (this.cands.has(key)) return this.cands.get(key)!;
    const c = proposalCandidates(this.features, i, w);
    this.cands.set(key, c);
    return c;
  }

  /** log P(第 i 次提議 | 隊長在 w 裡的類別)。藍方／奧伯倫只隨隊長的湖變，紅方隨 w 變。null = 讀不到（沒有後驗）。 */
  logProb(i: number, w: number, cls: ProposalClass): number | null {
    const c = this.candidates(i, w);
    if (!c) return null;
    if (this.scratch.length < c.teams.length) this.scratch = new Float64Array(c.teams.length);
    const v = this.features.flow.votes[i];
    const key = cls === 'evil' ? `${i}|${w}` : `${i}|${cls}|${this.features.lakeKey(i, v.leader, w)}`;
    const store = cls === 'evil' ? this.byWorld : this.fixed;
    let lp = store.get(key);
    if (lp === undefined) {
      lp = proposalLogProb(this.model.beta[cls], c, w, cls, this.scratch);
      store.set(key, lp);
    }
    return lp;
  }

  /**
   * 世界 w 裡，前 `upTo` 次提議（觀察者自己的、`skip` 的隊長的不讀）的派隊概似（log）。紅方隊長：3/4 知道隊友（刺客、莫甘娜、莫德雷德）、
   * 1/4 奧伯倫（標準 10 人局四紅一個奧伯倫；逐次混合，不和投票的角色排列綁在一起）。
   */
  worldLog(viewer: string, upTo: number, w: number, skip: (leader: string) => boolean): number {
    const flow = this.features.flow;
    let lp = 0;
    for (let i = 0; i < upTo; i++) {
      const v = flow.votes[i];
      if (v.leader === viewer || skip(v.leader)) continue;
      const red = (w & bitOf(flow, v.leader)) !== 0;
      if (!red) {
        const b = this.logProb(i, w, 'blue');
        if (b !== null) lp += b;
        continue;
      }
      const e = this.logProb(i, w, 'evil');
      const o = this.logProb(i, w, 'oberon');
      if (e === null || o === null) continue;
      const mx = Math.max(e, o);
      lp += mx + Math.log(0.75 * Math.exp(e - mx) + 0.25 * Math.exp(o - mx));
    }
    return lp;
  }
}


// ── 第 34 回合：角色混合讀人（`beliefRecursive=4`；Edward 2026-11-09「每個角色的視角分開讀」）──────────────

/**
 * Edward 11/09：坐在 3 號（忠臣）看，1、2 號都是單純忠臣的機率只有 3/9 × 2/8 = 1/12——前面的提議幾乎都來自有私訊的人。從一個座位看出去，
 * 隊長的角色是 3/9 單純忠臣（看不到）、3/9 知道隊友的紅（刺客、莫甘娜、莫德雷德，故意派）、1/9 奧伯倫（看不到但要失敗，之後的提議回頭對照）、
 * 1/9 派西（有視角：前期通常避開兩根拇指）、1/9 梅林（資訊最多：排除看得到的紅）。第 33 回合的讀法把藍方隊長全部當成看不到的人（藍＝忠臣＋派西，
 * 梅林沒有擬合），梅林「排除看得到的紅」、派西的拇指都讀不到，角色的權重也沒有算。
 *
 * 這裡每個座位的整段動作（他的每一票、每一次派隊）用同一個角色讀，世界裡把角色一起決定：
 *   P(紀錄 | w) = Σ_{莫德雷德 d, 其他三紅的角色排列, 梅林 m, 派西 p} 先驗 · Π_藍 L_忠臣(b) · L_梅林(m | d)/L_忠臣(m) · L_派西(p | 拇指 {m, 莫甘娜})/L_忠臣(p) · Π_紅 L_角色(r)，
 * 先驗在讀者自己的角色下均勻（讀者是忠臣：其他藍方 1/5 梅林、1/5 派西、3/5 忠臣；讀者是梅林：d 就是他看不到的那個紅；讀者是派西：拇指裡藍的那根是梅林、
 * 紅的那根是莫甘娜）。L_角色 = 那個角色的決策函數（讀票模型＋派隊的條件 logit，強者擬合）產生他每一個動作的機率；梅林的視角 = w 減去莫德雷德、
 * 派西的視角 = 兩根拇指。所以一個人前面的提議一直剛好排除紅的，梅林的權重就上升；奧伯倫前面的提議在他後來的提議、失敗出來之後自動重讀
 * （每次都是整段紀錄在每個世界、每種角色分配下重算，沒有用舊後驗快取過去的概似）。
 */
export const MIX_VOTE_CLASSES = ['loyal', 'percival', 'merlin', 'assassin', 'morgana', 'mordred', 'oberon'] as const;
export type MixVoteClass = (typeof MIX_VOTE_CLASSES)[number];

/** 投票的角色私訊欄（長度 N_EXTRA）：忠臣＝藍方欄；派西＝藍方欄＋「隊上（自己以外）有拇指」放在梅林那兩欄的位置；其他角色同 `FlowFeatures.extras`。 */
export function mixVoteExtras(ff: FlowFeatures, i: number, j: string, w: number, cls: MixVoteClass, mordredBit: number, thumbMask: number, out: Float64Array<ArrayBuffer>): Float64Array {
  if (cls === 'loyal' || cls === 'percival') {
    ff.extras(i, j, w, 'blue', 0, out);
    if (cls === 'percival') {
      const team = ff.teamMask(i);
      const jb = bitOf(ff.flow, j);
      const th = (thumbMask & team & ~jb) !== 0;
      out[5] = th ? 1 : 0;
      out[6] = th && (team & jb) !== 0 ? 1 : 0;
    }
    return out;
  }
  return ff.extras(i, j, w, cls, mordredBit, out);
}

/** 完整的投票特徵（擬合用）。 */
export function mixVoteVector(ff: FlowFeatures, i: number, j: string, w: number, cls: MixVoteClass, mordredBit: number, thumbMask: number): Float64Array {
  const x = new Float64Array(N_BASE + N_EXTRA);
  x.set(ff.base(i, j, w), 0);
  x.set(mixVoteExtras(ff, i, j, w, cls, mordredBit, thumbMask, new Float64Array(N_EXTRA)), N_BASE);
  return x;
}

export interface MixModel { vote: Record<MixVoteClass, Float64Array>; proposal: Record<ProposalClass, Float64Array> }

const RED_ORDER: readonly MixVoteClass[] = ['assassin', 'morgana', 'oberon'];
const PERMS3: readonly (readonly number[])[] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/** 讀者自己的私訊（決定角色分配的先驗）。 */
export interface MixViewer { id: string; role: Role | string; seesReds: number; thumbs: number }

/** 一局資訊流上的角色混合讀法。 */
export class RoleMixtureReader {
  private readonly cands = new Map<string, ProposalCandidates | null>();
  private readonly propCache = new Map<string, number>();
  private readonly dots = new Map<number, Float64Array>();
  private scratch = new Float64Array(256);
  private readonly extra: Float64Array<ArrayBuffer> = new Float64Array(N_EXTRA);

  /** 第 35 回合：整段概似的快取（同一個前綴的所有觀察者共用；數字鍵含 upTo）。 */
  private readonly seatNum = new Map<number, number>();

  /** `flowFeat`：派隊用資訊流特徵的那一組係數（`beliefRecursive=5`）。 */
  constructor(readonly model: MixModel, readonly features: FlowFeatures, readonly flowFeat = false) {}

  /**
   * 第 35 回合（增量快取）：從同一局較短資訊流的讀法接手第 0 … upTo − 1 次提議的快取（候選隊、派隊概似、投票內積的鍵都以提議序號開頭；
   * 那些值只看到那次提議為止的紀錄，資訊流變長也不會變）。
   */
  adoptFrom(other: RoleMixtureReader, upTo: number): void {
    for (const [src, dst] of [[other.cands, this.cands], [other.propCache, this.propCache]] as const) {
      for (const [k, v] of src as Map<string, unknown>) {
        if (Number(k.slice(0, k.indexOf('|'))) < upTo) (dst as Map<string, unknown>).set(k, v);
      }
    }
    for (const [k, v] of other.dots) if (Math.floor(k / 16384) < upTo) this.dots.set(k, v);
  }

  private baseDots(i: number, j: string, jIdx: number, w: number): Float64Array {
    // 數字鍵：(提議, 座位, j 的湖結果)；lakeSig < 1024。
    const key = (i * 16 + jIdx) * 1024 + this.features.lakeKey(i, j, w);
    let d = this.dots.get(key);
    if (!d) {
      const x = this.features.base(i, j, w);
      d = new Float64Array(MIX_VOTE_CLASSES.length);
      for (let ci = 0; ci < MIX_VOTE_CLASSES.length; ci++) { const b = this.model.vote[MIX_VOTE_CLASSES[ci]]; let z = 0; for (let k = 0; k < NB; k++) z += b[k] * x[k]; d[ci] = z; }
      this.dots.set(key, d);
    }
    return d;
  }

  /** log P(j 的每一票 | 角色, w)。 */
  voteLog(j: string, upTo: number, w: number, cls: MixVoteClass, mordredBit = 0, thumbMask = 0): number {
    const f = this.features;
    const ci = MIX_VOTE_CLASSES.indexOf(cls);
    const b = this.model.vote[cls];
    const jIdx = f.flow.ids.indexOf(j);
    let lp = 0;
    for (let i = 0; i < upTo; i++) {
      if (!f.voted(i)) continue;
      const vote = f.flow.votes[i].votes[j];
      if (vote === undefined) continue;
      let z = this.baseDots(i, j, jIdx, w)[ci];
      const ex = mixVoteExtras(f, i, j, w, cls, mordredBit, thumbMask, this.extra);
      for (let k = 0; k < NX; k++) if (ex[k] !== 0) z += b[NB + k] * ex[k];
      const p = Math.min(1 - P_CLIP, Math.max(P_CLIP, sigmoid(z)));
      lp += Math.log(vote ? p : 1 - p);
    }
    return lp;
  }

  private candidates(i: number, w: number): ProposalCandidates | null {
    const v = this.features.flow.votes[i];
    const key = `${i}|${this.features.lakeKey(i, v.leader, w)}`;
    if (this.cands.has(key)) return this.cands.get(key)!;
    const c = proposalCandidates(this.features, i, w);
    this.cands.set(key, c);
    return c;
  }

  /** log P(j 的每一次派隊 | 角色, w)（`skip` 的隊長不讀）。 */
  propLog(j: string, upTo: number, w: number, cls: ProposalClass, mordredBit = 0, thumbMask = 0): number {
    const flow = this.features.flow;
    let lp = 0;
    for (let i = 0; i < upTo; i++) {
      if (flow.votes[i].leader !== j) continue;
      const c = this.candidates(i, w);
      if (!c) continue;
      const base = cls.endsWith('F') ? cls.slice(0, -1) : cls;
      const sub = base === 'evil' ? w : base === 'merlin' ? w * 1024 + mordredBit : base === 'percival' ? thumbMask : this.features.lakeKey(i, j, w);
      const key = `${i}|${cls}|${sub}`;
      let v = this.propCache.get(key);
      if (v === undefined) {
        if (this.scratch.length < c.teams.length) this.scratch = new Float64Array(c.teams.length);
        v = proposalLogProb(this.model.proposal[cls], c, w, cls, this.scratch, mordredBit, thumbMask);
        this.propCache.set(key, v);
      }
      lp += v;
    }
    return lp;
  }

  /** 世界 w 的整段紀錄（讀者自己的動作不讀；`skip(j)` 的人的派隊不讀）的 log 概似，角色在世界裡一起決定。 */
  worldLog(viewer: MixViewer, upTo: number, w: number, skip: (leader: string) => boolean): number {
    const flow = this.features.flow;
    const ids = flow.ids;
    const reds: number[] = [];
    const blues: number[] = [];
    ids.forEach((id, k) => { if (id === viewer.id) return; if ((w & (1 << k)) !== 0) reds.push(k); else blues.push(k); });
    // 第 35 回合：數字鍵的整段概似快取（同一個前綴的所有觀察者共用；只有梅林的項看 d、派西的項看拇指）。
    const seat = (k: number, vci: number, d = 0, th = 0): number => {
      const j = ids[k];
      const sk = skip(j) ? 1 : 0;
      const key = ((((upTo * 1024 + w) * 16 + k) * 8 + vci) * 2 + sk) * 1048576 + (vci === 2 ? d : 0) * 1024 + (vci === 1 ? th : 0);
      let v = this.seatNum.get(key);
      if (v === undefined) {
        const vc = MIX_VOTE_CLASSES[vci];
        const pc: ProposalClass = vci === 0 ? 'loyal' : vci === 1 ? 'percival' : vci === 2 ? 'merlin' : vci === 6 ? 'oberon' : 'evil';
        v = this.voteLog(j, upTo, w, vc, d, th) + (sk ? 0 : this.propLog(j, upTo, w, this.flowFeat ? (`${pc}F` as ProposalClass) : pc, d, th));
        this.seatNum.set(key, v);
      }
      return v;
    };
    const lLoyal = blues.map((b) => seat(b, 0));
    let base = 0;
    for (const x of lLoyal) base += x;
    if (reds.length !== 4) {
      // 非標準配置：紅方角色平均，沒有梅林、派西層。
      for (const r of reds) {
        const ls = [3, 4, 5, 6].map((c) => seat(r, c));
        base += logSumExpArr(ls) - Math.log(ls.length);
      }
      return base;
    }
    const merlinViewer = viewer.role === 'merlin';
    const percivalViewer = viewer.role === 'percival' && popcount(viewer.thumbs) === 2;
    const viewerBit = bitOf(flow, viewer.id);
    // 紅方：每個人在刺客、莫甘娜、莫德雷德、奧伯倫下的整段概似（MIX_VOTE_CLASSES 的 3、4、5、6）。
    const lr = reds.map((r) => [seat(r, 3), seat(r, 4), seat(r, 5), seat(r, 6)]);
    const nb = blues.length;
    // 梅林項：LM[b][di] = 梅林是 b、莫德雷德是 reds[di]。
    const LM = blues.map((b, bi) => reds.map((d) => seat(b, 2, 1 << d) - lLoyal[bi]));
    // 派西項（延遲算）：LP[p][m][g]，m = 梅林（藍方序號；讀者是梅林時 = nb），g = 莫甘娜（紅方序號）。
    const LP = new Float64Array(nb * (nb + 1) * 4).fill(NaN);
    const percTerm = (pi: number, mi: number, gi: number): number => {
      const idx = (pi * (nb + 1) + mi) * 4 + gi;
      let v = LP[idx];
      if (Number.isNaN(v)) {
        const mBit = mi === nb ? viewerBit : 1 << blues[mi];
        v = seat(blues[pi], 1, 0, mBit | (1 << reds[gi])) - lLoyal[pi];
        LP[idx] = v;
      }
      return v;
    };
    const terms: number[] = [];
    // 紅方角色：莫德雷德 d，其他三人排到刺客／莫甘娜／奧伯倫（RED_ORDER 的 0／1／2 對應 lr 的 0／1／3）。
    const redIdx = [0, 1, 3];
    for (let di = 0; di < 4; di++) {
      if (merlinViewer && (viewer.seesReds & (1 << reds[di])) !== 0) continue;
      const rest = [0, 1, 2, 3].filter((x) => x !== di);
      for (const perm of PERMS3) {
        let lred = lr[di][2];
        let gi = -1;
        rest.forEach((ri, k) => { const role = perm[k]; lred += lr[ri][redIdx[role]]; if (role === 1) gi = ri; });
        if (percivalViewer && (viewer.thumbs & (1 << reds[gi])) === 0) continue;
        const ms: number[] = merlinViewer ? [nb] : percivalViewer ? blues.map((b, bi) => ((viewer.thumbs & (1 << b)) !== 0 ? bi : -1)).filter((x) => x >= 0) : blues.map((_, bi) => bi);
        for (const mi of ms) {
          const lm = mi === nb ? 0 : LM[mi][di];
          if (percivalViewer) { terms.push(lred + lm); continue; }
          for (let pi = 0; pi < nb; pi++) {
            if (pi === mi) continue;
            terms.push(lred + lm + percTerm(pi, mi, gi));
          }
        }
      }
    }
    if (terms.length === 0) return base;
    return base + logSumExpArr(terms) - Math.log(terms.length);
  }
}

function logSumExpArr(xs: readonly number[]): number {
  let mx = -Infinity;
  for (const x of xs) if (x > mx) mx = x;
  if (!Number.isFinite(mx)) return mx;
  let s = 0;
  for (const x of xs) s += Math.exp(x - mx);
  return mx + Math.log(s);
}

// ── 模型檔與線上入口 ─────────────────────────────────────────────

interface ModelFile {
  vote: { features: string[]; beta: Record<string, number[]> };
  proposal: { features: string[]; beta: Record<string, number[]> };
}

let voteModel: PolicyModel | null = null;
let propModel: ProposalModel | null = null;
let mixModel: MixModel | null = null;
/** 遞迴讀人的模型（第 34 回合：第 1 局提議的資訊價值也用它的讀票模型）。 */
export function recursiveModels(): { vote: PolicyModel; proposal: ProposalModel } {
  return models();
}

function models(): { vote: PolicyModel; proposal: ProposalModel } {
  if (voteModel && propModel) return { vote: voteModel, proposal: propModel };
  const m = MODEL as unknown as ModelFile;
  if (m.vote.features.length !== FEATURE_NAMES.length || m.vote.features.some((f, k) => f !== FEATURE_NAMES[k])) {
    throw new Error('recursive_strong.json: vote feature list does not match voteFeatures.ts (refit with scripts/fitRecursiveReader.ts)');
  }
  if (m.proposal.features.join(',') !== PROPOSAL_FEATURES.join(',')) {
    throw new Error('recursive_strong.json: proposal feature list does not match recursiveRead.ts (refit with scripts/fitRecursiveReader.ts)');
  }
  const vb = {} as Record<RoleClass, Float64Array>;
  for (const c of ROLE_CLASSES) vb[c] = Float64Array.from(m.vote.beta[c]);
  voteModel = { beta: vb, residual: false, useBayesView: true };
  const pb = {} as Record<ProposalClass, Float64Array>;
  for (const c of PROPOSAL_CLASSES) pb[c] = Float64Array.from(m.proposal.beta[c] ?? m.proposal.beta.blue);
  propModel = { beta: pb };
  return { vote: voteModel, proposal: propModel };
}

/** 第 34 回合的角色混合模型（投票：忠臣、派西分開；派隊：六類）。 */
export function mixModels(): MixModel {
  if (mixModel) return mixModel;
  const m = MODEL as unknown as ModelFile;
  const { proposal } = models();
  if (!m.vote.beta.loyal || !m.vote.beta.percival || !m.proposal.beta.merlin || !m.proposal.beta.merlinF) {
    throw new Error('recursive_strong.json: no role-mixture classes (refit with scripts/fitRecursiveReader.ts)');
  }
  const vote = {} as Record<MixVoteClass, Float64Array>;
  for (const c of MIX_VOTE_CLASSES) vote[c] = Float64Array.from(m.vote.beta[c]);
  mixModel = { vote, proposal: proposal.beta };
  return mixModel;
}

/** 派隊讀法的快取跟著資訊流特徵走（同一局的每個觀察者共用）。 */
const propReaders = new WeakMap<FlowFeatures, RecursiveProposalReader>();
const mixReaders = new WeakMap<FlowFeatures, RoleMixtureReader>();
/** 第 35 回合：每份資訊流特徵是從哪一份較短的接手的（角色混合讀法的增量快取跟著接手）。 */
const ffParent = new WeakMap<FlowFeatures, { parent: FlowFeatures; upTo: number }>();
const mixFlowReaders = new WeakMap<FlowFeatures, RoleMixtureReader>();

interface Entry { key: string; sigs: string[]; ff: FlowFeatures; quests: number; lakes: number }
const recent: Entry[] = [];
const MAX_ENTRIES = 24;
const voteSig = (v: PlayerObservation['voteHistory'][number]): string =>
  `${v.round}|${v.attempt}|${v.leader}|${v.team.join(',')}|${Object.keys(v.votes).sort().map((k) => `${k}${v.votes[k] ? '+' : '-'}`).join('')}`;

/** 這個觀察的資訊流特徵（j 座位的第 0 層後驗；接手同一局、同一組第 0 層選項較短資訊流的快取）。 */
function featuresOf(obs: PlayerObservation, level0: Readonly<BayesOptions>): FlowFeatures {
  const flow: Flow = flowOfObs(obs);
  const key = JSON.stringify(level0);
  const sigs = flow.votes.map(voteSig);
  let best: Entry | null = null;
  let bestLen = 0;
  for (const e of recent) {
    if (e.key !== key || e.sigs.length === 0 || sigs.length === 0 || e.sigs[0] !== sigs[0] || !e.ff.flow.ids.every((id, k) => id === flow.ids[k])) continue;
    let k = 0;
    while (k < e.sigs.length && k < sigs.length && e.sigs[k] === sigs[k]) k++;
    if (k > bestLen) { best = e; bestLen = k; }
  }
  if (best && bestLen === sigs.length && best.sigs.length === sigs.length && best.quests === flow.quests.length && best.lakes === flow.lakes.length) return best.ff;
  const ff = new FlowFeatures(flow, { useBayesView: true, bayesViewOptions: level0 });
  if (best && bestLen > 0) { ff.adoptFrom(best.ff, bestLen); ffParent.set(ff, { parent: best.ff, upTo: bestLen }); }
  recent.unshift({ key, sigs, ff, quests: flow.quests.length, lakes: flow.lakes.length });
  if (recent.length > MAX_ENTRIES) recent.length = MAX_ENTRIES;
  return ff;
}

/**
 * 遞迴讀人的世界概似（log）：`votes`（讀票；梅林觀察者看得到的紅決定莫德雷德）與 `proposals`（讀派隊；`skipLeader` 的提議不讀——
 * 派西的拇指照嚴格梅林模型讀）。`mode` 1 = 兩者、2 = 只有票、3 = 只有派隊、4 = 角色混合（票與派隊合在 `votes` 那一項）。沒有可讀的動作時該項 null。
 */
export function recursiveLogs(
  obs: PlayerObservation,
  level0: Readonly<BayesOptions>,
  mode: number,
  skipLeader: (leader: string) => boolean = () => false,
): { votes: ((w: number) => number) | null; proposals: ((w: number) => number) | null } {
  if (obs.voteHistory.length === 0) return { votes: null, proposals: null };
  const ff = featuresOf(obs, level0);
  if (mode >= 4) {
    // 第 34 回合：角色混合（票＋派隊一起讀，整段紀錄每個人一個角色）；5 = 派隊再加相對於資訊流的特徵。
    const store = mode === 5 ? mixFlowReaders : mixReaders;
    let reader = store.get(ff);
    if (!reader) {
      reader = new RoleMixtureReader(mixModels(), ff, mode === 5);
      const par = ffParent.get(ff);
      const prevReader = par ? store.get(par.parent) : undefined;
      if (par && prevReader) reader.adoptFrom(prevReader, par.upTo);
      store.set(ff, reader);
    }
    const r = reader;
    const n4 = ff.flow.votes.length;
    const viewer: MixViewer = {
      id: obs.myPlayerId, role: obs.myRole,
      seesReds: obs.myRole === 'merlin' ? maskOf(ff.flow, obs.knownEvils) : 0,
      thumbs: obs.myRole === 'percival' ? maskOf(ff.flow, obs.knownWizards ?? []) : 0,
    };
    return { votes: (w: number) => r.worldLog(viewer, n4, w, skipLeader), proposals: null };
  }
  const m = models();
  const n = ff.flow.votes.length;
  const me = obs.myPlayerId;
  let votes: ((w: number) => number) | null = null;
  if (mode !== 3 && obs.voteHistory.some((v) => v.attempt < 5)) {
    const reader = new PolicyVoteReader(m.vote, ff);
    const sees = obs.myRole === 'merlin' ? maskOf(ff.flow, obs.knownEvils) : null;
    votes = (w: number) => reader.worldLog(me, n, w, sees);
  }
  let proposals: ((w: number) => number) | null = null;
  if (mode !== 2) {
    let reader = propReaders.get(ff);
    if (!reader) { reader = new RecursiveProposalReader(m.proposal, ff); propReaders.set(ff, reader); }
    const r = reader;
    proposals = (w: number) => r.worldLog(me, n, w, skipLeader);
  }
  return { votes, proposals };
}
