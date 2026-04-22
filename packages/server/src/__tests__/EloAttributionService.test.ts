import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VoteRecord, QuestRecord } from '@avalon/shared';
import { computeAttributionDeltas } from '../services/EloAttributionService';
import {
  DEFAULT_ELO_CONFIG,
  setEloConfig,
} from '../services/EloConfig';
import {
  GameRecord,
  GamePlayerRecord,
} from '../services/GameHistoryRepository';
import {
  EloRankingService,
  EloEntry,
} from '../services/EloRanking';

// ---------------------------------------------------------------------------
// Mock Firebase RTD (reused mocking pattern from EloRanking.test.ts)
// ---------------------------------------------------------------------------

const mockRef = {
  once: vi.fn(),
  set: vi.fn(),
  orderByChild: vi.fn(),
  limitToLast: vi.fn(),
};

mockRef.orderByChild.mockReturnValue(mockRef);
mockRef.limitToLast.mockReturnValue(mockRef);

const mockAdminDB = {
  ref: vi.fn(() => mockRef),
};

vi.mock('../services/firebase', () => ({
  getAdminDB: vi.fn(() => mockAdminDB),
}));

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

function makeQuest(
  overrides: Partial<QuestRecord> &
    Pick<QuestRecord, 'team' | 'result'>
): QuestRecord {
  return {
    round: 1,
    failCount: overrides.result === 'fail' ? 1 : 0,
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

/**
 * 5-player fixture with fully persisted history. Shared across
 * integration tests so expected deltas are stable.
 *
 * Proposals (3 votes total):
 *   R1  leader=p1 (good)  team=[p1, p3]   approved → clean pick → p1: +1
 *   R2  leader=p1 (good)  team=[p1, p5]   approved → clean pick → p1: +1
 *   R3  leader=p3 (good)  team=[p3, p4]   approved → 1 evil slot + approved → p3: -2
 *
 * Quests:
 *   R1 success (p1, p3)
 *   R2 fail    (p1, p5)   ← wait, p5 is good; this doesn't work for sabotage.
 *   R3 success (p3, p4)   ← p4 on team, succeeded → +0.5
 *
 * Revised to give p4 a clear sabotage signal:
 *   Swap R2 quest team to (p3, p4) and keep R2 vote clean so p4 is also on team 2.
 *
 * Final shape:
 *   R1 vote leader=p1 team=[p1, p3] approved   → p1 +1 (clean)
 *   R2 vote leader=p1 team=[p3, p4] approved   → p1 -2 (1 evil, approved) — note p1 off team
 *   R3 vote leader=p3 team=[p3, p4] approved   → p3 -2 (1 evil, approved)
 *
 *   Quest R1 team=[p1, p3] success             → p4 off team, success → 0
 *   Quest R2 team=[p3, p4] fail                → p4 on team, fail → +3; p2 off team + fail → -1
 *   Quest R3 team=[p3, p4] success             → p4 on team, success → +0.5
 *
 *   Raw totals:
 *     p1 proposal = +1 - 2 = -1
 *     p3 proposal = -2
 *     p4 OWIB     = +3 + 0.5 = +3.5
 *     p2 OWIB     = -1 (off all 3 quests, 1 failed → -1 cumulative)
 *
 *   Weighted (proposal=2.0, OWIB=3.0):
 *     p1 = -2
 *     p3 = -4
 *     p4 = +10.5
 *     p2 = -3
 */
function makeAttributionFixture(): GameRecord {
  const players: GamePlayerRecord[] = [
    makePlayer({ playerId: 'p1', team: 'good', role: 'merlin', won: true }),
    makePlayer({ playerId: 'p2', team: 'evil', role: 'assassin', won: false }),
    makePlayer({ playerId: 'p3', team: 'good', role: 'loyal', won: true }),
    makePlayer({ playerId: 'p4', team: 'evil', role: 'morgana', won: false }),
    makePlayer({ playerId: 'p5', team: 'good', role: 'percival', won: true }),
  ];

  const voteHistoryPersisted: VoteRecord[] = [
    makeVote({ round: 1, attempt: 1, leader: 'p1', team: ['p1', 'p3'], approved: true }),
    makeVote({ round: 2, attempt: 1, leader: 'p1', team: ['p3', 'p4'], approved: true }),
    makeVote({ round: 3, attempt: 1, leader: 'p3', team: ['p3', 'p4'], approved: true }),
  ];

  const questHistoryPersisted: QuestRecord[] = [
    makeQuest({ round: 1, team: ['p1', 'p3'], result: 'success' }),
    makeQuest({ round: 2, team: ['p3', 'p4'], result: 'fail' }),
    makeQuest({ round: 3, team: ['p3', 'p4'], result: 'success' }),
  ];

  return {
    gameId: 'attrib-fixture',
    roomName: 'Attrib',
    playerCount: players.length,
    winner: 'good',
    winReason: 'assassination_failed',
    questResults: ['success', 'fail', 'success'],
    duration: 900_000,
    players,
    createdAt: 1_000_000,
    endedAt: 1_900_000,
    voteHistoryPersisted,
    questHistoryPersisted,
  };
}

// ---------------------------------------------------------------------------
// Unit: computeAttributionDeltas
// ---------------------------------------------------------------------------

describe('computeAttributionDeltas — feature flag gating', () => {
  afterEach(() => {
    setEloConfig(); // reset to DEFAULT_ELO_CONFIG
  });

  it('returns applied: false when attributionMode === legacy (default)', () => {
    const record = makeAttributionFixture();
    const result = computeAttributionDeltas(record);

    expect(result.applied).toBe(false);
    expect(result.deltas).toEqual({});
    expect(Object.keys(result.breakdown)).toHaveLength(0);
  });

  it('returns applied: false when per_event but record has no history', () => {
    setEloConfig({ attributionMode: 'per_event' });
    const record = makeAttributionFixture();
    const bare: GameRecord = {
      ...record,
      voteHistoryPersisted: undefined,
      questHistoryPersisted: undefined,
    };

    const result = computeAttributionDeltas(bare);
    expect(result.applied).toBe(false);
    expect(result.deltas).toEqual({});
  });

  it('applies deltas only when per_event + history present', () => {
    setEloConfig({ attributionMode: 'per_event' });
    const record = makeAttributionFixture();

    const result = computeAttributionDeltas(record);
    expect(result.applied).toBe(true);
    expect(Object.keys(result.breakdown).length).toBeGreaterThan(0);
  });
});

describe('computeAttributionDeltas — weighted sum math', () => {
  beforeEach(() => {
    setEloConfig({ attributionMode: 'per_event' });
  });
  afterEach(() => {
    setEloConfig();
  });

  it('applies default weights (proposal=2.0, OWIB=3.0) correctly', () => {
    const record = makeAttributionFixture();
    const result = computeAttributionDeltas(record);

    // p1 (good leader R1+R2):
    //   R1 clean pick (0 evil) = +1
    //   R2 1 evil slot + approved = -2
    //   Raw = -1 × 2.0 = -2
    expect(result.breakdown.p1.proposal).toBe(-2);
    expect(result.breakdown.p1.outerWhiteInnerBlack).toBe(0);
    expect(result.breakdown.p1.total).toBe(-2);

    // p3 (good leader R3): 1 proposal with 1 evil slot, approved → -2 raw × 2.0 = -4
    expect(result.breakdown.p3.proposal).toBe(-4);

    // p4 (evil morgana):
    //   Quest 2 on-team, failed → +3
    //   Quest 3 on-team, success → +0.5
    //   Raw OWIB = 3.5 × 3.0 = +10.5
    expect(result.breakdown.p4.outerWhiteInnerBlack).toBeCloseTo(10.5);

    // p2 (evil assassin): off-team all 3 quests, 1 failed → -1 raw × 3.0 = -3
    expect(result.breakdown.p2.outerWhiteInnerBlack).toBe(-3);
  });

  it('respects custom weights via setEloConfig', () => {
    setEloConfig({
      attributionMode: 'per_event',
      attributionWeights: { proposal: 1.0, outerWhiteInnerBlack: 1.0 },
    });

    const record = makeAttributionFixture();
    const result = computeAttributionDeltas(record);

    // With weight=1.0, delta === raw factor score.
    expect(result.breakdown.p1.proposal).toBe(-1); // raw
    expect(result.breakdown.p4.outerWhiteInnerBlack).toBeCloseTo(3.5); // raw
  });

  it('omits zero-delta players from deltas map (but keeps breakdown)', () => {
    const record = makeAttributionFixture();
    // p5 (percival): never led, never on evil team → breakdown all 0
    const result = computeAttributionDeltas(record);

    expect(result.deltas.p5).toBeUndefined();
    expect(result.breakdown.p5.total).toBe(0);
  });
});

describe('computeAttributionDeltas — partial history fallback', () => {
  beforeEach(() => {
    setEloConfig({ attributionMode: 'per_event' });
  });
  afterEach(() => {
    setEloConfig();
  });

  it('tolerates missing voteHistory (OWIB still runs)', () => {
    const record = makeAttributionFixture();
    const questOnly: GameRecord = {
      ...record,
      voteHistoryPersisted: undefined,
    };

    const result = computeAttributionDeltas(questOnly);
    expect(result.applied).toBe(true);
    expect(result.breakdown.p1.proposal).toBe(0);
    expect(result.breakdown.p4.outerWhiteInnerBlack).toBeGreaterThan(0);
  });

  it('tolerates missing questHistory (Proposal still runs)', () => {
    const record = makeAttributionFixture();
    const voteOnly: GameRecord = {
      ...record,
      questHistoryPersisted: undefined,
    };

    const result = computeAttributionDeltas(voteOnly);
    expect(result.applied).toBe(true);
    // Proposal ran (non-zero for leaders) — sign doesn't matter here.
    expect(result.breakdown.p1.proposal).not.toBe(0);
    expect(result.breakdown.p3.proposal).not.toBe(0);
    // OWIB zeroed out because questHistory missing.
    expect(result.breakdown.p4.outerWhiteInnerBlack).toBe(0);
    expect(result.breakdown.p2.outerWhiteInnerBlack).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: EloRankingService.processGameResult routing
// ---------------------------------------------------------------------------

describe('EloRankingService.processGameResult — Phase 2 routing', () => {
  let service: EloRankingService;

  beforeEach(() => {
    service = new EloRankingService();
    vi.clearAllMocks();
    mockAdminDB.ref.mockReturnValue(mockRef);
    mockRef.orderByChild.mockReturnValue(mockRef);
    mockRef.limitToLast.mockReturnValue(mockRef);
    mockRef.set.mockResolvedValue(undefined);
    mockRef.once.mockResolvedValue({ val: () => null }); // all start at 1000
  });

  afterEach(() => {
    setEloConfig(); // reset to DEFAULT_ELO_CONFIG
  });

  it('legacy mode: never populates attribution field on EloUpdate', async () => {
    const record = makeAttributionFixture();
    const updates = await service.processGameResult(record);

    expect(updates).toHaveLength(5);
    updates.forEach((u) => {
      expect(u.attribution).toBeUndefined();
    });
  });

  it('legacy mode: delta identical to pre-Phase-2 baseline', async () => {
    const record = makeAttributionFixture();
    const updates = await service.processGameResult(record);

    // Snapshot of legacy values for the fixture (all start at 1000, good wins).
    // These are the exact deltas Phase 1 computed — must not drift.
    const byUid = Object.fromEntries(updates.map((u) => [u.uid, u]));
    expect(byUid.p1.delta).toBe(24); // merlin 1.5x
    expect(byUid.p3.delta).toBe(16); // loyal 1.0x
    expect(byUid.p5.delta).toBe(19); // percival 1.2x
    expect(byUid.p2.delta).toBe(-24); // assassin 1.5x
    expect(byUid.p4.delta).toBe(-19); // morgana 1.2x
  });

  it('per_event mode: populates attribution + layers deltas on top of legacy', async () => {
    setEloConfig({ attributionMode: 'per_event' });
    const record = makeAttributionFixture();
    const updates = await service.processGameResult(record);

    const byUid = Object.fromEntries(updates.map((u) => [u.uid, u]));

    // All 5 players should carry attribution breakdown.
    updates.forEach((u) => {
      expect(u.attribution).toBeDefined();
    });

    // p1 (good merlin leader): legacy +24, proposal -2, OWIB 0 → +22
    expect(byUid.p1.attribution?.proposal).toBe(-2);
    expect(byUid.p1.attribution?.outerWhiteInnerBlack).toBe(0);
    expect(byUid.p1.delta).toBe(22);

    // p3 (good loyal leader): legacy +16, proposal -4, OWIB 0 → +12
    expect(byUid.p3.attribution?.proposal).toBe(-4);
    expect(byUid.p3.delta).toBe(12);

    // p4 (evil morgana): legacy -19, OWIB +10.5 → -19+10.5 = -8.5 → Math.round → -8
    expect(byUid.p4.attribution?.outerWhiteInnerBlack).toBeCloseTo(10.5);
    expect(byUid.p4.delta).toBe(-8);

    // p2 (evil assassin): legacy -24, OWIB -3 → -27
    expect(byUid.p2.attribution?.outerWhiteInnerBlack).toBe(-3);
    expect(byUid.p2.delta).toBe(-27);
  });

  it('per_event mode: legacy record (no history) falls back to Phase 1 deltas', async () => {
    setEloConfig({ attributionMode: 'per_event' });
    const record = makeAttributionFixture();
    const legacyRecord: GameRecord = {
      ...record,
      voteHistoryPersisted: undefined,
      questHistoryPersisted: undefined,
    };

    const updates = await service.processGameResult(legacyRecord);
    const byUid = Object.fromEntries(updates.map((u) => [u.uid, u]));

    // No attribution should fire — same deltas as legacy mode.
    updates.forEach((u) => expect(u.attribution).toBeUndefined());
    expect(byUid.p1.delta).toBe(24);
    expect(byUid.p4.delta).toBe(-19);
  });

  it('per_event mode: min-ELO floor still applies to layered delta', async () => {
    setEloConfig({
      attributionMode: 'per_event',
      // Extreme weight to push past floor.
      attributionWeights: { proposal: 1, outerWhiteInnerBlack: 10000 },
    });
    // Evil player with history that gives negative OWIB → would blow past floor.
    mockRef.once.mockResolvedValue({
      val: () => makeEloEntry('p2', 200), // close to floor
    });

    const record = makeAttributionFixture();
    const updates = await service.processGameResult(record);

    updates.forEach((u) => {
      expect(u.newElo).toBeGreaterThanOrEqual(DEFAULT_ELO_CONFIG.minElo);
    });
  });
});
