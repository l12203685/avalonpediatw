import { describe, it, expect } from 'vitest';
import { VoteRecord } from '@avalon/shared';
import {
  computeProposalFactor,
  computeProposalDelta,
} from '../services/ProposalFactor';
import {
  GameRecord,
  GamePlayerRecord,
} from '../services/GameHistoryRepository';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePlayer(
  overrides: Partial<GamePlayerRecord> & Pick<GamePlayerRecord, 'playerId' | 'team'>
): GamePlayerRecord {
  return {
    displayName: overrides.playerId,
    role: null,
    won: false,
    ...overrides,
  } as GamePlayerRecord;
}

function makeVote(
  overrides: Partial<VoteRecord> & Pick<VoteRecord, 'leader' | 'team' | 'approved'>
): VoteRecord {
  return {
    round: 1,
    attempt: 1,
    votes: {},
    ...overrides,
  };
}

function makeGameRecord(
  overrides: Partial<GameRecord> & {
    players: GamePlayerRecord[];
    voteHistoryPersisted?: VoteRecord[];
  }
): GameRecord {
  return {
    gameId: 'g1',
    roomName: 'Test',
    playerCount: overrides.players.length,
    winner: 'good',
    winReason: 'assassination_failed',
    questResults: [],
    duration: 0,
    createdAt: 0,
    endedAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure heuristic unit tests
// ---------------------------------------------------------------------------

describe('computeProposalDelta', () => {
  it('rewards good leader who picks a clean (no-evil) team', () => {
    expect(
      computeProposalDelta({ leaderTeam: 'good', evilSlots: 0, approved: true })
    ).toBe(1);
  });

  it('punishes good leader whose infected team was approved', () => {
    expect(
      computeProposalDelta({ leaderTeam: 'good', evilSlots: 2, approved: true })
    ).toBe(-4);
  });

  it('mildly punishes good leader whose infected team was rejected', () => {
    expect(
      computeProposalDelta({ leaderTeam: 'good', evilSlots: 1, approved: false })
    ).toBe(-0.5);
  });

  it('rewards evil leader who smuggled teammates in on approved team', () => {
    expect(
      computeProposalDelta({ leaderTeam: 'evil', evilSlots: 2, approved: true })
    ).toBe(2);
  });

  it('punishes evil leader forced to pick an all-good team', () => {
    expect(
      computeProposalDelta({ leaderTeam: 'evil', evilSlots: 0, approved: true })
    ).toBe(-1);
  });

  it('gives evil leader 0 when their infected pick was rejected', () => {
    expect(
      computeProposalDelta({ leaderTeam: 'evil', evilSlots: 2, approved: false })
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GameRecord integration
// ---------------------------------------------------------------------------

describe('computeProposalFactor', () => {
  it('returns empty result when voteHistoryPersisted missing (legacy record)', () => {
    const record = makeGameRecord({
      players: [makePlayer({ playerId: 'p1', team: 'good' })],
    });

    const result = computeProposalFactor(record);
    expect(result.scores).toEqual({});
    expect(result.proposalCounts).toEqual({});
  });

  it('scores a single good leader making a clean pick', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good' }),
        makePlayer({ playerId: 'p2', team: 'good' }),
        makePlayer({ playerId: 'p3', team: 'evil' }),
      ],
      voteHistoryPersisted: [
        makeVote({ leader: 'p1', team: ['p1', 'p2'], approved: true }),
      ],
    });

    const result = computeProposalFactor(record);
    expect(result.scores.p1).toBe(1);
    expect(result.proposalCounts.p1).toBe(1);
  });

  it('aggregates multi-proposal scores per leader', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good' }),
        makePlayer({ playerId: 'p2', team: 'good' }),
        makePlayer({ playerId: 'p3', team: 'evil' }),
      ],
      voteHistoryPersisted: [
        makeVote({ leader: 'p1', team: ['p1', 'p2'], approved: true }),
        makeVote({ leader: 'p1', team: ['p1', 'p3'], approved: true }),
      ],
    });

    const result = computeProposalFactor(record);
    expect(result.scores.p1).toBe(-1);
    expect(result.proposalCounts.p1).toBe(2);
  });

  it.skip('feeds EloAttributionService via weighted sum (Day 2)', () => {});
});
