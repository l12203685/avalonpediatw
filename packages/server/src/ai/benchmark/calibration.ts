/**
 * 信念校準曲線（methods_backlog.md 第 1 項）：把「機器人說某人是紅的機率 p」和「他其實是不是紅」配對，
 * 看 p 說 30% 的人是不是真的有 30% 是紅。累加器只存細格（100 格）的加總，可以分片計算再合併；
 * Brier 與對數損失是逐點精確值，ECE／可靠度圖用 10 個粗格，Platt 斜率用細格的分組邏輯迴歸。
 *
 * 純函式；資料與重播在 `scripts/beliefCalibrationCurve.ts`。
 */

export const FINE_BINS = 100;
const EPS = 1e-6;

export interface CalAcc {
  n: number[];
  /** Σp */
  sp: number[];
  /** Σy */
  sy: number[];
  /** Σp² */
  spp: number[];
  /** Σp·y */
  spy: number[];
  /** Σ 對數損失（自然對數，p 夾在 [1e-6, 1 − 1e-6]） */
  sll: number[];
}

export function newAcc(): CalAcc {
  const z = (): number[] => new Array(FINE_BINS).fill(0);
  return { n: z(), sp: z(), sy: z(), spp: z(), spy: z(), sll: z() };
}

export function addPoint(a: CalAcc, p: number, y: 0 | 1): void {
  const q = Math.min(1, Math.max(0, p));
  const b = Math.min(FINE_BINS - 1, Math.floor(q * FINE_BINS));
  const c = Math.min(1 - EPS, Math.max(EPS, q));
  a.n[b] += 1;
  a.sp[b] += q;
  a.sy[b] += y;
  a.spp[b] += q * q;
  a.spy[b] += q * y;
  a.sll[b] += -(y ? Math.log(c) : Math.log(1 - c));
}

export function mergeAcc(...accs: readonly CalAcc[]): CalAcc {
  const out = newAcc();
  for (const a of accs) {
    for (const k of ['n', 'sp', 'sy', 'spp', 'spy', 'sll'] as const) {
      for (let i = 0; i < FINE_BINS; i++) out[k][i] += a[k][i] ?? 0;
    }
  }
  return out;
}

export interface CurveBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  /** 真的是紅的比例。 */
  freq: number;
  ciLo: number;
  ciHi: number;
}

export interface CurveSummary {
  n: number;
  baseRate: number;
  meanP: number;
  brier: number;
  /** 一律猜基準率的 Brier（= 不確定度）。 */
  brierBase: number;
  /** 平均對數損失（nats）。 */
  logLoss: number;
  logLossBase: number;
  /** Σ n_k |meanP_k − freq_k| / N（10 格）。 */
  ece: number;
  /** n ≥ 30 的格裡最大的 |meanP − freq|。 */
  mce: number;
  /** Murphy 分解（10 格）：Brier ≈ 可靠度 − 鑑別度 + 不確定度。 */
  reliability: number;
  resolution: number;
  /**
   * 重新校準 logit(真紅) = a + b·logit(p)（細格分組邏輯迴歸）：b < 1 = 過度自信（機率要往 50% 拉），b > 1 = 不夠自信；
   * a ≠ 0 = 整體偏紅／偏藍。
   */
  platt: { a: number; b: number } | null;
  bins: CurveBin[];
}

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [NaN, NaN];
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const logit = (p: number): number => { const c = Math.min(1 - EPS, Math.max(EPS, p)); return Math.log(c / (1 - c)); };

/** 分組邏輯迴歸（IRLS）：成功數 s_j、試驗數 n_j、自變數 x_j。 */
export function groupedLogistic(x: readonly number[], s: readonly number[], n: readonly number[]): { a: number; b: number } | null {
  let a = 0;
  let b = 1;
  for (let it = 0; it < 50; it++) {
    let g0 = 0; let g1 = 0; let h00 = 0; let h01 = 0; let h11 = 0;
    for (let j = 0; j < x.length; j++) {
      if (!n[j]) continue;
      const mu = 1 / (1 + Math.exp(-(a + b * x[j])));
      const w = n[j] * mu * (1 - mu);
      const r = s[j] - n[j] * mu;
      g0 += r; g1 += r * x[j];
      h00 += w; h01 += w * x[j]; h11 += w * x[j] * x[j];
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) return null;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da; b += db;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}

export function summarize(a: CalAcc, coarse = 10): CurveSummary {
  const N = a.n.reduce((s, x) => s + x, 0);
  const sum = (k: keyof CalAcc): number => a[k].reduce((s, x) => s + x, 0);
  const sy = sum('sy');
  const base = N ? sy / N : NaN;
  const brier = N ? (sum('spp') - 2 * sum('spy') + sy) / N : NaN;
  const logLoss = N ? sum('sll') / N : NaN;
  const cb = Math.min(1 - EPS, Math.max(EPS, base));
  const bins: CurveBin[] = [];
  const per = FINE_BINS / coarse;
  let ece = 0; let mce = 0; let rel = 0; let res = 0;
  for (let k = 0; k < coarse; k++) {
    let n = 0; let sp = 0; let y = 0;
    for (let i = k * per; i < (k + 1) * per; i++) { n += a.n[i]; sp += a.sp[i]; y += a.sy[i]; }
    const [lo, hi] = wilson(y, n);
    const meanP = n ? sp / n : NaN;
    const freq = n ? y / n : NaN;
    bins.push({ lo: k / coarse, hi: (k + 1) / coarse, n, meanP, freq, ciLo: lo, ciHi: hi });
    if (n) {
      ece += (n * Math.abs(meanP - freq)) / N;
      rel += (n * (meanP - freq) ** 2) / N;
      res += (n * (freq - base) ** 2) / N;
      if (n >= 30) mce = Math.max(mce, Math.abs(meanP - freq));
    }
  }
  const xs: number[] = []; const ss: number[] = []; const ns: number[] = [];
  for (let i = 0; i < FINE_BINS; i++) {
    if (!a.n[i]) continue;
    xs.push(logit(a.sp[i] / a.n[i])); ss.push(a.sy[i]); ns.push(a.n[i]);
  }
  return {
    n: N, baseRate: base, meanP: N ? sum('sp') / N : NaN, brier, brierBase: base * (1 - base),
    logLoss, logLossBase: N ? -(base * Math.log(cb) + (1 - base) * Math.log(1 - cb)) : NaN,
    ece: N ? ece : NaN, mce, reliability: rel, resolution: res,
    platt: xs.length >= 2 ? groupedLogistic(xs, ss, ns) : null,
    bins,
  };
}
