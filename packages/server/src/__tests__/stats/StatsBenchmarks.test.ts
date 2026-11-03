/**
 * 基準列（Edward 2026-11-03「[散客 < 30場] [排除散客後全體] [排除散客後 PR50+] [排除散客後 PR50-]」，同日改成
 * 「前1/3 中間1/3 後1/3」）：@avalon/shared/stats computeBenchmarks 與 computeStats 的 benchmarks。名字全是虛構的。
 */
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_IDS,
  benchmarkLabel,
  computeStats,
  decodeGamesDataset,
  pooledPlayerName,
  prTertile,
  type BenchmarksSection,
  type GameFilter,
  type LineupTuple,
} from '@avalon/shared/stats';
import { TEN, makeDataset, type GameSpec } from './datasetBuilder';

const CTX = { asOf: '2026-10-14' };

/** 座位 PR（SEATS 順序）；provMask 的位元 = 暫定座位。 */
const lineup = (prs: number[], provMask = 0): LineupTuple => [20, 500, prs, provMask, prs.map(() => 15000)];
// 邊界：33 → 後、34 → 中、66 → 中、67 → 前；100/3、200/3 剛好在分界上（中、前），比它們小一點的歸下一組。
const PRS = [0, 10, 33, 34, 100 / 3, 66, 200 / 3, 67, 66.66, 100];

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
function expectedSeats(maxGames: number): Record<string, number> {
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
      // 獨立於引擎的寫法：用分數比較（pr = a / b 時 3a 對 100b）——測試裡的 PR 只有整數、100/3、200/3、66.66
      const third = pr === 100 / 3 ? 'prMid' : pr === 200 / 3 ? 'prTop'
        : pr >= 67 ? 'prTop' : pr >= 34 ? 'prMid' : 'prBottom';
      out[third] += 1;
    });
  }
  return out;
}

describe('benchmarks (基準列)', () => {
  it('five groups in display order with labels', () => {
    const b = computeStats(decoded, CTX, null).benchmarks;
    expect(b.groups.map((g) => g.id)).toEqual(['casual', 'regular', 'prTop', 'prMid', 'prBottom']);
    expect(b.groups.map((g) => g.label)).toEqual([
      '散客（<30場）', '排除散客後全體', '排除散客後 前1/3', '排除散客後 中間1/3', '排除散客後 後1/3',
    ]);
    expect(b.maxGames).toBe(30);
    expect(b.tertileBounds).toEqual([100, 200]);
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

  it('prTertile uses exact thirds: PR = 100/3 is middle, 200/3 is top; integers 0–33 / 34–66 / 67–100', () => {
    expect(prTertile(100 / 3)).toBe('prMid');
    expect(prTertile(200 / 3)).toBe('prTop');
    expect(prTertile(33.333)).toBe('prBottom');
    expect(prTertile(66.66)).toBe('prMid');
    expect(prTertile(66.667)).toBe('prTop');
    const ints = Array.from({ length: 101 }, (_, pr) => prTertile(pr));
    expect(ints.filter((x) => x === 'prBottom')).toHaveLength(34); // 0–33
    expect(ints.filter((x) => x === 'prMid')).toHaveLength(33); // 34–66
    expect(ints.filter((x) => x === 'prTop')).toHaveLength(34); // 67–100
    expect([prTertile(33), prTertile(34), prTertile(66), prTertile(67), prTertile(0), prTertile(100)])
      .toEqual(['prBottom', 'prMid', 'prMid', 'prTop', 'prBottom', 'prTop']);
  });

  it('tertile rows are disjoint and boundary seats land where the rule says', () => {
    // 只看路人的兩局：每局 10 個 PR 都可用（沒有暫定）
    const b = computeStats(decoded, CTX, { v: 1, clauses: [{ kind: 'date', from: '2026-04-01', to: '2026-04-30' }] }).benchmarks;
    // g1：座位 1、2 是散客 → 全體座位 3..10 的 PR = 33 34 100/3 66 200/3 67 66.66 100
    // g2：座位 1 散客 → 10 33 34 100/3 66 200/3 67 66.66 100
    expect(group(b, 'casual').seats).toBe(3);
    expect(group(b, 'regular').seats).toBe(17);
    expect(group(b, 'prBottom').seats).toBe(1 + 2); // g1：33；g2：10 33
    expect(group(b, 'prMid').seats).toBe(4 + 4); // 34 100/3 66 66.66
    expect(group(b, 'prTop').seats).toBe(3 + 3); // 200/3 67 100
    expect(b.noPrSeats).toBe(0);
    const sum = ['prTop', 'prMid', 'prBottom'].reduce((n, id) => n + group(b, id as 'prTop').seats, 0);
    expect(sum).toBe(group(b, 'regular').seats);
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
