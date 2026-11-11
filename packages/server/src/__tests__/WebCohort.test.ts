/**
 * 網站的分組切點（packages/web/src/stats/cohortCuts.ts）與分享連結的 &c=…（statsFilter.ts filterHash／parseStatsQuery、
 * utils/statsLinks.ts）。純函式＋zustand（沒有 window：localStorage 讀寫失敗時就是預設、不記）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COHORT_CUTS, decodeFilter } from '@avalon/shared/stats';
import { cohortCutsParam, useCohortCuts } from '../../../web/src/stats/cohortCuts';
import { filterHash, parseStatsQuery } from '../../../web/src/stats/statsFilter';
import { parseStatsHash } from '../../../web/src/utils/statsLinks';
import { applySharedFilter } from '../../../web/src/stats/sharedFilter';
import { cohortShade, SHADE_FULL, SHADE_PRIOR } from '../../../web/src/components/analysis/cohort/cohortFormat';

describe('web: cohort cut points', () => {
  it('starts at the defaults (80/20, 55/38) when nothing is stored', () => {
    expect(useCohortCuts.getState().cuts).toEqual(DEFAULT_COHORT_CUTS);
    expect(cohortCutsParam(DEFAULT_COHORT_CUTS)).toBeNull();
  });

  it('rejects invalid cut points and keeps the previous ones; reset goes back to the defaults', () => {
    const { setCuts, reset } = useCohortCuts.getState();
    expect(setCuts({ prHi: 20, prLo: 80, sHi: 55, sLo: 38 })).toBe(false);
    expect(useCohortCuts.getState().cuts).toEqual(DEFAULT_COHORT_CUTS);
    expect(setCuts({ prHi: 69, prLo: 31, sHi: 49.3, sLo: 40.9 })).toBe(true);
    expect(useCohortCuts.getState().cuts).toEqual({ prHi: 69, prLo: 31, sHi: 49.3, sLo: 40.9 });
    expect(cohortCutsParam(useCohortCuts.getState().cuts)).toBe('69-31-49.3-40.9');
    reset();
    expect(useCohortCuts.getState().cuts).toEqual(DEFAULT_COHORT_CUTS);
  });

  it('the share link carries non-default cuts as &c=… next to the filter', () => {
    expect(filterHash(null)).toBe('#stats');
    expect(filterHash(null, '69-31-49.3-40.9')).toBe('#stats?c=69-31-49.3-40.9');
    const filter = decodeFilter(filterHash({ v: 1, clauses: [{ kind: 'category', in: ['線瓦'] }] }).slice('#stats?f='.length)).filter;
    const hash = filterHash(filter, '70-30-55-38');
    expect(hash).toMatch(/^#stats\?f=1\.[\w-]+&c=70-30-55-38$/);
    expect(parseStatsQuery(hash.slice('#stats?'.length)).cuts).toBe('70-30-55-38');
    expect(parseStatsHash(hash)).toMatchObject({ kind: 'stats', cuts: '70-30-55-38' });
    expect(parseStatsHash('#stats?c=69-31-49.3-40.9')).toEqual({ kind: 'stats', cuts: '69-31-49.3-40.9' });
  });

  it('a shared link applies its cuts for this visit only; a link without c= means the defaults', () => {
    const { setCuts, reset } = useCohortCuts.getState();
    expect(setCuts({ prHi: 70, prLo: 30, sHi: 55, sLo: 38 })).toBe(true);
    const f = filterHash({ v: 1, clauses: [{ kind: 'category', in: ['線瓦'] }] }).slice('#stats?f='.length);
    // 連結帶 c=：用連結的切點
    applySharedFilter({ filter: f, cuts: '69-31-49.3-40.9' });
    expect(useCohortCuts.getState().cuts).toEqual({ prHi: 69, prLo: 31, sHi: 49.3, sLo: 40.9 });
    // 連結有篩選、沒帶 c=：分享的人用預設 → 預設
    applySharedFilter({ filter: f });
    expect(useCohortCuts.getState().cuts).toEqual(DEFAULT_COHORT_CUTS);
    // 壞掉的 c=：不動
    expect(setCuts({ prHi: 70, prLo: 30, sHi: 55, sLo: 38 })).toBe(true);
    applySharedFilter({ filter: f, cuts: '20-80-55-38' });
    expect(useCohortCuts.getState().cuts).toEqual({ prHi: 70, prLo: 30, sHi: 55, sLo: 38 });
    // 只在這次有效的切點：applyLinkCuts 不經過 setCuts (不寫 localStorage)
    expect(useCohortCuts.getState().applyLinkCuts({ prHi: 10, prLo: 90, sHi: 55, sLo: 38 })).toBe(false);
    reset();
  });
});

describe('web: cohort grid shading', () => {
  const all = { k: 680, n: 1000 };
  it('is a fixed scale around the overall rate, not stretched min-to-max', () => {
    // 跟全體一樣 → 0；差很多、樣本很大 → ±1
    expect(cohortShade({ k: 68, n: 100 }, all, 5)).toBeCloseTo(0, 10);
    expect(cohortShade({ k: 9000, n: 10000 }, all, 5)).toBe(1);
    expect(cohortShade({ k: 4000, n: 10000 }, all, 5)).toBe(-1);
    // 大樣本差 2 個百分點 → 只有約 0.2 (幾乎看不出)
    expect(cohortShade({ k: 7000, n: 10000 }, all, 5)).toBeCloseTo((0.7 - 0.68) * 10000 / (10000 + SHADE_PRIOR) / SHADE_FULL, 6);
  });
  it('pulls small cells toward the overall rate before shading, and skips cells under minN', () => {
    // 44 票 80%：收縮後 (35.2 + 30 × 0.68) / 74 ≈ 75.1% → 約 0.71，不是最深
    const small = cohortShade({ k: 35.2, n: 44 }, all, 5)!;
    expect(small).toBeGreaterThan(0.6);
    expect(small).toBeLessThan(0.8);
    expect(cohortShade({ k: 4, n: 4 }, all, 5)).toBeNull();
    expect(cohortShade({ k: 4, n: 10 }, { k: 0, n: 0 }, 5)).toBeNull();
  });
});

