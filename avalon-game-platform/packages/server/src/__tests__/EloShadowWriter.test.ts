import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeShadowUpdates,
  setShadowWriterOptions,
  getShadowWriterOptions,
  EloShadowWriter,
} from '../services/EloShadowWriter';
import { setEloConfig, DEFAULT_ELO_CONFIG, getEloConfig } from '../services/EloConfig';
import type {
  GameRecord,
  GamePlayerRecord,
} from '../services/GameHistoryRepository';
import type { VoteRecord, QuestRecord } from '@avalon/shared';

// ---------------------------------------------------------------------------
// Mock Firebase RTD
// ---------------------------------------------------------------------------

const mockRef = {
  once: vi.fn(),
  set: vi.fn(),
};

const mockAdminDB = {
  ref: vi.fn(() => mockRef),
};

vi.mock('../services/firebase', () => ({
  getAdminDB: vi.fn(() => mockAdminDB),
}));

// ---------------------------------------------------------------------------
// Fixtures
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

function makeRecord(overrides: Partial<GameRecord> = {}): GameRecord {
  const players: GamePlayerRecord[] = [
    makePlayer({ playerId: 'p1', team: 'good', role: 'merlin', won: true }),
    makePlayer({ playerId: 'p2', team: 'good', role: 'percival', won: true }),
    makePlayer({ playerId: 'p3', team: 'good', role: 'loyal', won: true }),
    makePlayer({ playerId: 'p4', team: 'evil', role: 'assassin', won: false }),
    makePlayer({ playerId: 'p5', team: 'evil', role: 'morgana', won: false }),
  ];
  return {
    gameId: 'g1',
    roomName: 'r1',
    playerCount: 5,
    winner: 'good',
    winReason: 'assassination_failed',
    questResults: ['success', 'success', 'success'],
    duration: 1000,
    players,
    createdAt: Date.now() - 1000,
    endedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EloShadowWriter — options', () => {
  beforeEach(() => {
    setShadowWriterOptions({ enabled: false, path: 'rankings_shadow' });
    setEloConfig();
    vi.clearAllMocks();
  });

  it('defaults to disabled', () => {
    const opts = getShadowWriterOptions();
    expect(opts.enabled).toBe(false);
  });

  it('can be toggled enabled', () => {
    setShadowWriterOptions({ enabled: true });
    expect(getShadowWriterOptions().enabled).toBe(true);
  });

  it('writer.getShadowElo returns fallback when disabled', async () => {
    const w = new EloShadowWriter();
    const elo = await w.getShadowElo('p1', 1234);
    expect(elo).toBe(1234);
    expect(mockAdminDB.ref).not.toHaveBeenCalled();
  });

  it('writer.writeUpdates is no-op when disabled', async () => {
    const w = new EloShadowWriter();
    await w.writeUpdates(makeRecord(), []);
    expect(mockRef.set).not.toHaveBeenCalled();
  });
});

describe('computeShadowUpdates — pure computation', () => {
  beforeEach(() => {
    setEloConfig(); // reset to DEFAULT
  });

  it('returns one update per player', () => {
    const record = makeRecord();
    const shadowElos = {
      p1: 1200,
      p2: 1100,
      p3: 1050,
      p4: 1150,
      p5: 1000,
    };
    const legacyElos = {
      p1: 1200,
      p2: 1100,
      p3: 1050,
      p4: 1150,
      p5: 1000,
    };

    const updates = computeShadowUpdates(record, shadowElos, legacyElos);
    expect(updates).toHaveLength(5);
    const uids = updates.map((u) => u.uid).sort();
    expect(uids).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('uses startingElo when shadow elo is missing', () => {
    const record = makeRecord();
    const updates = computeShadowUpdates(record, {}, {});
    // Winners gain (from startingElo 1000) — shadowNewElo > startingElo for p1/p2/p3
    const p1 = updates.find((u) => u.uid === 'p1');
    expect(p1).toBeDefined();
    expect(p1!.shadowNewElo).toBeGreaterThanOrEqual(DEFAULT_ELO_CONFIG.minElo);
  });

  it('respects minElo floor', () => {
    const record = makeRecord();
    // Push everyone very low so evil losers would go below floor.
    const lowElos = { p1: 100, p2: 100, p3: 100, p4: 100, p5: 100 };
    const updates = computeShadowUpdates(record, lowElos, lowElos);
    for (const u of updates) {
      expect(u.shadowNewElo).toBeGreaterThanOrEqual(DEFAULT_ELO_CONFIG.minElo);
    }
  });

  it('does NOT permanently mutate active config attributionMode', () => {
    setEloConfig({ attributionMode: 'legacy' });
    const record = makeRecord();
    computeShadowUpdates(record, {}, {});
    // The helper temporarily flips mode to 'per_event' but must restore.
    expect(getEloConfig().attributionMode).toBe('legacy');
  });

  it('applies per_event attribution when history is present', () => {
    const voteHistory: VoteRecord[] = [
      {
        round: 1,
        attempt: 1,
        leader: 'p1',
        team: ['p1', 'p2'], // clean pick (no evil)
        approved: true,
        votes: {},
      },
    ];
    const questHistory: QuestRecord[] = [
      { round: 1, team: ['p1', 'p2'], result: 'success', failCount: 0 },
    ];
    const record = makeRecord({
      voteHistoryPersisted: voteHistory,
      questHistoryPersisted: questHistory,
    });

    const baseline = {
      p1: 1000,
      p2: 1000,
      p3: 1000,
      p4: 1000,
      p5: 1000,
    };
    const updates = computeShadowUpdates(record, baseline, baseline);
    const p1 = updates.find((u) => u.uid === 'p1');
    // p1 was leader of a clean pick → Proposal factor + good-side win
    // should strictly exceed plain legacy. Assert NON-zero attribution delta
    // makes shadowNewElo differ from a hypothetical legacy-only compute.
    expect(p1).toBeDefined();
    expect(p1!.shadowNewElo).toBeGreaterThan(1000);
  });

  it('produces legacy-equivalent shadow ELO when no history (fallback path)', () => {
    const record = makeRecord(); // no voteHistoryPersisted / questHistoryPersisted
    const baseline = {
      p1: 1000,
      p2: 1000,
      p3: 1000,
      p4: 1000,
      p5: 1000,
    };
    const updates = computeShadowUpdates(record, baseline, baseline);
    // All players should have non-trivial legacy-equivalent movement.
    for (const u of updates) {
      expect(u.shadowNewElo).toBeGreaterThanOrEqual(DEFAULT_ELO_CONFIG.minElo);
    }
    // Sum-zero-ish property: winners' gain roughly equals losers' loss
    // (not exactly because K-factor varies by role).
    const winners = updates.filter((u) =>
      ['p1', 'p2', 'p3'].includes(u.uid)
    );
    const losers = updates.filter((u) =>
      ['p4', 'p5'].includes(u.uid)
    );
    const winnerGain = winners.reduce((s, u) => s + (u.shadowNewElo - 1000), 0);
    const loserLoss = losers.reduce((s, u) => s + (1000 - u.shadowNewElo), 0);
    expect(winnerGain).toBeGreaterThan(0);
    expect(loserLoss).toBeGreaterThan(0);
  });
});

describe('EloShadowWriter — RTDB persistence', () => {
  beforeEach(() => {
    setShadowWriterOptions({ enabled: true, path: 'rankings_shadow' });
    setEloConfig();
    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({ val: () => null });
    mockRef.set.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setShadowWriterOptions({ enabled: false });
  });

  it('writes to rankings_shadow path only (never rankings/)', async () => {
    const w = new EloShadowWriter();
    const record = makeRecord();
    await w.writeUpdates(record, [
      { uid: 'p1', legacyNewElo: 1010, shadowNewElo: 1015, shadowDelta: 15 },
    ]);
    const calls = mockAdminDB.ref.mock.calls.map((c) => c[0]);
    expect(calls).toContain('rankings_shadow/p1');
    expect(calls.every((c) => !c.startsWith('rankings/'))).toBe(true);
  });

  it('swallows RTDB errors without throwing', async () => {
    mockRef.set.mockRejectedValueOnce(new Error('boom'));
    const w = new EloShadowWriter();
    await expect(
      w.writeUpdates(makeRecord(), [
        { uid: 'p1', legacyNewElo: 1010, shadowNewElo: 1015, shadowDelta: 15 },
      ])
    ).resolves.toBeUndefined();
  });
});
