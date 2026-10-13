/**
 * 三塊結果 (Edward 2026-10-14) — @avalon/shared outcomeBlocks.ts, the conditional outcome rates the
 * site, the API radar and the bots show for any group of one player's games (red games, blue games,
 * a role, a seat): 任務結果 over all the group's games, 刺殺結果 over the games that reached 三藍
 * only, 遊戲結果 over all games. docs/stats/two_stage_outcome.md「三塊結果」.
 */
import { describe, expect, it } from 'vitest';
import {
  RED_ROLE_NAMES,
  normalizeOutcomeCounts,
  outcomeBlocks,
  playerOutcomeBlocks,
  roleFaction,
} from '@avalon/shared';

describe('outcomeBlocks', () => {
  it('red games: 任務結果 = 三紅 / n, 刺殺結果 = 三藍死 / 三藍 games, 遊戲結果 = (三紅 + 三藍死) / n', () => {
    expect(outcomeBlocks({ 三紅: 30, 三藍死: 20, 三藍活: 50 }, 'red')).toEqual({
      faction: 'red',
      mission: { win: 30, wins: 30, n: 100 },
      assassination: { win: 28.6, wins: 20, n: 70 }, // 20 / 70, not 20 / 100
      final: { win: 50, wins: 50, n: 100 },
    });
  });

  it('blue games: 任務結果 = 三藍 / n, 刺殺結果 = 三藍活 / 三藍 games, 遊戲結果 = 三藍活 / n', () => {
    expect(outcomeBlocks({ 三紅: 30, 三藍死: 20, 三藍活: 50 }, 'blue')).toEqual({
      faction: 'blue',
      mission: { win: 70, wins: 70, n: 100 },
      assassination: { win: 71.4, wins: 50, n: 70 },
      final: { win: 50, wins: 50, n: 100 },
    });
  });

  it("the owner's example: 三藍死 as red is a share of the red games that reached 三藍, not of all red games", () => {
    // 400 red games: 三紅 150, 三藍死 100, 三藍活 150. The old radar showed 100 / 400 = 25.0%.
    const red = outcomeBlocks({ 三紅: 150, 三藍死: 100, 三藍活: 150 }, 'red');
    expect(red.assassination).toEqual({ win: 40, wins: 100, n: 250 });
    expect(red.mission.win).toBe(37.5);
    expect(red.final.win).toBe(62.5);
  });

  it('n = 0 gives null, never 0% or NaN', () => {
    expect(outcomeBlocks({ 三紅: 5 }, 'red').assassination).toEqual({ win: null, wins: 0, n: 0 });
    const none = outcomeBlocks(null, 'blue');
    expect([none.mission.win, none.assassination.win, none.final.win]).toEqual([null, null, null]);
    expect([none.mission.n, none.assassination.n, none.final.n]).toEqual([0, 0, 0]);
  });

  it('rounds to one decimal with ties to even, like generate_cache.py', () => {
    expect(outcomeBlocks({ 三紅: 9, 三藍活: 7 }, 'red').mission.win).toBe(56.2); // 56.25
    expect(outcomeBlocks({ 三紅: 1, 三藍活: 7 }, 'red').mission.win).toBe(12.5);
    expect(outcomeBlocks({ 三紅: 1, 三藍活: 2 }, 'red').mission.win).toBe(33.3);
  });

  it('accepts the OutcomeBreakdown keys (players[].seatOutcomes) and ignores junk', () => {
    const seat = { threeRed: 3, threeBlueDead: 1, threeBlueAlive: 4, threeRedPct: 37.5, threeBlueDeadPct: 12.5, threeBlueAlivePct: 50 };
    expect(normalizeOutcomeCounts(seat)).toEqual({ 三紅: 3, 三藍死: 1, 三藍活: 4 });
    expect(outcomeBlocks(seat, 'blue').assassination).toEqual({ win: 80, wins: 4, n: 5 });
    expect(normalizeOutcomeCounts({ 三紅: -2, 三藍死: Number.NaN, 三藍活: 'x' as unknown as number })).toEqual({ 三紅: 0, 三藍死: 0, 三藍活: 0 });
  });

  it('roleFaction: the four red roles, everything else blue', () => {
    expect(RED_ROLE_NAMES).toEqual(['刺客', '莫甘娜', '莫德雷德', '奧伯倫']);
    expect(['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'].map(roleFaction))
      .toEqual(['red', 'red', 'red', 'red', 'blue', 'blue', 'blue']);
  });
});

describe('playerOutcomeBlocks', () => {
  const row = {
    rawRedThreeRed: 80, rawRedMerlinDead: 40, rawRedMerlinAlive: 48,
    rawBlueThreeRed: 110, rawBlueMerlinDead: 60, rawBlueMerlinAlive: 82,
  };

  it('red / blue from the raw counts (every cache has them); roles only with roleOutcomes (schemaVersion 4)', () => {
    const b = playerOutcomeBlocks(row);
    expect(b.red?.assassination).toEqual({ win: 45.5, wins: 40, n: 88 });
    expect(b.blue?.final).toEqual({ win: 32.5, wins: 82, n: 252 });
    expect(b.roles).toBeNull();
    const v4 = playerOutcomeBlocks({ ...row, roleOutcomes: { 刺客: { 三紅: 20, 三藍死: 10, 三藍活: 12 }, 梅林: { 三紅: 9, 三藍死: 6, 三藍活: 9 } } });
    expect(v4.roles?.['刺客']).toMatchObject({ faction: 'red', assassination: { win: 45.5, wins: 10, n: 22 } });
    expect(v4.roles?.['梅林']).toMatchObject({ faction: 'blue', assassination: { win: 60, wins: 9, n: 15 }, final: { win: 37.5, wins: 9, n: 24 } });
  });

  it('a row without raw counts gives null sides, not zeros', () => {
    expect(playerOutcomeBlocks({})).toEqual({ red: null, blue: null, roles: null });
    expect(playerOutcomeBlocks(undefined)).toEqual({ red: null, blue: null, roles: null });
    expect(playerOutcomeBlocks({ ...row, rawBlueMerlinAlive: undefined }).blue).toBeNull();
  });
});
