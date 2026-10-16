/**
 * 引擎的精確運算與 Python 逐筆相同（複合篩選，Edward 2026-10-14）：rnd1 的五成雙、_rate、f"{x:.1f}"、
 * Fraction 上的 _cell_rate / _round_exact、由左而右加總、依碼位排序名字。期望值由
 * scripts/build_pyround_fixture.py 用 Python 3.11 產生（fixtures/stats_parity/pyround_cases.json）。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  Rational,
  cellRate,
  cmpCodePoint,
  compareKeys,
  minByKey,
  pyFormatFixed,
  pySlice,
  rate,
  rnd1,
  sortByKey,
  sumLtr,
} from '@avalon/shared/stats';

const cases = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'stats_parity', 'pyround_cases.json'), 'utf-8'),
) as {
  rnd1: Array<[number, number]>;
  rate: Array<[number, number, number]>;
  format: Array<[number, string, string]>;
  cells: Array<[number, number, number, number, number]>;
  names: string[];
  sorted: string[];
  sumLtr: Array<[number[], number]>;
};

describe('Python rounding', () => {
  it('rnd1 = round(n * 10) / 10 with ties to even', () => {
    for (const [x, expected] of cases.rnd1) expect(Object.is(rnd1(x), expected) || rnd1(x) === expected, String(x)).toBe(true);
    expect(rnd1(56.25)).toBe(56.2);
    expect(rnd1(56.35)).toBe(56.4);
    expect(rnd1(-2.5 / 10)).toBe(-0.2);
  });

  it('_rate over every count / total up to 60', () => {
    for (const [c, t, expected] of cases.rate) expect(rate(c, t), `${c}/${t}`).toBe(expected);
  });

  it('f"{x:.1f}" and f"{x:.0f}" (ties to even on the exact binary value)', () => {
    for (const [x, one, zero] of cases.format) {
      expect(pyFormatFixed(x, 1), String(x)).toBe(one);
      expect(pyFormatFixed(x, 0), String(x)).toBe(zero);
    }
    expect(pyFormatFixed(40.5, 0)).toBe('40');
    expect((40.5).toFixed(0)).toBe('41'); // why toFixed is not used
  });

  it('_cell_rate + _round_exact on Fraction(str(population))', () => {
    for (const [wins, games, population, minCell, expected] of cases.cells) {
      expect(cellRate(wins, games, population, minCell).roundTenth(), JSON.stringify([wins, games, population, minCell])).toBe(expected);
    }
  });

  it('Rational', () => {
    expect(Rational.fromDecimalString('66.7').compare(Rational.of(667, 10))).toBe(0);
    expect(Rational.fromDecimalString('45').compare(Rational.fromDecimalString('45.0'))).toBe(0);
    expect(Rational.fromDecimalString('1e-3').compare(Rational.of(1, 1000))).toBe(0);
    expect(Rational.of(5, 2).roundHalfEven()).toBe(2n);
    expect(Rational.of(7, 2).roundHalfEven()).toBe(4n);
    expect(Rational.of(-5, 2).roundHalfEven()).toBe(-2n);
    expect(Rational.of(1, 4).roundTenth()).toBe(0.2); // 2.5 -> 2
    expect(Rational.of(3, 4).roundTenth()).toBe(0.8); // 7.5 -> 8
    expect(() => Rational.of(1, 0)).toThrow();
  });

  it('left-to-right float sums (Python 3.11 sum)', () => {
    for (const [xs, expected] of cases.sumLtr) expect(sumLtr(xs)).toBe(expected);
  });
});

describe('Python ordering', () => {
  it('names sort by code point like Python str', () => {
    expect([...cases.names].sort(cmpCodePoint)).toEqual(cases.sorted);
    expect(cmpCodePoint('測試😀', '測試Ｚ')).toBe(1); // U+1F600 > U+FF3A although '\ud83d' < 'Ｚ'
    expect('測試😀' < '測試Ｚ').toBe(true);
  });

  it('tuple keys, stable sort, min, slices', () => {
    expect(compareKeys([-50, 'b'], [-50, 'a'])).toBe(1);
    expect(compareKeys([false], [true])).toBe(-1);
    const rows = [{ n: 'b', v: 1 }, { n: 'a', v: 2 }, { n: 'c', v: 1 }];
    expect(sortByKey(rows, (r) => [-r.v]).map((r) => r.n)).toEqual(['a', 'b', 'c']); // ties keep their order
    expect(minByKey(rows, (r) => [r.v])?.n).toBe('b');
    const xs = [1, 2, 3, 4, 5];
    expect(pySlice(xs, -2)).toEqual([4, 5]);
    expect(pySlice(xs, -10)).toEqual(xs);
    expect(pySlice(xs, -0)).toEqual(xs); // seq[-0:] is the whole list
    expect(pySlice(xs, -4, -2)).toEqual([2, 3]);
    expect(pySlice(xs, -0, -0)).toEqual([]);
  });
});
