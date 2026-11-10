/**
 * Elo／理論走勢的網站純函式（Edward 2026-11-10「可以切換X軸是場次 … 然後可以取rolling 平均之類的 窗口也可以自訂要幾天/幾場」）：
 * web components/analysis/radar/trendSeries 的移動平均、記住的設定與每場展開。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TREND_VIEW,
  clampWindow,
  dayNumber,
  gamePoints,
  parseTrendView,
  rollingMean,
  trendWindow,
} from '../../../web/src/components/analysis/radar/trendSeries';

const means = (pts: Array<{ mean: number | null }>): Array<number | null> => pts.map((p) => (p.mean === null ? null : Math.round(p.mean * 100) / 100));

describe('rollingMean', () => {
  it('by days: a 7-day window counts calendar days, gaps included, and never fills days nobody played', () => {
    // Days 1, 2, 3, 10, 11, 30 (a week off, then three weeks off).
    const xs = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-10', '2026-05-11', '2026-05-30'].map(dayNumber);
    const ys = [10, 20, 30, 40, 50, 60];
    const out = rollingMean(xs, ys, 7);
    // 05-10 looks back to 05-04: only itself; 05-11 → 05-05..05-11: 05-10, 05-11; 05-30: only itself.
    expect(means(out)).toEqual([10, 15, 20, 40, 45, 60]);
    expect(out.map((p) => p.n)).toEqual([1, 2, 3, 1, 2, 1]);
    // An 8-day window reaches 05-03 from 05-10.
    expect(means(rollingMean(xs, ys, 8))).toEqual([10, 15, 20, 35, 45, 60]);
  });

  it('by games: the game and the window − 1 games before it; nulls (no rated game yet) are skipped', () => {
    const xs = [1, 2, 3, 4, 5, 6];
    expect(means(rollingMean(xs, [1, 2, 3, 4, 5, 6], 3))).toEqual([1, 1.5, 2, 3, 4, 5]);
    const withNulls = rollingMean(xs, [null, null, 3, 5, null, 7], 2);
    expect(means(withNulls)).toEqual([null, null, 3, 4, 5, 7]);
    expect(withNulls.map((p) => p.n)).toEqual([0, 0, 1, 2, 1, 1]);
    expect(means(rollingMean(xs, [1, 2, 3, 4, 5, 6], 1))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a window larger than the data is the running mean of everything so far', () => {
    const xs = [1, 2, 3, 4];
    const out = rollingMean(xs, [4, 8, 6, 2], 100);
    expect(means(out)).toEqual([4, 6, 6, 5]);
    expect(out.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    expect(rollingMean([], [], 7)).toEqual([]);
  });
});

describe('trend view settings', () => {
  it('parses what localStorage remembers, falling back to the defaults', () => {
    expect(DEFAULT_TREND_VIEW).toEqual({ axis: 'date', smooth: false, days: 7, games: 20 });
    expect(parseTrendView(null)).toEqual(DEFAULT_TREND_VIEW);
    expect(parseTrendView('not json')).toEqual(DEFAULT_TREND_VIEW);
    expect(parseTrendView('[]')).toEqual(DEFAULT_TREND_VIEW);
    expect(parseTrendView(JSON.stringify({ axis: 'games', smooth: true, days: 30, games: 50 })))
      .toEqual({ axis: 'games', smooth: true, days: 30, games: 50 });
    expect(parseTrendView(JSON.stringify({ axis: 'weird', smooth: 'yes', days: -4, games: 1e9 })))
      .toEqual({ axis: 'date', smooth: false, days: 1, games: 5000 });
  });

  it('clamps the window input and picks the unit of the axis', () => {
    expect(clampWindow('12.6', 'days')).toBe(13);
    expect(clampWindow('', 'games')).toBe(20);
    expect(clampWindow('abc', 'days')).toBe(7);
    expect(clampWindow(0, 'games')).toBe(1);
    expect(trendWindow({ axis: 'date', smooth: true, days: 30, games: 50 })).toBe(30);
    expect(trendWindow({ axis: 'games', smooth: true, days: 30, games: 50 })).toBe(50);
  });
});

describe('gamePoints', () => {
  it('expands the per-day counts into one point per career game', () => {
    const pts = gamePoints({
      days: [['', 1], ['2026-05-01', 2]], role: [40, 41, 42], position: [50, 51, 52], overall: [45, 46, 47],
      elo: [null, 1490, 1495], sigma: [null, 30, 29], roleFullFrom: 3,
    });
    expect(pts).toEqual([
      { game: 1, date: '', role: 40, position: 50, overall: 45, roleFull: false, elo: null, sigma: null },
      { game: 2, date: '2026-05-01', role: 41, position: 51, overall: 46, roleFull: false, elo: 1490, sigma: 30 },
      { game: 3, date: '2026-05-01', role: 42, position: 52, overall: 47, roleFull: true, elo: 1495, sigma: 29 },
    ]);
  });
});
