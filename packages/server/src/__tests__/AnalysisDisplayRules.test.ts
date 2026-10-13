/**
 * Display rules of the analysis pages (packages/web/src/utils/analysisDisplay.ts;
 * the web package has no test runner, so its pure helpers are tested here).
 *
 *  - 位置勝率 tooltip: the per-seat 三紅/三藍死/三藍活 line is the overall split on
 *    every seat (one result per game, all 10 seats filled), so it showed 三紅 45.5 %
 *    on all ten (players' report 2026-10-13 「全員 46%」). It is listed only when
 *    seats really differ.
 *  - 三結果配對 matrix: a pair cell from fewer shared games than theoryMinCellGames
 *    gets no red/blue colour (1–2 games read as 0 / 50 / 100 %).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  SEAT_OUTCOME_MIN_SPREAD,
  isThinPairCell,
  seatOutcomesDiffer,
} from '../../../web/src/utils/analysisDisplay';

const split = (r: number, d: number, a: number) => ({ threeRedPct: r, threeBlueDeadPct: d, threeBlueAlivePct: a });

describe('seatOutcomesDiffer', () => {
  it('hides the line when every seat carries the same split', () => {
    const seats = Array.from({ length: 10 }, () => ({ outcomes: split(45.5, 23.9, 30.6) }));
    expect(seatOutcomesDiffer(seats)).toBe(false);
  });

  it('hides it for differences below the spread (rounding, a game with an empty seat)', () => {
    const seats = [{ outcomes: split(45.5, 23.9, 30.6) }, { outcomes: split(45.6, 23.8, 30.6) }];
    expect(SEAT_OUTCOME_MIN_SPREAD).toBeGreaterThan(0.1);
    expect(seatOutcomesDiffer(seats)).toBe(false);
  });

  it('shows it when seats really differ in any of the three outcomes', () => {
    expect(seatOutcomesDiffer([{ outcomes: split(40, 30, 30) }, { outcomes: split(50, 20, 30) }])).toBe(true);
    expect(seatOutcomesDiffer([{ outcomes: split(45, 25, 30) }, { outcomes: split(45, 20, 35) }])).toBe(true);
  });

  it('needs two seats with a split; missing / odd outcomes are skipped', () => {
    expect(seatOutcomesDiffer([])).toBe(false);
    expect(seatOutcomesDiffer([{ outcomes: split(40, 30, 30) }])).toBe(false);
    expect(seatOutcomesDiffer([{ outcomes: split(40, 30, 30) }, {}, { outcomes: null }])).toBe(false);
    expect(seatOutcomesDiffer([{}, { outcomes: split(40, 30, 30) }, { outcomes: split(60, 10, 30) }])).toBe(true);
  });

  it('is false on the committed cache: every seat holds the overall split', () => {
    const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'analysis_cache.json'), 'utf-8'));
    const seats = cache.overview?.seatPositionWinRates ?? [];
    if (seats.length < 2 || !seats.every((s: { outcomes?: unknown }) => s.outcomes)) return;
    expect(seatOutcomesDiffer(seats)).toBe(false);
  });
});

describe('isThinPairCell', () => {
  it('flags pair cells under the threshold', () => {
    expect(isThinPairCell(1, 3)).toBe(true);
    expect(isThinPairCell(2, 3)).toBe(true);
    expect(isThinPairCell(3, 3)).toBe(false);
    expect(isThinPairCell(40, 3)).toBe(false);
  });

  it('never flags without a game count (older cache) or with the threshold off', () => {
    expect(isThinPairCell(undefined, 3)).toBe(false);
    expect(isThinPairCell(null, 3)).toBe(false);
    expect(isThinPairCell(1, 0)).toBe(false);
    expect(isThinPairCell(1, Number.NaN)).toBe(false);
  });
});
