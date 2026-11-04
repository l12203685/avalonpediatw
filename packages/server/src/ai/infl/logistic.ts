/**
 * 多變數邏輯迴歸（資訊流研究原型，2026-11-04；docs/ai/infl_research.md）。
 *
 * 牛頓法（IRLS）＋ L2 收縮（截距不收縮），沒有外部相依。特徵數幾十個、樣本數十萬以內：每一步 O(n·d²)，
 * 十步左右收斂。只給研究腳本與原型用，正式流程沒有讀它。
 */

/** 解 A x = b（A 對稱正定；Cholesky，A 會被覆寫）。失敗回傳 null。 */
function choleskySolve(a: Float64Array, b: Float64Array, d: number): Float64Array | null {
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i * d + j];
      for (let k = 0; k < j; k++) s -= a[i * d + k] * a[j * d + k];
      if (i === j) {
        if (s <= 1e-12) return null;
        a[i * d + i] = Math.sqrt(s);
      } else {
        a[i * d + j] = s / a[j * d + j];
      }
    }
  }
  const y = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= a[i * d + k] * y[k];
    y[i] = s / a[i * d + i];
  }
  const x = new Float64Array(d);
  for (let i = d - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < d; k++) s -= a[k * d + i] * x[k];
    x[i] = s / a[i * d + i];
  }
  return x;
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

export function dot(beta: Float64Array, x: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < beta.length; k++) s += beta[k] * x[k];
  return s;
}

export interface LogisticFitOptions {
  /** L2 強度（每個係數；第 0 個特徵當截距，不收縮）。 */
  lambda?: number;
  iters?: number;
  /** 只用 `cols[i] = 1` 的特徵（其餘係數固定 0）；缺 = 全用。 */
  cols?: ArrayLike<number>;
  /**
   * 第 26 回合：L2 收縮的中心（缺 = 0）。給「強者的係數向全體真人的係數收縮」（後退）用；有中心時截距也向中心收縮。
   */
  prior?: ArrayLike<number>;
}

/**
 * 擬合 P(y=1 | x) = σ(β·x)。`xs[i]` 的長度都一樣，第 0 個分量應該是常數 1（截距）。
 * 回傳 β；樣本是空的就回傳全 0。
 */
export function fitLogisticRegression(
  xs: readonly ArrayLike<number>[],
  ys: ArrayLike<number>,
  opts: LogisticFitOptions = {},
): Float64Array {
  const d = xs.length > 0 ? xs[0].length : 0;
  const beta = new Float64Array(d);
  if (opts.prior) for (let i = 0; i < d; i++) beta[i] = opts.prior[i] ?? 0;
  if (xs.length === 0) return beta;
  const prior = opts.prior;
  const lambda = opts.lambda ?? 1;
  const iters = opts.iters ?? 20;
  const use = opts.cols ? Array.from({ length: d }, (_, i) => opts.cols![i] !== 0) : Array.from({ length: d }, () => true);
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(d);
    const h = new Float64Array(d * d);
    for (let n = 0; n < xs.length; n++) {
      const x = xs[n];
      const p = sigmoid(dot(beta, x));
      const r = ys[n] - p;
      const w = Math.max(p * (1 - p), 1e-9);
      for (let i = 0; i < d; i++) {
        const xi = x[i];
        if (xi === 0 || !use[i]) continue;
        g[i] += r * xi;
        const wi = w * xi;
        for (let j = 0; j <= i; j++) if (use[j]) h[i * d + j] += wi * x[j];
      }
    }
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < i; j++) h[j * d + i] = h[i * d + j];
      if (!use[i]) { g[i] = 0; h[i * d + i] = 1; continue; }
      if (prior) { g[i] -= lambda * (beta[i] - (prior[i] ?? 0)); h[i * d + i] += lambda; } else if (i > 0) { g[i] -= lambda * beta[i]; h[i * d + i] += lambda; } else h[0] += 1e-6;
    }
    const step = choleskySolve(h, g, d);
    if (!step) break;
    let moved = 0;
    for (let i = 0; i < d; i++) { beta[i] += step[i]; moved += Math.abs(step[i]); }
    if (moved < 1e-7) break;
  }
  return beta;
}
