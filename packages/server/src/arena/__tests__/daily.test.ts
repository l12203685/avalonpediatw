import { describe, expect, it } from 'vitest';
import { SelfPlayEngine } from '../../ai/SelfPlayEngine';
import {
  addDays, applyRunToDay, buildTrend, decodeTable, encodeTable, isoWeek, makeShardFile, mergeShards, mergeSnapshots,
  parseSlice, parseSnapshot, planRollup, planShards, rosterHash, runSeed, sliceRange, totalGames,
  type HistorySnapshot, type ShardFile,
} from '../daily';
import { buildLeaderboard, tournamentSeating } from '../report';
import type { RegisteredBot } from '../registry';
import { seededRandom } from '../../ai/benchmark/agreement';
import { playTable, quietly, type Entrant, type TableResult } from '../table';
import type { BotProfile } from '../profile';

const ids = ['baike', 'a', 'b', 'c'];
const index = new Map(ids.map((id, i) => [id, i]));
const ROLES10 = ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];

/** 假的一局：座位與角色由 seed 決定，結果偏向 'a' 那一邊（給評分一點訊號）。 */
function fakeTable(seed: string, i: number): TableResult {
  const rnd = seededRandom(`${seed}|${i}|fake`);
  const { seats } = tournamentSeating(seed, i, ids, [10]);
  const roles = [...ROLES10].sort(() => rnd() - 0.5);
  const evilA = seats.filter((s, k) => s === 'a' && ['assassin', 'morgana', 'mordred', 'oberon'].includes(roles[k])).length;
  const r = rnd();
  const outcome = r < 0.5 + 0.1 * evilA ? (r < 0.3 ? 'threeRed' : 'merlinKilled') : 'threeBlue';
  const winner = outcome === 'threeBlue' ? 'good' : 'evil';
  return {
    gameSeed: `${seed}|${i}`,
    playerCount: 10,
    winner,
    outcome,
    fingerprint: '',
    seats: seats.map((entrant, k) => {
      const team = ['assassin', 'morgana', 'mordred', 'oberon'].includes(roles[k]) ? 'evil' as const : 'good' as const;
      const s: TableResult['seats'][number] = { entrant, role: roles[k], team, won: team === winner };
      if (roles[k] === 'assassin' && outcome !== 'threeRed') s.assassinHit = outcome === 'merlinKilled';
      return s;
    }),
  };
}

const bots: RegisteredBot[] = ids.map((id) => ({ id, source: id === 'baike' ? 'reference' : 'example', profile: null }));

function shardsFor(seed: string, total: number, count: number): ShardFile[] {
  return Array.from({ length: count }, (_, k) => {
    const slice = sliceRange(total, k, count);
    const tables = Array.from({ length: slice.end - slice.start }, (_, j) => fakeTable(seed, slice.start + j));
    return makeShardFile({
      seed, date: '2026-11-26', kind: 'daily', totalGames: total, slice, sizes: [10], roster: ids,
      rosterHash: rosterHash(bots), elapsedSec: 10 + k, workers: 4, tables,
    });
  });
}

describe('arena daily: seeds and slices', () => {
  it('daily seed depends only on the date; other kinds need a run id', () => {
    expect(runSeed('2026-11-26', 'daily')).toBe('arena-2026-11-26');
    expect(runSeed('2026-11-26', 'daily', 99)).toBe('arena-2026-11-26');
    expect(runSeed('2026-11-26', 'push', 123)).toBe('arena-2026-11-26-push-123');
    expect(() => runSeed('2026-11-26', 'manual')).toThrow();
    expect(() => runSeed('26-11-2026', 'daily')).toThrow();
  });

  it('slices cover every game exactly once, in order, sizes differ by at most one', () => {
    for (const [total, count] of [[120_000, 12], [100_003, 7], [5, 8], [0, 3], [20_000, 4]] as const) {
      let cursor = 0;
      const sizes: number[] = [];
      for (let k = 0; k < count; k++) {
        const r = sliceRange(total, k, count);
        expect(r.start).toBe(cursor);
        cursor = r.end;
        sizes.push(r.end - r.start);
      }
      expect(cursor).toBe(total);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
    expect(() => sliceRange(10, 3, 3)).toThrow();
    expect(parseSlice('3/12')).toEqual({ index: 3, count: 12 });
    expect(() => parseSlice('12/12')).toThrow();
    expect(() => parseSlice('a/b')).toThrow();
  });

  it('plans at most 20 shards of about 10,000 games', () => {
    expect(planShards(120_000)).toEqual({ shards: 12, perShard: 10_000 });
    expect(planShards(20_000)).toEqual({ shards: 2, perShard: 10_000 });
    expect(planShards(1)).toEqual({ shards: 1, perShard: 1 });
    expect(planShards(500_000)).toEqual({ shards: 20, perShard: 25_000 });
  });

  it('roster hash changes when a profile changes', () => {
    const p: BotProfile = { schema: 1, name: 'X', style: 's', sides: {} };
    const h1 = rosterHash([{ id: 'x', profile: p }]);
    expect(rosterHash([{ id: 'x', profile: { ...p } }])).toBe(h1);
    expect(rosterHash([{ id: 'x', profile: { ...p, name: 'Y' } }])).not.toBe(h1);
  });
});

describe('arena daily: compact encoding', () => {
  it('round-trips synthetic tables (31 characters per 10-player game)', () => {
    for (let i = 0; i < 50; i++) {
      const t = fakeTable('enc', i);
      const code = encodeTable(t, index);
      expect(code).toHaveLength(31);
      expect(decodeTable(code, ids, t.gameSeed)).toEqual(t);
    }
  });

  it('rejects inconsistent records instead of storing them wrong', () => {
    const t = fakeTable('bad', 0);
    expect(() => encodeTable({ ...t, winner: t.winner === 'good' ? 'evil' : 'good' }, index)).toThrow();
    expect(() => encodeTable({ ...t, seats: [{ ...t.seats[0], entrant: 'nobody' }, ...t.seats.slice(1)] }, index)).toThrow();
    expect(() => encodeTable({ ...t, seats: [{ ...t.seats[0], role: 'lancelot' }, ...t.seats.slice(1)] }, index)).toThrow();
    expect(() => decodeTable('Xzz', ids, 's')).toThrow();
  });

  it('round-trips a real engine game', async () => {
    const loud: BotProfile = { schema: 1, name: 'Loud', author: 'octocat', style: 's', sides: { evil: { redNormalVote: 0 } } };
    const entrants: Entrant[] = [{ id: 'a', profile: loud }, ...Array.from({ length: 4 }, () => ({ id: 'baike', profile: null }))];
    const t = await quietly(() => playTable(new SelfPlayEngine(), entrants, 'daily-test|0'));
    expect(decodeTable(encodeTable(t, index), ids, t.gameSeed)).toEqual({ ...t, fingerprint: '' });
  }, 60_000);
});

describe('arena daily: merging shards', () => {
  it('merged shards give the same leaderboard as one big run, whatever the shard count', () => {
    const seed = 'arena-2026-11-26';
    const total = 600;
    const direct = Array.from({ length: total }, (_, i) => fakeTable(seed, i));
    const ref = buildLeaderboard({ bots, tables: direct, seed, sizes: [10], generatedAt: 'x' });
    for (const count of [1, 3, 7]) {
      const run = mergeShards(shardsFor(seed, total, count).reverse());
      expect(run.missing).toEqual([]);
      expect(run.tables.map((t) => t.gameSeed)).toEqual(direct.map((t) => t.gameSeed));
      const board = buildLeaderboard({ bots, tables: run.tables, seed, sizes: [10], generatedAt: 'x' });
      expect(board.bots).toEqual(ref.bots);
    }
  });

  it('reports missing slices, rejects overlaps and mixed runs', () => {
    const shards = shardsFor('s', 100, 4);
    const run = mergeShards([shards[0], shards[2]]);
    expect(run.missing).toEqual([{ start: 25, end: 50 }, { start: 75, end: 100 }]);
    expect(run.tables).toHaveLength(50);
    expect(run.shards).toBe(2);
    expect(run.slowestShardSec).toBe(12);
    expect(() => mergeShards([shards[0], shards[0]])).toThrow(/重疊/);
    expect(() => mergeShards([shards[0], { ...shards[1], seed: 'other' }])).toThrow(/不是同一輪/);
    expect(() => mergeShards([shards[0], { ...shards[1], rosterHash: 'zzz' }])).toThrow(/不是同一輪/);
    expect(() => mergeShards([])).toThrow();
  });
});

describe('arena daily: history', () => {
  const board = (r: number): { bots: { id: string; rating: { overall: { rating: number; low: number; high: number }; red: { rating: number; low: number; high: number }; blue: { rating: number; low: number; high: number } } }[] } => ({
    bots: [{ id: 'a', rating: { overall: { rating: r, low: r - 10, high: r + 10 }, red: { rating: r + 5, low: 0, high: 0 }, blue: { rating: r - 5, low: 0, high: 0 } } }],
  });
  const day = (date: string, games: number, r: number): HistorySnapshot => applyRunToDay(null, date, games, board(r) as never);

  it('same-day runs add games and keep the latest ratings', () => {
    const first = day('2026-11-26', 20_000, 1600.4);
    expect(first).toMatchObject({ kind: 'day', period: '2026-11-26', games: 20_000, runs: 1, bots: { a: [1600, 1590, 1610, 1605, 1595] } });
    const second = applyRunToDay(first, '2026-11-26', 120_000, board(1550) as never);
    expect(second).toMatchObject({ games: 140_000, runs: 2, bots: { a: [1550, 1540, 1560, 1555, 1545] } });
    expect(() => applyRunToDay(first, '2026-11-27', 1, board(1) as never)).toThrow();
  });

  it('ISO weeks and day arithmetic', () => {
    expect(isoWeek('2026-11-26')).toBe('2026-W48');
    expect(isoWeek('2021-01-03')).toBe('2020-W53');
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
    expect(addDays('2026-11-26', -60)).toBe('2026-09-27');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('rolls days older than 60 into weekly snapshots (games-weighted), keeps recent days', () => {
    const snaps = [
      day('2026-09-21', 100_000, 1500), // W39 週一
      day('2026-09-22', 300_000, 1600), // W39
      day('2026-09-28', 100_000, 1400), // W40，在 60 天內（cutoff 2026-09-27）
      day('2026-11-26', 120_000, 1700),
    ];
    const plan = planRollup(snaps, '2026-11-26');
    expect(plan.remove).toEqual(['2026-09-21.json', '2026-09-22.json']);
    const w = plan.write.get('2026-W39.json')!;
    expect(w).toMatchObject({ kind: 'week', period: '2026-W39', games: 400_000, runs: 2 });
    expect(w.bots.a[0]).toBe(1575);
    // 第二天再滾一份進同一週：和已經存在的每週快照加權合併。
    const next = planRollup([w, day('2026-09-23', 400_000, 1400)], '2026-11-27');
    expect(next.write.get('2026-W39.json')).toMatchObject({ games: 800_000, runs: 3, bots: { a: [1488, 1478, 1498, 1493, 1483] } });
    expect(planRollup([day('2026-11-26', 1, 1)], '2026-11-26')).toEqual({ write: new Map(), remove: [] });
  });

  it('trend and totals', () => {
    const snaps = [
      day('2026-11-24', 100, 1500), day('2026-11-26', 300, 1520), day('2026-11-25', 200, 1510),
      mergeSnapshots('2026-W30', [day('2026-07-20', 1000, 1400)]),
    ];
    const trend = buildTrend(snaps, ['a', 'b'], 2);
    expect(trend).toEqual({ dates: ['2026-11-25', '2026-11-26'], ratings: { a: [1510, 1520], b: [null, null] } });
    expect(totalGames(snaps)).toBe(1600);
  });

  it('parses only well-formed snapshots', () => {
    expect(parseSnapshot(day('2026-11-26', 1, 1))).not.toBeNull();
    expect(parseSnapshot({ schema: 2 })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ schema: 1, kind: 'day', period: 'x', games: '1', runs: 1, bots: {} })).toBeNull();
  });
});
