import type { TheoryTrendGames } from '../../../services/api';

/**
 * Elo／理論走勢的共用純函式（Edward 2026-11-10「我希望除了照日期以外 可以切換X軸是場次 (因為有時候一天玩20場 隔很久才玩)
 * 然後可以取rolling 平均之類的 窗口也可以自訂要幾天/幾場」）：X 軸（日期／場次）、移動平均的視窗與記住的設定。
 * 不碰 React，伺服器的 vitest 直接測（WebTrendRolling.test.ts）。
 */

export type TrendAxis = 'date' | 'games';

export interface TrendView {
  axis: TrendAxis;
  /** 移動平均開或關。 */
  smooth: boolean;
  /** 日期軸的視窗（天）。 */
  days: number;
  /** 場次軸的視窗（場）。 */
  games: number;
}

export const DEFAULT_TREND_VIEW: TrendView = { axis: 'date', smooth: false, days: 7, games: 20 };
export const DAY_PRESETS = [7, 30, 90];
export const GAME_PRESETS = [10, 20, 50, 100];
export const WINDOW_LIMITS: Record<'days' | 'games', [number, number]> = { days: [1, 3650], games: [1, 5000] };
export const TREND_VIEW_STORAGE_KEY = 'analysis.trend.view';
export const DAY_MS = 86_400_000;

/** 視窗輸入：取整數、夾在上下限裡；不是數字就回預設值。 */
export function clampWindow(value: unknown, unit: 'days' | 'games'): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_TREND_VIEW[unit];
  const [lo, hi] = WINDOW_LIMITS[unit];
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** localStorage 裡記住的設定（壞掉或缺欄位就用預設）。 */
export function parseTrendView(raw: string | null | undefined): TrendView {
  if (!raw) return { ...DEFAULT_TREND_VIEW };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof TrendView, unknown>> | null;
    if (!v || typeof v !== 'object') return { ...DEFAULT_TREND_VIEW };
    return {
      axis: v.axis === 'games' ? 'games' : 'date',
      smooth: v.smooth === true,
      days: v.days === undefined ? DEFAULT_TREND_VIEW.days : clampWindow(v.days, 'days'),
      games: v.games === undefined ? DEFAULT_TREND_VIEW.games : clampWindow(v.games, 'games'),
    };
  } catch {
    return { ...DEFAULT_TREND_VIEW };
  }
}

/** 目前軸的視窗大小（日期軸用天、場次軸用場）。 */
export function trendWindow(view: TrendView): number {
  return view.axis === 'date' ? view.days : view.games;
}

export interface RollingPoint {
  /** 視窗裡有值的點的平均；視窗裡一個值都沒有時為 null。 */
  mean: number | null;
  /** 平均用到幾個點。 */
  n: number;
}

/**
 * 往回看的移動平均：第 i 點 = x 落在 (xs[i] − window, xs[i]] 的所有點（y 為 null 的不算）的平均。
 * xs 要由小到大（日期軸 = 第幾天，同一天只有一點；場次軸 = 生涯第幾場）。所以日期軸的 7 天 = 含當天往回 7 個日曆天，
 * 中間沒出賽的日子沒有點、也不補；場次軸的 20 場 = 這一場與前 19 場。資料不夠一整個視窗時，就用現有的點平均（n 較小）。
 */
export function rollingMean(xs: readonly number[], ys: ReadonlyArray<number | null>, window: number): RollingPoint[] {
  const out: RollingPoint[] = [];
  let lo = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y !== null && Number.isFinite(y)) { sum += y; n += 1; }
    while (lo <= i && xs[lo] <= xs[i] - window) {
      const old = ys[lo];
      if (old !== null && Number.isFinite(old)) { sum -= old; n -= 1; }
      lo += 1;
    }
    out.push({ mean: n > 0 ? sum / n : null, n });
  }
  return out;
}

/** 'YYYY-MM-DD' → 第幾天（UTC 午夜 ÷ 一天），日期軸的移動平均用。 */
export function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

export interface GamePoint {
  /** 生涯第幾場（1 起）。 */
  game: number;
  /** 那一場的日期；牌譜開頭沒有日期的局為 ''。 */
  date: string;
  role: number;
  position: number;
  overall: number;
  roleFull: boolean;
  elo: number | null;
  sigma: number | null;
}

/** 伺服器的每場走勢展開成一場一點。 */
export function gamePoints(g: TheoryTrendGames): GamePoint[] {
  const out: GamePoint[] = [];
  let k = 0;
  for (const [date, count] of g.days) {
    for (let j = 0; j < count; j++) {
      out.push({
        game: k + 1, date, role: g.role[k], position: g.position[k], overall: g.overall[k],
        roleFull: g.roleFullFrom !== null && k + 1 >= g.roleFullFrom, elo: g.elo[k] ?? null, sigma: g.sigma[k] ?? null,
      });
      k += 1;
    }
  }
  return out;
}

/** 約 count 個「好看」的刻度（1、2、5 × 10^n），場次軸與 Elo 的 Y 軸用。 */
export function niceTicks(min: number, max: number, count: number): number[] {
  const span = Math.max(max - min, 1);
  const raw = span / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}
