import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  expectedScore,
  computeNewElo,
  EloRankingService,
  EloEntry,
} from '../services/EloRanking';
import {
  DEFAULT_ELO_CONFIG,
  deriveEloOutcome,
  getEloConfig,
  setEloConfig,
} from '../services/EloConfig';
import { GameRecord } from '../services/GameHistoryRepository';

// ---------------------------------------------------------------------------
// Mock Firebase RTD
// ---------------------------------------------------------------------------

const mockRef = {
  once: vi.fn(),
  set: vi.fn(),
  orderByChild: vi.fn(),
  limitToLast: vi.fn(),
};

// Chain RTD query mocks
mockRef.orderByChild.mockReturnValue(mockRef);
mockRef.limitToLast.mockReturnValue(mockRef);

const mockAdminDB = {
  ref: vi.fn(() => mockRef),
};

vi.mock('../services/firebase', () => ({
  getAdminDB: vi.fn(() => mockAdminDB),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGameRecord(overrides: Partial<GameRecord> = {}): GameRecord {
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

function makeEloEntry(uid: string, elo: number): EloEntry {
  return {
    uid,
    displayName: uid,
    eloRating: elo,
    totalGames: 10,
    gamesWon: 5,
    gamesLost: 5,
    winRate: 50,
    lastGameAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('expectedScore', () => {
  it('returns 0.5 when both players have equal ELO', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5);
  });

  it('returns >0.5 when playerA has higher ELO', () => {
    expect(expectedScore(1200, 1000)).toBeGreaterThan(0.5);
  });

  it('returns <0.5 when playerA has lower ELO', () => {
    expect(expectedScore(800, 1000)).toBeLessThan(0.5);
  });

  it('returns value in [0,1] range', () => {
    const score = expectedScore(500, 2000);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('computeNewElo', () => {
  it('increases ELO on win', () => {
    const newElo = computeNewElo(1000, true, 1000, null);
    expect(newElo).toBeGreaterThan(1000);
  });

  it('decreases ELO on loss', () => {
    const newElo = computeNewElo(1000, false, 1000, null);
    expect(newElo).toBeLessThan(1000);
  });

  it('never drops below MIN_ELO (100)', () => {
    const newElo = computeNewElo(105, false, 3000, null);
    expect(newElo).toBeGreaterThanOrEqual(100);
  });

  it('applies role weight for Merlin (1.5x K)', () => {
    const baseElo = computeNewElo(1000, true, 1000, null, 32);
    const merlinElo = computeNewElo(1000, true, 1000, 'merlin', 32);
    expect(merlinElo).toBeGreaterThan(baseElo);
  });

  it('applies role weight for Assassin (1.5x K)', () => {
    const baseElo = computeNewElo(1000, true, 1000, null, 32);
    const assassinElo = computeNewElo(1000, true, 1000, 'assassin', 32);
    expect(assassinElo).toBeGreaterThan(baseElo);
  });

  it('loyal servant uses 1.0x weight (same as null)', () => {
    const loyalElo = computeNewElo(1000, true, 1000, 'loyal', 32);
    const nullElo = computeNewElo(1000, true, 1000, null, 32);
    expect(loyalElo).toBe(nullElo);
  });

  it('gain is larger when defeating a stronger opponent', () => {
    const vsWeak = computeNewElo(1000, true, 800, null);
    const vsStrong = computeNewElo(1000, true, 1400, null);
    expect(vsStrong).toBeGreaterThan(vsWeak);
  });

  it('loss penalty is smaller against a stronger opponent', () => {
    const vsWeak = computeNewElo(1000, false, 800, null);
    const vsStrong = computeNewElo(1000, false, 1400, null);
    expect(vsStrong).toBeGreaterThan(vsWeak); // less points lost
  });
});

// ---------------------------------------------------------------------------
// EloRankingService tests
// ---------------------------------------------------------------------------

describe('EloRankingService — getPlayerElo', () => {
  let service: EloRankingService;

  beforeEach(() => {
    service = new EloRankingService();
    vi.clearAllMocks();
    mockAdminDB.ref.mockReturnValue(mockRef);
    mockRef.orderByChild.mockReturnValue(mockRef);
    mockRef.limitToLast.mockReturnValue(mockRef);
  });

  it('returns existing ELO from database', async () => {
    mockRef.once.mockResolvedValue({ val: () => makeEloEntry('p1', 1200) });
    const elo = await service.getPlayerElo('p1');
    expect(elo).toBe(1200);
  });

  it('returns 1000 (STARTING_ELO) when player not found', async () => {
    mockRef.once.mockResolvedValue({ val: () => null });
    const elo = await service.getPlayerElo('unknown');
    expect(elo).toBe(1000);
  });

  it('returns 1000 on database error', async () => {
    mockRef.once.mockRejectedValue(new Error('Network error'));
    const elo = await service.getPlayerElo('p1');
    expect(elo).toBe(1000);
  });
});

describe('EloRankingService — processGameResult', () => {
  let service: EloRankingService;

  beforeEach(() => {
    service = new EloRankingService();
    vi.clearAllMocks();
    mockAdminDB.ref.mockReturnValue(mockRef);
    mockRef.orderByChild.mockReturnValue(mockRef);
    mockRef.limitToLast.mockReturnValue(mockRef);
    mockRef.set.mockResolvedValue(undefined);
  });

  it('returns EloUpdate for every player', async () => {
    mockRef.once.mockResolvedValue({ val: () => null }); // all start at 1000
    const record = makeGameRecord();
    const updates = await service.processGameResult(record);
    expect(updates).toHaveLength(record.players.length);
  });

  it('winners gain ELO, losers lose ELO', async () => {
    mockRef.once.mockResolvedValue({ val: () => null }); // all at 1000
    const record = makeGameRecord();
    const updates = await service.processGameResult(record);

    const winners = updates.filter((u) =>
      record.players.find((p) => p.playerId === u.uid)?.won
    );
    const losers = updates.filter((u) =>
      !record.players.find((p) => p.playerId === u.uid)?.won
    );

    winners.forEach((u) => expect(u.delta).toBeGreaterThan(0));
    losers.forEach((u) => expect(u.delta).toBeLessThan(0));
  });

  it('persists updated entries to database', async () => {
    mockRef.once.mockResolvedValue({ val: () => null });
    const record = makeGameRecord();
    await service.processGameResult(record);
    // Each player does 2 once() calls (fetch elo + fetch existing entry) + 1 set
    expect(mockRef.set).toHaveBeenCalledTimes(record.players.length);
  });
});

describe('EloRankingService — getLeaderboard', () => {
  let service: EloRankingService;

  beforeEach(() => {
    service = new EloRankingService();
    vi.clearAllMocks();
    mockAdminDB.ref.mockReturnValue(mockRef);
    mockRef.orderByChild.mockReturnValue(mockRef);
    mockRef.limitToLast.mockReturnValue(mockRef);
  });

  it('returns players sorted by ELO descending with ranks', async () => {
    const entries = [
      makeEloEntry('p1', 1300),
      makeEloEntry('p2', 1100),
      makeEloEntry('p3', 1500),
    ];
    const fakeSnap = {
      forEach: (cb: (child: { val: () => EloEntry; key: string }) => void) => {
        entries.forEach((e) => cb({ val: () => e, key: e.uid }));
      },
    };
    mockRef.once.mockResolvedValue(fakeSnap);

    const result = await service.getLeaderboard(10);
    expect(result[0].eloRating).toBe(1500);
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
    expect(result[2].rank).toBe(3);
  });

  it('returns empty array on error', async () => {
    mockRef.once.mockRejectedValue(new Error('DB error'));
    const result = await service.getLeaderboard();
    expect(result).toEqual([]);
  });
});

describe('EloRankingService — getPlayerEntry', () => {
  let service: EloRankingService;

  beforeEach(() => {
    service = new EloRankingService();
    vi.clearAllMocks();
    mockAdminDB.ref.mockReturnValue(mockRef);
  });

  it('returns entry when found', async () => {
    const entry = makeEloEntry('p1', 1250);
    mockRef.once.mockResolvedValue({ val: () => entry });
    const result = await service.getPlayerEntry('p1');
    expect(result?.eloRating).toBe(1250);
  });

  it('returns null when not found', async () => {
    mockRef.once.mockResolvedValue({ val: () => null });
    const result = await service.getPlayerEntry('p999');
    expect(result).toBeNull();
  });

  it('returns null on error', async () => {
    mockRef.once.mockRejectedValue(new Error('Timeout'));
    const result = await service.getPlayerEntry('p1');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #54 Phase 1 — data-driven config + three-outcome weighting
// ---------------------------------------------------------------------------

describe('#54 EloConfig — data-driven defaults', () => {
  afterEach(() => {
    // Reset to defaults so later tests aren't polluted.
    setEloConfig();
  });

  it('exposes the seed config (baselines + outcome weights)', () => {
    const cfg = getEloConfig();
    expect(cfg.teamBaselines.good).toBe(1500);
    expect(cfg.teamBaselines.evil).toBe(1500);
    expect(cfg.outcomeWeights.good_wins_quests).toBe(1.0);
    expect(cfg.outcomeWeights.evil_wins_quests).toBe(1.0);
    expect(cfg.outcomeWeights.assassin_kills_merlin).toBe(1.5);
    expect(cfg.startingElo).toBe(1000);
    expect(cfg.minElo).toBe(100);
  });

  it('setEloConfig merges partial overrides and resets on undefined', () => {
    const merged = setEloConfig({ baseKFactor: 48 });
    expect(merged.baseKFactor).toBe(48);
    expect(merged.outcomeWeights.assassin_kills_merlin).toBe(1.5); // preserved

    setEloConfig();
    expect(getEloConfig()).toEqual(DEFAULT_ELO_CONFIG);
  });
});

describe('#54 deriveEloOutcome — winReason -> EloOutcome', () => {
  it('maps assassination_success → assassin_kills_merlin', () => {
    expect(deriveEloOutcome('evil', 'assassination_success')).toBe(
      'assassin_kills_merlin'
    );
  });

  it('maps merlin_assassinated → assassin_kills_merlin', () => {
    expect(deriveEloOutcome('evil', 'merlin_assassinated')).toBe(
      'assassin_kills_merlin'
    );
  });

  it('maps legacy CJK "刺殺梅林" → assassin_kills_merlin', () => {
    expect(deriveEloOutcome('evil', '刺殺梅林')).toBe('assassin_kills_merlin');
  });

  it('maps assassination_failed (good winner) → good_wins_quests', () => {
    expect(deriveEloOutcome('good', 'assassination_failed')).toBe(
      'good_wins_quests'
    );
  });

  it('maps assassination_timeout (good winner) → good_wins_quests', () => {
    expect(deriveEloOutcome('good', 'assassination_timeout')).toBe(
      'good_wins_quests'
    );
  });

  it('maps failed_quests_limit (evil winner) → evil_wins_quests', () => {
    expect(deriveEloOutcome('evil', 'failed_quests_limit')).toBe(
      'evil_wins_quests'
    );
  });

  it('maps vote_rejections_limit (evil winner) → evil_wins_quests', () => {
    expect(deriveEloOutcome('evil', 'vote_rejections_limit')).toBe(
      'evil_wins_quests'
    );
  });

  it('falls back to team flag when winReason is null/unknown', () => {
    expect(deriveEloOutcome('good', null)).toBe('good_wins_quests');
    expect(deriveEloOutcome('evil', undefined)).toBe('evil_wins_quests');
    expect(deriveEloOutcome('good', 'something_new')).toBe('good_wins_quests');
  });
});

describe('#54 computeNewElo — three-outcome weighting', () => {
  afterEach(() => {
    setEloConfig();
  });

  it('good_wins_quests uses 1.0x multiplier (same as no outcome)', () => {
    const withOutcome = computeNewElo(
      1000,
      true,
      1000,
      null,
      32,
      'good_wins_quests'
    );
    const noOutcome = computeNewElo(1000, true, 1000, null, 32);
    expect(withOutcome).toBe(noOutcome);
  });

  it('evil_wins_quests uses 1.0x multiplier (same as no outcome)', () => {
    const withOutcome = computeNewElo(
      1000,
      true,
      1000,
      null,
      32,
      'evil_wins_quests'
    );
    const noOutcome = computeNewElo(1000, true, 1000, null, 32);
    expect(withOutcome).toBe(noOutcome);
  });

  it('assassin_kills_merlin applies 1.5x multiplier (larger delta)', () => {
    const baseElo = computeNewElo(
      1000,
      true,
      1000,
      null,
      32,
      'good_wins_quests'
    );
    const killElo = computeNewElo(
      1000,
      true,
      1000,
      null,
      32,
      'assassin_kills_merlin'
    );
    expect(killElo).toBeGreaterThan(baseElo);
  });

  it('respects config overrides for outcome weights', () => {
    setEloConfig({ outcomeWeights: { ...DEFAULT_ELO_CONFIG.outcomeWeights, good_wins_quests: 2.0 } });
    const boosted = computeNewElo(1000, true, 1000, null, 32, 'good_wins_quests');
    const baseline = computeNewElo(1000, true, 1000, null, 32, 'evil_wins_quests');
    expect(boosted - 1000).toBeGreaterThan(baseline - 1000);
  });

  it('falls back to default minElo from config (100)', () => {
    const newElo = computeNewElo(105, false, 3000, null, 32, 'evil_wins_quests');
    expect(newElo).toBeGreaterThanOrEqual(getEloConfig().minElo);
  });

  it('honours custom minElo override', () => {
    setEloConfig({ minElo: 500 });
    const newElo = computeNewElo(510, false, 3000, null, 32, 'evil_wins_quests');
    expect(newElo).toBeGreaterThanOrEqual(500);
  });
});

describe('#54 processGameResult — stamps outcome on every update', () => {
  let service: EloRankingService;

  beforeEach(() => {
    service = new EloRankingService();
    vi.clearAllMocks();
    mockAdminDB.ref.mockReturnValue(mockRef);
    mockRef.orderByChild.mockReturnValue(mockRef);
    mockRef.limitToLast.mockReturnValue(mockRef);
    mockRef.set.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setEloConfig();
  });

  it('stamps good_wins_quests on assassination_failed games', async () => {
    mockRef.once.mockResolvedValue({ val: () => null });
    const record = makeGameRecord({
      winner: 'good',
      winReason: 'assassination_failed',
    });
    const updates = await service.processGameResult(record);
    updates.forEach((u) => expect(u.outcome).toBe('good_wins_quests'));
  });

  it('stamps evil_wins_quests on failed_quests_limit games', async () => {
    mockRef.once.mockResolvedValue({ val: () => null });
    const record = makeGameRecord({
      winner: 'evil',
      winReason: 'failed_quests_limit',
      players: [
        { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: false },
        { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: true },
        { playerId: 'p3', displayName: 'Carol', role: 'loyal', team: 'good', won: false },
        { playerId: 'p4', displayName: 'Dave', role: 'morgana', team: 'evil', won: true },
        { playerId: 'p5', displayName: 'Eve', role: 'percival', team: 'good', won: false },
      ],
    });
    const updates = await service.processGameResult(record);
    updates.forEach((u) => expect(u.outcome).toBe('evil_wins_quests'));
  });

  it('stamps assassin_kills_merlin on assassination_success games', async () => {
    mockRef.once.mockResolvedValue({ val: () => null });
    const record = makeGameRecord({
      winner: 'evil',
      winReason: 'assassination_success',
      players: [
        { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: false },
        { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: true },
        { playerId: 'p3', displayName: 'Carol', role: 'loyal', team: 'good', won: false },
        { playerId: 'p4', displayName: 'Dave', role: 'morgana', team: 'evil', won: true },
        { playerId: 'p5', displayName: 'Eve', role: 'percival', team: 'good', won: false },
      ],
    });
    const updates = await service.processGameResult(record);
    updates.forEach((u) => expect(u.outcome).toBe('assassin_kills_merlin'));
  });

  it('assassin_kills_merlin produces larger absolute delta than good_wins_quests', async () => {
    mockRef.once.mockResolvedValue({ val: () => null });

    const goodWinRecord = makeGameRecord({
      winner: 'good',
      winReason: 'assassination_failed',
    });
    const goodWinUpdates = await service.processGameResult(goodWinRecord);
    const goodWinMerlinDelta = Math.abs(
      goodWinUpdates.find((u) => u.role === 'merlin')?.delta ?? 0
    );

    vi.clearAllMocks();
    mockAdminDB.ref.mockReturnValue(mockRef);
    mockRef.orderByChild.mockReturnValue(mockRef);
    mockRef.limitToLast.mockReturnValue(mockRef);
    mockRef.set.mockResolvedValue(undefined);
    mockRef.once.mockResolvedValue({ val: () => null });

    const killRecord = makeGameRecord({
      winner: 'evil',
      winReason: 'assassination_success',
      players: [
        { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: false },
        { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: true },
        { playerId: 'p3', displayName: 'Carol', role: 'loyal', team: 'good', won: false },
        { playerId: 'p4', displayName: 'Dave', role: 'morgana', team: 'evil', won: true },
        { playerId: 'p5', displayName: 'Eve', role: 'percival', team: 'good', won: false },
      ],
    });
    const killUpdates = await service.processGameResult(killRecord);
    const killMerlinDelta = Math.abs(
      killUpdates.find((u) => u.role === 'merlin')?.delta ?? 0
    );

    // 1.5x outcome weight should produce a larger magnitude for merlin
    expect(killMerlinDelta).toBeGreaterThan(goodWinMerlinDelta);
  });
});
