/**
 * 卡方獨立性檢定 (Edward 2026-10-28：「刺客座位有影響嗎? 梅林座位影響比較大吧」)。
 *
 * 給「幾組 × 幾種結果」的局數表 (例：10 個座位 × {刺中, 沒刺中})，回答「各組的結果比例差這麼多，
 * 是不是只是運氣」：
 *   期望局數 = 該組總數 × 該結果總數 ÷ 全部總數 (如果分組完全沒影響，每格該有的局數)
 *   χ² = Σ (實際 − 期望)² ÷ 期望，自由度 = (有資料的組數 − 1) × (有資料的結果數 − 1)
 *   p = 分組完全沒影響時，光靠運氣得到這麼大 (或更大) 的 χ² 的機率 (χ² 分布的右尾)。
 * 全為 0 的列或欄不算 (不影響 χ²，也不該算進自由度)。
 *
 * 純函式、不依賴 React / 瀏覽器：網站各分析分頁的「差異明顯／可能只是運氣」一句話都由這裡算，
 * 測試在 packages/server/src/__tests__/WebAnalysisStats.test.ts。
 */

export interface ChiSquareResult {
  /** χ² 統計量。 */
  chi2: number;
  /** 自由度。 */
  df: number;
  /** 右尾機率 (0–1)。 */
  p: number;
  /** 全部局數。 */
  n: number;
  /** 最小的期望局數 (小於 5 時近似不準，呼叫端可提示樣本少)。 */
  minExpected: number;
}

/** 判讀：p < alpha → 差異明顯；否則差異可能只是運氣。 */
export type ChiSquareVerdict = 'clear' | 'luck';

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(z)，z > 0 (Lanczos，g = 7)。 */
export function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正規化的上不完全 Gamma 函數 Q(a, x) = Γ(a, x) / Γ(a)。 */
export function gammaQ(a: number, x: number): number {
  if (!(a > 0) || !(x >= 0) || !Number.isFinite(x)) return Number.NaN;
  if (x === 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    // 級數展開算 P，再 Q = 1 − P
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return Math.max(0, Math.min(1, 1 - sum * Math.exp(-x + a * Math.log(x) - gln)));
  }
  // 連分數 (Lentz) 直接算 Q
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.max(0, Math.min(1, Math.exp(-x + a * Math.log(x) - gln) * h));
}

/** χ² 分布的右尾機率 P(X ≥ x)，自由度 df。 */
export function chiSquareSurvival(x: number, df: number): number {
  if (!(df > 0)) return Number.NaN;
  if (!(x > 0)) return 1;
  return gammaQ(df / 2, x / 2);
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * table[i][j] = 第 i 組、第 j 種結果的局數 (負數、NaN 當 0)。有資料的組 < 2 或結果 < 2 時回 null
 * (沒有東西可以比)。
 */
export function chiSquareIndependence(table: ReadonlyArray<ReadonlyArray<number>>): ChiSquareResult | null {
  const width = table.reduce((w, row) => Math.max(w, row.length), 0);
  const rows = table.map(row => Array.from({ length: width }, (_, j) => count(row[j])));
  const rowSums = rows.map(row => row.reduce((s, v) => s + v, 0));
  const colSums = Array.from({ length: width }, (_, j) => rows.reduce((s, row) => s + row[j], 0));
  const n = rowSums.reduce((s, v) => s + v, 0);
  const liveRows = rows.map((_, i) => i).filter(i => rowSums[i] > 0);
  const liveCols = colSums.map((_, j) => j).filter(j => colSums[j] > 0);
  if (liveRows.length < 2 || liveCols.length < 2) return null;
  let chi2 = 0;
  let minExpected = Infinity;
  for (const i of liveRows) {
    for (const j of liveCols) {
      const expected = (rowSums[i] * colSums[j]) / n;
      minExpected = Math.min(minExpected, expected);
      chi2 += (rows[i][j] - expected) ** 2 / expected;
    }
  }
  const df = (liveRows.length - 1) * (liveCols.length - 1);
  return { chi2, df, p: chiSquareSurvival(chi2, df), n, minExpected };
}

export function chiSquareVerdict(result: Pick<ChiSquareResult, 'p'>, alpha = 0.05): ChiSquareVerdict {
  return result.p < alpha ? 'clear' : 'luck';
}

/** p 的大約值：< 0.001 寫「<0.001」，其他兩位有效數字 (0.0023 → "0.0023"、0.187 → "0.19")。 */
export function formatPValue(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 0.001) return '<0.001';
  if (p >= 0.995) return '1';
  return String(Number(p.toPrecision(2)));
}
