/**
 * Players' report 2026-10-13 「全員 46%」: caches written before round 5 carry players[].seatOutcomes
 * and chemistry.outcomePair as the overall 三紅/三藍死/三藍活 split projected onto every player /
 * pair (三紅 45.5 % everywhere). The server serves them only when generate_cache.py marks them as
 * counted from the game log ("games"); otherwise it drops them and the site hides the tooltip /
 * matrix. Made-up names.
 */
import { describe, expect, it } from 'vitest';
import { OUTCOME_SOURCE_GAMES, servedChemistry, servedPlayerRow } from '../services/sheetsAnalysis';
import type { ChemistryData, PlayerStats } from '../services/sheetsAnalysis';

const split = (r: number, d: number, a: number) => {
  const n = r + d + a;
  const pct = (x: number) => (n ? Math.round((x / n) * 1000) / 10 : 0);
  return { threeRed: r, threeBlueDead: d, threeBlueAlive: a, threeRedPct: pct(r), threeBlueDeadPct: pct(d), threeBlueAlivePct: pct(a) };
};

function row(name: string, seatOutcomes?: PlayerStats['seatOutcomes']): PlayerStats {
  return { name, totalGames: 3, winRate: 66.7, seatOutcomes } as unknown as PlayerStats;
}

const matrix = (values: (number | null)[][]) => ({ players: ['阿甲', '阿乙'], rowLabels: ['阿甲', '阿乙'], values });

function chemistry(outcomePair?: ChemistryData['outcomePair']): ChemistryData {
  const m = matrix([[null, 50], [50, null]]);
  return { coWin: m, coLose: m, winCorr: m, coWinMinusLose: m, ...(outcomePair ? { outcomePair } : {}) };
}

describe('servedPlayerRow', () => {
  const own = { '1': split(1, 0, 2), '2': split(0, 0, 0) };

  it('keeps seatOutcomes the cache marks as the player\'s own games', () => {
    const p = row('阿甲', own);
    expect(servedPlayerRow(p, OUTCOME_SOURCE_GAMES)).toBe(p);
  });

  it('drops the projected split of an unmarked (older) cache, without touching the cache row', () => {
    const projected = { '1': split(1013, 533, 682), '2': split(1013, 533, 682) };
    const p = row('阿乙', projected);
    for (const source of [undefined, 'projected', 1]) {
      const served = servedPlayerRow(p, source);
      expect(served.seatOutcomes).toBeUndefined();
      expect('seatOutcomes' in served).toBe(false);
      expect(served.name).toBe('阿乙');
    }
    expect(p.seatOutcomes).toBe(projected);
  });

  it('leaves a row without seatOutcomes as it is', () => {
    const p = row('阿丙');
    expect(servedPlayerRow(p, undefined)).toBe(p);
  });
});

describe('servedChemistry', () => {
  it('serves an outcomePair counted from the game log', () => {
    const pair = { ...matrix([[null, 25], [25, null]]), games: [[null, 4], [4, null]], source: OUTCOME_SOURCE_GAMES };
    const c = chemistry(pair);
    expect(servedChemistry(c).outcomePair).toBe(pair);
  });

  it('drops a projected outcomePair (no source) and keeps the four sheet matrices', () => {
    const c = chemistry({ ...matrix([[null, 45.5], [45.5, null]]), threeBlueDeadPct: [[null, 23.9], [23.9, null]] });
    const served = servedChemistry(c);
    expect(served.outcomePair).toBeUndefined();
    expect('outcomePair' in served).toBe(false);
    expect(served.coWin).toBe(c.coWin);
    expect(c.outcomePair).toBeDefined();
  });

  it('is a no-op without an outcomePair', () => {
    const c = chemistry();
    expect(servedChemistry(c)).toBe(c);
  });
});
