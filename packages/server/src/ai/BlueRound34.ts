/**
 * 優化迴圈第 34 回合・藍方（2026-11-09）。
 *
 * 第 1 局提議的資訊價值改用 INFL 讀票模型（`loyalR1Spread=4`）。Edward 11/09：「不是刻意全部去派沒票的人 而是適時疊票 也要適時做票源分散」。
 * 第 33 回合的 `loyalR1Spread=3` 用後驗讀票的格子算票的機率：格子只看「投票者陣營 × 在不在隊上 × 隊上有沒有紅 × 回合段」，第 1 局的票幾乎沒有資訊
 * （一支隊約 0.01–0.017 bit），資訊價值最大的隊退化成「乾淨機率最接近一半」＝疊在被派過的人身上。
 * 這裡改用遞迴讀人的讀票模型（`infl/recursiveRead.ts` 的投票部分，強者擬合）：每個投票者 j 對這支假想隊伍的票，是 j 自己的決策函數套在
 * j 當時的資訊流（含前面的提議與票、j 自己的後驗）上——所以前面提議過、被票讀得夠清楚的人，再派一次換不到資訊（分散）；
 * 還模糊、而且他在不在隊上會讓別人的票分得很開的人，疊他才有資訊（疊票）。
 * 價值 = Σ_投票者 Σ_座位 I(座位紅; 票)（公開視角＝只看公開紀錄的忠臣的後驗；強制局隊長自己那一位不算）。
 */
import type { PlayerObservation, VoteRecord } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesWorlds } from './belief/BayesBelief';
import { flowOfObs, type Flow } from './infl/flow';
import { FlowFeatures, N_BASE, N_EXTRA, RED_CLASSES, ROLE_CLASSES, type SharedSeatView } from './infl/voteFeatures';
import { P_CLIP } from './infl/policyModel';
import { recursiveModels } from './infl/recursiveRead';
import { sigmoid } from './infl/logistic';
import { leaderAhead } from './GoodVoteAlt';

const h2 = (p: number): number => (p <= 1e-12 || p >= 1 - 1e-12 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)));

export interface R1InflCtx {
  worlds: readonly number[];
  wts: readonly number[];
  bit: (id: string) => number;
  ids: readonly string[];
  me: string;
  tailBit: number;
  flow: Flow;
  record: Omit<VoteRecord, 'team'>;
  level0: ReturnType<typeof bayesOptionsOf>;
  shared: Map<string, SharedSeatView>;
}

/** 公開視角的情境（梅林＝坐在他位置、只看公開紀錄的忠臣）；假想的提議接在現在的紀錄後面（第 failCount + 1 次）。 */
export function r1InflCtx(tuning: Readonly<AgentTuning>, obs: PlayerObservation): R1InflCtx {
  const pub = { ...obs, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [] } as PlayerObservation;
  const level0 = bayesOptionsOf({ ...tuning, beliefRecursive: 0, beliefLeadRecursive: 0 });
  const bw = bayesWorlds(pub, level0);
  const tail = leaderAhead(obs, 4 - (obs.failCount ?? 0));
  return {
    worlds: bw.worlds, wts: bw.wts, bit: bw.bitOf, ids: obs.allPlayerIds, me: obs.myPlayerId,
    tailBit: tail && tail !== obs.myPlayerId ? bw.bitOf(tail) : 0,
    flow: flowOfObs(pub),
    record: { round: obs.currentRound ?? 1, attempt: (obs.failCount ?? 0) + 1, leader: obs.myPlayerId, votes: {}, approved: false } as Omit<VoteRecord, 'team'>,
    level0,
    shared: new Map(),
  };
}

/** P(j 贊成 | 世界 w)：j 在 w 裡是藍 → 藍方類別；紅 → 四個紅方類別平均（梅林不另外讀）。 */
function approveProb(ff: FlowFeatures, i: number, j: string, w: number, jRed: boolean, extra: Float64Array<ArrayBuffer>): number {
  const { vote } = recursiveModels();
  const x = ff.base(i, j, w);
  const one = (cls: (typeof ROLE_CLASSES)[number]): number => {
    const b = vote.beta[cls];
    let z = 0;
    for (let k = 0; k < N_BASE; k++) z += b[k] * x[k];
    const ex = ff.extras(i, j, w, cls, 0, extra);
    for (let k = 0; k < N_EXTRA; k++) if (ex[k] !== 0) z += b[N_BASE + k] * ex[k];
    return Math.min(1 - P_CLIP, Math.max(P_CLIP, sigmoid(z)));
  };
  if (!jRed) return one('blue');
  let s = 0;
  for (const c of RED_CLASSES) s += one(c);
  return s / RED_CLASSES.length;
}

/** 這支隊（含隊長）被提議、投票之後的期望資訊（bit）：Σ_投票者 Σ_座位 I(座位紅; 票)，不算強制局隊長那一位。 */
export function r1InfoValueInfl(team: readonly string[], ctx: R1InflCtx): number {
  const { worlds, wts, bit, ids, me, tailBit } = ctx;
  const flow: Flow = { ...ctx.flow, votes: [...ctx.flow.votes, { ...ctx.record, team: [...team] } as VoteRecord] };
  const i = flow.votes.length - 1;
  const ff = new FlowFeatures(flow, { useBayesView: true, bayesViewOptions: ctx.level0, sharedViews: ctx.shared });
  const seats = ids.filter((id) => id !== me && bit(id) !== tailBit).map((id) => bit(id));
  const pRed = seats.map((b) => worlds.reduce((a, w, x) => a + ((w & b) !== 0 ? wts[x] : 0), 0));
  const extra = new Float64Array(N_EXTRA);
  const p1w = new Float64Array(worlds.length);
  let total = 0;
  for (const j of ids) {
    if (j === me) continue;
    const jb = bit(j);
    let p1 = 0;
    worlds.forEach((w, x) => { p1w[x] = approveProb(ff, i, j, w, (w & jb) !== 0, extra); p1 += wts[x] * p1w[x]; });
    const hv = h2(p1);
    seats.forEach((b, k) => {
      const a = pRed[k];
      if (a <= 1e-12 || a >= 1 - 1e-12) return;
      let q1 = 0;
      worlds.forEach((w, x) => { if ((w & b) !== 0) q1 += wts[x] * p1w[x]; });
      total += hv - (a * h2(q1 / a) + (1 - a) * h2((p1 - q1) / (1 - a)));
    });
  }
  return total;
}
