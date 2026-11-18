import { describe, expect, it } from 'vitest';
import { addPoint, FINE_BINS, groupedLogistic, mergeAcc, newAcc, summarize } from './calibration';

/** 決定性的偽亂數（測試用）。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('calibration curve', () => {
  it('computes exact Brier and log loss from the binned sums', () => {
    const a = newAcc();
    addPoint(a, 0.8, 1);
    addPoint(a, 0.8, 0);
    addPoint(a, 0.2, 0);
    addPoint(a, 0, 0);
    const s = summarize(a);
    expect(s.n).toBe(4);
    expect(s.baseRate).toBe(0.25);
    expect(s.brier).toBeCloseTo((0.04 + 0.64 + 0.04 + 0) / 4, 12);
    expect(s.logLoss).toBeCloseTo((-Math.log(0.8) - Math.log(0.2) - Math.log(0.8) - Math.log(1 - 1e-6)) / 4, 9);
    expect(s.bins[8].n).toBe(2);
    expect(s.bins[8].freq).toBe(0.5);
    expect(s.bins[0].n).toBe(1);
    expect(s.brierBase).toBeCloseTo(0.1875, 12);
  });

  it('puts p = 1 into the last bin and merges shards', () => {
    const a = newAcc();
    const b = newAcc();
    addPoint(a, 1, 1);
    addPoint(b, 0.55, 0);
    const m = mergeAcc(a, b);
    expect(m.n[FINE_BINS - 1]).toBe(1);
    expect(m.n[55]).toBe(1);
    expect(summarize(m).n).toBe(2);
  });

  it('finds a calibrated predictor calibrated and an overconfident one overconfident', () => {
    const rnd = lcg(7);
    const good = newAcc();
    const over = newAcc();
    for (let i = 0; i < 40000; i++) {
      const p = 0.05 + 0.9 * rnd();
      const y: 0 | 1 = rnd() < p ? 1 : 0;
      addPoint(good, p, y);
      // 過度自信：logit 放大兩倍
      const z = 2 * Math.log(p / (1 - p));
      addPoint(over, 1 / (1 + Math.exp(-z)), y);
    }
    const g = summarize(good);
    const o = summarize(over);
    expect(g.ece).toBeLessThan(0.02);
    expect(g.platt!.b).toBeGreaterThan(0.9);
    expect(g.platt!.b).toBeLessThan(1.1);
    expect(o.ece).toBeGreaterThan(g.ece);
    expect(o.platt!.b).toBeGreaterThan(0.4);
    expect(o.platt!.b).toBeLessThan(0.6); // 真斜率 0.5
    expect(o.reliability).toBeGreaterThan(g.reliability);
  });

  it('fits a grouped logistic regression', () => {
    // 真參數 a = 0.5、b = 2：用期望次數當資料，估計要回到真值。
    const x = [-2, -1, 0, 1, 2];
    const n = x.map(() => 10000);
    const s = x.map((v, i) => n[i] / (1 + Math.exp(-(0.5 + 2 * v))));
    const fit = groupedLogistic(x, s, n)!;
    expect(fit.a).toBeCloseTo(0.5, 6);
    expect(fit.b).toBeCloseTo(2, 6);
    expect(groupedLogistic([1], [1], [2])).toBeNull();
  });
});
