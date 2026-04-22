import { describe, it, expect } from 'vitest';
import { VoteRecord, QuestRecord } from '@avalon/shared';
import {
  computeMisdirectionFactor,
  computeMisdirectionVoteDelta,
  computeStealthFailBonus,
} from '../services/MisdirectionFactor';
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
// Unit: voting delta
// ---------------------------------------------------------------------------

describe('computeMisdirectionVoteDelta', () => {
  it('rewards evil approving infected team (smuggle)', () => {
    expect(
      computeMisdirectionVoteDelta({ approved: true, teamHasEvil: true })
    ).toBe(0.5);
  });
  it('rewards evil approving clean team (camouflage)', () => {
    expect(
      computeMisdirectionVoteDelta({ approved: true, teamHasEvil: false })
    ).toBe(0.25);
  });
  it('neutral when evil rejects infected team', () => {
    expect(
      computeMisdirectionVoteDelta({ approved: false, teamHasEvil: true })
    ).toBe(0);
  });
  it('penalizes evil rejecting clean team (obvious)', () => {
    expect(
      computeMisdirectionVoteDelta({ approved: false, teamHasEvil: false })
    ).toBe(-0.5);
  });
});

describe('computeStealthFailBonus', () => {
  it('max bonus when exactly one evil on failed quest', () => {
    expect(computeStealthFailBonus({ evilCountOnTeam: 1 })).toBe(2);
  });
  it('minimal bonus when multiple evil on failed quest', () => {
    expect(computeStealthFailBonus({ evilCountOnTeam: 2 })).toBe(0.5);
  });
  it('zero when no evil on team', () => {
    expect(computeStealthFailBonus({ evilCountOnTeam: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: computeMisdirectionFactor
// ---------------------------------------------------------------------------

describe('computeMisdirectionFactor', () => {
  it('returns empty when both histories missing', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good' }),
        makePlayer({ playerId: 'p2', team: 'evil' }),
      ],
    });
    const result = computeMisdirectionFactor(record);
    expect(result.scores).toEqual({});
  });

  it('ignores good team entirely', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good' }),
        makePlayer({ playerId: 'p2', team: 'evil' }),
      ],
      voteHistoryPersisted: [
        makeVote({
          leader: 'p2',
          team: ['p2'],
          approved: true,
          votes: { p1: true, p2: true },
        }),
      ],
      questHistoryPersisted: [
        makeQuest({ team: ['p2'], result: 'fail' }),
      ],
    });
    const result = computeMisdirectionFactor(record);
    expect(result.scores.p1).toBeUndefined();
    expect(result.scores.p2).toBeDefined();
  });

  it('awards stealth-fail bonus to solo evil on failed quest', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good' }),
        makePlayer({ playerId: 'p2', team: 'evil' }),
      ],
      questHistoryPersisted: [
        makeQuest({ team: ['p1', 'p2'], result: 'fail' }),
      ],
    });
    const result = computeMisdirectionFactor(record);
    // Solo evil (1 evil on team) on failed quest → +2.
    expect(result.scores.p2).toBe(2);
  });

  it('awards post-approval coordination bonus on infected + approved + failed', () => {
    const record = makeGameRecord({
      players: [
        makePlayer({ playerId: 'p1', team: 'good' }),
        makePlayer({ playerId: 'p2', team: 'evil' }),
      ],
      voteHistoryPersisted: [
        makeVote({
          round: 1,
          leader: 'p2',
          team: ['p1', 'p2'],
          approved: true,
          votes: { p1: true, p2: true },
        }),
      ],
      questHistoryPersisted: [
        makeQuest({ round: 1, team: ['p1', 'p2'], result: 'fail' }),
      ],
    });
    const result = computeMisdirectionFactor(record);
    // p2 voted approve (+0.5 smuggle) + stealth bonus (+2 solo evil fail) +
    // post-approval coord (+1 approved infected fail) = +3.5.
    expect(result.scores.p2).toBeCloseTo(3.5);
  });
});
