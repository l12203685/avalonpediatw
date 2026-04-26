import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameStatePersistence } from '../services/GameStatePersistence';
import type { GameEngineState } from '../game/GameEngine';
import { Room } from '@avalon/shared';

// ---------------------------------------------------------------------------
// Mock firebase module — single stable set of mock fns
// ---------------------------------------------------------------------------

const mockSet = vi.fn();
const mockOnce = vi.fn();
const mockRemove = vi.fn();

const mockRef = {
  set: mockSet,
  once: mockOnce,
  remove: mockRemove,
};

const mockDB = {
  ref: vi.fn(() => mockRef),
};

vi.mock('../services/firebase', () => ({
  getAdminDB: vi.fn(() => mockDB),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-42',
    name: 'Test Room',
    host: 'p1',
    state: 'voting',
    players: {
      p1: { id: 'p1', name: 'Alice', role: 'merlin', team: 'good', status: 'active', createdAt: 1000 },
      p2: { id: 'p2', name: 'Bob', role: 'assassin', team: 'evil', status: 'active', createdAt: 1000 },
    },
    maxPlayers: 10,
    currentRound: 1,
    maxRounds: 5,
    votes: {},
    questTeam: ['p1'],
    questResults: ['success'],
    failCount: 0,
    evilWins: null,
    leaderIndex: 0,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// saveRoom
// ---------------------------------------------------------------------------

describe('GameStatePersistence — saveRoom', () => {
  let persistence: GameStatePersistence;

  beforeEach(() => {
    persistence = new GameStatePersistence();
    vi.clearAllMocks();
    mockDB.ref.mockReturnValue(mockRef);
  });

  it('calls ref.set with a payload containing room data', async () => {
    mockSet.mockResolvedValue(undefined);
    const room = makeRoom();

    await persistence.saveRoom(room);

    expect(mockDB.ref).toHaveBeenCalledWith(`rooms/${room.id}`);
    const payload = mockSet.mock.calls[0][0] as { room: { id: string; name: string }; engine?: unknown };
    expect(payload.room).toMatchObject({ id: room.id, name: room.name });
  });

  it('does not include engine key when engineState is not provided', async () => {
    mockSet.mockResolvedValue(undefined);
    await persistence.saveRoom(makeRoom());
    const payload = mockSet.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.engine).toBeUndefined();
  });

  it('includes engine key when engineState is provided', async () => {
    mockSet.mockResolvedValue(undefined);
    const engineState: GameEngineState = {
      version: 1,
      roomId: 'room-42',
      roleAssignments: { p1: 'merlin' },
      questVotes: [],
      currentLeaderIndex: 0,
    };
    await persistence.saveRoom(makeRoom(), engineState);
    const payload = mockSet.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.engine).toBeDefined();
    expect((payload.engine as Record<string, unknown>).version).toBe(1);
  });

  it('does not throw when ref.set rejects', async () => {
    mockSet.mockRejectedValue(new Error('DB unavailable'));
    await expect(persistence.saveRoom(makeRoom())).resolves.toBeUndefined();
  });

  it('serialises room without undefined values', async () => {
    let captured: unknown;
    mockSet.mockImplementation((data: unknown) => {
      captured = data;
      return Promise.resolve();
    });

    await persistence.saveRoom(makeRoom());

    const serialised = JSON.stringify(captured);
    expect(serialised).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// loadRoom — returns { room, engineState } | null
// ---------------------------------------------------------------------------

describe('GameStatePersistence — loadRoom', () => {
  let persistence: GameStatePersistence;

  beforeEach(() => {
    persistence = new GameStatePersistence();
    vi.clearAllMocks();
    mockDB.ref.mockReturnValue(mockRef);
  });

  it('returns { room, engineState } in new nested format', async () => {
    const room = makeRoom();
    mockOnce.mockResolvedValue({ val: () => ({ room }) });

    const result = await persistence.loadRoom(room.id);

    expect(result).not.toBeNull();
    expect(result!.room.id).toBe(room.id);
    expect(result!.room.name).toBe(room.name);
    expect(result!.engineState).toBeNull();
  });

  it('returns { room, engineState } when engine data is present', async () => {
    const room = makeRoom();
    // 棋瓦 P1 (2026-04-27): v1 inputs are migrated to v2 in-memory by
    // deserialiseEngineState. The on-disk record stays v1 until next save,
    // but the loaded snapshot reports version=2 with pending=undefined.
    const engine = { version: 1, roomId: room.id, roleAssignments: {}, questVotes: [], currentLeaderIndex: 0 };
    mockOnce.mockResolvedValue({ val: () => ({ room, engine }) });

    const result = await persistence.loadRoom(room.id);

    expect(result!.engineState).not.toBeNull();
    expect(result!.engineState!.version).toBe(2);
    expect(result!.engineState!.pending).toBeUndefined();
  });

  it('handles legacy flat Room format transparently', async () => {
    const room = makeRoom();
    // Legacy: data IS the room (no nested `room` key)
    mockOnce.mockResolvedValue({ val: () => ({ ...room }) });

    const result = await persistence.loadRoom(room.id);

    expect(result).not.toBeNull();
    expect(result!.room.id).toBe(room.id);
    expect(result!.engineState).toBeNull();
  });

  it('returns null when snapshot is empty', async () => {
    mockOnce.mockResolvedValue({ val: () => null });
    const result = await persistence.loadRoom('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when DB throws', async () => {
    mockOnce.mockRejectedValue(new Error('Network error'));
    const result = await persistence.loadRoom('room-x');
    expect(result).toBeNull();
  });

  it('applies defaults for missing optional Room fields', async () => {
    // Minimal room data — only required fields
    mockOnce.mockResolvedValue({
      val: () => ({ room: { id: 'r1', name: 'Min Room', host: 'h1' } }),
    });

    const result = await persistence.loadRoom('r1');

    expect(result).not.toBeNull();
    const r = result!.room;
    expect(r.state).toBe('lobby');
    expect(r.votes).toEqual({});
    expect(r.questTeam).toEqual([]);
    expect(r.questResults).toEqual([]);
    expect(r.failCount).toBe(0);
    expect(r.evilWins).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadAllRooms — returns Array<{ room, engineState }>
// ---------------------------------------------------------------------------

describe('GameStatePersistence — loadAllRooms', () => {
  let persistence: GameStatePersistence;

  beforeEach(() => {
    persistence = new GameStatePersistence();
    vi.clearAllMocks();
    mockDB.ref.mockReturnValue(mockRef);
  });

  it('returns all room entries when snapshot has data', async () => {
    const r1 = makeRoom({ id: 'r1' });
    const r2 = makeRoom({ id: 'r2' });
    mockOnce.mockResolvedValue({
      val: () => ({ r1: { room: r1 }, r2: { room: r2 } }),
    });

    const result = await persistence.loadAllRooms();

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.room.id).sort()).toEqual(['r1', 'r2']);
  });

  it('returns empty array when snapshot is null', async () => {
    mockOnce.mockResolvedValue({ val: () => null });
    const result = await persistence.loadAllRooms();
    expect(result).toEqual([]);
  });

  it('returns empty array when DB throws', async () => {
    mockOnce.mockRejectedValue(new Error('DB error'));
    const result = await persistence.loadAllRooms();
    expect(result).toEqual([]);
  });

  it('includes entries with engine state when available', async () => {
    const r1 = makeRoom({ id: 'r1' });
    const engine = { version: 1, roomId: 'r1', roleAssignments: {}, questVotes: [], currentLeaderIndex: 0 };
    mockOnce.mockResolvedValue({
      val: () => ({ r1: { room: r1, engine } }),
    });

    const result = await persistence.loadAllRooms();

    expect(result[0].engineState).not.toBeNull();
    // 棋瓦 P1 (2026-04-27): v1 input migrated to v2 on load.
    expect(result[0].engineState!.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// removeRoom
// ---------------------------------------------------------------------------

describe('GameStatePersistence — removeRoom', () => {
  let persistence: GameStatePersistence;

  beforeEach(() => {
    persistence = new GameStatePersistence();
    vi.clearAllMocks();
    mockDB.ref.mockReturnValue(mockRef);
  });

  it('calls ref.remove for the correct path', async () => {
    mockRemove.mockResolvedValue(undefined);

    await persistence.removeRoom('room-99');

    expect(mockDB.ref).toHaveBeenCalledWith('rooms/room-99');
    expect(mockRemove).toHaveBeenCalled();
  });

  it('does not throw when ref.remove rejects', async () => {
    mockRemove.mockRejectedValue(new Error('Remove failed'));
    await expect(persistence.removeRoom('room-99')).resolves.toBeUndefined();
  });
});
