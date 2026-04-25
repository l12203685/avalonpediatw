import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameAnalytics } from '../services/GameAnalytics';
import { GameRecord } from '../services/GameHistoryRepository';

// ---------------------------------------------------------------------------
// Mock Firestore
// ---------------------------------------------------------------------------

const mockQuery = {
  orderBy: vi.fn(),
  limit: vi.fn(),
  get: vi.fn(),
};
mockQuery.orderBy.mockReturnValue(mockQuery);
mockQuery.limit.mockReturnValue(mockQuery);

const mockCollection = {
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

function makeRecord(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    gameId: 'g1',
    roomName: 'Test Room',
    playerCount: 5,
    winner: 'good',
    winReason: 'assassination_failed',
    questResults: ['success', 'success', 'success'],
    duration: 900_000,
    players: [
      { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: true },
      { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: false },
      { playerId: 'p3', displayName: 'Carol', role: 'loyal', team: 'good', won: true },
      { playerId: 'p4', displayName: 'Dave', role: 'morgana', team: 'evil', won: false },
      { playerId: 'p5', displayName: 'Eve', role: 'percival', team: 'good', won: true },
    ],
    createdAt: 1_000_000,
    endedAt: 1_900_000,
    ...overrides,
  };
}

function makeEvilWinRecord(): GameRecord {
  return makeRecord({
    gameId: 'g-evil',
    winner: 'evil',
    winReason: 'failed_quests_limit',
    questResults: ['success', 'fail', 'fail', 'fail'],
    players: [
      { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: false },
      { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: true },
      { playerId: 'p3', displayName: 'Carol', role: 'loyal', team: 'good', won: false },
      { playerId: 'p4', displayName: 'Dave', role: 'morgana', team: 'evil', won: true },
      { playerId: 'p5', displayName: 'Eve', role: 'percival', team: 'good', won: false },
    ],
  });
}

function makeAssassinationSuccessRecord(): GameRecord {
  return makeRecord({
    gameId: 'g-assassin',
    winner: 'evil',
    winReason: 'assassination_success',
    questResults: ['success', 'success', 'success'],
    players: [
      { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: false },
      { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: true },
      { playerId: 'p3', displayName: 'Carol', role: 'loyal', team: 'good', won: false },
      { playerId: 'p4', displayName: 'Dave', role: 'morgana', team: 'evil', won: true },
      { playerId: 'p5', displayName: 'Eve', role: 'percival', team: 'good', won: false },
    ],
  });
}

// ---------------------------------------------------------------------------
// computeFactionStats
// ---------------------------------------------------------------------------

describe('GameAnalytics.computeFactionStats', () => {
  it('returns empty array for empty input', () => {
    expect(GameAnalytics.computeFactionStats([])).toEqual([]);
  });

  it('correctly counts good wins', () => {
    const records = [makeRecord(), makeRecord(), makeEvilWinRecord()];
    const stats = GameAnalytics.computeFactionStats(records);
    const good = stats.find((s) => s.faction === 'good')!;
    expect(good.wins).toBe(2);
    expect(good.winRate).toBeCloseTo(66.7, 0);
  });

  it('correctly counts evil wins', () => {
    const records = [makeRecord(), makeEvilWinRecord(), makeEvilWinRecord()];
    const stats = GameAnalytics.computeFactionStats(records);
    const evil = stats.find((s) => s.faction === 'evil')!;
    expect(evil.wins).toBe(2);
    expect(evil.winRate).toBeCloseTo(66.7, 0);
  });

  it('tracks assassination successes', () => {
    const records = [makeRecord(), makeAssassinationSuccessRecord()];
    const stats = GameAnalytics.computeFactionStats(records);
    const good = stats.find((s) => s.faction === 'good')!;
    expect(good.assassinationSuccessRate).toBeGreaterThan(0);
  });

  it('returns 0 win rate when nobody wins', () => {
    // Edge case: all records have same result
    const records = [makeEvilWinRecord()];
    const stats = GameAnalytics.computeFactionStats(records);
    const good = stats.find((s) => s.faction === 'good')!;
    expect(good.winRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRoleStats
// ---------------------------------------------------------------------------

describe('GameAnalytics.computeRoleStats', () => {
  it('returns correct game count per role', () => {
    const records = [makeRecord(), makeRecord()]; // 2 games, same roles
    const stats = GameAnalytics.computeRoleStats(records);
    const merlin = stats.find((s) => s.role === 'merlin')!;
    expect(merlin.totalGames).toBe(2);
  });

  it('tracks wins correctly', () => {
    const records = [makeRecord(), makeEvilWinRecord()];
    const stats = GameAnalytics.computeRoleStats(records);
    const merlin = stats.find((s) => s.role === 'merlin')!;
    // Merlin wins in good-win record, loses in evil-win record
    expect(merlin.wins).toBe(1);
    expect(merlin.totalGames).toBe(2);
  });

  it('ignores players with null role', () => {
    const record = makeRecord({
      players: [
        { playerId: 'p1', displayName: 'Alice', role: null, team: 'good', won: true },
      ],
    });
    const stats = GameAnalytics.computeRoleStats([record]);
    expect(stats).toHaveLength(0);
  });

  it('handles multiple game records', () => {
    const records = [makeRecord(), makeRecord(), makeAssassinationSuccessRecord()];
    const stats = GameAnalytics.computeRoleStats(records);
    expect(stats.length).toBeGreaterThan(0);
    stats.forEach((s) => {
      expect(s.winRate).toBeGreaterThanOrEqual(0);
      expect(s.winRate).toBeLessThanOrEqual(100);
    });
  });
});

// ---------------------------------------------------------------------------
// computePlayerCountStats
// ---------------------------------------------------------------------------

describe('GameAnalytics.computePlayerCountStats', () => {
  it('groups by player count', () => {
    const r5 = makeRecord({ playerCount: 5 });
    const r7 = makeRecord({ playerCount: 7 });
    const stats = GameAnalytics.computePlayerCountStats([r5, r5, r7]);
    const s5 = stats.find((s) => s.playerCount === 5)!;
    const s7 = stats.find((s) => s.playerCount === 7)!;
    expect(s5.totalGames).toBe(2);
    expect(s7.totalGames).toBe(1);
  });

  it('sorts by player count ascending', () => {
    const records = [
      makeRecord({ playerCount: 9 }),
      makeRecord({ playerCount: 5 }),
      makeRecord({ playerCount: 7 }),
    ];
    const stats = GameAnalytics.computePlayerCountStats(records);
    expect(stats[0].playerCount).toBe(5);
    expect(stats[1].playerCount).toBe(7);
    expect(stats[2].playerCount).toBe(9);
  });

  it('computes good win rate correctly', () => {
    const records = [
      makeRecord({ playerCount: 5, winner: 'good' }),
      makeRecord({ playerCount: 5, winner: 'good' }),
      makeRecord({ playerCount: 5, winner: 'evil' }),
    ];
    const stats = GameAnalytics.computePlayerCountStats(records);
    const s5 = stats.find((s) => s.playerCount === 5)!;
    expect(s5.goodWinRate).toBeCloseTo(66.7, 0);
  });

  it('returns empty array for empty input', () => {
    expect(GameAnalytics.computePlayerCountStats([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeQuestPatterns
// ---------------------------------------------------------------------------

describe('GameAnalytics.computeQuestPatterns', () => {
  it('generates pattern keys correctly', () => {
    const record = makeRecord({ questResults: ['success', 'fail', 'success'] });
    const patterns = GameAnalytics.computeQuestPatterns([record]);
    expect(patterns[0].pattern).toBe('SFS');
  });

  it('counts repeated patterns', () => {
    const records = [
      makeRecord({ questResults: ['success', 'success', 'success'] }),
      makeRecord({ questResults: ['success', 'success', 'success'] }),
      makeRecord({ questResults: ['fail', 'fail', 'fail'] }),
    ];
    const patterns = GameAnalytics.computeQuestPatterns(records);
    const sss = patterns.find((p) => p.pattern === 'SSS')!;
    expect(sss.count).toBe(2);
  });

  it('respects topN limit', () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ gameId: `g${i}`, questResults: i % 2 === 0 ? ['success'] : ['fail'] })
    );
    const patterns = GameAnalytics.computeQuestPatterns(records, 1);
    expect(patterns).toHaveLength(1);
  });

  it('skips records with empty quest results', () => {
    const record = makeRecord({ questResults: [] });
    const patterns = GameAnalytics.computeQuestPatterns([record]);
    expect(patterns).toHaveLength(0);
  });

  it('returns patterns sorted by count descending', () => {
    const records = [
      makeRecord({ questResults: ['success', 'success', 'success'] }),
      makeRecord({ questResults: ['success', 'success', 'success'] }),
      makeRecord({ questResults: ['fail', 'fail', 'fail'] }),
    ];
    const patterns = GameAnalytics.computeQuestPatterns(records);
    expect(patterns[0].count).toBeGreaterThanOrEqual(patterns[1].count);
  });
});

// ---------------------------------------------------------------------------
// computeAssassinationStats
// ---------------------------------------------------------------------------

describe('GameAnalytics.computeAssassinationStats', () => {
  it('returns 0 attempts for empty input', () => {
    const stats = GameAnalytics.computeAssassinationStats([]);
    expect(stats.totalAttempts).toBe(0);
    expect(stats.successRate).toBe(0);
  });

  it('counts assassination successes', () => {
    const records = [
      makeAssassinationSuccessRecord(),
      makeAssassinationSuccessRecord(),
      makeRecord(), // good wins, assassination fails
    ];
    const stats = GameAnalytics.computeAssassinationStats(records);
    expect(stats.successes).toBe(2);
    expect(stats.totalAttempts).toBe(3);
    expect(stats.successRate).toBeCloseTo(66.7, 0);
  });

  it('does not count non-assassination evil wins as attempts', () => {
    const records = [makeEvilWinRecord()]; // evil wins by missions, no assassination
    const stats = GameAnalytics.computeAssassinationStats(records);
    expect(stats.totalAttempts).toBe(0);
  });

  it('goodWinRateOnFail reflects failed assassinations', () => {
    const records = [
      makeRecord(), // good wins (assassination fails)
      makeRecord(), // good wins (assassination fails)
      makeAssassinationSuccessRecord(), // assassination succeeds
    ];
    const stats = GameAnalytics.computeAssassinationStats(records);
    // 2 fails out of 3 attempts
    expect(stats.goodWinRateOnFail).toBeCloseTo(66.7, 0);
  });
});

// ---------------------------------------------------------------------------
// computePlayerAnalytics
// ---------------------------------------------------------------------------

describe('GameAnalytics.computePlayerAnalytics', () => {
  it('returns null when player has no games', () => {
    const result = GameAnalytics.computePlayerAnalytics('p-unknown', [makeRecord()]);
    expect(result).toBeNull();
  });

  it('returns null for empty records', () => {
    const result = GameAnalytics.computePlayerAnalytics('p1', []);
    expect(result).toBeNull();
  });

  it('calculates win rate correctly', () => {
    const records = [
      makeRecord({ gameId: 'g1', winner: 'good' }),   // p1 wins
      makeRecord({ gameId: 'g2', winner: 'evil', players: [
        { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: false },
        { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: true },
        { playerId: 'p3', displayName: 'Carol', role: 'loyal', team: 'good', won: false },
        { playerId: 'p4', displayName: 'Dave', role: 'morgana', team: 'evil', won: true },
        { playerId: 'p5', displayName: 'Eve', role: 'percival', team: 'good', won: false },
      ]}), // p1 loses
    ];
    const analytics = GameAnalytics.computePlayerAnalytics('p1', records);
    expect(analytics?.totalGames).toBe(2);
    expect(analytics?.wins).toBe(1);
    expect(analytics?.winRate).toBe(50);
  });

  it('calculates per-faction win rates', () => {
    const records = [
      makeRecord({ gameId: 'g1', winner: 'good' }), // p1 plays good, wins
    ];
    const analytics = GameAnalytics.computePlayerAnalytics('p1', records);
    expect(analytics?.goodWinRate).toBe(100);
    expect(analytics?.evilWinRate).toBe(0); // no evil games
  });

  it('includes role stats', () => {
    const records = [makeRecord()];
    const analytics = GameAnalytics.computePlayerAnalytics('p1', records);
    expect(analytics?.roleStats).toBeDefined();
    expect(analytics?.roleStats.length).toBeGreaterThan(0);
    const merlinStat = analytics?.roleStats.find((r) => r.role === 'merlin');
    expect(merlinStat).toBeDefined();
  });

  it('calculates average game duration', () => {
    const records = [
      makeRecord({ gameId: 'g1', duration: 1_000_000 }),
      makeRecord({ gameId: 'g2', duration: 2_000_000 }),
    ];
    const analytics = GameAnalytics.computePlayerAnalytics('p1', records);
    expect(analytics?.averageGameDuration).toBe(1_500_000);
  });
});

// ---------------------------------------------------------------------------
// GameAnalytics service methods (Firestore integration)
// ---------------------------------------------------------------------------

describe('GameAnalytics — getOverview', () => {
  let service: GameAnalytics;

  beforeEach(() => {
    service = new GameAnalytics();
    vi.clearAllMocks();
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    mockCollection.orderBy = vi.fn(() => mockQuery);
    mockFirestore.collection.mockReturnValue(mockCollection);
  });

  it('returns overview with totalGames count', async () => {
    const records = [makeRecord(), makeEvilWinRecord()];
    mockQuery.get.mockResolvedValue({
      docs: records.map((r) => ({ data: () => r })),
    });
    const result = await service.getOverview(100);
    expect(result.totalGames).toBe(2);
  });

  it('includes all required analytics sections', async () => {
    mockQuery.get.mockResolvedValue({ docs: [] });
    const result = await service.getOverview();
    expect(result).toHaveProperty('factionStats');
    expect(result).toHaveProperty('roleStats');
    expect(result).toHaveProperty('playerCountStats');
    expect(result).toHaveProperty('topQuestPatterns');
    expect(result).toHaveProperty('assassinationStats');
    expect(result).toHaveProperty('computedAt');
  });

  it('returns zero-state overview when no games exist', async () => {
    mockQuery.get.mockResolvedValue({ docs: [] });
    const result = await service.getOverview();
    expect(result.totalGames).toBe(0);
    expect(result.factionStats).toEqual([]);
  });

  it('handles Firestore errors gracefully', async () => {
    mockQuery.get.mockRejectedValue(new Error('Network error'));
    const result = await service.getOverview();
    expect(result.totalGames).toBe(0);
  });
});

describe('GameAnalytics — getPlayerAnalytics', () => {
  let service: GameAnalytics;

  beforeEach(() => {
    service = new GameAnalytics();
    vi.clearAllMocks();
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    mockCollection.orderBy = vi.fn(() => mockQuery);
    mockFirestore.collection.mockReturnValue(mockCollection);
  });

  it('returns analytics for a player with games', async () => {
    const records = [makeRecord()];
    mockQuery.get.mockResolvedValue({
      docs: records.map((r) => ({ data: () => r })),
    });
    const result = await service.getPlayerAnalytics('p1');
    expect(result?.playerId).toBe('p1');
    expect(result?.totalGames).toBe(1);
  });

  it('returns null when player has no games', async () => {
    mockQuery.get.mockResolvedValue({ docs: [] });
    const result = await service.getPlayerAnalytics('p-unknown');
    expect(result).toBeNull();
  });

  it('handles Firestore errors gracefully', async () => {
    mockQuery.get.mockRejectedValue(new Error('DB error'));
    const result = await service.getPlayerAnalytics('p1');
    expect(result).toBeNull();
  });
});
