/**
 * 網站的篩選面板 (packages/web/src/stats/filterDraft.ts、statsFilter.ts) 與篩選的分享連結
 * (utils/statsLinks.ts 的 #stats?f=…、#stats?preset=…)。純函式。
 */
import { describe, expect, it } from 'vitest';
import { PRESETS, canonicalFilterKey, decodeFilter, presetFilter, type GameFilter } from '@avalon/shared/stats';
import {
  EMPTY_FILTER,
  categoryClause,
  clausesOf,
  completeFilter,
  hasPreset,
  listClause,
  otherClauses,
  selectedCategories,
  splitNames,
  togglePreset,
  withClauses,
} from '../../../web/src/stats/filterDraft';
import { filterFromParams, filterHash, parseStatsQuery } from '../../../web/src/stats/statsFilter';
import { parseStatsHash } from '../../../web/src/utils/statsLinks';

const AS_OF = '2026-10-25';
const preset = (id: string): GameFilter => presetFilter(id, AS_OF) as GameFilter;

describe('filter panel draft', () => {
  it('category boxes: all ticked = no clause; few unticked = a "not" clause (= the 排除娛樂局 preset)', () => {
    expect(categoryClause(['線瓦', '面瓦', '娛樂', '未分類', '其他'])).toBeNull();
    expect(categoryClause(['線瓦', '面瓦', '未分類', '其他'])).toEqual({ kind: 'category', in: ['娛樂'], not: true });
    expect(categoryClause(['線瓦'])).toEqual({ kind: 'category', in: ['線瓦'] });
    const f = withClauses(EMPTY_FILTER, 'category', categoryClause(['線瓦', '面瓦', '未分類', '其他']));
    expect(hasPreset(f, preset('noCasual'))).toBe(true);
    expect(selectedCategories(f)).toEqual(['線瓦', '面瓦', '未分類', '其他']);
    expect(selectedCategories(preset('online'))).toEqual(['線瓦']);
    expect(selectedCategories(null)).toHaveLength(5);
  });

  it('presets toggle on and off and replace the same kind of condition', () => {
    let f = togglePreset(null, preset('online'));
    expect(f.clauses).toEqual([{ kind: 'category', in: ['線瓦'] }]);
    f = togglePreset(f, preset('offline')); // 只看面瓦 換掉 只看線瓦
    expect(f.clauses).toEqual([{ kind: 'category', in: ['面瓦'] }]);
    f = togglePreset(f, preset('fullNames'));
    expect(hasPreset(f, preset('offline')) && hasPreset(f, preset('fullNames'))).toBe(true);
    f = togglePreset(f, preset('offline'));
    expect(f.clauses).toEqual([{ kind: 'namedSeats', min: 10 }]);
    expect(togglePreset(togglePreset(null, preset('lastYear')), preset('lastYear')).clauses).toEqual([]);
  });

  it('a field replaces only its own kind of clause, in place; other clauses stay', () => {
    const start: GameFilter = { v: 1, clauses: [{ kind: 'lakeCount', in: [3] }, { kind: 'outcome', in: ['三紅'] }, { kind: 'roleSeat', role: '梅林', seats: [1] }] };
    const f = withClauses(start, 'outcome', listClause('outcome', ['三藍死', '三藍活'], ['三紅', '三藍死', '三藍活']));
    expect(f.clauses.map((c) => c.kind)).toEqual(['lakeCount', 'outcome', 'roleSeat']);
    expect(clausesOf(f, 'outcome')).toEqual([{ kind: 'outcome', in: ['三藍死', '三藍活'] }]);
    expect(withClauses(f, 'outcome', listClause('outcome', ['三紅', '三藍死', '三藍活'], ['三紅', '三藍死', '三藍活'])).clauses.map((c) => c.kind))
      .toEqual(['lakeCount', 'roleSeat']); // 全選 = 不限
    expect(otherClauses(f).map((c) => c.kind)).toEqual(['lakeCount', 'roleSeat']);
  });

  it('unfinished rows are left out when applying (no player name, no threshold, nothing ticked)', () => {
    const f: GameFilter = {
      v: 1,
      clauses: [
        { kind: 'withPlayer', player: ' ' },
        { kind: 'withPlayer', player: '虛構甲', side: 'red' },
        { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'names', names: [] } },
        { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'metric', metric: 'r3RejectLoyal', op: 'gt', pr: undefined } },
        { kind: 'excludePlayers', scope: 'hideFromLists', who: { by: 'metric', metric: 'evilTeamReject', op: 'ge', value: 60 } },
        { kind: 'category', in: [] },
      ],
    };
    expect(completeFilter(f).clauses).toEqual([
      { kind: 'withPlayer', player: '虛構甲', side: 'red' },
      { kind: 'excludePlayers', scope: 'hideFromLists', who: { by: 'metric', metric: 'evilTeamReject', op: 'ge', value: 60 } },
    ]);
  });

  it('names typed with commas, 頓號 or new lines', () => {
    expect(splitNames('虛構甲, 虛構乙、虛構丙\n虛構甲，')).toEqual(['虛構甲', '虛構乙', '虛構丙']);
  });
});

describe('filter share links', () => {
  const filter: GameFilter = {
    v: 1,
    clauses: [
      { kind: 'category', in: ['線瓦'] },
      { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'metric', metric: 'roleTheory', op: 'gt', pr: 90 } },
    ],
  };

  it('#stats?f=… round-trips the filter; no filter = plain #stats', () => {
    const hash = filterHash(filter);
    expect(hash.startsWith('#stats?f=1.')).toBe(true);
    const link = parseStatsHash(hash);
    expect(link).toMatchObject({ kind: 'stats' });
    const back = filterFromParams(link as { filter?: string }, AS_OF);
    expect(canonicalFilterKey(back.filter)).toBe(canonicalFilterKey(filter));
    expect(back.warnings).toEqual([]);
    expect(filterHash(null)).toBe('#stats');
    expect(filterHash(EMPTY_FILTER)).toBe('#stats');
  });

  it('#stats?preset=… for the bots; unknown preset or a broken link = no filter, with a warning', () => {
    for (const p of PRESETS) {
      const link = parseStatsHash(`#stats?preset=${p.id}`) as { preset?: string };
      expect(link.preset).toBe(p.id);
      expect(filterFromParams(link, AS_OF).filter).toEqual(p.build(AS_OF));
    }
    expect(filterFromParams({ preset: 'nope' }, AS_OF)).toEqual({ filter: null, warnings: ['unknown preset'] });
    expect(filterFromParams({ filter: '1.@@@' }, AS_OF).filter).toBeNull();
    expect(decodeFilter('2.abc').filter).toBeNull();
  });

  it('other stats links are unchanged', () => {
    expect(parseStatsHash('#stats')).toEqual({ kind: 'stats' });
    expect(parseStatsHash('#leaderboard?f=1.x')).toEqual({ kind: 'stats', filter: '1.x' });
    expect(parseStatsHash('#practice?f=1.x')).toBeNull();
    expect(parseStatsQuery('f=1.abc&preset=online&x=1')).toEqual({ filter: '1.abc', preset: 'online' });
  });
});
