/**
 * `percivalThumbLogic` (round 3, Edward 2026-10-29): Percival's thumbs are one Merlin and one Morgana; Merlin's
 * information is right. A thumb that proposes (R3+) a team with two certain reds cannot be Merlin.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from '../types';
import { bayesRedShare } from './BayesBelief';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

function obs(): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'percival', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    knownWizards: ['P7', 'P8'], currentRound: 4, currentLeader: 'P9', failCount: 0, questResults: ['fail', 'success', 'fail'],
    gamePhase: 'team_vote', proposedTeam: [], lakeHistory: [],
    // R1: P1 (me), P2, P3 went and two fail cards came back → P2 and P3 are red.
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 2 },
      { round: 2, team: ['P1', 'P4', 'P5', 'P6'], result: 'success', failCount: 0 },
      { round: 3, team: ['P7', 'P2', 'P3', 'P4'], result: 'fail', failCount: 2 },
    ],
    // R3: thumb P7 led a team with both certain reds on it.
    voteHistory: [{
      round: 3, attempt: 1, leader: 'P7', team: ['P7', 'P2', 'P3', 'P4'], approved: true,
      votes: Object.fromEntries(IDS.map((id) => [id, ['P7', 'P2', 'P3', 'P4', 'P5', 'P9'].includes(id)])),
    }],
  } as unknown as PlayerObservation;
}

describe('percivalThumbLogic', () => {
  it('a thumb that sent two certain reds on an R3 team reads as Morgana', () => {
    const plain = bayesRedShare(obs()).get('P7') ?? 0;
    const strict = bayesRedShare(obs(), { strictMerlin: true }).get('P7') ?? 0;
    expect(strict).toBeGreaterThan(plain);
    expect(strict).toBeGreaterThan(0.9);
    // Exactly one thumb is red in every world.
    expect((bayesRedShare(obs(), { strictMerlin: true }).get('P8') ?? 0) + strict).toBeCloseTo(1, 6);
  });

  it('other viewers are unaffected', () => {
    const loyal = { ...obs(), myRole: 'loyal', knownWizards: undefined } as unknown as PlayerObservation;
    expect(bayesRedShare(loyal, { strictMerlin: true }).get('P7')).toBeCloseTo(bayesRedShare({ ...loyal }).get('P7') ?? 0, 9);
  });
});
