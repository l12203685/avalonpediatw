import { describe, expect, it } from 'vitest';
import type { ReplayGame } from '../../ai/benchmark/sheetsReplay';
import { validateProfile } from '../profile';
import { samplesFromSeats, validateSamples } from '../samples';

/** 編的一局（只用到樣本數會看的欄位）。 */
function game(over: Partial<ReplayGame>): ReplayGame {
  return {
    id: 'G1', playerCount: 10, names: Array(10).fill(''), lakeChainValid: true,
    seatRoles: ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'morgana', 'assassin', 'mordred', 'oberon'],
    proposals: [
      { round: 1, attempt: 1, globalIndex: 0, leaderSeat: 1, teamSeats: [1, 2, 3], plusSeats: [], minusSeats: [], votes: [] } as never,
      { round: 1, attempt: 2, globalIndex: 1, leaderSeat: 2, teamSeats: [2, 3, 4], plusSeats: [], minusSeats: [], votes: [] } as never,
    ],
    quests: [1, 2, 3].map((round) => ({ round, teamSeats: [1, 2, 3], successCount: 3, failCount: 0, failed: false })),
    lakes: [{ round: 2, holderSeat: 10, targetSeat: 1, claim: 'good' } as never],
    winner: 'good',
    ...over,
  };
}

describe('knight learning samples (owner 2026-11-27)', () => {
  it('counts seats by seat (10 = 0家 at index 9), role, missions, result and decision points', () => {
    const blue = game({});
    const killed = game({ id: 'G2', winner: 'evil', assassinTargetSeat: 1 });
    const red3 = game({ id: 'G3', winner: 'evil', quests: [1, 2, 3].map((round) => ({ round, teamSeats: [1, 2, 3], successCount: 2, failCount: 1, failed: true })) });
    const s = samplesFromSeats([{ game: blue, seat: 1 }, { game: killed, seat: 8 }, { game: red3, seat: 10 }], 4);
    expect(s.games).toBe(4);
    expect(s.seats).toBe(3);
    expect(s.bySeat).toEqual([1, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
    expect(s.byRole).toMatchObject({ merlin: 1, assassin: 1, oberon: 1, loyal: 0 });
    expect(s.byMissions).toEqual({ blue3: 2, red3: 1 });
    expect(s.byResult).toEqual({ red3: 1, merlinKilled: 1, blueWin: 1 });
    expect(s.decisions).toEqual({ propose: 1, vote: 6, quest: 3, lake: 1, assassinate: 1 });
    expect(validateSamples(JSON.parse(JSON.stringify(s)), [])).toEqual(s);
  });

  it('only numbers in known fields; only official knights may carry samples', () => {
    const s = samplesFromSeats([], 0);
    const errors: string[] = [];
    expect(validateSamples({ ...s, gameIds: ['x'] }, errors)).toBeUndefined();
    expect(errors.join(' ')).toContain('gameIds');
    expect(validateSamples({ ...s, bySeat: [1, 2] }, [])).toBeUndefined();
    expect(validateSamples({ ...s, games: -1 }, [])).toBeUndefined();
    const community = validateProfile({ schema: 1, name: '測試', author: 'octocat', style: 'x', overrides: { redNormalVote: 0.5 }, samples: s });
    expect(community.ok).toBe(false);
    const house = validateProfile({ schema: 1, name: 'AI騎士_測試', author: 'AI騎士團', official: true, style: 'x', overrides: { redNormalVote: 0.5 }, samples: s }, 'knight-test-01', { house: true });
    expect(house.ok).toBe(true);
    expect(house.profile?.samples).toEqual(s);
  });
});
