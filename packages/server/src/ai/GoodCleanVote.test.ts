/**
 * `goodCleanVote` (optimization loop round 3): loyal / Percival reject an R3+ team whose posterior chance of
 * being clean is below the threshold — and nothing else changes.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { goodCleanVoteReject } from './GoodCleanVote';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const ON = { ...DEFAULT_AGENT_TUNING, goodCleanVote: 0.2 };

function obs(partial: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P4', failCount: 0, questResults: ['fail'], gamePhase: 'team_vote',
    // R1: P1 (me), P2, P3 went and two fail cards came back → P2 and P3 are red.
    questHistory: [{ round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 2 }],
    voteHistory: [], proposedTeam: ['P4', 'P2', 'P5', 'P6'], lakeHistory: [], ...partial,
  } as PlayerObservation;
}

describe('goodCleanVote', () => {
  it('a team with a certain red: reject', () => {
    expect(goodCleanVoteReject(ON, obs())).toBe(true);
  });

  it('a team that can be clean, under a tiny threshold: keep the vote', () => {
    expect(goodCleanVoteReject({ ...ON, goodCleanVote: 1e-9 }, obs({ proposedTeam: ['P4', 'P5', 'P6', 'P7'] }))).toBe(false);
  });

  it('off: threshold 0, R1–R2, Merlin, red, not a vote', () => {
    expect(goodCleanVoteReject(DEFAULT_AGENT_TUNING, obs())).toBe(false);
    expect(goodCleanVoteReject(ON, obs({ currentRound: 2 }))).toBe(false);
    expect(goodCleanVoteReject(ON, obs({ myRole: 'merlin', knownEvils: ['P2', 'P3'] }))).toBe(false);
    expect(goodCleanVoteReject(ON, obs({ myRole: 'assassin', myTeam: 'evil' }))).toBe(false);
    expect(goodCleanVoteReject(ON, obs({ gamePhase: 'team_select' }))).toBe(false);
    expect(goodCleanVoteReject({ ...ON, goodCleanVoteLoyalOnly: true }, obs({ myRole: 'percival', knownWizards: ['P7', 'P8'] }))).toBe(false);
    expect(goodCleanVoteReject({ ...ON, goodCleanVoteLoyalOnly: true }, obs())).toBe(true);
  });
});
