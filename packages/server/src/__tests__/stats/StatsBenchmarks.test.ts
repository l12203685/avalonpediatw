/**
 * 基準列（Edward 2026-11-03「[散客 < 30場] [排除散客後全體] [排除散客後 PR50+] [排除散客後 PR50-]」，同日改成
 * PR 分組、「切分點可以自己訂? 前 & 後 可選 預設都是20%」）：@avalon/shared/stats computeBenchmarks 與 computeStats 的 benchmarks。名字全是虛構的。
 */
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_IDS,
  benchmarkLabel,
  computeStats,
  decodeGamesDataset,
  canonicalFilterKey,
  decodeFilter,
  encodeFilter,
  pooledPlayerName,
  prGroup,
  sanitizeFilter,
  type BenchmarkCuts,
  type BenchmarksSection,
  type GameFilter,
  type LineupTuple,
} from '@avalon/shared/stats';
import { TEN, makeDataset, type GameSpec } from './datasetBuilder';
import { filterChangesNumbers } from '../../../../web/src/stats/statsFilter';

const CTX = { asOf: '2026-10-14' };

/** 座位 PR（SEATS 順序）；provMask 的位元 = 暫定座位。 */
const lineup = (prs: number[], provMask = 0): LineupTuple => [20, 500, prs, provMask, prs.map(() => 15000)];
// 邊界：預設 20／20 → 19 後、20 中、79 中、80 前；前 10%／後 33% → 32 後、33 中、89 中、90 前。
const PRS = [0, 19, 20, 32, 33, 79, 80, 89, 90, 100];
const CUSTOM: BenchmarkCuts = { top: 10, bottom: 33 };
const withCuts = (cuts: BenchmarkCuts, clauses: GameFilter['clauses'] = []): GameFilter => ({ v: 1, clauses, options: { benchmark: cuts } });

// 虛構甲..癸 每人 35 場（生涯 ≥ 30）；「路人A」2 場、「路人B」1 場；最後一局沒有結果（不算任何人的生涯、不算座位）。
const guest = (a: string, b: string | null): Array<string | null> => [a, b ?? TEN[1], ...TEN.slice(2)];
const SPECS: GameSpec[] = [
  ...Array.from({ length: 34 }, (_, i): GameSpec => ({
    id: `t${i}`, date: `2026-03-${String((i % 28) + 1).padStart(2, '0')}`, outcome: i % 3 === 0 ? '三紅' : i % 3 === 1 ? '三藍死' : '三藍活',
    kill: i % 3 === 1 ? '6' : i % 3 === 2 ? '7' : '',
    // 每 3 局一局沒評分；其他局座位 1 是暫定（PR 被壓在 50 以下，不算）
    lineup: i % 3 === 2 ? [] : lineup(PRS, 1),
  })),
  { id: 'g1', date: '2026-04-01', outcome: '三紅', names: guest('路人A', '路人B'), lineup: lineup(PRS) },
  { id: 'g2', date: '2026-04-02', outcome: '三藍活', names: guest('路人A', null), lineup: lineup(PRS) },
  { id: 'g3', date: '2026-04-03', outcome: '', lineup: lineup(PRS) },
];
const decoded = decodeGamesDataset(makeDataset(SPECS));

const group = (b: BenchmarksSection, id: (typeof BENCHMARK_IDS)[number]) => b.groups.find((g) => g.id === id)!;

/** 從局直接數：每組的座位數（獨立於引擎的算法）。 */
function expectedSeats(maxGames: number, cuts: BenchmarkCuts = { top: 20, bottom: 20 }): Record<string, number> {
  const career = new Map<string, number>();
  for (const s of SPECS) {
    if (!s.outcome && s.outcome !== undefined) continue;
    for (const n of s.names ?? TEN) if (n) career.set(n, (career.get(n) ?? 0) + 1);
  }
  const out = { all: 0, casual: 0, regular: 0, prTop: 0, prMid: 0, prBottom: 0, noPr: 0 };
  for (const s of SPECS) {
    if (s.outcome === '') continue;
    (s.names ?? TEN).forEach((n, i) => {
      if (!n) return;
      out.all += 1;
      if ((career.get(n) ?? 0) < maxGames) {
        out.casual += 1;
        return;
      }
      out.regular += 1;
      const l = s.lineup as number[] | undefined;
      const prov = l && l.length ? (((l[3] as number) >> i) & 1) === 1 : true;
      if (!l || !l.length || prov) {
        out.noPr += 1;
        return;
      }
      const pr = (l[2] as unknown as number[])[i];
      // 後 Y% = PR < Y、前 X% = PR > 100 − X − 1（整數 PR），其他 = 中間
      const g = pr < cuts.bottom ? 'prBottom' : pr > 99 - cuts.top ? 'prTop' : 'prMid';
      out[g] += 1;
    });
  }
  return out;
}

describe('benchmarks (基準列)', () => {
  it('five groups in display order with labels', () => {
    const b = computeStats(decoded, CTX, null).benchmarks;
    expect(b.groups.map((g) => g.id)).toEqual(['casual', 'regular', 'prTop', 'prMid', 'prBottom']);
    expect(b.groups.map((g) => g.label)).toEqual([
      '散客（<30場）', '排除散客後全體', '排除散客後 前20%', '排除散客後 中間60%', '排除散客後 後20%',
    ]);
    expect(b.maxGames).toBe(30);
    expect(b.cuts).toEqual({ top: 20, bottom: 20 });
    const c = computeStats(decoded, CTX, withCuts(CUSTOM)).benchmarks;
    expect(c.cuts).toEqual(CUSTOM);
    expect(c.groups.slice(2).map((g) => g.label)).toEqual(['排除散客後 前10%', '排除散客後 中間57%', '排除散客後 後33%']);
  });

  it('seat counts partition: 散客 + 全體 = all named seats; 前 + 中 + 後 + no PR = 全體', () => {
    const b = computeStats(decoded, CTX, null).benchmarks;
    const want = expectedSeats(30);
    const [casual, regular, top, mid, bottom] = BENCHMARK_IDS.map((id) => group(b, id));
    expect(b.totalSeats).toBe(want.all);
    expect(casual.seats).toBe(want.casual);
    expect(casual.seats).toBe(3); // 路人A 2 + 路人B 1
    expect(casual.players).toBe(2);
    expect(casual.seats + regular.seats).toBe(b.totalSeats);
    expect(top.seats + mid.seats + bottom.seats + b.noPrSeats).toBe(regular.seats);
    expect(b.noPrSeats).toBe(want.noPr);
    expect(b.noPrSeats).toBeGreaterThan(0);
    expect(top.seats).toBe(want.prTop);
    expect(mid.seats).toBe(want.prMid);
    expect(bottom.seats).toBe(want.prBottom);
    // 全部玩家的場數加總 = 全部座位（基準列不改任何人的數字）
    const players = computeStats(decoded, CTX, null).players.players;
    expect(players.reduce((n, p) => n + p.totalGames, 0)).toBe(b.totalSeats);
  });

  it('custom cuts also partition 全體 and match an independent count', () => {
    const b = computeStats(decoded, CTX, withCuts(CUSTOM)).benchmarks;
    const want = expectedSeats(30, CUSTOM);
    const [, regular, top, mid, bottom] = BENCHMARK_IDS.map((id) => group(b, id));
    expect(top.seats + mid.seats + bottom.seats + b.noPrSeats).toBe(regular.seats);
    expect([top.seats, mid.seats, bottom.seats]).toEqual([want.prTop, want.prMid, want.prBottom]);
  });

  it('prGroup: top X% = PR ≥ 100 − X, bottom Y% = PR < Y, middle = the rest (lower bound in, upper bound out)', () => {
    expect([19, 20, 79, 80].map((pr) => prGroup(pr))).toEqual(['prBottom', 'prMid', 'prMid', 'prTop']);
    expect([32, 33, 89, 90].map((pr) => prGroup(pr, CUSTOM))).toEqual(['prBottom', 'prMid', 'prMid', 'prTop']);
    const ints = Array.from({ length: 101 }, (_, pr) => prGroup(pr));
    expect(ints.filter((x) => x === 'prBottom')).toHaveLength(20); // 0–19
    expect(ints.filter((x) => x === 'prMid')).toHaveLength(60); // 20–79
    expect(ints.filter((x) => x === 'prTop')).toHaveLength(21); // 80–100
  });

  it('boundary seats land where the rule says (defaults and a custom setting)', () => {
    const april: GameFilter['clauses'] = [{ kind: 'date', from: '2026-04-01', to: '2026-04-30' }];
    // 只看路人的兩局：每局 10 個 PR 都可用（沒有暫定）
    // g1：座位 1、2 是散客 → 全體座位 3..10 的 PR = 20 32 33 79 80 89 90 100
    // g2：座位 1 散客 → 19 20 32 33 79 80 89 90 100
    const d = computeStats(decoded, CTX, { v: 1, clauses: april }).benchmarks;
    expect(group(d, 'casual').seats).toBe(3);
    expect(group(d, 'regular').seats).toBe(17);
    expect(group(d, 'prBottom').seats).toBe(0 + 1); // 19
    expect(group(d, 'prMid').seats).toBe(4 + 4); // 20 32 33 79
    expect(group(d, 'prTop').seats).toBe(4 + 4); // 80 89 90 100
    expect(d.noPrSeats).toBe(0);
    const c = computeStats(decoded, CTX, withCuts(CUSTOM, april)).benchmarks;
    expect(group(c, 'prBottom').seats).toBe(2 + 3); // g1：20 32；g2：19 20 32
    expect(group(c, 'prMid').seats).toBe(4 + 4); // 33 79 80 89
    expect(group(c, 'prTop').seats).toBe(2 + 2); // 90 100
    expect(group(c, 'regular').seats).toBe(17);
  });

  it('options.benchmark: sanitize bounds, defaults drop out, share links carry it, other sections unchanged', () => {
    const clean = (o: unknown) => sanitizeFilter({ v: 1, clauses: [], options: { benchmark: o } });
    // 預設 = 不寫：標準鍵與不篩選相同
    expect(clean({ top: 20, bottom: 20 }).filter?.options).toBeUndefined();
    expect(canonicalFilterKey(clean({ top: 20, bottom: 20 }).filter)).toBe('');
    expect(canonicalFilterKey(withCuts({ top: 20, bottom: 20 }))).toBe('');
    for (const bad of [{ top: 4, bottom: 20 }, { top: 20, bottom: 46 }, { top: 20.5, bottom: 20 }, { top: 20 }, 'x', [10, 10]]) {
      const r = clean(bad);
      expect(r.filter?.options?.benchmark).toBeUndefined();
      expect(r.warnings).toContain('options.benchmark');
    }
    expect(clean({ top: 5, bottom: 45 }).filter?.options?.benchmark).toEqual({ top: 5, bottom: 45 });
    expect(clean({ top: 45, bottom: 45 }).filter?.options?.benchmark).toEqual({ top: 45, bottom: 45 }); // 相加 = 90
    expect(clean({ top: 10, bottom: 33, extra: 1 }).filter?.options?.benchmark).toEqual(CUSTOM);
    // 分享連結
    const f = withCuts(CUSTOM);
    const key = canonicalFilterKey(f);
    expect(key).not.toBe('');
    expect(canonicalFilterKey(withCuts({ top: 33, bottom: 10 }))).not.toBe(key);
    const decodedLink = decodeFilter(encodeFilter(f));
    expect(decodedLink.filter?.options?.benchmark).toEqual(CUSTOM);
    // 其他區塊的數字不變；網站把只改切分點的篩選當成沒有改數字
    const base = computeStats(decoded, CTX, null);
    const custom = computeStats(decoded, CTX, f);
    expect(custom.players).toEqual(base.players);
    expect(custom.leaderboard).toEqual(base.leaderboard);
    expect(custom.overview).toEqual(base.overview);
    expect(filterChangesNumbers(f)).toBe(false);
    expect(filterChangesNumbers(null)).toBe(false);
    expect(filterChangesNumbers({ ...f, clauses: [{ kind: 'date', from: '2026-04-01' }] })).toBe(true);
  });

  it('threshold follows options.mergeSmall.maxGames; the pooled player itself is a casual', () => {
    const filter: GameFilter = { v: 1, clauses: [], options: { mergeSmall: { maxGames: 40 } } };
    const r = computeStats(decoded, CTX, filter);
    const b = r.benchmarks;
    expect(b.maxGames).toBe(40);
    expect(group(b, 'casual').label).toBe(benchmarkLabel('casual', 40));
    // 門檻 40：每個人生涯都不到 40 場 → 全部座位都是散客（散客（<40場）本身也是）
    expect(r.players.players.map((p) => p.name)).toEqual([pooledPlayerName(40)]);
    expect(group(b, 'casual').seats).toBe(b.totalSeats);
    expect(group(b, 'regular').seats).toBe(0);
    expect(group(b, 'regular').row).toBeNull();
    // 門檻 2：只有路人B（1 場）是散客
    const b2 = computeStats(decoded, CTX, { v: 1, clauses: [], options: { mergeSmall: { maxGames: 2 } } }).benchmarks;
    expect(group(b2, 'casual').seats).toBe(1);
    expect(group(b2, 'casual').seats + group(b2, 'regular').seats).toBe(b2.totalSeats);
  });

  it('career games ignore game clauses (a date filter does not make regulars casual)', () => {
    const b = computeStats(decoded, CTX, { v: 1, clauses: [{ kind: 'date', from: '2026-04-02', to: '2026-04-02' }] }).benchmarks;
    // g2 只有一局：甲..癸（除了座位 1 的路人A）在期間內只有 1 場，但生涯 ≥ 30
    expect(group(b, 'casual').seats).toBe(1);
    expect(group(b, 'regular').seats).toBe(9);
  });

  it('metrics are sane: rates in range, theory columns present, assassin hits ≤ attempts', () => {
    const b = computeStats(decoded, CTX, null).benchmarks;
    for (const g of b.groups) {
      if (!g.row || !g.theory) continue;
      expect(g.row.name).toBe(g.label);
      expect(g.row.totalGames).toBe(g.seats);
      expect(g.theory.games).toBe(g.seats);
      for (const v of [g.row.finalWinRate, g.theory.roleTheory, g.theory.positionTheory, g.theory.overallTheory, g.theory.missionWinRate]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      expect(g.theory.finalWinRate).toBe(g.row.finalWinRate);
      expect(g.assassin.hits).toBeLessThanOrEqual(g.assassin.attempts);
      expect(Object.keys(g.row.seatOutcomes ?? {})).toHaveLength(10);
    }
    // 全體 = 散客以外每個座位：全體的勝場 + 散客的勝場 = 全部人的勝場
    const players = computeStats(decoded, CTX, null).players.players;
    const wins = (p: { rawRedThreeRed: number; rawRedMerlinDead: number; rawBlueMerlinAlive: number }): number =>
      p.rawRedThreeRed + p.rawRedMerlinDead + p.rawBlueMerlinAlive;
    const casual = group(b, 'casual').row!;
    const regular = group(b, 'regular').row!;
    expect(wins(casual) + wins(regular)).toBe(players.reduce((n, p) => n + wins(p), 0));
  });

  it('does not change any other section', () => {
    const a = computeStats(decoded, CTX, null);
    const { benchmarks: _b, ...rest } = a;
    void _b;
    expect(rest.players.total).toBe(TEN.length + 2);
    expect(Object.keys(a)).toContain('benchmarks');
  });
});
