/**
 * 殘差層的擬合（純函式；`scripts/knightFidelity.ts` 用）。
 *
 * 兩種模型，都用牛頓法、L2 收縮到一個先驗向量（全體玩家擬合出來的權重；全體本身收縮到 0）：
 *   - logistic（投票、任務牌、湖中宣告）：P(y = 1) = σ(β·x)。
 *   - 條件 logit（派隊、湖中對象、刺殺）：P(選 j) = softmax(β·x_j)，候選數每個決策點不同。
 * 目標 = −Σ wᵢ log P(yᵢ) + (λ/2)‖β − β₀‖²。λ 越大越貼近先驗（資料少的玩家自動靠向全體）。
 */

export interface LogisticRow { x: readonly number[]; y: 0 | 1; w?: number }
export interface ChoiceRow { X: readonly (readonly number[])[]; y: number; w?: number }

/** 解 A x = b（A 對稱正定；高斯消去、部分選主元）。 */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0);
const matrix = (n: number): number[][] => Array.from({ length: n }, () => zeros(n));

function logSigmoid(z: number): number {
  return z >= 0 ? -Math.log1p(Math.exp(-z)) : z - Math.log1p(Math.exp(z));
}

function penalty(beta: readonly number[], prior: readonly number[], lambda: number): number {
  let s = 0;
  for (let i = 0; i < beta.length; i++) s += (beta[i] - prior[i]) ** 2;
  return 0.5 * lambda * s;
}

export function logisticLoss(rows: readonly LogisticRow[], beta: readonly number[], prior: readonly number[], lambda: number): number {
  let s = 0;
  for (const r of rows) {
    let z = 0;
    for (let i = 0; i < beta.length; i++) z += beta[i] * r.x[i];
    s -= (r.w ?? 1) * logSigmoid(r.y === 1 ? z : -z);
  }
  return s + penalty(beta, prior, lambda);
}

export function fitLogistic(rows: readonly LogisticRow[], prior: readonly number[], lambda: number, opts: { iters?: number; start?: readonly number[] } = {}): number[] {
  const d = prior.length;
  let beta = [...(opts.start ?? prior)];
  let loss = logisticLoss(rows, beta, prior, lambda);
  for (let it = 0; it < (opts.iters ?? 25); it++) {
    const g = beta.map((b, i) => lambda * (b - prior[i]));
    const H = matrix(d);
    for (let i = 0; i < d; i++) H[i][i] = lambda + 1e-6;
    for (const r of rows) {
      let z = 0;
      for (let i = 0; i < d; i++) z += beta[i] * r.x[i];
      const p = 1 / (1 + Math.exp(-z));
      const w = r.w ?? 1;
      const e = w * (p - r.y);
      const h = w * p * (1 - p);
      for (let i = 0; i < d; i++) {
        const xi = r.x[i];
        if (xi === 0) continue;
        g[i] += e * xi;
        for (let k = i; k < d; k++) H[i][k] += h * xi * r.x[k];
      }
    }
    for (let i = 0; i < d; i++) for (let k = 0; k < i; k++) H[i][k] = H[k][i];
    const step = solve(H, g);
    let t = 1;
    let next = beta;
    let nextLoss = loss;
    for (let ls = 0; ls < 20; ls++) {
      next = beta.map((b, i) => b - t * step[i]);
      nextLoss = logisticLoss(rows, next, prior, lambda);
      if (nextLoss <= loss) break;
      t /= 2;
    }
    if (nextLoss > loss) break;
    const done = loss - nextLoss < 1e-7 * Math.max(1, Math.abs(loss));
    beta = next;
    loss = nextLoss;
    if (done) break;
  }
  return beta;
}

export function choiceLoss(rows: readonly ChoiceRow[], beta: readonly number[], prior: readonly number[], lambda: number): number {
  let s = 0;
  for (const r of rows) {
    let m = -Infinity;
    const z = r.X.map((x) => { let v = 0; for (let i = 0; i < beta.length; i++) v += beta[i] * x[i]; if (v > m) m = v; return v; });
    let se = 0;
    for (const v of z) se += Math.exp(v - m);
    s -= (r.w ?? 1) * (z[r.y] - m - Math.log(se));
  }
  return s + penalty(beta, prior, lambda);
}

export function fitChoice(rows: readonly ChoiceRow[], prior: readonly number[], lambda: number, opts: { iters?: number; start?: readonly number[] } = {}): number[] {
  const d = prior.length;
  let beta = [...(opts.start ?? prior)];
  let loss = choiceLoss(rows, beta, prior, lambda);
  for (let it = 0; it < (opts.iters ?? 25); it++) {
    const g = beta.map((b, i) => lambda * (b - prior[i]));
    const H = matrix(d);
    for (let i = 0; i < d; i++) H[i][i] = lambda + 1e-6;
    const ex = zeros(d);
    for (const r of rows) {
      const w = r.w ?? 1;
      let m = -Infinity;
      const z = r.X.map((x) => { let v = 0; for (let i = 0; i < d; i++) v += beta[i] * x[i]; if (v > m) m = v; return v; });
      let se = 0;
      const p = z.map((v) => { const e = Math.exp(v - m); se += e; return e; });
      ex.fill(0);
      for (let j = 0; j < p.length; j++) {
        p[j] /= se;
        if (p[j] < 1e-9) continue;
        const x = r.X[j];
        for (let i = 0; i < d; i++) ex[i] += p[j] * x[i];
      }
      const xy = r.X[r.y];
      for (let i = 0; i < d; i++) g[i] += w * (ex[i] - xy[i]);
      // H += w (E[x xᵀ] − E[x] E[x]ᵀ) = w Σ p_j (x_j − E[x])(x_j − E[x])ᵀ
      for (let j = 0; j < p.length; j++) {
        if (p[j] < 1e-9) continue;
        const x = r.X[j];
        const pj = w * p[j];
        for (let i = 0; i < d; i++) {
          const di = x[i] - ex[i];
          if (di === 0) continue;
          const a = pj * di;
          for (let k = i; k < d; k++) H[i][k] += a * (x[k] - ex[k]);
        }
      }
    }
    for (let i = 0; i < d; i++) for (let k = 0; k < i; k++) H[i][k] = H[k][i];
    const step = solve(H, g);
    let t = 1;
    let next = beta;
    let nextLoss = loss;
    for (let ls = 0; ls < 20; ls++) {
      next = beta.map((b, i) => b - t * step[i]);
      nextLoss = choiceLoss(rows, next, prior, lambda);
      if (nextLoss <= loss) break;
      t /= 2;
    }
    if (nextLoss > loss) break;
    const done = loss - nextLoss < 1e-7 * Math.max(1, Math.abs(loss));
    beta = next;
    loss = nextLoss;
    if (done) break;
  }
  return beta;
}

/** 向量 ↔ `{特徵: 權重}`（只留絕對值 ≥ 0.001 的、三位小數）。 */
export function toWeights(names: readonly string[], beta: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  names.forEach((n, i) => { const v = Math.round(beta[i] * 1000) / 1000; if (Math.abs(v) >= 0.001) out[n] = v; });
  return out;
}

export function fromWeights(names: readonly string[], w: Readonly<Record<string, number>> | undefined): number[] {
  return names.map((n) => w?.[n] ?? 0);
}

/** 二元分類的 precision／recall／F1（預測的正例、真的正例）。 */
export function prf(pairs: ReadonlyArray<readonly [boolean, boolean]>): { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null } {
  let tp = 0; let fp = 0; let fn = 0;
  for (const [pred, truth] of pairs) {
    if (pred && truth) tp++;
    else if (pred && !truth) fp++;
    else if (!pred && truth) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn, precision, recall, f1 };
}

/**
 * 自我一致度（天花板的估計）：同一個「局面簽名」裡，留一個出來、用其他次最常見的選擇去猜它，猜中的比例。
 * `ties` = 同一個簽名裡和那個選擇分不開的完全選擇有幾個（例如兩個座位特徵一樣：猜中類別也只有 1/ties 機會猜中確切的隊）。
 * 只有一次的簽名不算（沒有東西可以比）。
 */
export function selfConsistency(items: ReadonlyArray<{ sig: string; choice: string; ties?: number }>): { n: number; hit: number } {
  const bySig = new Map<string, Map<string, number>>();
  for (const it of items) {
    let m = bySig.get(it.sig);
    if (!m) { m = new Map(); bySig.set(it.sig, m); }
    m.set(it.choice, (m.get(it.choice) ?? 0) + 1);
  }
  let n = 0;
  let hit = 0;
  for (const it of items) {
    const m = bySig.get(it.sig)!;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (total < 2) continue;
    // 留一：自己的選擇少算一次。
    let best = -1;
    const winners: string[] = [];
    for (const [c, k0] of m) {
      const k = c === it.choice ? k0 - 1 : k0;
      if (k > best) { best = k; winners.length = 0; winners.push(c); } else if (k === best) winners.push(c);
    }
    n += 1;
    if (winners.includes(it.choice)) hit += 1 / winners.length / Math.max(1, it.ties ?? 1);
  }
  return { n, hit };
}
