/**
 * 網站的分組切點（packages/web/src/stats/cohortCuts.ts）與分享連結的 &c=…（statsFilter.ts filterHash／parseStatsQuery、
 * utils/statsLinks.ts）。純函式＋zustand（沒有 window：localStorage 讀寫失敗時就是預設、不記）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COHORT_CUTS, decodeFilter } from '@avalon/shared/stats';
import { cohortCutsParam, useCohortCuts } from '../../../web/src/stats/cohortCuts';
import { filterHash, parseStatsQuery } from '../../../web/src/stats/statsFilter';
import { parseStatsHash } from '../../../web/src/utils/statsLinks';

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
});
