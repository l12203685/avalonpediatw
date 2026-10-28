/**
 * 分析頁的純函式 (Edward 2026-10-28)：
 *  - packages/web/src/utils/chiSquare.ts — 卡方獨立性檢定 (刺殺座位、1-1、湖中女神的「差異明顯／可能只是運氣」)
 *  - packages/web/src/components/analysis/overview/playerOutcomeShares.ts — 三種結果 × 贏輸的四條比例
 */
import { describe, expect, it } from 'vitest';
import {
  chiSquareIndependence, chiSquareSurvival, chiSquareVerdict, formatPValue, gammaQ, logGamma,
} from '../../../web/src/utils/chiSquare';
import {
  hasRawOutcomes, playerOutcomeShares, sumRawOutcomes,
} from '../../../web/src/components/analysis/overview/playerOutcomeShares';

describe('chiSquareSurvival', () => {
  it('matches closed forms for even df (df = 2: p = e^(−x/2); df = 4: e^(−x/2)(1 + x/2))', () => {
    for (const x of [0.1, 1, 3, 7.5, 20]) {
      expect(chiSquareSurvival(x, 2)).toBeCloseTo(Math.exp(-x / 2), 12);
      expect(chiSquareSurvival(x, 4)).toBeCloseTo(Math.exp(-x / 2) * (1 + x / 2), 12);
    }
  });

  it('matches textbook critical values', () => {
    expect(chiSquareSurvival(3.841459, 1)).toBeCloseTo(0.05, 5);
    expect(chiSquareSurvival(6.634897, 1)).toBeCloseTo(0.01, 5);
    expect(chiSquareSurvival(16.918978, 9)).toBeCloseTo(0.05, 5);
    expect(chiSquareSurvival(21.665994, 9)).toBeCloseTo(0.01, 5);
    expect(chiSquareSurvival(43.772972, 30)).toBeCloseTo(0.05, 5);
  });

  it('edge cases: x ≤ 0 → 1, bad df → NaN', () => {
    expect(chiSquareSurvival(0, 3)).toBe(1);
    expect(chiSquareSurvival(-1, 3)).toBe(1);
    expect(chiSquareSurvival(2, 0)).toBeNaN();
    expect(gammaQ(1, 0)).toBe(1);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
  });
});

describe('chiSquareIndependence', () => {
  it('computes χ², df and p for a 2×2 table (hand-computed)', () => {
    const r = chiSquareIndependence([[10, 20], [30, 40]]);
    expect(r).not.toBeNull();
    // 期望 12 / 18 / 28 / 42 → 4/12 + 4/18 + 4/28 + 4/42
    expect(r!.chi2).toBeCloseTo(4 / 12 + 4 / 18 + 4 / 28 + 4 / 42, 10);
    expect(r!.df).toBe(1);
    expect(r!.n).toBe(100);
    expect(r!.minExpected).toBe(12);
    expect(r!.p).toBeCloseTo(0.373, 3);
    expect(chiSquareVerdict(r!)).toBe('luck');
  });

  it('identical proportions → χ² = 0, p = 1', () => {
    const r = chiSquareIndependence([[5, 10], [10, 20], [1, 2]]);
    expect(r!.chi2).toBeCloseTo(0, 12);
    expect(r!.p).toBe(1);
  });

  it('skips all-zero rows / columns and returns null when nothing can be compared', () => {
    const r = chiSquareIndependence([[10, 0, 20], [0, 0, 0], [30, 0, 40]]);
    expect(r!.df).toBe(1);
    expect(r!.chi2).toBeCloseTo(4 / 12 + 4 / 18 + 4 / 28 + 4 / 42, 10);
    expect(chiSquareIndependence([[10, 20]])).toBeNull();
    expect(chiSquareIndependence([[10, 0], [5, 0]])).toBeNull();
    expect(chiSquareIndependence([])).toBeNull();
    // 負數、NaN 當 0
    const cleaned = chiSquareIndependence([[10, Number.NaN], [-3, 4]])!;
    expect(cleaned.n).toBe(14);
    expect(cleaned.chi2).toBeCloseTo(14, 10); // [[10, 0], [0, 4]]：完全分開 → χ² = n
  });

  // 三藍局 × 座位 (刺中, 沒刺中) — 2026-10-28 快取的合計數字 (只有局數，沒有任何玩家資料)
  const merlinSeat = [[56, 64], [57, 52], [55, 56], [67, 67], [92, 86], [55, 83], [40, 61], [40, 59], [37, 81], [46, 87]];
  const assassinSeat = [[54, 75], [67, 84], [60, 80], [44, 65], [29, 63], [59, 60], [74, 77], [52, 71], [68, 67], [38, 54]];

  it("Merlin's seat: the gap is real (p < 0.01)", () => {
    const r = chiSquareIndependence(merlinSeat)!;
    expect(r.n).toBe(1241);
    expect(r.df).toBe(9);
    expect(r.chi2).toBeGreaterThan(21.67);
    expect(r.p).toBeLessThan(0.01);
    expect(chiSquareVerdict(r)).toBe('clear');
  });

  it("Assassin's seat: could be luck (p > 0.05)", () => {
    const r = chiSquareIndependence(assassinSeat)!;
    expect(r.n).toBe(1241);
    expect(r.p).toBeGreaterThan(0.05);
    expect(r.p).toBeLessThan(0.5);
    expect(chiSquareVerdict(r)).toBe('luck');
  });
});

describe('formatPValue', () => {
  it('rounds to two significant digits, floors tiny values', () => {
    expect(formatPValue(0.0004)).toBe('<0.001');
    expect(formatPValue(0.00234)).toBe('0.0023');
    expect(formatPValue(0.187)).toBe('0.19');
    expect(formatPValue(0.05)).toBe('0.05');
    expect(formatPValue(0.999)).toBe('1');
    expect(formatPValue(Number.NaN)).toBe('—');
  });
});

describe('playerOutcomeShares', () => {
  const raw = {
    rawRedThreeRed: 20, rawRedMerlinDead: 10, rawRedMerlinAlive: 6,
    rawBlueThreeRed: 30, rawBlueMerlinDead: 14, rawBlueMerlinAlive: 20,
  };

  it('splits each outcome into won / lost from the player’s own side', () => {
    const s = playerOutcomeShares(raw);
    expect(s.games).toBe(100);
    expect(s.outcomes.三紅).toEqual({ won: 20, lost: 30 }); // 紅方三紅贏、藍方三紅輸
    expect(s.outcomes.三藍死).toEqual({ won: 10, lost: 14 }); // 紅方刺中贏、藍方被刺輸
    expect(s.outcomes.三藍活).toEqual({ won: 20, lost: 6 }); // 藍方梅林活贏、紅方沒刺中輸
  });

  it('mission / assassination / final win rates and denominators', () => {
    const s = playerOutcomeShares(raw);
    expect(s.mission).toEqual({ win: 20 + 14 + 20, n: 100, rate: 54 });
    expect(s.assassination.win).toBe(10 + 20);
    expect(s.assassination.n).toBe(10 + 6 + 14 + 20);
    expect(s.assassination.rate).toBeCloseTo(60, 10);
    expect(s.final).toEqual({ win: 20 + 10 + 20, n: 100, rate: 50 });
    // 最終贏 = 三種結果「贏」的加總
    expect(s.final.win).toBe(s.outcomes.三紅.won + s.outcomes.三藍死.won + s.outcomes.三藍活.won);
  });

  it('no three-blue games → assassination rate null; missing counts treated as 0', () => {
    const s = playerOutcomeShares({ rawRedThreeRed: 3, rawBlueThreeRed: 2 });
    expect(s.games).toBe(5);
    expect(s.assassination).toEqual({ win: 0, n: 0, rate: null });
    expect(s.final.rate).toBe(60);
    expect(playerOutcomeShares({}).mission.rate).toBeNull();
  });

  it('sumRawOutcomes pools every player-game; null when any row lacks the counts', () => {
    const sum = sumRawOutcomes([raw, raw]);
    expect(sum).toEqual({
      rawRedThreeRed: 40, rawRedMerlinDead: 20, rawRedMerlinAlive: 12,
      rawBlueThreeRed: 60, rawBlueMerlinDead: 28, rawBlueMerlinAlive: 40,
    });
    expect(playerOutcomeShares(sum!).final.rate).toBe(50);
    expect(sumRawOutcomes([raw, { rawRedThreeRed: 1 }])).toBeNull();
    expect(sumRawOutcomes([])).toBeNull();
    expect(hasRawOutcomes(raw)).toBe(true);
    expect(hasRawOutcomes(null)).toBe(false);
  });
});
