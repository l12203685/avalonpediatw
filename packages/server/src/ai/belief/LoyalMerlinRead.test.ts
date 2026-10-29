/**
 * `loyalMerlinRead` (round 5, loyals): one of the blues is Merlin, who from R3 does not approve a team holding a red
 * it sees. A lone rejection of a team with a certain red reads as Merlin's — that seat looks bluer.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from '../types';
import { bayesRedShare } from './BayesBelief';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

function obs(partial: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P8', failCount: 1, questResults: ['fail', 'success'], gamePhase: 'team_vote',
    proposedTeam: [], lakeHistory: [],
    // R1: P1 (me), P2, P3 and two fail cards → P2 and P3 red.
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 2 },
      { round: 2, team: ['P1', 'P8', 'P9', 'P10'], result: 'success', failCount: 0 },
    ],
    // R3: a team with P2 on it; only P7 rejected it.
    voteHistory: [{
      round: 3, attempt: 1, leader: 'P2', team: ['P2', 'P4', 'P5', 'P6'], approved: true,
      votes: Object.fromEntries(IDS.map((id) => [id, id !== 'P7'])),
    }],
    ...partial,
  } as unknown as PlayerObservation;
}

describe('loyalMerlinRead', () => {
  it('strict: the lone rejector of a team with a certain red looks bluer', () => {
    const off = bayesRedShare(obs()).get('P7') ?? 0;
    const strict = bayesRedShare(obs(), { merlinMixture: 2 }).get('P7') ?? 0;
    expect(strict).toBeLessThan(off - 0.05);
    expect(Number.isFinite(strict)).toBe(true);
  });

  it('human table: off-team human Merlins reject a red team about as often as other blues (8.5% vs 10.2% approve), so it barely moves', () => {
    const off = bayesRedShare(obs()).get('P7') ?? 0;
    const human = bayesRedShare(obs(), { merlinMixture: 1 }).get('P7') ?? 0;
    expect(Math.abs(human - off)).toBeLessThan(0.03);
  });

  it('only loyal viewers', () => {
    const merlin = obs({ myRole: 'merlin', knownEvils: ['P2', 'P3'] });
    expect(bayesRedShare(merlin, { merlinMixture: 2 }).get('P7')).toBeCloseTo(bayesRedShare({ ...merlin }).get('P7') ?? 0, 9);
  });
});
