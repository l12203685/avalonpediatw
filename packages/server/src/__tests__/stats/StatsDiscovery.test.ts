/**
 * 自動發現（Edward 2026-10-31）：統計工具、單位拆分（局勢用任務順序）、掃描能找出埋進去的差異、隨機資料不亂報、
 * 定義上相關的組合不比、比分與順序都有差時只留順序。合成局，名字全是虛構的。
 */
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_DIMENSIONS, EXCLUDED_PAIRS, benjaminiHochberg, cohenH, decodeGamesDataset, discoverFindings, findingPages,
  gameUnits, normalCdf, scoreOfSequence, twoProportion, welch, type LineupTuple,
} from '@avalon/shared/stats';
import { makeDataset, type GameSpec } from './datasetBuilder';

/** 固定種子的亂數（每次測試結果一樣）。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** n 局：梅林（6 號）PR 隨機 0–100；planted = true 時梅林 PR 越高越少三紅。 */
function synthetic(n: number, planted: boolean, seed = 7): GameSpec[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const merlin = Math.round(r() * 100);
    const prs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((j) => (j === 5 ? merlin : Math.round(30 + 40 * r())));
    const pRed = planted ? 0.75 - 0.5 * (merlin / 100) : 0.5;
    const outcome = r() < pRed ? '三紅' : r() < 0.5 ? '三藍死' : '三藍活';
    return {
      id: `G${i}`, date: `202${3 + (i % 3)}-0${1 + (i % 9)}-15`, config: '123456', outcome, kill: outcome === '三紅' ? '' : '6',
      missions: outcome === '三紅' ? 'oox|ooox|ooox||' : 'ooo|oooo|oooo||',
      lineup: [30, Math.round(prs.reduce((a, b) => a + b, 0)), prs, 0] as LineupTuple, // S×10 = 10 個 PR 的總和
    };
  });
}

describe('statistics', () => {
  it('normal CDF, two proportions, Welch, Cohen h, BH', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    const t = twoProportion(60, 100, 40, 100);
    expect(t.diff).toBeCloseTo(20);
    expect(t.p).toBeCloseTo(0.0047, 3);
    expect(t.lo).toBeCloseTo(6.4, 0);
    const w = welch([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(w.diff).toBe(0);
    expect(w.p).toBeCloseTo(1, 6);
    expect(cohenH(0.5, 0.5)).toBe(0);
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.5]);
    [0.04, 0.16 / 3, 0.16 / 3, 0.5].forEach((v, i) => expect(q[i]).toBeCloseTo(v, 10));
  });
});

describe('units and the game state', () => {
  const [g] = decodeGamesDataset(makeDataset([{
    config: '123456', outcome: '三紅', missions: 'ooo|ooox|ooox|ooxxo|',
    votes: [[1, 1, '567', '567890'], [2, 1, '1567', '156789'], [3, 1, '1567', '156789'], [4, 1, '12567', '125678']],
    lakes: '01----', claims: '01x',
  }])).games;
  it('the state before each round is the mission sequence (order matters), also with the lake claims', () => {
    const p = gameUnits(g).proposal;
    expect(p.map((r) => r.dims.sequence)).toEqual(['（開局）', '藍', '藍紅', '藍紅紅']);
    expect(p.map((r) => r.dims.score)).toEqual(['藍 0：紅 0', '藍 1：紅 0', '藍 1：紅 1', '藍 1：紅 2']);
    expect(p[3].dims.seqLake).toBe('藍紅紅｜湖宣告紅'); // the lake after round 2 said red
    expect(gameUnits(g).lake[0].dims.sequence).toBe('藍紅');
    expect(scoreOfSequence('紅藍藍紅')).toBe('藍 2：紅 2');
  });

  it('missions, lakes and seats become rows with their metrics', () => {
    const u = gameUnits(g);
    expect(u.mission.map((r) => r.metrics.get('failed')?.[0])).toEqual([0, 1, 1, 1]);
    expect(u.lake[0].metrics.get('targetRed')).toEqual([1, 1]);
    expect(u.lake[0].metrics.get('claimTrue')).toEqual([1, 1]);
    expect(u.seat).toHaveLength(10);
    expect(u.seat[0].metrics.get('finalWin')).toEqual([1, 1]); // the assassin, three red
  });
});

describe('discoverFindings', () => {
  it('finds a planted effect with the right direction, CI and a grouping link', () => {
    const { games } = decodeGamesDataset(makeDataset(synthetic(600, true)));
    const r = discoverFindings(games);
    const f = r.findings.find((x) => x.dimension.id === 'merlin' && x.metric.id === 'threeRed');
    expect(f).toBeDefined();
    expect(f!.diff).toBeLessThan(-15);
    expect(f!.hi).toBeLessThan(0);
    expect(f!.q).toBeLessThanOrEqual(0.05);
    expect(f!.grouping).toMatchObject({ kind: 'tertile', dim: 'merlin' });
    expect(findingPages(f!)).toEqual(expect.arrayContaining(['overview', 'strength']));
    expect(r.findings.every((x, i, a) => i === 0 || Math.abs(a[i - 1].effect) >= Math.abs(x.effect))).toBe(true);
  });

  it('reports nothing on the same dimension when the outcome is random', () => {
    const { games } = decodeGamesDataset(makeDataset(synthetic(600, false)));
    const r = discoverFindings(games);
    expect(r.findings.filter((x) => x.dimension.id === 'merlin' && x.metric.id === 'threeRed')).toEqual([]);
    expect(r.tests).toBeGreaterThan(50);
  });

  it('skips definitional pairs and needs 30 per group', () => {
    const { games } = decodeGamesDataset(makeDataset(synthetic(600, true)));
    const r = discoverFindings(games);
    expect(r.findings.some((f) => EXCLUDED_PAIRS.has(`${f.unit}|${f.dimension.id}|${f.metric.id}`))).toBe(false);
    expect(r.findings.every((f) => f.a.units >= 30 && f.b.units >= 30)).toBe(true);
    const small = discoverFindings(decodeGamesDataset(makeDataset(synthetic(40, true))).games);
    expect(small.findings.filter((f) => f.unit === 'game')).toEqual([]); // 40 games: no tertile reaches 30
  });

  it('marks the game-state dimensions as structural and keeps the coarse score as its own dimension', () => {
    const ids = DISCOVERY_DIMENSIONS.filter((d) => d.unit === 'proposal' && d.structural).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['sequence', 'seqLake', 'score', 'round']));
  });
});
