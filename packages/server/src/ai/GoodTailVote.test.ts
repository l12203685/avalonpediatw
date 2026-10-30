/**
 * Strong-table gap B3 `goodTailVote`: off the team a loyal / Percival votes normal (reject) unless the team is clean
 * enough and the outer white washes a suspect tail or wins the game.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { goodTailVote } from './GoodCleanVote';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const obs = (partial: Partial<PlayerObservation> = {}): PlayerObservation => ({
  myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 3, currentLeader: 'P2', failCount: 0, questResults: ['success', 'fail'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 },
    { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'fail', failCount: 1 },
  ],
  voteHistory: [], proposedTeam: ['P2', 'P3', 'P4', 'P9'], lakeHistory: [], ...partial,
} as unknown as PlayerObservation);
const on = (tau: number) => ({ ...DEFAULT_AGENT_TUNING, goodTailVote: tau });

describe('goodTailVote', () => {
  it('a team below the threshold: normal reject', () => {
    expect(goodTailVote(on(0.99), obs())).toBe(false);
  });
  it('two wins in and a clean enough team: approve (this team wins the game)', () => {
    expect(goodTailVote(on(0.01), obs({ questResults: ['success', 'success'] }))).toBe(true);
  });
  it('not applicable: off, on the team, Merlin, R1–R2, forced', () => {
    expect(goodTailVote(on(0), obs())).toBeNull();
    expect(goodTailVote(on(0.5), obs({ proposedTeam: ['P1', 'P2', 'P3', 'P4'] }))).toBeNull();
    expect(goodTailVote(on(0.5), obs({ myRole: 'merlin' } as Partial<PlayerObservation>))).toBeNull();
    expect(goodTailVote(on(0.5), obs({ currentRound: 2 }))).toBeNull();
    expect(goodTailVote(on(0.5), obs({ failCount: 4 }))).toBeNull();
  });
});
