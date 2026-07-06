import { describe, expect, it } from 'vitest';
import {
  convertV1ToV2,
  normalizeWinReason,
  buildPlayerSeats,
  buildRolesFromV1,
  findSeatByPlayerId,
  buildMissionsFromV1,
  buildLadyChainFromV1,
  type V1GameRecordInput,
  type V1PlayerInput,
} from '@avalon/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlayer(id: string, role: V1PlayerInput['role'], team: 'good' | 'evil'): V1PlayerInput {
  return {
    playerId: id,
    displayName: id,
    role,
    team,
    won: true,
  };
}

const PLAYERS_8: V1PlayerInput[] = [
  makePlayer('alice-uuid', 'merlin', 'good'),
  makePlayer('bob-uuid', 'percival', 'good'),
  makePlayer('carol-uuid', 'loyal', 'good'),
  makePlayer('dave-uuid', 'loyal', 'good'),
  makePlayer('eve-uuid', 'loyal', 'good'),
  makePlayer('frank-uuid', 'assassin', 'evil'),
  makePlayer('grace-uuid', 'morgana', 'evil'),
  makePlayer('heidi-uuid', 'mordred', 'evil'),
];

// ---------------------------------------------------------------------------
// normalizeWinReason
// ---------------------------------------------------------------------------

describe('normalizeWinReason', () => {
  it('maps merlin_assassinated → threeBlue_merlinKilled', () => {
    expect(normalizeWinReason('merlin_assassinated', 'evil')).toBe('threeBlue_merlinKilled');
  });

  it('maps assassination_failed → threeBlue_merlinAlive', () => {
    expect(normalizeWinReason('assassination_failed', 'good')).toBe('threeBlue_merlinAlive');
  });

  it('maps assassination_timeout → threeBlue_merlinAlive', () => {
    expect(normalizeWinReason('assassination_timeout', 'good')).toBe('threeBlue_merlinAlive');
  });

  it('maps failed_quests_limit → threeRed', () => {
    expect(normalizeWinReason('failed_quests_limit', 'evil')).toBe('threeRed');
  });

  it('maps vote_rejections_limit → fiveRejections', () => {
    expect(normalizeWinReason('vote_rejections_limit', 'evil')).toBe('fiveRejections');
  });

  it('maps host_cancelled → hostCancelled', () => {
    expect(normalizeWinReason('host_cancelled', 'good')).toBe('hostCancelled');
  });

  it('falls back to winner-based default for unknown reasons', () => {
    expect(normalizeWinReason('unknown_reason', 'good')).toBe('threeBlue_merlinAlive');
    expect(normalizeWinReason('unknown_reason', 'evil')).toBe('threeRed');
  });
});

// ---------------------------------------------------------------------------
// buildPlayerSeats
// ---------------------------------------------------------------------------

describe('buildPlayerSeats', () => {
  it('pads 8-player game to 10 slots with empty strings', () => {
    const seats = buildPlayerSeats(PLAYERS_8);
    expect(seats.length).toBe(10);
    expect(seats[0]).toBe('alice-uuid');
    expect(seats[7]).toBe('heidi-uuid');
    expect(seats[8]).toBe('');
    expect(seats[9]).toBe('');
  });

  it('never exceeds 10 slots even for over-sized input', () => {
    const over = Array.from({ length: 12 }, (_, i) =>
      makePlayer(`p${i + 1}`, 'loyal', 'good'),
    );
    const seats = buildPlayerSeats(over);
    expect(seats.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// buildRolesFromV1
// ---------------------------------------------------------------------------

describe('buildRolesFromV1', () => {
  it('maps special roles to seats 1..8', () => {
    const roles = buildRolesFromV1(PLAYERS_8);
    expect(roles.merlin).toBe(1);
    expect(roles.percival).toBe(2);
    expect(roles.assassin).toBe(6);
    expect(roles.morgana).toBe(7);
    expect(roles.mordred).toBe(8);
    expect(roles.oberon).toBeUndefined(); // not present
  });

  it('leaves loyal/minion roles out of the map', () => {
    const roles = buildRolesFromV1([
      makePlayer('a', 'loyal', 'good'),
      makePlayer('b', 'loyal', 'good'),
    ]);
    expect(Object.keys(roles).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findSeatByPlayerId
// ---------------------------------------------------------------------------

describe('findSeatByPlayerId', () => {
  it('returns 1-indexed seat for matching player', () => {
    expect(findSeatByPlayerId(PLAYERS_8, 'alice-uuid')).toBe(1);
    expect(findSeatByPlayerId(PLAYERS_8, 'heidi-uuid')).toBe(8);
  });

  it('returns undefined for unknown player or missing input', () => {
    expect(findSeatByPlayerId(PLAYERS_8, 'nonexistent')).toBeUndefined();
    expect(findSeatByPlayerId(PLAYERS_8, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildMissionsFromV1
// ---------------------------------------------------------------------------

describe('buildMissionsFromV1', () => {
  it('returns empty array when voteHistory is missing/empty', () => {
    expect(buildMissionsFromV1(PLAYERS_8, undefined, undefined)).toEqual([]);
    expect(buildMissionsFromV1(PLAYERS_8, [], [])).toEqual([]);
  });

  it('converts approved proposal + quest result into MissionV2', () => {
    const votes: Record<string, boolean> = {};
    PLAYERS_8.forEach((p) => (votes[p.playerId] = true)); // all approve

    const missions = buildMissionsFromV1(
      PLAYERS_8,
      [
        {
          round: 1,
          attempt: 1,
          leader: 'alice-uuid',
          team: ['alice-uuid', 'carol-uuid', 'heidi-uuid'],
          approved: true,
          votes,
        },
      ],
      [{ round: 1, team: ['alice-uuid', 'carol-uuid', 'heidi-uuid'], result: 'success', failCount: 0 }],
    );

    expect(missions).toHaveLength(1);
    const m = missions[0];
    expect(m.round).toBe(1);
    expect(m.proposalIndex).toBe(1);
    expect(m.leaderSeat).toBe(1);
    expect(m.teamSeats).toEqual([1, 3, 8]);
    expect(m.passed).toBe(true);
    expect(m.approveCount).toBe(8);
    expect(m.rejectCount).toBe(0);
    expect(m.votes).toHaveLength(8);
    expect(m.votes?.[0]).toBe('approve');
    expect(m.questResult?.success).toBe(true);
    expect(m.questResult?.failCount).toBe(0);
    expect(m.questResult?.successCount).toBe(3);
  });

  it('does not attach questResult to rejected proposal', () => {
    const votes: Record<string, boolean> = {};
    PLAYERS_8.forEach((p) => (votes[p.playerId] = false)); // all reject

    const missions = buildMissionsFromV1(
      PLAYERS_8,
      [
        {
          round: 1,
          attempt: 1,
          leader: 'alice-uuid',
          team: ['alice-uuid'],
          approved: false,
          votes,
        },
      ],
      [],
    );

    expect(missions[0].passed).toBe(false);
    expect(missions[0].questResult).toBeUndefined();
  });

  it('sorts by round asc, proposalIndex asc', () => {
    const missions = buildMissionsFromV1(
      PLAYERS_8,
      [
        { round: 2, attempt: 1, leader: 'alice-uuid', team: [], approved: false, votes: {} },
        { round: 1, attempt: 2, leader: 'alice-uuid', team: [], approved: false, votes: {} },
        { round: 1, attempt: 1, leader: 'alice-uuid', team: [], approved: false, votes: {} },
      ],
      [],
    );
    expect(missions.map((m) => [m.round, m.proposalIndex])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildLadyChainFromV1
// ---------------------------------------------------------------------------

describe('buildLadyChainFromV1', () => {
  it('converts lady history with declaration', () => {
    const chain = buildLadyChainFromV1(PLAYERS_8, [
      {
        round: 2,
        holderId: 'alice-uuid',
        targetId: 'frank-uuid',
        result: 'evil',
        declared: true,
        declaredClaim: 'evil',
      },
    ]);
    expect(chain).toHaveLength(1);
    expect(chain[0].holderSeat).toBe(1);
    expect(chain[0].targetSeat).toBe(6);
    expect(chain[0].actual).toBe('evil');
    expect(chain[0].declaration).toBe('evil');
    expect(chain[0].truthful).toBe(true);
  });

  it('falls back declaration to actual when holder did not declare', () => {
    const chain = buildLadyChainFromV1(PLAYERS_8, [
      {
        round: 2,
        holderId: 'alice-uuid',
        targetId: 'frank-uuid',
        result: 'evil',
      },
    ]);
    expect(chain[0].declaration).toBe('evil');
    expect(chain[0].truthful).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// convertV1ToV2 — integration
// ---------------------------------------------------------------------------

describe('convertV1ToV2', () => {
  const baseV1: V1GameRecordInput = {
    gameId: 'game-1',
    roomName: 'Test Room',
    playerCount: 8,
    winner: 'evil',
    winReason: 'merlin_assassinated',
    questResults: ['success', 'success', 'success'],
    duration: 1_800_000,
    players: PLAYERS_8,
    createdAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_000 + 1_800_000,
    voteHistoryPersisted: [],
    questHistoryPersisted: [],
    assassinTargetId: 'alice-uuid', // Merlin killed
  };

  it('produces a well-formed GameRecordV2', () => {
    const v2 = convertV1ToV2(baseV1);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.gameId).toBe('game-1');
    expect(v2.playedAt).toBe(1_700_000_000_000);
    expect(v2.totalDurationMs).toBe(1_800_000);
    expect(v2.playerSeats.length).toBe(10);
    expect(v2.playerSeats[0]).toBe('alice-uuid');
    expect(v2.playerSeats[9]).toBe('');
  });

  it('writes assassin target seat + correct flag when Merlin killed', () => {
    const v2 = convertV1ToV2(baseV1);
    expect(v2.finalResult.winnerCamp).toBe('evil');
    expect(v2.finalResult.winReason).toBe('threeBlue_merlinKilled');
    expect(v2.finalResult.assassinTargetSeat).toBe(1);
    expect(v2.finalResult.assassinCorrect).toBe(true);
  });

  it('sets assassinCorrect=false when target is not Merlin', () => {
    const v2 = convertV1ToV2({ ...baseV1, assassinTargetId: 'bob-uuid', winReason: 'assassination_failed', winner: 'good' });
    expect(v2.finalResult.winReason).toBe('threeBlue_merlinAlive');
    expect(v2.finalResult.assassinTargetSeat).toBe(2);
    expect(v2.finalResult.assassinCorrect).toBe(false);
  });

  it('omits assassinTargetSeat when V1 lacks assassinTargetId', () => {
    const v2 = convertV1ToV2({ ...baseV1, assassinTargetId: undefined, winReason: 'failed_quests_limit' });
    expect(v2.finalResult.assassinTargetSeat).toBeUndefined();
    expect(v2.finalResult.assassinCorrect).toBeUndefined();
    expect(v2.finalResult.winReason).toBe('threeRed');
  });

  it('populates roles map from V1 players', () => {
    const v2 = convertV1ToV2(baseV1);
    expect(v2.finalResult.roles.merlin).toBe(1);
    expect(v2.finalResult.roles.percival).toBe(2);
    expect(v2.finalResult.roles.assassin).toBe(6);
    expect(v2.finalResult.roles.morgana).toBe(7);
    expect(v2.finalResult.roles.mordred).toBe(8);
  });

  it('leaves ladyChain undefined when no lady history', () => {
    const v2 = convertV1ToV2(baseV1);
    expect(v2.ladyChain).toBeUndefined();
  });

  it('includes ladyChain when lady history is present', () => {
    const v2 = convertV1ToV2({
      ...baseV1,
      ladyOfTheLakeHistoryPersisted: [
        { round: 2, holderId: 'alice-uuid', targetId: 'frank-uuid', result: 'evil', declaredClaim: 'evil' },
      ],
    });
    expect(v2.ladyChain).toHaveLength(1);
  });
});
