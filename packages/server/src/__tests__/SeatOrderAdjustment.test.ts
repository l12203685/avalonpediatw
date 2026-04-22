import { describe, it, expect } from 'vitest';
import { VoteRecord } from '@avalon/shared';
import {
  computeSeatOrderAdjustment,
  depthToMultiplier,
  lookupSeatMultiplier,
} from '../services/SeatOrderAdjustment';
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
    Pick<VoteRecord, 'leader' | 'team' | 'approved'>
): VoteRecord {
  return {
    round: 1,
    attempt: 1,
    votes: {},
    ...overrides,
  };
}

function makeGameRecord(
  overrides: Partial<GameRecord> & { players: GamePlayerRecord[] }
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
// Unit: depthToMultiplier
// ---------------------------------------------------------------------------

describe('depthToMultiplier', () => {
  it('maps depth 0 to MIN (0.8)', () => {
    expect(depthToMultiplier(0)).toBe(0.8);
  });
  it('maps depth 1 to MAX (1.2)', () => {
    expect(depthToMultiplier(1)).toBe(1.2);
  });
  it('maps depth 0.5 to NEUTRAL (1.0)', () => {
    expect(depthToMultiplier(0.5)).toBeCloseTo(1.0);
  });
  it('clamps negative inputs to MIN', () => {
    expect(depthToMultiplier(-5)).toBe(0.8);
  });
  it('clamps > 1 inputs to MAX', () => {
    expect(depthToMultiplier(10)).toBe(1.2);
  });
});

// ---------------------------------------------------------------------------
// Unit: lookupSeatMultiplier
// ---------------------------------------------------------------------------

describe('lookupSeatMultiplier', () => {
  it('returns 1.0 for unknown playerId', () => {
    expect(lookupSeatMultiplier({}, 'p1')).toBe(1.0);
  });
  it('returns 1.0 for NaN multiplier', () => {
    expect(lookupSeatMultiplier({ p1: NaN }, 'p1')).toBe(1.0);
  });
  it('returns stored multiplier when valid', () => {
    expect(lookupSeatMultiplier({ p1: 0.9 }, 'p1')).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Unit: computeSeatOrderAdjustment
// ---------------------------------------------------------------------------

describe('computeSeatOrderAdjustment', () => {
  it('returns empty when voteHistory missing', () => {
    const record = makeGameRecord({
      players: [makePlayer({ playerId: 'p1', team: 'good' })],
    });
    const result = computeSeatOrderAdjustment(record);
    expect(result.multipliers).toEqual({});
    expect(result.averageDepth).toEqual({});
  });

  it('assigns first leader low multiplier, last leader high multiplier', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good' }),
        makePlayer({ playerId: 'p2', team: 'evil' }),
        makePlayer({ playerId: 'p3', team: 'good' }),
      ],
      voteHistoryPersisted: [
        makeVote({ leader: 'p1', team: ['p1'], approved: true }),
        makeVote({ leader: 'p2', team: ['p2'], approved: true }),
        makeVote({ leader: 'p3', team: ['p3'], approved: true }),
      ],
    });
    const result = computeSeatOrderAdjustment(record);
    // depths: p1=0/2=0 (MIN), p2=1/2=0.5 (NEUTRAL), p3=2/2=1 (MAX)
    expect(result.multipliers.p1).toBe(0.8);
    expect(result.multipliers.p2).toBeCloseTo(1.0);
    expect(result.multipliers.p3).toBe(1.2);
  });

  it('averages depth when a single player leads multiple proposals', () => {
    const record = makeGameRecord({
      players: [makePlayer({ playerId: 'p1', team: 'good' })],
      voteHistoryPersisted: [
        makeVote({ leader: 'p1', team: [], approved: true }),
        makeVote({ leader: 'p1', team: [], approved: true }),
        makeVote({ leader: 'p1', team: [], approved: true }),
      ],
    });
    const result = computeSeatOrderAdjustment(record);
    // depths: 0, 0.5, 1.0 → avg 0.5 → multiplier 1.0
    expect(result.averageDepth.p1).toBeCloseTo(0.5);
    expect(result.multipliers.p1).toBeCloseTo(1.0);
  });

  it('handles single-proposal game with neutral depth 0.5', () => {
    const record = makeGameRecord({
      players: [makePlayer({ playerId: 'p1', team: 'good' })],
      voteHistoryPersisted: [
        makeVote({ leader: 'p1', team: [], approved: true }),
      ],
    });
    const result = computeSeatOrderAdjustment(record);
    // single slot → depth 0.5 → multiplier 1.0
    expect(result.averageDepth.p1).toBe(0.5);
    expect(result.multipliers.p1).toBeCloseTo(1.0);
  });
});
