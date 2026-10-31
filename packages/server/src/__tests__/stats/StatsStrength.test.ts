/**
 * 數據分析「陣容強度」（Edward 2026-10-31）：lineup 欄的座位 Elo、角色強度（紅方／忠臣／藍方、梅林、派西、刺客）、
 * 角色篩選條件、computeStrengthReport（散點、季 × S、分層、分組比較的過程指標）。合成局，名字全是虛構的。
 * 配置 123456：刺 1、娜 2、德 3、奧 4、派 5、梅 6；7、8、9、0 忠臣。
 */
import { describe, expect, it } from 'vitest';
import {
  applyFilter, computeStrengthReport, decodeGamesDataset, decodeLineup, gameSeats, halfYearOf, matchesLineup, outcomeByS,
  quantileSorted, redBlueGap, riverSeries, rollingMedian, roleStrength, sanitizeFilter, seatSpread, shrinkRate, wilson,
  type LineupTuple, type StrengthGrouping, type StrengthPoint,
} from '@avalon/shared/stats';
import { TEN, makeDataset, type GameSpec } from './datasetBuilder';

const PRS_A = [80, 75, 72, 71, 90, 85, 60, 55, 52, 50]; // S 69
const ELOS_A = [15200, 15150, 15120, 15110, 15300, 15250, 15000, 14950, 14920, 14900];
const PRS_C = [30, 30, 30, 30, 40, 30, 50, 50, 50, 60]; // S 40
const ELOS_C = Array(10).fill(14950);
const lineup = (prs: number[], elos: number[] | null, mask = 0): LineupTuple => {
  const s = Math.round((prs.reduce((a, b) => a + b, 0) / 10) * 10);
  return elos ? [30, s, prs, mask, elos] : [30, s, prs, mask];
};

// A：三藍活。R1 567 成功 → R2 5679（三加一）成功 → R3 1567 只有刺客一紅、出失敗 → R4 12567 兩紅、兩張失敗 → R5 成功。
// 湖：0 驗 1（藍驗到紅、宣告紅）；1 驗 2（紅驗隊友、宣告藍）。
const A: GameSpec = {
  id: 'A', date: '2024-02-10', config: '123456', outcome: '三藍活', kill: '7',
  missions: 'ooo|oooo|xooo|ooxxo|ooooo',
  votes: [[1, 1, '567', '567890'], [2, 1, '5678', '56789'], [2, 2, '5679', '567901'], [3, 1, '1567', '156789'],
    [4, 1, '12567', '125678'], [5, 1, '56789', '567890']],
  lakes: '0112--', claims: '01x12o', lineup: lineup(PRS_A, ELOS_A),
};
// C：只打一輪的局（三紅的結果欄、投票：隊上 1 5 7 贊成，隊外 8 9 0 外白）。
const C: GameSpec = {
  id: 'C', date: '2024-05-01', config: '123456', outcome: '三紅', missions: 'ooo||||', votes: [[1, 1, '157', '157890']],
  lakes: '------', lineup: lineup(PRS_C, ELOS_C),
};
const U: GameSpec = { id: 'U', date: '2024-05-02', outcome: '三藍死', kill: '6' }; // 沒評分
const OLD: GameSpec = { id: 'O', date: '2024-06-01', outcome: '三紅', lineup: lineup(PRS_C, null) }; // 沒有座位 Elo
const { games, dataset } = (() => {
  const ds = makeDataset([A, C, U, OLD]);
  return { games: decodeGamesDataset(ds).games, dataset: ds };
})();
const byId = (id: string) => games.find((g) => g.id === id)!;

describe('lineup seats Elo and role strength', () => {
  it('decodes the 5th item (seat Elo × 10); 4-item files still read', () => {
    expect(byId('A').lineup?.elos?.[0]).toBe(1520);
    expect(byId('O').lineup?.elos).toBeNull();
    expect(decodeLineup([30, 500, Array(10).fill(50), 0])?.elos).toBeNull();
  });

  it('red / loyal / blue mean, max, min; Merlin, Percival, assassin', () => {
    const st = roleStrength(byId('A').lineup!, gameSeats(byId('A')));
    expect(st.pr.red).toEqual({ mean: 74.5, max: 80, min: 71 });
    expect(st.pr.loyal).toEqual({ mean: 54.25, max: 60, min: 50 });
    expect(st.pr.blue?.mean).toBeCloseTo(65.33, 2);
    expect([st.pr.merlin, st.pr.percival, st.pr.assassin]).toEqual([85, 90, 80]);
    expect(st.elo?.red?.max).toBe(1520);
    expect(redBlueGap(st)).toBeCloseTo(9.17, 2);
  });

  it('a group with an unnamed seat cannot be scored; the others still can', () => {
    const seats = { ...gameSeats(byId('A')), known: [true, true, true, true, true, true, true, true, true, false] };
    const st = roleStrength(byId('A').lineup!, seats);
    expect(st.pr.loyal).toBeNull();
    expect(st.pr.blue).toBeNull();
    expect(st.pr.red?.min).toBe(71);
    expect(redBlueGap(st)).toBeNull();
  });

  it('role conditions: alone, with S, and / or; an unknown seat fails the condition', () => {
    const a = byId('A');
    const seats = gameSeats(a);
    expect(matchesLineup(a.lineup, { merlinPrMin: 80 }, seats)).toBe(true);
    expect(matchesLineup(a.lineup, { merlinPrMin: 90 }, seats)).toBe(false);
    expect(matchesLineup(a.lineup, { percivalPrMin: 90, redMinPrMin: 71, loyalMinPrMin: 50 }, seats)).toBe(true);
    expect(matchesLineup(a.lineup, { gapMin: 9 }, seats)).toBe(true);
    expect(matchesLineup(a.lineup, { gapMin: 10 }, seats)).toBe(false);
    expect(matchesLineup(a.lineup, { gapMin: 10, sMin: 60, combine: 'or' }, seats)).toBe(true);
    expect(matchesLineup(a.lineup, { merlinPrMin: 0 })).toBe(false); // no roles given
    expect(matchesLineup(a.lineup, { loyalMinPrMin: 0 }, { ...seats, known: seats.known.map((k, i) => i !== 9) })).toBe(false);
  });

  it('the lineup clause with role fields filters games and survives link validation', () => {
    const decoded = decodeGamesDataset(dataset);
    const ids = (clause: Record<string, unknown>) => applyFilter(decoded, { asOf: '2026-10-31' },
      sanitizeFilter({ v: 1, clauses: [{ kind: 'lineup', ...clause }] }).filter).games.map((g) => g.id);
    expect(ids({ merlinPrMin: 70 })).toEqual(['A']);
    expect(ids({ gapMin: -20 })).toEqual(['A', 'C', 'O']);
    expect(ids({ gapMin: 0 })).toEqual(['A']);
    expect(ids({ redMinPrMin: 50, includeUnscored: true })).toEqual(['A', 'U']);
    expect(sanitizeFilter({ v: 1, clauses: [{ kind: 'lineup', gapMin: -101 }] }).warnings).toEqual(['clauses[0].gapMin']);
  });
});

describe('computeStrengthReport', () => {
  const report = computeStrengthReport(games);
  it('points with the table Elo range; old files without seat Elo have none', () => {
    expect(report.points.map((p) => p.id)).toEqual(['A', 'C', 'O']);
    expect(report.points[0].elo).toMatchObject({ min: 1490, median: 1511.5, max: 1530 });
    expect(report.points[0].elo?.mean).toBeCloseTo(1509);
    expect(report.points[2].elo).toBeNull();
    expect([report.games, report.scored]).toEqual([4, 3]);
  });

  it('half-year × S bin cells and S tiers', () => {
    expect(report.periods).toEqual(['2024 H1']);
    expect(report.heatmap.find((c) => c.bin === 'ge65')).toMatchObject({ period: '2024 H1', n: 1, blueAlive: 1 });
    expect(report.heatmap.find((c) => c.bin === '38-45')).toMatchObject({ period: '2024 H1', n: 2, threeRed: 2 });
    expect(report.tiers.map((t) => t.n)).toEqual([1, 0, 2, 0]);
    expect(report.overall).toEqual({ n: 3, threeRed: 2, blueDead: 0, blueAlive: 1 });
  });

  it('process metrics per group, the unscored game left out', () => {
    const m = (id: string) => report.comparison.metrics.find((x) => x.id === id)!;
    expect(report.comparison.groups.map((g) => g.games)).toEqual([1, 0, 2, 0]);
    expect(report.comparison.excluded).toBe(1);
    expect(m('threePlusOne').values[0]).toEqual({ value: 100, n: 1 });
    expect(m('loneRedFail').values[0]).toEqual({ value: 100, n: 1 });
    expect(m('r4Double').values[0]).toEqual({ value: 100, n: 1 });
    expect(m('proposalsPerRound').values[0].value).toBeCloseTo(1.2);
    expect(m('blueLakeRed').values[0]).toEqual({ value: 100, n: 1 });
    expect(m('redLakeMate').values[0]).toEqual({ value: 100, n: 1 });
    expect(m('redTruth').values[0]).toEqual({ value: 0, n: 1 });
    expect(m('hit').values[0]).toEqual({ value: 0, n: 1 });
    // C: one proposal, team 1 5 7, outer white by 8 9 0 (all loyal)
    expect(m('outerWhiteBlue').values[2]).toEqual({ value: 3, n: 1 });
    expect(m('offApproveBlue').values[2]).toEqual({ value: 75, n: 4 });
    expect(m('offApproveRed').values[2]).toEqual({ value: 0, n: 3 });
    expect(m('outerWhite:忠臣').values[2]).toEqual({ value: 100, n: 3 });
    expect(m('threeRed').all).toEqual({ value: 200 / 3, n: 3 });
    expect(m('s').values[2].value).toBeCloseTo(40);
  });

  it('role groupings: Merlin tier, Merlin vs assassin, red-blue gap, weakest red, PR count', () => {
    const groups = (g: StrengthGrouping) => computeStrengthReport(games, g).comparison.groups.map((x) => x.games);
    expect(groups({ kind: 'merlin' })).toEqual([1, 0, 2]); // 85 / — / 30, 30
    expect(groups({ kind: 'merlinVsAssassin' })).toEqual([0, 3, 0]);
    expect(groups({ kind: 'gap' })).toEqual([0, 1, 2]); // A +9.2；C、O 藍方強 16.7
    expect(groups({ kind: 'weakRed', pr: 50 })).toEqual([2, 1]);
    expect(groups({ kind: 'weakLoyal', pr: 50 })).toEqual([0, 3]);
    expect(groups({ kind: 'count', pr: 70, count: 4 })).toEqual([1, 2]);
    expect(groups({ kind: 'percival' })).toEqual([1, 2, 0]);
  });

  it('rolling median and half years', () => {
    expect(rollingMedian([1, 9, 2, 8, 3], 1)).toEqual([5, 2, 8, 3, 5.5]);
    expect([halfYearOf('2025-06-30'), halfYearOf('2025-07-01')]).toEqual(['2025 H1', '2025 H2']);
    expect(TEN).toHaveLength(10);
  });

  it('seat spread (min, quartiles, median, mean, max) of PR and Elo', () => {
    expect(report.points[0].pr).toEqual(seatSpread(PRS_A));
    expect(seatSpread([1, 2, 3, 4, 5])).toEqual({ min: 1, q1: 2, median: 3, mean: 3, q3: 4, max: 5 });
    expect(quantileSorted([10, 20], 0.25)).toBe(12.5);
  });

  it('tertile grouping: explicit cuts, or cuts from the games', () => {
    const groups = (g: StrengthGrouping) => computeStrengthReport(games, g).comparison.groups;
    expect(groups({ kind: 'tertile', dim: 'merlin', lo: 50, hi: 80 }).map((x) => x.games)).toEqual([1, 0, 2]);
    expect(groups({ kind: 'tertile', dim: 'merlin', lo: 50, hi: 80 })[0].label).toBe('梅林 PR 前 1/3');
    expect(groups({ kind: 'tertile', dim: 's' }).reduce((a, x) => a + x.games, 0)).toBe(3);
  });

  it('decision metrics: Merlin votes and leads, red leaders stacking, the assassin hitting Percival', () => {
    const m = (id: string) => report.comparison.metrics.find((x) => x.id === id)!;
    // A, R3 1567 (Merlin 6 on the team, the assassin 1 visible): Merlin approves; R4 12567 likewise.
    expect(m('merlinOnSeenApprove').values[0]).toEqual({ value: 100, n: 2 });
    // C: team 157 has the visible assassin 1, Merlin 6 off the team, does not approve.
    expect(m('merlinOffSeenApprove').values[2]).toEqual({ value: 0, n: 1 });
    expect(m('killPercival').values[0]).toEqual({ value: 0, n: 1 });
  });
});

describe('strength vs outcome helpers', () => {
  it('Wilson interval and empirical-Bayes shrinkage', () => {
    const w = wilson(5, 10);
    expect(w.rate).toBe(50);
    expect(w.lo).toBeCloseTo(23.66, 1);
    expect(w.hi).toBeCloseTo(76.34, 1);
    expect(shrinkRate(5, 5, 0.5)).toBeCloseTo(60); // (5 + 20·0.5) / 25
    expect(shrinkRate(0, 0, 0.45)).toBeCloseTo(45);
    expect(shrinkRate(100, 100, 0.5)).toBeCloseTo(100 * 110 / 120);
  });

  it('outcome by S: equal-count bins, ties kept together', () => {
    const many = decodeGamesDataset(makeDataset(Array.from({ length: 40 }, (_, i) => ({
      id: `S${i}`, date: '2025-01-01', outcome: i < 20 ? '三紅' : '三藍活',
      lineup: [30, i < 20 ? 300 : 700, Array(10).fill(i < 20 ? 30 : 70), 0] as LineupTuple,
    })))).games;
    const bins = outcomeByS(many, 8);
    expect(bins).toHaveLength(2); // only two distinct S values
    expect(bins.map((b) => [b.lo, b.n, Math.round(b.threeRed.rate)])).toEqual([[30, 20, 100], [70, 20, 0]]);
  });

  it('river series: medians of the table spread over a ±half window, outcome shares, at most maxPoints', () => {
    const pts: StrengthPoint[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), date: `2025-01-${String(i + 1).padStart(2, '0')}`, outcome: i % 2 ? '三紅' : '三藍活', s: 40 + i,
      pr: { min: i, q1: i + 10, median: i + 20, mean: i + 21, q3: i + 30, max: i + 40 }, elo: null,
    }));
    const river = riverSeries(pts, 'pr', 1, 100);
    expect(river).toHaveLength(10);
    expect(river[5]).toMatchObject({ n: 3, median: 25, min: 5, max: 45, s: 45 });
    expect(river[5].threeRed + river[5].blueAlive).toBeCloseTo(100);
    expect(riverSeries(pts, 'pr', 1, 4)).toHaveLength(4);
    expect(riverSeries(pts, 'elo')).toEqual([]);
  });
});
