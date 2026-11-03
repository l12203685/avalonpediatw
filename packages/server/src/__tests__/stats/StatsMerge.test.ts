/**
 * 合併計算（Edward 2026-11-03「你能夠把 場數未滿30場的人 併成同一個人嗎 或是我希望你可以增加一個功能 類似把某幾個人
 * 戰績合併計算」）：options.mergeSmall（散客）與 options.merge（自訂合併）。名字全是虛構的。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  canonicalFilterKey,
  computeStats,
  decodeFilter,
  decodeGamesDataset,
  encodeFilter,
  pooledPlayerName,
  sanitizeFilter,
  type GameFilter,
} from '@avalon/shared/stats';
import { TEN, makeDataset, type GameSpec } from './datasetBuilder';
import { completeFilter, withOptions } from '../../../../web/src/stats/filterDraft';
import { filterHash, useStatsFilter } from '../../../../web/src/stats/statsFilter';

const AS_OF = '2026-10-14';
const CTX = { asOf: AS_OF };

// 虛構甲..癸 每人 6 場；「路人A」「路人B」各 1 場、「路人C」2 場，第 3 局 A、B 同局。
const withGuests = (a: string | null, b: string | null): Array<string | null> => [a ?? TEN[0], b ?? TEN[1], ...TEN.slice(2)];
const SPECS: GameSpec[] = [
  ...Array.from({ length: 6 }, (_, i): GameSpec => ({ id: `t${i}`, date: `2026-01-0${i + 1}`, outcome: i % 2 ? '三藍活' : '三紅' })),
  { id: 'g1', date: '2026-02-01', outcome: '三紅', names: withGuests('路人A', '路人B') },
  { id: 'g2', date: '2026-02-02', outcome: '三藍死', kill: '6', names: withGuests('路人C', null) },
  { id: 'g3', date: '2026-02-03', outcome: '三藍活', names: withGuests(null, '路人C') },
  { id: 'g4', date: '2026-02-04', outcome: '', names: withGuests('路人D', null) }, // 沒有結果：路人D 生涯 0 場
];
const decoded = decodeGamesDataset(makeDataset(SPECS));

function f(options: GameFilter['options'], clauses: GameFilter['clauses'] = []): GameFilter {
  return { v: 1, clauses, ...(options ? { options } : {}) };
}

const sumGames = (rows: ReadonlyArray<{ totalGames: number }>): number => rows.reduce((n, r) => n + r.totalGames, 0);

describe('mergeSmall (散客)', () => {
  it('players below N career games become one pooled player; seat totals are preserved', () => {
    const base = computeStats(decoded, CTX, null);
    const merged = computeStats(decoded, CTX, f({ mergeSmall: { maxGames: 3 } }));
    const pool = pooledPlayerName(3);
    expect(pool).toBe('散客（<3場）');
    const names = merged.players.players.map((p) => p.name);
    expect(names).toContain(pool);
    for (const n of ['路人A', '路人B', '路人C', '路人D']) expect(names).not.toContain(n);
    // 虛構甲..癸 生涯都 ≥ 6 場：不併
    for (const n of TEN) expect(names).toContain(n);
    const poolRow = merged.players.players.find((p) => p.name === pool)!;
    // 逐座位算：A 1 + B 1 + C 2 = 4（g1 兩位散客同局算兩場；D 只在沒有結果的局）
    expect(poolRow.totalGames).toBe(4);
    expect(sumGames(merged.players.players)).toBe(sumGames(base.players.players));
    expect(merged.overview).toBeDefined();
    expect(merged.meta.merge).toMatchObject({ pooled: { name: pool, maxGames: 3, players: 4 }, groups: [], renamed: 4 });
  });

  it('a pooled player in two seats of one game is not paired with itself and pairs count the game once', () => {
    const merged = computeStats(decoded, CTX, f({ mergeSmall: { maxGames: 3 } }));
    const pool = pooledPlayerName(3);
    const selfPairs = merged.pairs.sameFaction.filter((p) => p.players[0] === p.players[1]);
    expect(selfPairs).toEqual([]);
    const withPool = merged.pairs.sameFaction.find((p) => p.players.includes(pool) && p.players.includes(TEN[2]))!;
    // g1、g2、g3 三局有散客、都有虛構丙：共同出賽 3 局（g1 兩位散客不算兩次）
    expect(withPool.sharedGames).toBe(3);
  });

  it('threshold is on career games over all games, before game clauses', () => {
    // 只看 2026-02 的局：虛構丙 在期間內只有 3 場（g4 沒有結果），但生涯 ≥ 3，不併
    const app = applyFilter(decoded, CTX, f({ mergeSmall: { maxGames: 3 } }, [{ kind: 'date', from: '2026-02-01', to: '2026-02-28' }]));
    const seen = new Set(app.games.flatMap((g) => g.seatPlayers));
    expect(seen.has(TEN[2])).toBe(true);
    expect(seen.has(pooledPlayerName(3))).toBe(true);
    expect(seen.has('路人C')).toBe(false);
  });

  it('player clauses see merged names: an original name resolves to the merged player', () => {
    const pooled = applyFilter(decoded, CTX, f({ mergeSmall: { maxGames: 3 } }, [{ kind: 'withPlayer', player: pooledPlayerName(3) }]));
    expect(pooled.games.map((g) => g.id)).toEqual(['g1', 'g2', 'g3', 'g4']);
    // 合併在任何子句之前：打原名 = 合併後的那位（不是單看路人A 的局）
    const app = applyFilter(decoded, CTX, f({ mergeSmall: { maxGames: 3 } }, [{ kind: 'withPlayer', player: '路人A' }]));
    expect(app.games.map((g) => g.id)).toEqual(['g1', 'g2', 'g3', 'g4']);
    expect(app.meta.unresolvedNames).toEqual([]);
    const dropped = applyFilter(decoded, CTX, f({ mergeSmall: { maxGames: 3 } }, [
      { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'names', names: ['路人B'] } },
    ]));
    expect(dropped.games.map((g) => g.id)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
  });

  it('does not change the source dataset', () => {
    applyFilter(decoded, CTX, f({ mergeSmall: { maxGames: 30 } }));
    expect(decoded.games.find((g) => g.id === 'g1')!.seatPlayers[0]).toBe('路人A');
    expect(decoded.dataset.players).toContain('路人A');
  });
});

describe('merge (自訂合併)', () => {
  it('merges the named players into one; totals are preserved; unresolved names are reported', () => {
    const base = computeStats(decoded, CTX, null);
    const merged = computeStats(decoded, CTX, f({ merge: [{ names: ['路人A', '路人c', '沒有這個人'], as: '路人合體' }] }));
    const row = merged.players.players.find((p) => p.name === '路人合體')!;
    expect(row.totalGames).toBe(3);
    expect(merged.players.players.map((p) => p.name)).not.toContain('路人A');
    expect(merged.players.players.map((p) => p.name)).toContain('路人B');
    expect(sumGames(merged.players.players)).toBe(sumGames(base.players.players));
    expect(merged.meta.merge?.groups).toEqual([{ as: '路人合體', names: ['路人A', '路人C'], unresolved: ['沒有這個人'] }]);
    expect(merged.meta.unresolvedNames).toEqual(['沒有這個人']);
    // 原名當成合併後名字的別名
    expect(merged.players.aliases).toMatchObject({ 路人A: '路人合體', 路人C: '路人合體' });
  });

  it('merging into an existing name adds the records to that player', () => {
    const base = computeStats(decoded, CTX, null).players.players.find((p) => p.name === TEN[0])!;
    const merged = computeStats(decoded, CTX, f({ merge: [{ names: ['路人C'], as: TEN[0] }] })).players.players.find((p) => p.name === TEN[0])!;
    expect(merged.totalGames).toBe(base.totalGames + 2);
  });

  it('custom groups are counted first and are never pooled', () => {
    const merged = computeStats(decoded, CTX, f({ merge: [{ names: ['路人A', '路人B'], as: '雙人組' }], mergeSmall: { maxGames: 30 } }));
    const names = merged.players.players.map((p) => p.name);
    expect(names).toContain('雙人組');
    expect(names).toContain(pooledPlayerName(30)); // 其他人（含虛構甲..癸，都不到 30 場）併成散客
    expect(names.filter((n) => n !== '雙人組' && n !== pooledPlayerName(30))).toEqual([]);
    expect(merged.players.players.find((p) => p.name === '雙人組')!.totalGames).toBe(2);
  });
});

describe('options round-trip, sanitize and canonical key', () => {
  const filter = f({ merge: [{ names: ['路人A', '路人B'], as: '合體' }], mergeSmall: { maxGames: 30 } });

  it('encode / decode keeps merge options', () => {
    const { filter: back, warnings } = decodeFilter(encodeFilter(filter));
    expect(warnings).toEqual([]);
    expect(back).toEqual(filter);
  });

  it('sanitizeFilter drops bad groups and out-of-range thresholds', () => {
    const { filter: clean, warnings } = sanitizeFilter({
      v: 1, clauses: [],
      options: {
        merge: [
          { names: [' 路人A ', '路人A', ''], as: ' 合體 ' },
          { names: [], as: '空' },
          { names: ['x'], as: '' },
          { names: ['x'], as: 'x'.repeat(41) },
          'nope',
        ],
        mergeSmall: { maxGames: 0 },
      },
    });
    expect(clean?.options).toEqual({ merge: [{ names: ['路人A'], as: '合體' }] });
    expect(warnings).toEqual(['options.merge[1]', 'options.merge[2]', 'options.merge[3]', 'options.merge[4]', 'options.mergeSmall']);
    expect(sanitizeFilter({ v: 1, clauses: [], options: { mergeSmall: {} } }).filter?.options).toEqual({ mergeSmall: { maxGames: 30 } });
    expect(sanitizeFilter({ v: 1, clauses: [], options: { mergeSmall: { maxGames: 5001 } } }).filter?.options).toBeUndefined();
  });

  it('canonical key: merge options make a non-empty key; name order inside a group does not matter', () => {
    expect(canonicalFilterKey(f({ mergeSmall: { maxGames: 30 } }))).not.toBe('');
    expect(canonicalFilterKey(f({ merge: [{ names: ['b', 'a'], as: 'x' }] })))
      .toBe(canonicalFilterKey(f({ merge: [{ names: ['a', 'b'], as: 'x' }] })));
    expect(canonicalFilterKey(f({ mergeSmall: { maxGames: 30 } }))).not.toBe(canonicalFilterKey(f({ mergeSmall: { maxGames: 20 } })));
    expect(canonicalFilterKey(f({ merge: [] }))).toBe('');
  });
});

describe('default unchanged', () => {
  it('no merge options = same result as no filter (invented fixture), and empty merge is a no-op', () => {
    const fixture = path.resolve(__dirname, '..', 'fixtures', 'stats_parity', 'invented');
    const inv = decodeGamesDataset(JSON.parse(fs.readFileSync(path.join(fixture, 'games.json'), 'utf-8')));
    const ctx = { asOf: '2026-02-28' };
    const base = computeStats(inv, ctx, null);
    const { key: _k, filterKey: _f, meta: _m, ...baseSections } = base;
    const { key: _k2, filterKey: _f2, meta: m2, ...emptySections } = computeStats(inv, ctx, f({ merge: [] }));
    expect(emptySections).toEqual(baseSections);
    expect(m2.merge).toBeUndefined();
    // 散客在真實形狀的資料上：座位總數不變、散客唯一
    const pooled = computeStats(inv, ctx, f({ mergeSmall: { maxGames: 30 } }));
    expect(sumGames(pooled.players.players)).toBe(sumGames(base.players.players));
    const small = base.players.players.filter((p) => p.totalGames < 30);
    if (small.length) {
      const poolRow = pooled.players.players.find((p) => p.name === pooledPlayerName(30))!;
      expect(poolRow.totalGames).toBe(sumGames(small));
      expect(pooled.players.players.length).toBe(base.players.players.length - small.length + 1);
    }
  });
});

describe('web filter panel: merge options', () => {
  it('completeFilter drops unfinished merge groups; withOptions removes empty options', () => {
    const draft = f({ merge: [{ names: [' 路人A ', '路人B'], as: ' 合體 ' }, { names: [], as: '空' }, { names: ['路人C'], as: '' }] });
    expect(completeFilter(draft)).toEqual(f({ merge: [{ names: ['路人A', '路人B'], as: '合體' }] }));
    expect(completeFilter(f({ merge: [{ names: [], as: '' }] }))).toEqual(f(undefined));
    expect(withOptions(f({ mergeSmall: { maxGames: 30 } }), { mergeSmall: undefined })).toEqual(f(undefined));
  });

  it('a merge-only filter is an active, shareable filter', () => {
    const only = f({ mergeSmall: { maxGames: 30 } });
    useStatsFilter.getState().setFilter(only);
    expect(useStatsFilter.getState().key).not.toBe('');
    expect(useStatsFilter.getState().filter).toEqual(only);
    expect(filterHash(only).startsWith('#stats?f=1.')).toBe(true);
    useStatsFilter.getState().setFilter(null);
  });
});
