import { describe, it, expect } from 'vitest';
import { VoteRecord } from '@avalon/shared';
import {
  computeInformationFactor,
  computeInformationVoteDelta,
  roleMultiplier,
} from '../services/InformationFactor';
import {
  GameRecord,
  GamePlayerRecord,
} from '../services/GameHistoryRepository';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePlayer(
  overrides: Partial<GamePlayerRecord> &
    Pick<GamePlayerRecord, 'playerId' | 'team'>
): GamePlayerRecord {
  return {
    displayName: overrides.playerId,
    role: null,
    won: false,
    ...overrides,
  } as GamePlayerRecord;
}

function makeVote(
  overrides: Partial<VoteRecord> &
    Pick<VoteRecord, 'leader' | 'team' | 'approved' | 'votes'>
): VoteRecord {
  return {
    round: 1,
    attempt: 1,
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
// Unit: computeInformationVoteDelta
// ---------------------------------------------------------------------------

describe('computeInformationVoteDelta', () => {
  it('punishes approving infected team', () => {
    expect(
      computeInformationVoteDelta({ approved: true, teamHasEvil: true })
    ).toBe(-0.5);
  });

  it('rewards rejecting infected team', () => {
    expect(
      computeInformationVoteDelta({ approved: false, teamHasEvil: true })
    ).toBe(0.5);
  });

  it('mildly rewards approving clean team', () => {
    expect(
      computeInformationVoteDelta({ approved: true, teamHasEvil: false })
    ).toBe(0.25);
  });

  it('mildly punishes rejecting clean team', () => {
    expect(
      computeInformationVoteDelta({ approved: false, teamHasEvil: false })
    ).toBe(-0.25);
  });
});

describe('roleMultiplier', () => {
  it('gives Merlin the highest weight', () => {
    expect(roleMultiplier('merlin')).toBe(2.0);
  });
  it('gives Percival mid weight', () => {
    expect(roleMultiplier('percival')).toBe(1.5);
  });
  it('gives generic good roles 1.0', () => {
    expect(roleMultiplier('loyal')).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Unit: computeInformationFactor
// ---------------------------------------------------------------------------

describe('computeInformationFactor', () => {
  it('returns empty when voteHistory missing', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good', role: 'merlin' }),
        makePlayer({ playerId: 'p2', team: 'evil', role: 'assassin' }),
      ],
    });
    const result = computeInformationFactor(record);
    expect(result.scores).toEqual({});
    expect(result.voteCounts).toEqual({});
  });

  it('awards Merlin a survival bonus on assassination_failed', () => {
    const record = makeGameRecord({
      winReason: 'assassination_failed',
      players: [
        makePlayer({ playerId: 'p1', team: 'good', role: 'merlin' }),
        makePlayer({ playerId: 'p2', team: 'evil', role: 'assassin' }),
      ],
      voteHistoryPersisted: [
        makeVote({
          leader: 'p1',
          team: ['p1'],
          approved: true,
          votes: { p1: true },
        }),
      ],
    });
    const result = computeInformationFactor(record);
    // p1 approved a clean team as merlin: base +0.25, role mult 2.0 = +0.5
    // Plus survival bonus +2 = 2.5 total.
    expect(result.scores.p1).toBeCloseTo(2.5);
  });

  it('penalizes Merlin when assassinated', () => {
    const record = makeGameRecord({
      winReason: 'merlin_assassinated',
      winner: 'evil',
      players: [
        makePlayer({ playerId: 'p1', team: 'good', role: 'merlin' }),
        makePlayer({ playerId: 'p2', team: 'evil', role: 'assassin' }),
      ],
      voteHistoryPersisted: [
        makeVote({
          leader: 'p1',
          team: ['p1'],
          approved: true,
          votes: { p1: true },
        }),
      ],
    });
    const result = computeInformationFactor(record);
    // p1 approved a clean team as merlin: base +0.25, role mult 2.0 = +0.5
    // Minus death penalty -2 = -1.5 total.
    expect(result.scores.p1).toBeCloseTo(-1.5);
  });

  it('ignores evil players entirely', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good', role: 'merlin' }),
        makePlayer({ playerId: 'p2', team: 'evil', role: 'assassin' }),
      ],
      voteHistoryPersisted: [
        makeVote({
          leader: 'p1',
          team: ['p2'], // evil slot
          approved: true,
          votes: { p1: true, p2: true },
        }),
      ],
    });
    const result = computeInformationFactor(record);
    expect(result.scores.p2).toBeUndefined();
  });

  it('applies Percival multiplier correctly', () => {
    const record = makeGameRecord({
      // No assassination reason → no survival bonus clouding result.
      winReason: 'vote_rejections',
      winner: 'evil',
      players: [
        makePlayer({ playerId: 'p1', team: 'good', role: 'percival' }),
        makePlayer({ playerId: 'p2', team: 'evil', role: 'morgana' }),
      ],
      voteHistoryPersisted: [
        makeVote({
          leader: 'p1',
          team: ['p2'],
          approved: false,
          votes: { p1: false },
        }),
      ],
    });
    const result = computeInformationFactor(record);
    // p1 rejected an infected team: base +0.5, role mult 1.5 = +0.75.
    expect(result.scores.p1).toBeCloseTo(0.75);
  });
});
