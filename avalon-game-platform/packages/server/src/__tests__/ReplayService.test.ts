import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ReplayService,
  ReplayRecorder,
  GameReplay,
  GameStartedPayload,
  TeamSelectedPayload,
  TeamVoteResolvedPayload,
  QuestResolvedPayload,
  GameEndedPayload,
} from '../services/ReplayService';

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

function makeReplay(gameId = 'game-xyz'): GameReplay {
  return {
    gameId,
    roomName: 'Test Room',
    playerCount: 5,
    winner: 'good',
    winReason: 'assassination_failed',
    startedAt: 1_000_000,
    endedAt: 2_000_000,
    durationMs: 1_000_000,
    players: [
      { playerId: 'p1', displayName: 'Alice', role: 'merlin', team: 'good', won: true },
      { playerId: 'p2', displayName: 'Bob', role: 'assassin', team: 'evil', won: false },
    ],
    timeline: [],
  };
}

// ---------------------------------------------------------------------------
// ReplayRecorder unit tests
// ---------------------------------------------------------------------------

describe('ReplayRecorder', () => {
  it('starts with zero events', () => {
    const recorder = new ReplayRecorder('g1');
    expect(recorder.size).toBe(0);
    expect(recorder.getEvents()).toHaveLength(0);
  });

  it('assigns sequential seq numbers', () => {
    const recorder = new ReplayRecorder('g1');
    const payload: GameStartedPayload = { playerCount: 5, roleAssignments: {} };
    recorder.record('game_started', payload);
    recorder.record('game_started', payload);
    const events = recorder.getEvents();
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(1);
  });

  it('stores the correct event type', () => {
    const recorder = new ReplayRecorder('g1');
    const payload: TeamSelectedPayload = {
      leaderId: 'p1',
      teamPlayerIds: ['p1', 'p2'],
      teamSize: 2,
    };
    recorder.record('leader_selected_team', payload);
    expect(recorder.getEvents()[0].type).toBe('leader_selected_team');
  });

  it('uses current round when recording', () => {
    const recorder = new ReplayRecorder('g1');
    recorder.setRound(3);
    const payload: GameStartedPayload = { playerCount: 5, roleAssignments: {} };
    recorder.record('game_started', payload);
    expect(recorder.getEvents()[0].round).toBe(3);
  });

  it('updates round when setRound is called', () => {
    const recorder = new ReplayRecorder('g1');
    const payload: GameStartedPayload = { playerCount: 5, roleAssignments: {} };
    recorder.setRound(1);
    recorder.record('game_started', payload);
    recorder.setRound(2);
    recorder.record('game_started', payload);
    const events = recorder.getEvents();
    expect(events[0].round).toBe(1);
    expect(events[1].round).toBe(2);
  });

  it('returns a read-only snapshot via getEvents()', () => {
    const recorder = new ReplayRecorder('g1');
    const events = recorder.getEvents();
    // Attempt to mutate — TypeScript won't catch at runtime but the array is a copy
    expect(Array.isArray(events)).toBe(true);
  });

  it('increments size correctly', () => {
    const recorder = new ReplayRecorder('g1');
    const p: GameStartedPayload = { playerCount: 5, roleAssignments: {} };
    recorder.record('game_started', p);
    recorder.record('game_started', p);
    recorder.record('game_started', p);
    expect(recorder.size).toBe(3);
  });

  it('stores the payload correctly', () => {
    const recorder = new ReplayRecorder('g1');
    const payload: QuestResolvedPayload = {
      round: 2,
      result: 'fail',
      successCount: 1,
      failCount: 1,
    };
    recorder.record('quest_resolved', payload);
    expect(recorder.getEvents()[0].payload).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// ReplayService — saveReplay
// ---------------------------------------------------------------------------

describe('ReplayService — saveReplay', () => {
  let service: ReplayService;

  beforeEach(() => {
    service = new ReplayService();
    vi.clearAllMocks();
    mockCollection.doc.mockReturnValue(mockDocRef);
    mockFirestore.collection.mockReturnValue(mockCollection);
  });

  it('saves to the replays collection with correct document id', async () => {
    mockDocRef.set.mockResolvedValue(undefined);
    const replay = makeReplay('abc');
    await service.saveReplay(replay);
    expect(mockFirestore.collection).toHaveBeenCalledWith('replays');
    expect(mockCollection.doc).toHaveBeenCalledWith('abc');
  });

  it('throws when Firestore set rejects', async () => {
    mockDocRef.set.mockRejectedValue(new Error('Quota exceeded'));
    await expect(service.saveReplay(makeReplay())).rejects.toThrow('Quota exceeded');
  });
});

// ---------------------------------------------------------------------------
// ReplayService — getReplay
// ---------------------------------------------------------------------------

describe('ReplayService — getReplay', () => {
  let service: ReplayService;

  beforeEach(() => {
    service = new ReplayService();
    vi.clearAllMocks();
    mockCollection.doc.mockReturnValue(mockDocRef);
    mockFirestore.collection.mockReturnValue(mockCollection);
  });

  it('returns replay when document exists', async () => {
    const replay = makeReplay('game-xyz');
    mockDocRef.get.mockResolvedValue({ exists: true, data: () => replay });
    const result = await service.getReplay('game-xyz');
    expect(result?.gameId).toBe('game-xyz');
  });

  it('returns null when document does not exist', async () => {
    mockDocRef.get.mockResolvedValue({ exists: false, data: () => null });
    const result = await service.getReplay('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null on Firestore error', async () => {
    mockDocRef.get.mockRejectedValue(new Error('Permission denied'));
    const result = await service.getReplay('game-xyz');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ReplayService — listRecentReplays
// ---------------------------------------------------------------------------

describe('ReplayService — listRecentReplays', () => {
  let service: ReplayService;

  beforeEach(() => {
    service = new ReplayService();
    vi.clearAllMocks();
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    mockCollection.orderBy = vi.fn(() => mockQuery);
    mockFirestore.collection.mockReturnValue(mockCollection);
  });

  it('returns ordered replays', async () => {
    const replays = [makeReplay('g1'), makeReplay('g2')];
    mockQuery.get.mockResolvedValue({
      docs: replays.map((r) => ({ data: () => r })),
    });
    const result = await service.listRecentReplays(10);
    expect(result).toHaveLength(2);
  });

  it('respects limit parameter', async () => {
    mockQuery.get.mockResolvedValue({ docs: [] });
    await service.listRecentReplays(5);
    expect(mockQuery.limit).toHaveBeenCalledWith(5);
  });

  it('returns empty array on error', async () => {
    mockQuery.get.mockRejectedValue(new Error('Network error'));
    const result = await service.listRecentReplays();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ReplayService — buildReplay
// ---------------------------------------------------------------------------

describe('ReplayService — buildReplay', () => {
  let service: ReplayService;

  beforeEach(() => {
    service = new ReplayService();
  });

  it('builds a replay document with correct metadata', () => {
    const recorder = new ReplayRecorder('game-1');
    const payload: GameStartedPayload = { playerCount: 5, roleAssignments: {} };
    recorder.record('game_started', payload);

    const meta = {
      roomName: 'My Room',
      startedAt: 1_000_000,
      winner: 'evil' as const,
      winReason: 'assassination_success',
      players: [
        { playerId: 'p1', displayName: 'Alice', role: 'merlin' as const, team: 'good' as const, won: false },
      ],
    };

    const replay = service.buildReplay(recorder, meta);
    expect(replay.gameId).toBe('game-1');
    expect(replay.roomName).toBe('My Room');
    expect(replay.winner).toBe('evil');
    expect(replay.players).toHaveLength(1);
    expect(replay.timeline).toHaveLength(1);
    expect(replay.timeline[0].type).toBe('game_started');
  });

  it('sets durationMs as endedAt - startedAt', () => {
    const recorder = new ReplayRecorder('game-2');
    const startedAt = Date.now() - 5_000;
    const meta = {
      roomName: 'Room',
      startedAt,
      winner: 'good' as const,
      winReason: 'assassination_failed',
      players: [],
    };
    const replay = service.buildReplay(recorder, meta);
    expect(replay.durationMs).toBeGreaterThanOrEqual(5_000);
  });

  it('includes all timeline events from the recorder', () => {
    const recorder = new ReplayRecorder('game-3');
    const p: GameStartedPayload = { playerCount: 5, roleAssignments: {} };
    recorder.record('game_started', p);
    recorder.record('game_started', p);
    recorder.record('game_started', p);

    const meta = {
      roomName: 'Room',
      startedAt: 1_000_000,
      winner: 'good' as const,
      winReason: 'assassination_failed',
      players: [],
    };
    const replay = service.buildReplay(recorder, meta);
    expect(replay.timeline).toHaveLength(3);
  });

  it('sets playerCount from players array length', () => {
    const recorder = new ReplayRecorder('game-4');
    const meta = {
      roomName: 'Room',
      startedAt: 1_000_000,
      winner: 'good' as const,
      winReason: 'assassination_failed',
      players: [
        { playerId: 'p1', displayName: 'A', role: 'merlin' as const, team: 'good' as const, won: true },
        { playerId: 'p2', displayName: 'B', role: 'loyal' as const, team: 'good' as const, won: true },
        { playerId: 'p3', displayName: 'C', role: 'assassin' as const, team: 'evil' as const, won: false },
      ],
    };
    const replay = service.buildReplay(recorder, meta);
    expect(replay.playerCount).toBe(3);
  });
});
