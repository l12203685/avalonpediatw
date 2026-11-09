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
import { FEATURE_NAMES, FlowFeatures, ROLE_CLASSES, type RoleClass } from './voteFeatures';
import { PolicyVoteReader, type PolicyModel } from './policyModel';
import MODEL from './recursive_strong.json';

// ── 派隊的條件 logit ─────────────────────────────────────────────

export const PROPOSAL_CLASSES = ['blue', 'evil', 'oberon'] as const;
export type ProposalClass = (typeof PROPOSAL_CLASSES)[number];
/** 前 3 個是公開（j 自己後驗）的特徵，後 3 個是紅方隊長的私訊（w 裡的真相；藍方、奧伯倫的係數是 0）。 */
export const PROPOSAL_FEATURES = ['logClean', 'selfOn', 'reuse', 'allies1', 'allies2', 'canFail'] as const;
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
  return { teams, chosen, logClean, selfOn, reuse, leaderBit, failsRequired: req };
}

/** 一支隊的完整特徵（擬合用；`out` 長度 N_PROP）。紅方隊長的私訊欄只在 `cls === 'evil'` 時填。 */
export function proposalFeatures(c: ProposalCandidates, t: number, w: number, cls: ProposalClass, out: Float64Array): Float64Array {
  out.fill(0);
  out[0] = c.logClean[t];
  out[1] = c.selfOn[t];
  out[2] = c.reuse[t];
  if (cls === 'evil') {
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
export function proposalLogProb(beta: Float64Array, c: ProposalCandidates, w: number, cls: ProposalClass, scratch: Float64Array): number {
  const x = new Float64Array(N_PROP);
  const n = c.teams.length;
  for (let t = 0; t < n; t++) {
    proposalFeatures(c, t, w, cls, x);
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

// ── 模型檔與線上入口 ─────────────────────────────────────────────

interface ModelFile {
  vote: { features: string[]; beta: Record<string, number[]> };
  proposal: { features: string[]; beta: Record<string, number[]> };
}

let voteModel: PolicyModel | null = null;
let propModel: ProposalModel | null = null;
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
  for (const c of PROPOSAL_CLASSES) pb[c] = Float64Array.from(m.proposal.beta[c]);
  propModel = { beta: pb };
  return { vote: voteModel, proposal: propModel };
}

/** 派隊讀法的快取跟著資訊流特徵走（同一局的每個觀察者共用）。 */
const propReaders = new WeakMap<FlowFeatures, RecursiveProposalReader>();

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
  if (best && bestLen > 0) ff.adoptFrom(best.ff, bestLen);
  recent.unshift({ key, sigs, ff, quests: flow.quests.length, lakes: flow.lakes.length });
  if (recent.length > MAX_ENTRIES) recent.length = MAX_ENTRIES;
  return ff;
}

/**
 * 遞迴讀人的世界概似（log）：`votes`（讀票；梅林觀察者看得到的紅決定莫德雷德）與 `proposals`（讀派隊；`skipLeader` 的提議不讀——
 * 派西的拇指照嚴格梅林模型讀）。`mode` 1 = 兩者、2 = 只有票、3 = 只有派隊。沒有可讀的動作時該項 null。
 */
export function recursiveLogs(
  obs: PlayerObservation,
  level0: Readonly<BayesOptions>,
  mode: number,
  skipLeader: (leader: string) => boolean = () => false,
): { votes: ((w: number) => number) | null; proposals: ((w: number) => number) | null } {
  if (obs.voteHistory.length === 0) return { votes: null, proposals: null };
  const ff = featuresOf(obs, level0);
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
