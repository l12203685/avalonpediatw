import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import { GameHistoryRepository, GameRecord } from '../services/GameHistoryRepository';
import { Room } from '@avalon/shared';

// ---------------------------------------------------------------------------
// Mock Firestore
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

// Chain mocks so .orderBy(...).limit(...).get() works
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
// Helpers
// ---------------------------------------------------------------------------

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'game-abc',
    name: 'Test Game',
    host: 'p1',
    state: 'ended',
    players: {
      p1: { id: 'p1', name: 'Alice', role: 'merlin', team: 'good', status: 'active', createdAt: 1000 },
      p2: { id: 'p2', name: 'Bob', role: 'assassin', team: 'evil', status: 'active', createdAt: 1000 },
      p3: { id: 'p3', name: 'Charlie', role: 'loyal', team: 'good', status: 'active', createdAt: 1000 },
    },
    maxPlayers: 10,
    currentRound: 5,
    maxRounds: 5,
    votes: {},
    questTeam: [],
    questResults: ['success', 'fail', 'success', 'fail', 'success'],
    failCount: 0,
    evilWins: false,
    leaderIndex: 0,
    createdAt: 1_000_000,
    updatedAt: 5_000_000,
    ...overrides,
  };
}

function makeFakeRecord(id = 'game-abc'): GameRecord {
  return {
    gameId: id,
    roomName: 'Test Game',
    playerCount: 3,
    winner: 'good',
    winReason: 'assassination_failed',
    questResults: ['success', 'fail', 'success', 'fail', 'success'],
    duration: 4_000_000,
    players: [
      { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: true },
      { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: false },
    ],
    createdAt: 1_000_000,
    endedAt: 5_000_000,
  };
}

// ---------------------------------------------------------------------------
// saveGameRecord
// ---------------------------------------------------------------------------

describe('GameHistoryRepository — saveGameRecord', () => {
  let repo: GameHistoryRepository;

  beforeEach(() => {
    repo = new GameHistoryRepository();
    vi.clearAllMocks();
    // Re-chain mocks after clear
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    mockCollection.doc.mockReturnValue(mockDocRef);
    mockFirestore.collection.mockReturnValue(mockCollection);
  });

  it('returns the room id on success', async () => {
    mockDocRef.set.mockResolvedValue(undefined);
    const room = makeRoom();
    const id = await repo.saveGameRecord(room, 'assassination_failed');
    expect(id).toBe(room.id);
  });

  it('writes to the games collection with correct document id', async () => {
    mockDocRef.set.mockResolvedValue(undefined);
    const room = makeRoom();
    await repo.saveGameRecord(room, 'assassination_failed');
    expect(mockFirestore.collection).toHaveBeenCalledWith('games');
    expect(mockCollection.doc).toHaveBeenCalledWith(room.id);
  });

  it('records correct winner when evilWins=false', async () => {
    mockDocRef.set.mockResolvedValue(undefined);
    const room = makeRoom({ evilWins: false });
    await repo.saveGameRecord(room, 'assassination_failed');
    const written = (mockDocRef.set as MockedFunction<typeof mockDocRef.set>).mock.calls[0][0] as GameRecord;
    expect(written.winner).toBe('good');
  });

  it('records correct winner when evilWins=true', async () => {
    mockDocRef.set.mockResolvedValue(undefined);
    const room = makeRoom({ evilWins: true });
    await repo.saveGameRecord(room, 'failed_quests_limit');
    const written = (mockDocRef.set as MockedFunction<typeof mockDocRef.set>).mock.calls[0][0] as GameRecord;
    expect(written.winner).toBe('evil');
  });

  it('builds player records correctly', async () => {
    mockDocRef.set.mockResolvedValue(undefined);
    const room = makeRoom({ evilWins: false });
    await repo.saveGameRecord(room, 'assassination_failed');
    const written = (mockDocRef.set as MockedFunction<typeof mockDocRef.set>).mock.calls[0][0] as GameRecord;
    expect(written.players).toHaveLength(3);
    const alice = written.players.find((p) => p.playerId === 'p1')!;
    expect(alice.won).toBe(true); // good team wins
    const bob = written.players.find((p) => p.playerId === 'p2')!;
    expect(bob.won).toBe(false); // evil team loses
  });

  it('throws when Firestore set rejects', async () => {
    mockDocRef.set.mockRejectedValue(new Error('Quota exceeded'));
    const room = makeRoom();
    await expect(repo.saveGameRecord(room, 'assassination_failed')).rejects.toThrow('Quota exceeded');
  });

  it('includes questResults in the saved record', async () => {
    mockDocRef.set.mockResolvedValue(undefined);
    const room = makeRoom();
    await repo.saveGameRecord(room, 'assassination_failed');
    const written = (mockDocRef.set as MockedFunction<typeof mockDocRef.set>).mock.calls[0][0] as GameRecord;
    expect(written.questResults).toEqual(room.questResults);
  });
});

// ---------------------------------------------------------------------------
// getGameRecord
// ---------------------------------------------------------------------------

describe('GameHistoryRepository — getGameRecord', () => {
  let repo: GameHistoryRepository;

  beforeEach(() => {
    repo = new GameHistoryRepository();
    vi.clearAllMocks();
    mockCollection.doc.mockReturnValue(mockDocRef);
    mockFirestore.collection.mockReturnValue(mockCollection);
  });

  it('returns GameRecord when document exists', async () => {
    const record = makeFakeRecord();
    mockDocRef.get.mockResolvedValue({ exists: true, data: () => record });
    const result = await repo.getGameRecord('game-abc');
    expect(result).toEqual(record);
  });

  it('returns null when document does not exist', async () => {
    mockDocRef.get.mockResolvedValue({ exists: false, data: () => null });
    const result = await repo.getGameRecord('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when Firestore throws', async () => {
    mockDocRef.get.mockRejectedValue(new Error('Permission denied'));
    const result = await repo.getGameRecord('game-abc');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listRecentGames
// ---------------------------------------------------------------------------

describe('GameHistoryRepository — listRecentGames', () => {
  let repo: GameHistoryRepository;

  beforeEach(() => {
    repo = new GameHistoryRepository();
    vi.clearAllMocks();
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    mockFirestore.collection.mockReturnValue(mockCollection);
    mockCollection.orderBy = vi.fn(() => mockQuery);
  });

  it('returns game records ordered by endedAt', async () => {
    const records = [makeFakeRecord('g1'), makeFakeRecord('g2')];
    mockQuery.get.mockResolvedValue({
      docs: records.map((r) => ({ data: () => r })),
    });

    const result = await repo.listRecentGames(10);
    expect(result).toHaveLength(2);
    expect(result[0].gameId).toBe('g1');
  });

  it('respects the limit parameter', async () => {
    mockQuery.get.mockResolvedValue({ docs: [] });
    await repo.listRecentGames(5);
    expect(mockQuery.limit).toHaveBeenCalledWith(5);
  });

  it('returns empty array when Firestore throws', async () => {
    mockQuery.get.mockRejectedValue(new Error('Network error'));
    const result = await repo.listRecentGames();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listPlayerGames
// ---------------------------------------------------------------------------

describe('GameHistoryRepository — listPlayerGames', () => {
  let repo: GameHistoryRepository;

  beforeEach(() => {
    repo = new GameHistoryRepository();
    vi.clearAllMocks();
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    mockFirestore.collection.mockReturnValue(mockCollection);
    mockCollection.orderBy = vi.fn(() => mockQuery);
  });

  function makeRecordWithPlayer(gameId: string, playerId: string): GameRecord {
    return {
      ...makeFakeRecord(gameId),
      players: [
        { playerId, displayName: 'Test', role: 'loyal', team: 'good', won: true },
      ],
    };
  }

  it('returns only games in which the player participated', async () => {
    const records = [
      makeRecordWithPlayer('g1', 'player-A'),
      makeRecordWithPlayer('g2', 'player-B'),
      makeRecordWithPlayer('g3', 'player-A'),
    ];
    mockQuery.get.mockResolvedValue({
      docs: records.map((r) => ({ data: () => r })),
    });

    const result = await repo.listPlayerGames('player-A', 20);
    expect(result).toHaveLength(2);
    result.forEach((r) =>
      expect(r.players.some((p) => p.playerId === 'player-A')).toBe(true)
    );
  });

  it('returns empty array when player has no games', async () => {
    const records = [makeRecordWithPlayer('g1', 'other-player')];
    mockQuery.get.mockResolvedValue({
      docs: records.map((r) => ({ data: () => r })),
    });

    const result = await repo.listPlayerGames('player-X', 20);
    expect(result).toEqual([]);
  });

  it('caps results at the provided limit', async () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecordWithPlayer(`g${i}`, 'player-A')
    );
    mockQuery.get.mockResolvedValue({
      docs: records.map((r) => ({ data: () => r })),
    });

    const result = await repo.listPlayerGames('player-A', 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('returns empty array when Firestore throws', async () => {
    mockQuery.get.mockRejectedValue(new Error('Firestore error'));
    const result = await repo.listPlayerGames('player-A');
    expect(result).toEqual([]);
  });
});
