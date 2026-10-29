/**
 * Round 6 (red) `assassinMerlinVotes`: a blue who from R3 rejected every team with a red Merlin sees and approved
 * the clean ones reads as Merlin; one who approved a red team does not.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from '../types';
import { merlinVoteLogRatio } from './MerlinVoteRead';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const REDS = ['P1', 'P2', 'P3', 'P4'];
const vote = (round: number, team: string[], yes: string[]) => ({
  round, attempt: 1, leader: team[0], team, approved: true,
  votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});

const obs = {
  myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: REDS,
  currentRound: 5, gamePhase: 'assassination', questHistory: [], lakeHistory: [],
  voteHistory: [
    // Teams with two reds: P5 rejects, P6 approves.
    vote(3, ['P1', 'P2', 'P7', 'P8'], ['P1', 'P2', 'P3', 'P4', 'P6', 'P7', 'P8']),
    vote(4, ['P3', 'P4', 'P9', 'P10', 'P6'], ['P1', 'P2', 'P3', 'P4', 'P6', 'P9', 'P10']),
    // A clean team: both approve.
    vote(5, ['P5', 'P6', 'P7', 'P8', 'P9'], ['P5', 'P6', 'P7', 'P8', 'P9', 'P10']),
  ],
} as unknown as PlayerObservation;

describe('merlinVoteLogRatio', () => {
  it('the consistent rejector reads as Merlin, the red-team approver does not', () => {
    const p5 = merlinVoteLogRatio(obs, 'P5', REDS);
    const p6 = merlinVoteLogRatio(obs, 'P6', REDS);
    expect(p5).toBeGreaterThan(0);
    expect(p6).toBeLessThan(0);
    expect(p5).toBeGreaterThan(p6 + 2);
  });
  it('no R3+ votes: neutral', () => {
    expect(merlinVoteLogRatio({ ...obs, voteHistory: [] } as PlayerObservation, 'P5', REDS)).toBe(0);
  });
});
