import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GameRecordV2,
  hydrateV2ToV1View,
  resolveDisplayNameFallback,
  computePlayerCount,
  computeQuestResults,
  computeWinner,
  type FixedTenStrings,
} from '@avalon/shared';
import { GameHistoryRepositoryV2 } from '../services/GameHistoryRepositoryV2';

// ---------------------------------------------------------------------------
// Mock Firestore — 模仿 GameHistoryRepository.test.ts 的手法
// ---------------------------------------------------------------------------

const mockDocRef = {
  set: vi.fn(),
  get: vi.fn(),
};

const mockQuery = {
  orderBy: vi.fn(),
  limit: vi.fn(),
  get: vi.fn(),
};
mockQuery.orderBy.mockReturnValue(mockQuery);
mockQuery.limit.mockReturnValue(mockQuery);

const mockCollection = {
  doc: vi.fn(() => mockDocRef),
  orderBy: vi.fn(() => mockQuery),
};

const mockFirestore = {
  collection: vi.fn(() => mockCollection),
};

vi.mock('../services/firebase', () => ({
  getAdminFirestore: vi.fn(() => mockFirestore),
}));

// ---------------------------------------------------------------------------
// Fixture — 8 人局三藍活 (好人勝，刺殺失敗)
// ---------------------------------------------------------------------------

function padTen(values: string[]): FixedTenStrings {
  const out: string[] = [...values];
  while (out.length < 10) out.push('');
  return out.slice(0, 10) as unknown as FixedTenStrings;
}

function makeFixtureV2(): GameRecordV2 {
  return {
    schemaVersion: 2,
    gameId: 'game-v2-test-001',
    playedAt: 1_745_000_000_000,
    totalDurationMs: 2_400_000,

    // 8 人：前 5 個是真 UUID；第 6 個 sheets: 前綴歷史資料；7/8 真 UUID；9/10 空。
    playerSeats: padTen([
      'uid-aaaaaa-alice',
      'uid-bbbbbb-bob',
      'uid-cccccc-carol',
      'uid-dddddd-dave',
      'uid-eeeeee-eve',
      'sheets:Frank',
      'uid-gggggg-grace',
      'uid-hhhhhh-henry',
    ]),

    finalResult: {
      winnerCamp: 'good',
      winReason: 'threeBlue_merlinAlive',
      assassinTargetSeat: 3,
      assassinCorrect: false,
      roles: {
        merlin: 1,
        percival: 3,
        assassin: 6,
        morgana: 7,
        mordred: 8,
      },
    },

    missions: [
      {
        round: 1,
        proposalIndex: 1,
        leaderSeat: 1,
        teamSeats: [1, 3, 4],
        votes: ['approve', 'approve', 'approve', 'approve', 'reject', 'approve', 'reject', 'approve'],
        passed: true,
        approveCount: 6,
        rejectCount: 2,
        questResult: { successCount: 3, failCount: 0, success: true },
      },
      {
        round: 2,
        proposalIndex: 1,
        leaderSeat: 2,
        teamSeats: [2, 5, 6, 7],
        votes: ['approve', 'approve', 'approve', 'reject', 'approve', 'approve', 'approve', 'reject'],
        passed: true,
        approveCount: 6,
        rejectCount: 2,
        questResult: { successCount: 2, failCount: 2, success: false },
      },
      {
        round: 3,
        proposalIndex: 1,
        leaderSeat: 3,
        teamSeats: [1, 2, 3, 4],
        votes: null, // 歷史資料無逐人投票
        passed: true,
        approveCount: 5,
        rejectCount: 3,
        questResult: { successCount: 4, failCount: 0, success: true },
      },
      {
        round: 4,
        proposalIndex: 1,
        leaderSeat: 4,
        teamSeats: [1, 3, 4, 5, 8],
        votes: null,
        passed: true,
        approveCount: 5,
        rejectCount: 3,
        questResult: { successCount: 4, failCount: 1, success: true },
      },
    ],

    ladyChain: [
      {
        round: 2,
        holderSeat: 1,
        targetSeat: 7,
        declaration: 'evil',
        actual: 'evil',
        truthful: true,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Repository round-trip
// ---------------------------------------------------------------------------

describe('GameHistoryRepositoryV2', () => {
  let repo: GameHistoryRepositoryV2;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection.doc.mockReturnValue(mockDocRef);
    mockCollection.orderBy.mockReturnValue(mockQuery);
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    repo = new GameHistoryRepositoryV2();
  });

  it('saves a V2 record and reads it back unchanged (round-trip)', async () => {
    const record = makeFixtureV2();

    // saveV2: 捕獲寫入參數
    mockDocRef.set.mockResolvedValue(undefined);
    await repo.saveV2(record);

    expect(mockCollection.doc).toHaveBeenCalledWith(record.gameId);
    expect(mockDocRef.set).toHaveBeenCalledWith(record);

    // getV2: 回傳同筆 record
    mockDocRef.get.mockResolvedValue({
      exists: true,
      data: () => record,
    });
    const loaded = await repo.getV2(record.gameId);

    expect(loaded).not.toBeNull();
    expect(loaded?.gameId).toBe(record.gameId);
    expect(loaded?.schemaVersion).toBe(2);
    expect(loaded?.finalResult.winnerCamp).toBe('good');
    expect(loaded?.missions).toHaveLength(4);
    expect(loaded?.missions[2].votes).toBeNull();
  });

  it('returns null for non-existent gameId', async () => {
    mockDocRef.get.mockResolvedValue({ exists: false, data: () => null });
    const loaded = await repo.getV2('no-such-game');
    expect(loaded).toBeNull();
  });

  it('lists games by player using playerSeats membership', async () => {
    const record = makeFixtureV2();
    mockQuery.get.mockResolvedValue({
      docs: [{ data: () => record }],
    });
    const games = await repo.listV2ByPlayer('uid-cccccc-carol');
    expect(games).toHaveLength(1);
    expect(games[0].gameId).toBe(record.gameId);
  });

  it('skips games where the player is not in playerSeats', async () => {
    const record = makeFixtureV2();
    mockQuery.get.mockResolvedValue({
      docs: [{ data: () => record }],
    });
    const games = await repo.listV2ByPlayer('not-in-game');
    expect(games).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// V2 → V1 adapter
// ---------------------------------------------------------------------------

describe('hydrateV2ToV1View', () => {
  it('produces a valid V1 view from V2 record (no callback, fallback resolution)', () => {
    const v2 = makeFixtureV2();
    const v1 = hydrateV2ToV1View(v2);

    expect(v1.gameId).toBe('game-v2-test-001');
    expect(v1.playerCount).toBe(8);
    expect(v1.winner).toBe('good');
    expect(v1.winReason).toBe('threeBlue_merlinAlive');
    expect(v1.duration).toBe(2_400_000);
    expect(v1.createdAt).toBe(1_745_000_000_000);
    expect(v1.endedAt).toBe(1_745_000_000_000 + 2_400_000);

    // questResults: [success, fail, success, success] (4 rounds played)
    expect(v1.questResults).toEqual(['success', 'fail', 'success', 'success']);

    // players array: 8 人，空座不納入
    expect(v1.players).toHaveLength(8);

    // seat 1 = Alice = merlin (UUID 末 6 碼 = "-alice")
    const alice = v1.players[0];
    expect(alice.playerId).toBe('uid-aaaaaa-alice');
    expect(alice.displayName).toBe('-alice'); // UUID 末 6 碼
    expect(alice.role).toBe('merlin');
    expect(alice.team).toBe('good');
    expect(alice.won).toBe(true);

    // seat 6 = Frank = assassin (sheets: 前綴)
    const frank = v1.players[5];
    expect(frank.playerId).toBe('sheets:Frank');
    expect(frank.displayName).toBe('Frank');
    expect(frank.role).toBe('assassin');
    expect(frank.team).toBe('evil');
    expect(frank.won).toBe(false);

    // assassinTargetId 從 seat 3 (Carol) 反查
    expect(v1.assassinTargetId).toBe('uid-cccccc-carol');
    // leaderStartIndex = first mission leaderSeat - 1 = 0
    expect(v1.leaderStartIndex).toBe(0);
  });

  it('uses getDisplayName callback when provided', () => {
    const v2 = makeFixtureV2();
    const directory: Record<string, string> = {
      'uid-aaaaaa-alice': 'Alice',
      'uid-bbbbbb-bob': 'Bob',
      'uid-cccccc-carol': 'Carol',
    };
    const v1 = hydrateV2ToV1View(v2, {
      getDisplayName: (uid) => directory[uid],
    });

    expect(v1.players[0].displayName).toBe('Alice');
    expect(v1.players[1].displayName).toBe('Bob');
    expect(v1.players[2].displayName).toBe('Carol');
    // 查不到的仍走 fallback（"uid-dddddd-dave" 末 6 碼 = "d-dave"）
    expect(v1.players[3].displayName).toBe('d-dave');
    expect(v1.players[5].displayName).toBe('Frank'); // sheets: 前綴
  });

  it('computePlayerCount counts only non-empty seats', () => {
    const v2 = makeFixtureV2();
    expect(computePlayerCount(v2)).toBe(8);
  });

  it('computeWinner returns finalResult.winnerCamp', () => {
    const v2 = makeFixtureV2();
    expect(computeWinner(v2)).toBe('good');
  });

  it('computeQuestResults derives from passed missions', () => {
    const v2 = makeFixtureV2();
    const results = computeQuestResults(v2);
    expect(results).toEqual(['success', 'fail', 'success', 'success']);
  });

  it('handles Sheets historical record with only sheets: prefix UUIDs', () => {
    const sheetsFixture: GameRecordV2 = {
      ...makeFixtureV2(),
      playerSeats: padTen([
        'sheets:Alice',
        'sheets:Bob',
        'sheets:Carol',
        'sheets:Dave',
        'sheets:Eve',
        'sheets:Frank',
        'sheets:Grace',
        'sheets:Henry',
      ]),
    };
    const v1 = hydrateV2ToV1View(sheetsFixture);
    expect(v1.playerCount).toBe(8);
    expect(v1.players[0].playerId).toBe('sheets:Alice');
    expect(v1.players[0].displayName).toBe('Alice');
  });
});

describe('resolveDisplayNameFallback', () => {
  it('returns empty string for empty UID', () => {
    expect(resolveDisplayNameFallback('')).toBe('');
    expect(resolveDisplayNameFallback('   ')).toBe('');
  });

  it('strips sheets: prefix for historical records', () => {
    expect(resolveDisplayNameFallback('sheets:雪怪')).toBe('雪怪');
    expect(resolveDisplayNameFallback('sheets:Ray')).toBe('Ray');
  });

  it('uses last 6 chars for regular UUIDs', () => {
    expect(resolveDisplayNameFallback('abc12345678')).toBe('345678');
    expect(resolveDisplayNameFallback('abcdef')).toBe('abcdef');
    expect(resolveDisplayNameFallback('ab')).toBe('ab');
  });
});
