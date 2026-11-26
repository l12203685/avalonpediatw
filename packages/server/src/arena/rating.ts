/**
 * AI 擂台的評分：分陣營的隊伍邏輯回歸（Bradley–Terry 的多人隊伍版），一次用全部對局解出來，
 * 跟對局順序無關（不像逐局更新的 Elo），信賴區間從 Hessian 來。
 *
 *   logit P(紅方贏) = c[人數] + 平均_{紅方座位}( red[機器人] ) − 平均_{藍方座位}( blue[機器人] )
 *
 * 百科AI（參考點）的 red = blue = 0。所以「一整邊都換成這隻機器人、對手是百科AI」時勝算的對數變化 = 它的分數；
 * 顯示成 Elo 的尺度：1500 + 400·log10(e)·分數（+100 分 ≈ 同樣對手下勝算 ×1.78）。
 * 其他機器人的分數有一點 L2 收縮（先驗標準差 2），局數少時不會飄太遠。
 */
import type { TableResult } from './table';

export const ELO_SCALE = 400 / Math.LN10;
export const ELO_BASE = 1500;

export interface SideRating {
  /** Elo 尺度的分數。 */
  rating: number;
  /** 95% 信賴區間。 */
  low: number;
  high: number;
}

export interface EntrantRating {
  id: string;
  red: SideRating;
  blue: SideRating;
  overall: SideRating;
}

export interface RatingFit {
  ratings: EntrantRating[];
  /** 各人數的紅方基準勝率（百科AI 對百科AI 時的估計）。 */
  baseRedWin: Record<number, number>;
  iterations: number;
  converged: boolean;
}

const PRIOR_VAR = 4;
const Z = 1.959964;

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** 對稱正定矩陣求反矩陣（Gauss–Jordan，含部分選主元）。 */
export function invert(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('matrix is singular');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * `referenceId` 的分數固定 0。`entrantIds` 決定輸出順序（沒出場的機器人分數 = 0、區間 = 先驗）。
 */
export function fitRatings(tables: readonly TableResult[], entrantIds: readonly string[], referenceId: string): RatingFit {
  const others = entrantIds.filter((id) => id !== referenceId);
  const sizes = [...new Set(tables.map((t) => t.playerCount))].sort((a, b) => a - b);
  const idx = new Map<string, number>();
  sizes.forEach((s, i) => idx.set(`c${s}`, i));
  others.forEach((id, i) => { idx.set(`r:${id}`, sizes.length + 2 * i); idx.set(`b:${id}`, sizes.length + 2 * i + 1); });
  const P = sizes.length + 2 * others.length;
  // 每局的設計向量（稀疏）。
  const rows = tables.map((t) => {
    const x = new Map<number, number>();
    x.set(idx.get(`c${t.playerCount}`)!, 1);
    const red = t.seats.filter((s) => s.team === 'evil');
    const blue = t.seats.filter((s) => s.team === 'good');
    for (const s of red) if (s.entrant !== referenceId) { const k = idx.get(`r:${s.entrant}`); if (k !== undefined) x.set(k, (x.get(k) ?? 0) + 1 / red.length); }
    for (const s of blue) if (s.entrant !== referenceId) { const k = idx.get(`b:${s.entrant}`); if (k !== undefined) x.set(k, (x.get(k) ?? 0) - 1 / blue.length); }
    return { x: [...x.entries()], y: t.winner === 'evil' ? 1 : 0 };
  });
  const isSkill = (k: number): boolean => k >= sizes.length;
  const beta = new Array<number>(P).fill(0);
  let H: number[][] = [];
  let converged = false;
  let it = 0;
  for (; it < 50; it++) {
    const g = new Array<number>(P).fill(0);
    H = Array.from({ length: P }, () => new Array<number>(P).fill(0));
    for (const { x, y } of rows) {
      let eta = 0;
      for (const [k, v] of x) eta += beta[k] * v;
      const p = sigmoid(eta);
      const w = p * (1 - p);
      for (const [k, v] of x) {
        g[k] += (y - p) * v;
        for (const [k2, v2] of x) H[k][k2] += w * v * v2;
      }
    }
    for (let k = 0; k < P; k++) {
      if (isSkill(k)) { g[k] -= beta[k] / PRIOR_VAR; H[k][k] += 1 / PRIOR_VAR; } else H[k][k] += 1e-6;
    }
    const inv = invert(H);
    let maxStep = 0;
    for (let k = 0; k < P; k++) {
      let step = 0;
      for (let j = 0; j < P; j++) step += inv[k][j] * g[j];
      beta[k] += step;
      maxStep = Math.max(maxStep, Math.abs(step));
    }
    if (maxStep < 1e-8) { converged = true; it++; break; }
  }
  const cov = invert(H);
  const side = (mean: number, variance: number): SideRating => {
    const half = Z * Math.sqrt(Math.max(variance, 0));
    return { rating: ELO_BASE + ELO_SCALE * mean, low: ELO_BASE + ELO_SCALE * (mean - half), high: ELO_BASE + ELO_SCALE * (mean + half) };
  };
  const ratings: EntrantRating[] = entrantIds.map((id) => {
    if (id === referenceId) {
      const zero = side(0, 0);
      return { id, red: zero, blue: zero, overall: zero };
    }
    const r = idx.get(`r:${id}`)!;
    const b = idx.get(`b:${id}`)!;
    return {
      id,
      red: side(beta[r], cov[r][r]),
      blue: side(beta[b], cov[b][b]),
      overall: side((beta[r] + beta[b]) / 2, (cov[r][r] + cov[b][b] + 2 * cov[r][b]) / 4),
    };
  });
  const baseRedWin: Record<number, number> = {};
  sizes.forEach((s, i) => { baseRedWin[s] = sigmoid(beta[i]); });
  return { ratings, baseRedWin, iterations: it, converged };
}

// ── 小工具 ─────────────────────────────────────────────

export interface Interval { rate: number; low: number; high: number; n: number; k: number }

/** Wilson 95% 區間。 */
export function wilson(k: number, n: number): Interval {
  if (n === 0) return { rate: 0, low: 0, high: 0, n, k };
  const p = k / n;
  const denom = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half), n, k };
}

/** 成對差的平均與常態近似 95% 區間。 */
export function pairedMean(diffs: readonly number[]): { mean: number; low: number; high: number; n: number } {
  const n = diffs.length;
  if (n === 0) return { mean: 0, low: 0, high: 0, n };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1) : 0;
  const half = Z * Math.sqrt(variance / n);
  return { mean, low: mean - half, high: mean + half, n };
}
