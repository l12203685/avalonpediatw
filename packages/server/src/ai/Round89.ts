/**
 * 第 89 回合（路線圖 Phase B，Issue #215，`docs/ai/NEXT_GEN_AI_ROADMAP.md`；Gemini 的 worldSpaceMerlinMordred）：
 * 在 210 個紅方世界 W 上面加一層「莫德雷德 D ∈ W、梅林 M ∉ W」的聯合讀法，V = W \ {D} = 梅林看得到的三個紅。
 *
 * 現行預設已經有一層（第 5 回合 `loyalMerlinRead = 2`，`BayesBelief.merlinMixture`）：忠臣把每一個世界照「藍方裡誰是梅林、紅方裡誰是莫德雷德」平均，
 * 梅林的提議**一定**不帶 V、第 3 局起的票**一定**不贊成有 V 的隊（嚴格，違反的機率 0.03）。真人梅林不是這樣：
 * 時間切分（`scripts/worldDM89Rates.ts`，前 2/3 擬合）真人梅林第 1、2 局非強制的提議避開 V 86.6%（一般藍方同一個 V 39.5%），
 * 第 3 局起 88.0%（53.6%），強制局 92.1%（48.0%）；第 3 局起在隊上、隊上有 V 時梅林投贊成 52.0%（嚴格模型說 3%）。
 *
 * `worldDM89 = λ`（0 = 關；關著時這個檔案不改任何東西）：藍方座位（忠臣；位元 1 加派西）的信念把那一層換成這裡的聯合層——每一個世界 W 都照
 * Σ_{D ∈ W} Σ_{M} P(D) P(M) × Π 梅林模型 / 一般藍方模型 重新加權（所有世界一起算，不單邊折扣：第 63 回合 G2 的教訓）：
 * - **提議**（M 當隊長、自己在隊上）：梅林 = a × 「在避開 V 的隊裡平均挑」＋ (1 − a) × 一般藍方的派隊表；a = λ × 擬合的混合權重
 *   （a = (梅林避開率 − 一般藍方避開率) / (1 − 一般藍方避開率)：第 1、2 局非強制 0.779、第 3 局起非強制 0.741、強制局 0.847）。
 *   λ ≥ 1.25 時 a ≈ 1（接近現行的嚴格）。
 * - **票**（M 第 3 局起、非強制）：預設照現行的嚴格；位元 8 = 真人梅林的比例（有 V 的隊：不在隊上 6.1%、在隊上 52.0% 贊成）。
 * - **湖**（位元 2）：M 持湖時查 V 裡的人的比例 8.8%（一般藍方持湖 19.0%）→ 查 V 乘 0.46、查別人乘 1.13。
 * - **紅方持湖宣告分第 1 湖／之後**（位元 4；擬合那一半的比例，真人表）：第 1 湖說壞 目標藍 23.6%、目標紅 16.2%；之後 24.7%、23.1%。
 * - 莫德雷德、梅林都是均勻先驗；派西（位元 1）：M = 這個世界裡是藍的那根拇指，D 不是莫甘娜那根拇指；派西原本的嚴格拇指讀法（提議、票）由這裡取代。
 * - 位元 16 = 聯合層不打折（預設和被取代的那一層一樣乘投票的次方 `beliefTemper`）；位元 32 = 不讀梅林的票（只讀提議與湖）；
 *   位元 64 = 梅林座位的「公開忠臣視角」也用（預設只有真的忠臣／派西座位；紅方座位的讀法一律不變）。
 *
 * 每一個決策點只多一個世界迴圈裡 M × D（≤ 5 × 4）的小乘積；預先算好每一個候選人的提議、票、湖。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';

/** 時間切分前 2/3（1,500 局）擬合的混合權重（`scripts/worldDM89Rates.ts`）。 */
export const DM89_FIT = {
  /** 梅林提議的混合權重 a：第 1、2 局非強制、第 3 局起非強制、強制局。 */
  a12: 0.779,
  a3: 0.741,
  aForced: 0.847,
  /** 梅林第 3 局起、非強制，隊上有 V 時投贊成：不在隊上、在隊上。 */
  voteV: { off: 0.061, on: 0.52 },
  /** 持湖查 V 裡的人：梅林、一般藍方（忠臣＋派西）。 */
  lakeV: { merlin: 0.088, blue: 0.19 },
  /** 紅方持湖說壞：[第 1 湖, 之後] × [目標藍, 目標紅]。 */
  redLakeEvil: { first: [0.236, 0.162], later: [0.247, 0.231] },
} as const;

/** 診斷計數（不影響決策）。 */
export const round89Stats = { applied: 0, percival: 0 };

export interface DM89Cfg {
  lambda: number;
  percival: boolean;
  lake: boolean;
  lakeFirst: boolean;
  softVotes: boolean;
  untempered: boolean;
  noVotes: boolean;
  publicViews: boolean;
}

/** 開關的設定；關著 = null。 */
export function dm89Cfg(t: Readonly<Partial<AgentTuning>>): DM89Cfg | null {
  const lambda = t.worldDM89 ?? 0;
  if (!(lambda > 0)) return null;
  const s = t.worldDM89Scope ?? 0;
  return {
    lambda,
    percival: (s & 1) !== 0,
    lake: (s & 2) !== 0,
    lakeFirst: (s & 4) !== 0,
    softVotes: (s & 8) !== 0,
    untempered: (s & 16) !== 0,
    noVotes: (s & 32) !== 0,
    publicViews: (s & 64) !== 0,
  };
}

/** 這個觀察用不用聯合層：藍方座位（紅方凍結）、忠臣（派西要位元 1），公開忠臣視角要位元 64。 */
export function dm89Applies(cfg: DM89Cfg | null | undefined, obs: PlayerObservation): 'loyal' | 'percival' | null {
  if (!cfg) return null;
  if ((obs.seatTeam ?? obs.myTeam) !== 'good' || obs.redLoyalView === true || obs.myTeam !== 'good') return null;
  if (obs.publicLoyalView === true && !cfg.publicViews) return null;
  if (obs.myRole === 'loyal') return 'loyal';
  if (cfg.percival && obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2 && obs.publicLoyalView !== true) return 'percival';
  return null;
}

/** 紅方持湖說壞的機率（位元 4）：第幾個湖、目標是不是紅。 */
export function dm89RedLakeEvil(first: boolean, targetRed: boolean): number {
  const row = first ? DM89_FIT.redLakeEvil.first : DM89_FIT.redLakeEvil.later;
  return row[targetRed ? 1 : 0];
}

interface PropRec { teamMask: number; size: number; round: number; a: number }
interface VoteRec { teamMask: number; on: boolean; yes: boolean; round: number }
interface LakeRec { tb: number }
interface SeatRec { b: number; props: PropRec[]; votes: VoteRec[]; lakes: LakeRec[] }

export interface DM89Pre {
  mode: 'loyal' | 'percival';
  cfg: DM89Cfg;
  n: number;
  all: number;
  meBit: number;
  thumbMask: number;
  seats: SeatRec[];
  proposalProb: (round: number, k: number) => number;
  voteProb: (on: boolean, hasRed: boolean, round: number) => number;
}

const EPS = 0.03;
const popcount = (x: number): number => { let c = 0; while (x) { x &= x - 1; c++; } return c; };
const CH: number[][] = [];
function choose(n: number, k: number): number {
  if (k < 0 || n < 0 || k > n) return 0;
  if (!CH[n]) CH[n] = [];
  const hit = CH[n][k];
  if (hit !== undefined) return hit;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  CH[n][k] = r;
  return r;
}

/**
 * 預先整理每一個可能是梅林的座位的提議、票、湖（只有公開紀錄；自己的不算）。`proposalProb` / `voteProb` = 呼叫端（`BayesBelief`）現在讀的
 * 一般藍方派隊表與投票表（同一個後驗的表、同一個 mix）。
 */
export function dm89Pre(
  obs: PlayerObservation,
  mode: 'loyal' | 'percival',
  cfg: DM89Cfg,
  bit: (id: string) => number,
  maskOf: (ids: readonly string[]) => number,
  proposalProb: DM89Pre['proposalProb'],
  voteProb: DM89Pre['voteProb'],
): DM89Pre {
  const ids = obs.allPlayerIds;
  const me = obs.myPlayerId;
  const thumbs = mode === 'percival' ? obs.knownWizards ?? [] : [];
  const cand = mode === 'percival' ? thumbs : ids.filter((id) => id !== me);
  const seats: SeatRec[] = cand.map((id) => ({ b: bit(id), props: [], votes: [], lakes: [] }));
  const byId = new Map(cand.map((id, i) => [id, seats[i]] as const));
  for (const v of obs.voteHistory) {
    const forced = v.attempt >= 5;
    const early = v.round <= 2 && !forced;
    const teamMask = maskOf(v.team);
    const s = byId.get(v.leader);
    if (s && v.leader !== me && v.team.includes(v.leader)) {
      const fit = forced ? DM89_FIT.aForced : early ? DM89_FIT.a12 : DM89_FIT.a3;
      const a = Math.min(Math.max(cfg.lambda * fit, 0), 0.999);
      s.props.push({ teamMask, size: v.team.length, round: v.round, a });
    }
    if (v.round >= 3 && !forced && !cfg.noVotes) {
      for (const [id, yes] of Object.entries(v.votes)) {
        const r = byId.get(id);
        if (!r || id === me || yes === undefined) continue;
        r.votes.push({ teamMask, on: v.team.includes(id), yes: yes === true, round: v.round });
      }
    }
  }
  if (cfg.lake) {
    for (const l of obs.lakeHistory ?? []) {
      const s = byId.get(l.holderId);
      if (!s || l.holderId === me) continue;
      s.lakes.push({ tb: bit(l.targetId) });
    }
  }
  return { mode, cfg, n: ids.length, all: maskOf(ids), meBit: bit(me), thumbMask: maskOf(thumbs), seats, proposalProb, voteProb };
}

/** log Σ_{M, D} P(M) P(D) Π (梅林模型 / 一般藍方模型)：世界 `w`（紅方的位元）被「誰是梅林、誰是莫德雷德」重新加權的倍數。 */
export function dm89Log(pre: DM89Pre, w: number): number {
  const { seats, all, n, cfg } = pre;
  const reds: number[] = [];
  for (let x = w & all; x; x &= x - 1) reds.push(x & -x);
  if (reds.length === 0) return 0;
  const ms = seats.filter((s) => (w & s.b) === 0 && s.b !== pre.meBit);
  if (ms.length === 0) return 0;
  // Percival: D is not the Morgana thumb (she is the red thumb in this world).
  const ds = pre.mode === 'percival' ? reds.filter((d) => (d & pre.thumbMask) === 0) : reds;
  if (ds.length === 0) return 0;
  let sum = 0;
  for (const m of ms) {
    const others = all & ~m.b;
    const redsAvail = popcount(w & others);
    const goodsAvail = popcount(others) - redsAvail;
    for (const d of ds) {
      const vis = w & ~d;
      let lr = 0;
      for (const p of m.props) {
        const k = popcount(w & p.teamMask & ~m.b);
        const nk = choose(redsAvail, k) * choose(goodsAvail, p.size - 1 - k);
        if (nk <= 0) continue;
        const pg = pre.proposalProb(p.round, k) / nk;
        if (!(pg > 0)) continue;
        const clean = (p.teamMask & vis) === 0;
        const nClean = choose(popcount(others & ~vis), p.size - 1);
        const pm = (clean && nClean > 0 ? p.a / nClean : 0) + (1 - p.a) * pg;
        lr += Math.log(pm / pg);
      }
      for (const v of m.votes) {
        const seen = (v.teamMask & vis) !== 0;
        const hasRed = (v.teamMask & w) !== 0;
        const pg = Math.min(Math.max(pre.voteProb(v.on, hasRed, v.round), EPS), 1 - EPS);
        let pm = seen ? (cfg.softVotes ? (v.on ? DM89_FIT.voteV.on : DM89_FIT.voteV.off) : EPS) : pre.voteProb(v.on, false, v.round);
        pm = Math.min(Math.max(pm, EPS), 1 - EPS);
        lr += Math.log(v.yes ? pm / pg : (1 - pm) / (1 - pg));
      }
      for (const l of m.lakes) {
        const inV = (l.tb & vis) !== 0;
        lr += Math.log(inV ? DM89_FIT.lakeV.merlin / DM89_FIT.lakeV.blue : (1 - DM89_FIT.lakeV.merlin) / (1 - DM89_FIT.lakeV.blue));
      }
      sum += Math.exp(lr);
    }
  }
  void n;
  return Math.log(sum / (ms.length * ds.length));
}
