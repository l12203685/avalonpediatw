/**
 * 優化迴圈第 50 回合（2026-11-18；站長同一天在主控台的四條裁定）：
 *
 *   (a)「哪些動作是忠臣做得到 或 忠臣可取得的資訊 如果某個玩家做出 超前資訊 或是 不合理的選擇 (比如 湖中當下沒有最大化藍方效益
 *       尾局派票沒有選擇最可能開藍的組合 派票選擇不是讓場上好人的共同資訊最大化) 那他通常是紅方的可能越高」
 *   (b)「…應該可以帶入自己如果只有1-1~1-4 的資訊, 在5家是忠臣 能不能派出那個全好組合(沒有姆指) 如果很難 代表是超前資訊
 *       超前資訊只有三種可能 1. 內建視角 2. 場外資訊 3. 賭博選擇」
 *   (c) 湖的均衡：「不是完全信 也不能完全不信 他本來就是有個比例」
 *   (d) A0（好人持湖說實話）、A1（兩敗後紅方必出失敗）照舊是硬的——本模組不碰 `Certainty`。
 *
 * 共同的零件：「坐在那個位置、只有當時公開資訊的忠臣」視角（沒有角色視野、沒有拇指；私訊只有他自己湖過、照實宣告的結果——A0）。
 * 在這個視角下用機器人自己的忠臣評分重算一次：
 *   - 提議（含強制局）：預設後驗（`bayesWorlds`，預設選項）下每一個「隊長＋k−1 人」的隊乾淨的機率 P(T)；
 *     不合理度 d = log P(最乾淨的隊) − log P(實際的隊)（≥ 0；上限 `D_CAP`）。
 *   - 湖的目標：機器人忠臣持湖的湖中分數（`GoodLakeInfo.analyzeGoodLake`，預設的 `goodLakeInfoMax`）；不合理度 = 最高分 − 實際目標的分（bits）。
 *
 * 三個用法：
 *   1. `loyalRationality50`（藍方讀法）：每個人的不合理度加總（提議、強制局、湖分開）× 真人強者擬合的殘差權重（`W50`，
 *      `scripts/fitRound50.ts`＋`fitRound50.py`，第 47 回合的殘差擬合）加到他是紅的對數勝算（`BayesBelief.posteriorWith` 的世界權重）。
 *   2. `assassinDerivability50`（紅方・刺客）：公開視角的忠臣派隊模型 P_L(T) ∝ exp(β·log P(T))（β 照真人忠臣隊長擬合，`BETA_TEAM_50`）；
 *      梅林在他看得到的乾淨隊（紅方開牌：全部的紅，除了莫德雷德）裡照同一個模型挑：P_M(T) = (1 − ε)·P_L(T)／P_L(看得到的乾淨) ＋ ε·P_L(T)。
 *      對數概似比加到刺殺分數。
 *   3. `lakePickSuspicion50`（藍方讀法）：持湖者是紅的世界 P(t) = w·[t 是可湖的紅]／可湖的紅的人數 ＋ (1 − w)·P_L(t)，是藍的世界 P(t) = P_L(t)，
 *      P_L(t) = 湖中分數的 softmax（溫度 `BETA_LAKE_50` 照真人忠臣持湖者擬合）。
 * 另外 `redLakeDisguise50`（紅方持湖，只測）在 `LakePolicy.pickLakeTargetForTeam`：比例 d 改照公開視角的忠臣挑目標。
 *
 * 快取：同一局裡每一次提議的公開前綴只算一次（鍵 = 公開紀錄前綴的雜湊）；所有座位、所有決策共用。
 */
import type { PlayerObservation, VoteRecord } from './types';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesWorlds, type BayesOptions } from './belief/BayesBelief';
import { analyzeGoodLake } from './GoodLakeInfo';
import { returnLakeOptions } from './belief/Certainty';
import { successfulTeamReuse } from './assassin/VisibleRedProposals';

/** 每一次提議的不合理度上限（nats；含確定紅的隊在後驗下幾乎是 0）。 */
export const D_CAP = 4;
const P_FLOOR = 1e-4;

/**
 * 殘差權重（對數勝算／單位不合理度；紅 > 0）：`scripts/fitRound50.ts` → `fitRound50.py`，真人局（games_cache 2,236 局）忠臣座位、
 * 第 2–5 局第 1 次提議的投票點，logit P(紅) = b0 + a·logit(預設後驗) + w·特徵，局的集群自助法 200 次。
 *   強者桌（S ≥ 55，316 局、29,839 點）：提議 +0.018 [−0.082, +0.118]、強制局 −0.111 [−0.476, +0.230]、湖 +0.167 [−0.790, +1.612]；a 0.757。
 *   全部真人（2,236 局、216,877 點）：提議 +0.000 [−0.035, +0.034]、強制局 +0.191 [+0.082, +0.284]、湖 +0.478 [+0.152, +0.844]；a 0.679。
 * 也就是說預設後驗（派隊概似表）已經把「提議不合理」讀完了；強者桌三項都在 0 附近，全部真人只有強制局與湖有殘差。
 * `loyalRationality50` 1／2 用強者的點估計（第 1E 節第 7 條），3／4 用全部真人的（參考：和強者的結論不同）。
 */
export const W50_STRONG = Object.freeze({ prop: 0.018, tail: -0.111, lake: 0.167 });
export const W50_ALL = Object.freeze({ prop: 0.0, tail: 0.191, lake: 0.478 });
export const W50 = W50_STRONG;
/** 公開視角忠臣隊長的派隊溫度 β：真人忠臣隊長、自己在隊上的提議，最大概似；強者桌 1,748 次 2.19 [1.96, 2.47]，全部真人 12,728 次 2.02 [1.92, 2.12]。 */
export const BETA_TEAM_50 = 2.19;
/** 忠臣持湖者挑目標的溫度 β（湖中分數，bits）：強者桌 263 次 3.83 [3.08, 4.64]，全部真人 1,832 次 2.60 [2.33, 2.91]。 */
export const BETA_LAKE_50 = 3.83;

// ── 公開前綴的雜湊鍵 ────────────────────────────────────────────

function fnv(h: [number, number], text: string): [number, number] {
  let a = h[0];
  let b = h[1];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x0100019d) >>> 0;
  }
  return [a, b];
}
const keyOf = (h: [number, number], tag: string): string => `${h[0].toString(36)}.${h[1].toString(36)}.${tag}`;

const voteSig = (v: VoteRecord, ids: readonly string[]): string =>
  `P${v.round}.${v.attempt}.${v.leader}.${v.team.join(',')}.${v.attempt >= 5 ? '' : ids.filter((id) => v.votes[id] === true).join(',')}.${v.approved ? 1 : 0};`;

/** 每次提議 i 的公開前綴鍵（紀錄 0..i−1、i 那一局之前的任務與湖）＋每個湖的鍵（湖那一局結束為止、之前的湖）。 */
function prefixKeys(obs: PlayerObservation): { props: string[]; lakes: string[] } {
  const ids = obs.allPlayerIds;
  let h = fnv([0x811c9dc5, 0x2f1b6c3d], `${ids.join(',')}|${obs.evilCount ?? ''}|`);
  const quests = obs.questHistory;
  const lakes = obs.lakeHistory ?? [];
  let qi = 0;
  let li = 0;
  const lakeKeys: string[] = new Array(lakes.length);
  const flushBefore = (round: number): void => {
    // Events of earlier rounds in time order: that round's quest, then its lake (the lake key is taken before the lake enters).
    for (;;) {
      const q = quests[qi];
      const l = lakes[li];
      const qr = q ? q.round : Infinity;
      const lr = l ? l.round : Infinity;
      if (Math.min(qr, lr) >= round) return;
      if (qr <= lr) { h = fnv(h, `Q${q.round}.${q.team.join(',')}.${q.failCount ?? 0};`); qi++; } else {
        lakeKeys[li] = keyOf(h, `L${li}.${l.holderId}`);
        h = fnv(h, `K${l.round}.${l.holderId}.${l.targetId}.${l.declaredClaim};`);
        li++;
      }
    }
  };
  const props: string[] = [];
  obs.voteHistory.forEach((v, i) => {
    flushBefore(v.round);
    props.push(keyOf(h, `T${i}.${v.leader}.${v.team.length}.${v.team.join(',')}`));
    h = fnv(h, voteSig(v, ids));
  });
  flushBefore(Infinity);
  return { props, lakes: lakeKeys };
}

// ── 公開視角 ────────────────────────────────────────────────────

/** 坐在 `seat`、只有公開資訊的忠臣；私訊 = 他自己湖過、照實宣告的結果（A0）。 */
function loyalSeatView(obs: PlayerObservation, seat: string, round: number, votes: readonly VoteRecord[], lakesUntil: number, questsThrough: number): PlayerObservation {
  const lakes = (obs.lakeHistory ?? []).slice(0, lakesUntil);
  return {
    ...obs,
    myPlayerId: seat,
    myRole: 'loyal',
    myTeam: 'good',
    seatTeam: 'good',
    knownEvils: [],
    knownWizards: undefined,
    allEvilIds: undefined,
    allEvilRoles: undefined,
    publicLoyalView: true,
    redLoyalView: undefined,
    currentRound: round,
    currentLeader: seat,
    failCount: 0,
    gamePhase: 'team_vote',
    proposedTeam: [],
    voteHistory: [...votes],
    questHistory: obs.questHistory.filter((q) => q.round <= questsThrough),
    questResults: (obs.questResults ?? []).slice(0, Math.max(0, questsThrough)),
    lakeHistory: lakes,
    myLakeResults: lakes.filter((l) => l.holderId === seat && l.declaredClaim !== 'none').map((l) => ({ round: l.round, targetId: l.targetId, result: l.declaredClaim as 'good' | 'evil' })),
  } as PlayerObservation;
}

let baseOpts: BayesOptions | null = null;
/**
 * 預設選項的後驗（本回合的開關都關；`publicLoyalView` 讓挑隊自己的先驗不作用）。
 * 第 56b 回合：隊長視角讀法（V3P，`viewpoint53`／`viewpointPow53`）2026-11-20 改成預設，但公開視角的忠臣模型（`W50` 的殘差權重）是在沒有它的讀法上擬合、
 * 也是在沒有它的時候確認的（藍方讀人與紅方 `assassinDerivability50` 共用），所以這裡照舊不讀。
 */
function defaultOpts(): BayesOptions {
  if (!baseOpts) baseOpts = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, loyalRationality50: 0, lakePickSuspicion50: 0, viewpoint53: 0, viewpointPow53: 0 } as AgentTuning);
  return baseOpts;
}

export interface ProposalRead50 {
  leader: string;
  forced: boolean;
  round: number;
  /** 隊長＋k−1 人的每一個隊（位元遮罩，`bitOf` 的位元）。 */
  masks: Int32Array;
  /** log max(P(乾淨), P_FLOOR)。 */
  logp: Float64Array;
  /** 實際的隊的 log P(乾淨)。 */
  actual: number;
  /** 實際的隊的遮罩。 */
  actualMask: number;
  /** 不合理度 log P(最乾淨) − log P(實際)，夾在 [0, D_CAP]。 */
  d: number;
  bitOf: (id: string) => number;
}

export interface LakeRead50 {
  holder: string;
  target: string;
  /** 可湖的人與忠臣的湖中分數（bits）。 */
  scores: Map<string, number>;
  /** 最高分 − 實際目標的分（≥ 0）；還湖（A2）的目標 = 0。 */
  d: number;
}

const cache = new Map<string, ProposalRead50 | LakeRead50 | null>();
const CACHE_MAX = 60000;
function remember<T extends ProposalRead50 | LakeRead50 | null>(key: string, value: T): T {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, value);
  return value;
}

function proposalRead(obs: PlayerObservation, i: number, key: string): ProposalRead50 | null {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as ProposalRead50 | null;
  const v = obs.voteHistory[i];
  const view = loyalSeatView(obs, v.leader, v.round, obs.voteHistory.slice(0, i), (obs.lakeHistory ?? []).filter((l) => l.round < v.round).length, v.round - 1);
  const post = bayesWorlds(view, defaultOpts());
  if (post.worlds.length === 0 || v.team.length === 0) return remember(key, null);
  const ids = obs.allPlayerIds;
  const lb = post.bitOf(v.leader);
  const others = ids.filter((id) => id !== v.leader).map((id) => post.bitOf(id));
  const k = v.team.length - 1;
  const masks: number[] = [];
  const pick = (start: number, left: number, m: number): void => {
    if (left === 0) { masks.push(m | lb); return; }
    for (let j = start; j <= others.length - left; j++) pick(j + 1, left - 1, m | others[j]);
  };
  pick(0, k, 0);
  const clean = (mask: number): number => {
    let s = 0;
    for (let w = 0; w < post.worlds.length; w++) if ((post.worlds[w] & mask) === 0) s += post.wts[w];
    return Math.log(Math.max(s, P_FLOOR));
  };
  const logp = Float64Array.from(masks, clean);
  const actualMask = v.team.reduce((m, id) => m | post.bitOf(id), 0);
  const actual = clean(actualMask);
  let best = -Infinity;
  for (const x of logp) if (x > best) best = x;
  const d = Math.min(Math.max(best - actual, 0), D_CAP);
  return remember(key, { leader: v.leader, forced: v.attempt >= 5, round: v.round, masks: Int32Array.from(masks), logp, actual, actualMask, d, bitOf: post.bitOf });
}

function lakeRead(obs: PlayerObservation, li: number, key: string): LakeRead50 | null {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as LakeRead50 | null;
  const lakes = obs.lakeHistory ?? [];
  const l = lakes[li];
  const used = new Set<string>();
  for (let j = 0; j <= li; j++) used.add(lakes[j].holderId);
  for (let j = 0; j < li; j++) used.add(lakes[j].targetId);
  const valid = obs.allPlayerIds.filter((id) => !used.has(id));
  if (!valid.includes(l.targetId) || valid.length < 2) return remember(key, null);
  const view = loyalSeatView(obs, l.holderId, l.round, obs.voteHistory.filter((v) => v.round <= l.round), li, l.round);
  // A2 (還湖): returning the lake to a publicly certain-good seat is what a loyal must do — no deficit.
  const back = returnLakeOptions(view, l.holderId, valid);
  const analysis = analyzeGoodLake(view, valid);
  if (!analysis) return remember(key, null);
  const scores = new Map(analysis.candidates.map((c) => [c.id, c.score]));
  const best = Math.max(...analysis.candidates.map((c) => c.score));
  const d = back.includes(l.targetId) ? 0 : Math.max(0, best - (scores.get(l.targetId) ?? best));
  return remember(key, { holder: l.holderId, target: l.targetId, scores, d });
}

/** 這個觀察看得到的每一次提議的公開視角評分（強制局也算）。 */
export function proposalReads50(obs: PlayerObservation): (ProposalRead50 | null)[] {
  const keys = prefixKeys(obs);
  return obs.voteHistory.map((_, i) => proposalRead(obs, i, keys.props[i]));
}

/** 這個觀察看得到的每一個湖的公開視角評分。 */
export function lakeReads50(obs: PlayerObservation): (LakeRead50 | null)[] {
  const keys = prefixKeys(obs);
  return (obs.lakeHistory ?? []).map((_, i) => lakeRead(obs, i, keys.lakes[i]));
}

// ── 1. loyalRationality50 ───────────────────────────────────────

export interface Rationality50 { prop: number; tail: number; lake: number }

/** 每個座位的不合理度加總（非強制提議、強制局、湖的目標）。 */
export function rationalityFeatures50(obs: PlayerObservation): Map<string, Rationality50> {
  const out = new Map<string, Rationality50>(obs.allPlayerIds.map((id) => [id, { prop: 0, tail: 0, lake: 0 }]));
  const keys = prefixKeys(obs);
  obs.voteHistory.forEach((v, i) => {
    const r = proposalRead(obs, i, keys.props[i]);
    if (!r) return;
    const f = out.get(v.leader);
    if (!f) return;
    if (r.forced) f.tail += r.d; else f.prop += r.d;
  });
  (obs.lakeHistory ?? []).forEach((l, i) => {
    const r = lakeRead(obs, i, keys.lakes[i]);
    const f = out.get(l.holderId);
    if (r && f) f.lake += r.d;
  });
  return out;
}

/** 每個座位是紅的對數勝算調整（不含觀察者自己）；`scale` = 權重倍數。 */
export function rationalityAdj50(obs: PlayerObservation, scale = 1, w: Readonly<Rationality50> = W50): Map<string, number> {
  const out = new Map<string, number>();
  if (!(scale > 0)) return out;
  for (const [id, f] of rationalityFeatures50(obs)) {
    if (id === obs.myPlayerId) continue;
    const a = scale * (w.prop * f.prop + w.tail * f.tail + w.lake * f.lake);
    if (a !== 0) out.set(id, a);
  }
  return out;
}

// ── 3. lakePickSuspicion50 ──────────────────────────────────────

/** 忠臣持湖者挑每個可湖對象的機率（湖中分數的 softmax，溫度 β）。 */
export function loyalLakePolicy50(r: LakeRead50, beta = BETA_LAKE_50): Map<string, number> {
  const xs = [...r.scores];
  const mx = Math.max(...xs.map(([, s]) => s));
  const ex = xs.map(([id, s]) => [id, Math.exp(beta * (s - mx))] as const);
  const z = ex.reduce((a, [, e]) => a + e, 0);
  return new Map(ex.map(([id, e]) => [id, e / z]));
}

export interface LakePickTerm50 { hb: number; tb: number; valid: number; pL: number }

/**
 * 別人的每一個已宣告的湖：持湖者、被驗者的位元，可湖的人的遮罩，P_L(被驗者)（下限 0.02）。`bit` = 後驗的位元。
 * 世界權重（持湖者是紅）乘 w'·[被驗者紅]／(可湖的紅的人數·P_L) ＋ (1 − w')，w' = 可湖的人裡有紅才是 w。
 */
export function lakePickTerms50(obs: PlayerObservation, bit: (id: string) => number): LakePickTerm50[] {
  const lakes = obs.lakeHistory ?? [];
  const keys = prefixKeys(obs);
  const out: LakePickTerm50[] = [];
  const me = obs.myPlayerId;
  lakes.forEach((l, i) => {
    if (l.declaredClaim === 'none' || l.holderId === me) return;
    const r = lakeRead(obs, i, keys.lakes[i]);
    if (!r) return;
    const pol = loyalLakePolicy50(r);
    let valid = 0;
    for (const id of r.scores.keys()) valid |= bit(id);
    out.push({ hb: bit(l.holderId), tb: bit(l.targetId), valid, pL: Math.max(pol.get(l.targetId) ?? 0, 0.02) });
  });
  return out;
}

// ── 2. assassinDerivability50 ───────────────────────────────────

/**
 * 刺殺分數上這一項的倍數：真人刺殺點（games_cache 有刺殺的局；候選 = 全部非紅座位），P(候選 = 梅林) ∝ exp(預設刺殺分數 ＋ λ·對數概似比) 的條件 logit，
 * β = `BETA_TEAM_50`，局的自助法 200 次。mode 1（取代派票讀法）：強者 158 次 0.58 [0.42, 0.86]、全部 1,187 次 0.61 [0.52, 0.70]；
 * mode 2（只加強制局）：強者 0.49 [0.21, 0.80]、全部 0.69 [0.56, 0.83]。照第 1E 節第 7 條用強者的點估計。
 */
export const LAMBDA_ASSASSIN_50: Readonly<Record<number, number>> = { 1: 0.58, 2: 0.49 };

/** 照派成功的隊（`assassinReuseRead ≥ 1` 時派票讀法也不算）。 */
export function reuseSkip50(obs: PlayerObservation, ignoreReuse: boolean): ((v: VoteRecord) => boolean) | undefined {
  return ignoreReuse ? (v) => successfulTeamReuse(obs, v) : undefined;
}

const EPS_R3 = 0.05;
const EPS_R12 = 0.5;

/**
 * 候選人 `candidate` 是梅林 vs 忠臣的對數概似比：他派過的每一隊（`mode` 1 = 全部提議、2 = 只有強制局；`skip` 的提議不算，例如照派成功的隊），
 * 梅林在看得到的乾淨隊裡照公開視角的忠臣模型挑。莫德雷德由 `allEvilRoles` 得知；不知道時對每個紅取平均（同 `MerlinLeadRead`）。
 */
export function derivabilityLogRatio50(obs: PlayerObservation, candidate: string, reds: readonly string[], mode: number, skip?: (v: VoteRecord) => boolean, beta = BETA_TEAM_50): number {
  if (!(mode > 0) || reds.length === 0) return 0;
  const reads = proposalReads50(obs);
  const leads: number[] = [];
  obs.voteHistory.forEach((v, i) => {
    if (v.leader !== candidate || !reads[i]) return;
    if (mode === 2 && v.attempt < 5) return;
    if (skip && skip(v)) return;
    leads.push(i);
  });
  if (leads.length === 0) return 0;
  const roles = obs.allEvilRoles;
  const known = roles ? reds.filter((id) => roles[id] === 'mordred') : [];
  const mordreds: (string | null)[] = roles ? (known.length > 0 ? known : [null]) : [...reds];
  let sum = 0;
  for (const dm of mordreds) {
    let lr = 0;
    for (const i of leads) {
      const r = reads[i]!;
      const v = obs.voteHistory[i];
      const seen = reds.filter((id) => id !== dm).reduce((m, id) => m | r.bitOf(id), 0);
      const eps = v.round > 2 || v.attempt >= 5 ? EPS_R3 : EPS_R12;
      if ((r.actualMask & seen) !== 0) { lr += Math.log(eps); continue; }
      // P_L(seen-clean) = Σ_{T seen-clean} e^{β s_T} / Σ_T e^{β s_T}.
      let mx = -Infinity;
      for (const s of r.logp) if (s > mx) mx = s;
      let zAll = 0;
      let zClean = 0;
      for (let t = 0; t < r.masks.length; t++) {
        const e = Math.exp(beta * (r.logp[t] - mx));
        zAll += e;
        if ((r.masks[t] & seen) === 0) zClean += e;
      }
      if (zClean <= 0) continue;
      lr += Math.log((1 - eps) * (zAll / zClean) + eps);
    }
    sum += Math.exp(lr);
  }
  return Math.log(sum / mordreds.length);
}

// ── redLakeDisguise50 ───────────────────────────────────────────

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 這一個紅方持湖要不要改照公開視角的忠臣挑（比例 d，照座位、第幾湖、公開比分雜湊；不用亂數）。 */
export function redLakeDisguiseNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const d = tuning.redLakeDisguise50 ?? 0;
  if (!(d > 0) || obs.myTeam !== 'evil') return false;
  if (d >= 1) return true;
  const state = obs.questHistory.map((q) => `${q.round}:${q.failCount ?? 0}`).join(',');
  return hash01(`${obs.myPlayerId}|${(obs.lakeHistory ?? []).length}|${state}|redlakedisguise50`) < d;
}

/** 測試用：清掉前綴快取。 */
export function clearRound50Cache(): void { cache.clear(); }
