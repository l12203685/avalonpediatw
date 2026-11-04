/**
 * 以策略為本的投票概似（資訊流研究原型 (a)，2026-11-04；docs/ai/infl_research.md）。
 *
 * P(j 在第 t 次提議的票 | 世界 w, INFL_t) = Σ_角色 P(角色 | w) · σ(β_角色 · x(j, t, w))，x 見 `voteFeatures.ts`。
 * 角色在一個世界裡是一起決定的（一局固定）：同一個人所有的票用同一個角色，紅方四個角色是一個排列（24 種），
 * 梅林是觀察者以外的藍方之一，梅林看不到的紅＝那個排列裡的莫德雷德。所以世界的票概似是
 *   Π_藍 L_藍(b) × (1 / (24·|B|)) Σ_d [ Σ_{d = 莫德雷德的排列} Π_紅 L_角色(r) ] × [ Σ_m L_梅林(m | d) / L_藍(m) ]，
 * 一個世界只要幾千次加法（基本特徵的內積快取在 (提議, 座位, 湖結果)）。觀察者是梅林時，梅林不在別人裡、d 就是他看不到的那個紅。
 */
import type { ReplayGame } from '../benchmark/sheetsReplay';
import { campOf } from '../benchmark/sheetsReplay';
import { fitLogisticRegression, dot, sigmoid } from './logistic';
import { FEATURE_NAMES, FlowFeatures, N_BASE, N_EXTRA, RED_CLASSES, ROLE_CLASSES, roleClassOf, type RoleClass } from './voteFeatures';
import { bitOf, type Flow } from './flow';

export const P_CLIP = 0.005;

export interface PolicyModel {
  /** β 每個角色類別：前 N_BASE 個對基本特徵、後 N_EXTRA 個對角色私訊特徵。 */
  beta: Record<RoleClass, Float64Array>;
  residual: boolean;
  useBayesView: boolean;
}

/** 一局的真相世界（紅方座位遮罩）與每個座位的角色類別。 */
export function truthOf(game: ReplayGame, flow: Flow): { w: number; cls: RoleClass[]; mordredBit: number } {
  let w = 0;
  let mordredBit = 0;
  game.seatRoles.forEach((r, k) => {
    if (campOf(r) === 'evil') w |= bitOf(flow, flow.ids[k]);
    if (r === 'mordred') mordredBit = bitOf(flow, flow.ids[k]);
  });
  return { w, cls: game.seatRoles.map(roleClassOf), mordredBit };
}

export interface TrainingSet {
  xs: Record<RoleClass, Float32Array[]>;
  ys: Record<RoleClass, number[]>;
  /** 每個樣本來自第幾局（`items` 的索引；交叉擬合分折用）。 */
  game: Record<RoleClass, number[]>;
}

/** 訓練樣本：每一局每一張可信的票，用真相世界算特徵。 */
export function collectTraining(items: readonly { game: ReplayGame; features: FlowFeatures }[]): TrainingSet {
  const xs = Object.fromEntries(ROLE_CLASSES.map((c) => [c, [] as Float32Array[]])) as Record<RoleClass, Float32Array[]>;
  const ys = Object.fromEntries(ROLE_CLASSES.map((c) => [c, [] as number[]])) as Record<RoleClass, number[]>;
  const gameOf = Object.fromEntries(ROLE_CLASSES.map((c) => [c, [] as number[]])) as Record<RoleClass, number[]>;
  items.forEach(({ game, features }, gi) => {
    const flow = features.flow;
    const truth = truthOf(game, flow);
    flow.votes.forEach((v, i) => {
      if (!features.reliable(i)) return;
      flow.ids.forEach((j, k) => {
        const vote = v.votes[j];
        if (vote === undefined) return;
        const cls = truth.cls[k];
        xs[cls].push(Float32Array.from(features.full(i, j, truth.w, cls, truth.mordredBit)));
        ys[cls].push(vote ? 1 : 0);
        gameOf[cls].push(gi);
      });
    });
  });
  return { xs, ys, game: gameOf };
}

/** 模型用到的特徵欄（1 = 用）：沒有殘差就拿掉「隊上有沒有紅」，沒有貝氏視角就拿掉 b* 欄。 */
export function featureColumns(opts: { residual: boolean; useBayesView: boolean }): Uint8Array {
  const cols = new Uint8Array(N_BASE + N_EXTRA).fill(1);
  FEATURE_NAMES.forEach((name, k) => {
    if (!opts.residual && (name === 'hasRed' || name === 'on×hasRed')) cols[k] = 0;
    if (!opts.useBayesView && /^b[A-Z]|×bLogit/.test(name)) cols[k] = 0;
  });
  return cols;
}

export function fitPolicyModel(
  train: TrainingSet,
  opts: { residual: boolean; useBayesView: boolean; lambda?: number; include?: (index: number) => boolean },
): PolicyModel {
  const beta = {} as Record<RoleClass, Float64Array>;
  const cols = featureColumns(opts);
  for (const c of ROLE_CLASSES) {
    const keep = opts.include ? train.xs[c].map((_, n) => opts.include!(train.game[c][n])) : null;
    const xs = keep ? train.xs[c].filter((_, n) => keep[n]) : train.xs[c];
    const ys = keep ? train.ys[c].filter((_, n) => keep[n]) : train.ys[c];
    beta[c] = fitLogisticRegression(xs, ys, { lambda: opts.lambda ?? 2, iters: 15, cols });
  }
  return { beta, residual: opts.residual, useBayesView: opts.useBayesView };
}

export function policyVoteProb(m: PolicyModel, cls: RoleClass, x: ArrayLike<number>, approve: boolean): number {
  const p = Math.min(1 - P_CLIP, Math.max(P_CLIP, sigmoid(dot(m.beta[cls], x))));
  return approve ? p : 1 - p;
}

function logSumExp(xs: readonly number[]): number {
  let mx = -Infinity;
  for (const x of xs) if (x > mx) mx = x;
  if (!Number.isFinite(mx)) return mx;
  let s = 0;
  for (const x of xs) s += Math.exp(x - mx);
  return mx + Math.log(s);
}

/** 三個角色排到三個人的六種排列。 */
const PERMS3: readonly (readonly number[])[] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/**
 * 一個觀察者讀前 `upTo` 次提議的票時，策略模型的世界概似（log）。`viewer` 自己的票不算、強制局不算。
 * `viewerSeesReds`：觀察者是梅林時他看得到的紅（世界裡不在這裡面的那個紅就是莫德雷德），否則 null。
 */
export class PolicyVoteReader {
  private readonly dotCache = new Map<string, Float64Array>();
  /** 不隨世界變的 (提議, 座位) 內積：索引 i · 人數 + 座位；undefined = 還沒算，null = 會隨世界變（走 dotCache）。 */
  private readonly flat: (Float64Array | null | undefined)[] = [];
  private readonly extra = new Float64Array(N_EXTRA);

  constructor(readonly model: PolicyModel, readonly features: FlowFeatures) {}

  private baseDots(i: number, j: string, w: number): Float64Array {
    const n = this.features.flow.ids.length;
    const idx = i * n + this.features.flow.ids.indexOf(j);
    let slot = this.flat[idx];
    if (slot === undefined) {
      slot = this.features.dependsOnWorld(i, j) ? null : this.compute(i, j, w);
      this.flat[idx] = slot;
    }
    if (slot) return slot;
    const key = `${i}|${j}|${w}`;
    let d = this.dotCache.get(key);
    if (!d) { d = this.compute(i, j, w); this.dotCache.set(key, d); }
    return d;
  }

  private compute(i: number, j: string, w: number): Float64Array {
    const x = this.features.base(i, j, w);
    const d = new Float64Array(ROLE_CLASSES.length);
    ROLE_CLASSES.forEach((c, ci) => {
      const b = this.model.beta[c];
      let s = 0;
      for (let k = 0; k < N_BASE; k++) s += b[k] * x[k];
      d[ci] = s;
    });
    return d;
  }

  /** log P(j 的票 | 角色類別, 世界 w)，加總 j 在前 upTo 次提議的所有票。 */
  seatLog(j: string, upTo: number, w: number, cls: RoleClass, mordredBit = 0): number {
    const f = this.features;
    const ci = ROLE_CLASSES.indexOf(cls);
    const b = this.model.beta[cls];
    let lp = 0;
    for (let i = 0; i < upTo; i++) {
      if (!f.voted(i)) continue;
      const vote = f.flow.votes[i].votes[j];
      if (vote === undefined) continue;
      let z = this.baseDots(i, j, w)[ci];
      const ex = f.extras(i, j, w, cls, mordredBit, this.extra);
      for (let k = 0; k < N_EXTRA; k++) if (ex[k] !== 0) z += b[N_BASE + k] * ex[k];
      const p = Math.min(1 - P_CLIP, Math.max(P_CLIP, sigmoid(z)));
      lp += Math.log(vote ? p : 1 - p);
    }
    return lp;
  }

  /** 世界 w 的票概似（log），角色在世界裡一起決定（見檔頭）。 */
  worldLog(viewer: string, upTo: number, w: number, viewerSeesReds: number | null): number {
    const flow = this.features.flow;
    const reds: string[] = [];
    const blues: string[] = [];
    for (const id of flow.ids) {
      if (id === viewer) continue;
      if ((w & bitOf(flow, id)) !== 0) reds.push(id); else blues.push(id);
    }
    if (reds.length !== 4) {
      // 非標準配置：紅方角色平均、沒有梅林層。
      let lp = 0;
      for (const b of blues) lp += this.seatLog(b, upTo, w, 'blue');
      for (const r of reds) lp += logSumExp(RED_CLASSES.map((c) => this.seatLog(r, upTo, w, c))) - Math.log(RED_CLASSES.length);
      return lp;
    }
    const lr = reds.map((r) => RED_CLASSES.map((c) => this.seatLog(r, upTo, w, c)));
    const lb = blues.map((b) => this.seatLog(b, upTo, w, 'blue'));
    let lp = lb.reduce((a, x) => a + x, 0);
    const MORDRED = RED_CLASSES.indexOf('mordred');
    const others = RED_CLASSES.map((_, k) => k).filter((k) => k !== MORDRED);
    const terms: number[] = [];
    reds.forEach((d, di) => {
      if (viewerSeesReds !== null && (viewerSeesReds & bitOf(flow, d)) !== 0) return;
      const rest = reds.map((_, k) => k).filter((k) => k !== di);
      const permTerms = PERMS3.map((perm) => rest.reduce((a, rk, pi) => a + lr[rk][others[perm[pi]]], lr[di][MORDRED]));
      const permLog = logSumExp(permTerms) - Math.log(24);
      if (viewerSeesReds !== null) { terms.push(permLog); return; }
      const dBit = bitOf(flow, d);
      const merlinTerms = blues.map((m, mi) => this.seatLog(m, upTo, w, 'merlin', dBit) - lb[mi]);
      terms.push(permLog + logSumExp(merlinTerms) - Math.log(Math.max(1, blues.length)));
    });
    lp += terms.length > 0 ? logSumExp(terms) : 0;
    return lp;
  }
}
