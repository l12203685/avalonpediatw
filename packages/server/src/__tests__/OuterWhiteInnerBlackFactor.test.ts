import { describe, it, expect } from 'vitest';
import { QuestRecord } from '@avalon/shared';
import {
  computeOuterWhiteInnerBlackFactor,
  computeOwibDelta,
  OUTER_WHITE_INNER_BLACK_ROLES,
} from '../services/OuterWhiteInnerBlackFactor';
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

function makeQuest(
  overrides: Partial<QuestRecord> & Pick<QuestRecord, 'team' | 'result'>
): QuestRecord {
  return {
    round: 1,
    failCount: overrides.result === 'fail' ? 1 : 0,
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
    winner: 'evil',
    winReason: 'failed_quests',
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

describe('computeOwibDelta', () => {
  it('heavily rewards evil player on a failed quest', () => {
    expect(computeOwibDelta({ onTeam: true, questFailed: true })).toBe(3);
  });

  it('mildly rewards evil player on a successful quest (trust built)', () => {
    expect(computeOwibDelta({ onTeam: true, questFailed: false })).toBe(0.5);
  });

  it('punishes evil player NOT on a failed quest (teammate carried)', () => {
    expect(computeOwibDelta({ onTeam: false, questFailed: true })).toBe(-1);
  });

  it('gives 0 to evil player NOT on a successful quest', () => {
    expect(computeOwibDelta({ onTeam: false, questFailed: false })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GameRecord integration
// ---------------------------------------------------------------------------

describe('computeOuterWhiteInnerBlackFactor', () => {
  it('returns empty result when questHistoryPersisted missing', () => {
    const record = makeGameRecord({
      players: [makePlayer({ playerId: 'p1', team: 'evil', role: 'mordred' })],
    });

    const result = computeOuterWhiteInnerBlackFactor(record);
    expect(result.scores).toEqual({});
  });

  it('ignores good-team players entirely (no false positives)', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'g1', team: 'good' }),
        makePlayer({ playerId: 'e1', team: 'evil' }),
      ],
      questHistoryPersisted: [
        makeQuest({ team: ['g1', 'e1'], result: 'fail' }),
      ],
    });

    const result = computeOuterWhiteInnerBlackFactor(record);
    expect(result.scores.g1).toBeUndefined();
    expect(result.scores.e1).toBe(3);
  });

  it('scores an evil player across multiple quests', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'e1', team: 'evil', role: 'mordred' }),
        makePlayer({ playerId: 'g1', team: 'good' }),
      ],
      questHistoryPersisted: [
        makeQuest({ team: ['e1', 'g1'], result: 'fail' }),
        makeQuest({ team: ['e1', 'g1'], result: 'success' }),
        makeQuest({ team: ['g1'], result: 'fail' }),
      ],
    });

    const result = computeOuterWhiteInnerBlackFactor(record);
    expect(result.scores.e1).toBe(2.5);
    expect(result.questAppearances.e1).toBe(2);
  });

  it('exposes OUTER_WHITE_INNER_BLACK_ROLES set for downstream config', () => {
    expect(OUTER_WHITE_INNER_BLACK_ROLES.has('mordred')).toBe(true);
    expect(OUTER_WHITE_INNER_BLACK_ROLES.has('morgana')).toBe(true);
    expect(OUTER_WHITE_INNER_BLACK_ROLES.has('oberon')).toBe(true);
    expect(OUTER_WHITE_INNER_BLACK_ROLES.has('merlin')).toBe(false);
  });

  it.skip('flips sign for good-wins-assassin outcome (Day 2)', () => {});
});
