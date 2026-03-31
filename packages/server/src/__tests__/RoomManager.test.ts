import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomManager } from '../game/RoomManager';
import type { Room } from '@avalon/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoom(id: string, state: Room['state'] = 'lobby'): Room {
  return {
    id,
    name: `Room ${id}`,
    host: 'p1',
    state,
    players: {
      p1: { id: 'p1', name: 'Alice', role: null, team: null, status: 'active', createdAt: Date.now() },
    },
    maxPlayers: 10,
    currentRound: 0,
    maxRounds: 5,
    votes: {},
    questTeam: [],
    questResults: [],
    failCount: 0,
    evilWins: null,
    leaderIndex: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomManager — createRoom', () => {
  let rm: RoomManager;

  beforeEach(() => { rm = new RoomManager(); });
  afterEach(() => rm.destroy());

  it('creates a room and stores it', () => {
    const room = rm.createRoom('r1', 'Alice', 'p1');
    expect(room.id).toBe('r1');
    expect(room.host).toBe('p1');
    expect(room.state).toBe('lobby');
  });

  it('includes the host as a player', () => {
    const room = rm.createRoom('r1', 'Alice', 'p1');
    expect(room.players['p1']).toBeDefined();
    expect(room.players['p1'].name).toBe('Alice');
  });

  it('room is retrievable after creation', () => {
    rm.createRoom('r1', 'Alice', 'p1');
    expect(rm.getRoom('r1')).toBeDefined();
  });

  it('getRoomCount reflects created rooms', () => {
    expect(rm.getRoomCount()).toBe(0);
    rm.createRoom('r1', 'Alice', 'p1');
    expect(rm.getRoomCount()).toBe(1);
  });
});

describe('RoomManager — getRoom / getAllRooms', () => {
  let rm: RoomManager;

  beforeEach(() => { rm = new RoomManager(); });
  afterEach(() => rm.destroy());

  it('returns undefined for unknown roomId', () => {
    expect(rm.getRoom('nonexistent')).toBeUndefined();
  });

  it('getAllRooms returns all stored rooms', () => {
    rm.createRoom('r1', 'Alice', 'p1');
    rm.createRoom('r2', 'Bob', 'p2');
    expect(rm.getAllRooms()).toHaveLength(2);
  });
});

describe('RoomManager — updateRoom', () => {
  let rm: RoomManager;

  beforeEach(() => { rm = new RoomManager(); });
  afterEach(() => rm.destroy());

  it('updates fields and preserves id', () => {
    rm.createRoom('r1', 'Alice', 'p1');
    const updated = rm.updateRoom('r1', { state: 'voting', currentRound: 1 });
    expect(updated).toBeDefined();
    expect(updated!.id).toBe('r1');
    expect(updated!.state).toBe('voting');
    expect(updated!.currentRound).toBe(1);
  });

  it('returns undefined for unknown roomId', () => {
    const result = rm.updateRoom('ghost', { state: 'voting' });
    expect(result).toBeUndefined();
  });

  it('prevents id from being overwritten', () => {
    rm.createRoom('r1', 'Alice', 'p1');
    const updated = rm.updateRoom('r1', { id: 'hacked', state: 'voting' } as unknown as Partial<Room>);
    expect(updated!.id).toBe('r1');
  });
});

describe('RoomManager — deleteRoom', () => {
  let rm: RoomManager;

  beforeEach(() => { rm = new RoomManager(); });
  afterEach(() => rm.destroy());

  it('removes the room', () => {
    rm.createRoom('r1', 'Alice', 'p1');
    rm.deleteRoom('r1');
    expect(rm.getRoom('r1')).toBeUndefined();
  });

  it('no-ops on unknown roomId', () => {
    expect(() => rm.deleteRoom('ghost')).not.toThrow();
  });
});

describe('RoomManager — saveReplay / getReplay', () => {
  let rm: RoomManager;

  beforeEach(() => { rm = new RoomManager(); });
  afterEach(() => rm.destroy());

  it('saves and retrieves a replay', () => {
    const room = makeRoom('r1', 'ended');
    rm.saveReplay(room);
    const replay = rm.getReplay('r1');
    expect(replay).toBeDefined();
    expect(replay!.id).toBe('r1');
  });

  it('returns undefined for unknown replay', () => {
    expect(rm.getReplay('ghost')).toBeUndefined();
  });

  it('replay is a copy, not the original reference', () => {
    const room = makeRoom('r1', 'ended');
    rm.saveReplay(room);
    const replay = rm.getReplay('r1')!;
    room.name = 'modified';
    expect(replay.name).toBe('Room r1'); // unchanged
  });

  it('evicts oldest replay when capacity (200) is exceeded', () => {
    // Fill up to 200 replays
    for (let i = 0; i < 200; i++) {
      rm.saveReplay(makeRoom(`r${i}`, 'ended'));
    }
    // This should evict r0
    rm.saveReplay(makeRoom('r200', 'ended'));
    expect(rm.getReplay('r0')).toBeUndefined();
    expect(rm.getReplay('r200')).toBeDefined();
  });
});

describe('RoomManager — rehydrate', () => {
  let rm: RoomManager;

  beforeEach(() => { rm = new RoomManager(); });
  afterEach(() => rm.destroy());

  it('loads non-ended rooms and returns count', () => {
    const rooms = [makeRoom('r1', 'voting'), makeRoom('r2', 'lobby'), makeRoom('r3', 'ended')];
    const count = rm.rehydrate(rooms);
    expect(count).toBe(2); // r3 (ended) is skipped
    expect(rm.getRoom('r1')).toBeDefined();
    expect(rm.getRoom('r3')).toBeUndefined();
  });
});

describe('RoomManager — cleanup timer (expired rooms)', () => {
  afterEach(() => vi.useRealTimers());

  it('removes ended rooms older than 30 minutes', () => {
    vi.useFakeTimers();
    const rm = new RoomManager();

    const oldEnded = makeRoom('old-ended', 'ended');
    oldEnded.updatedAt = Date.now() - 31 * 60 * 1000;
    (rm as unknown as { rooms: Map<string, Room> }).rooms.set('old-ended', oldEnded);

    const freshEnded = makeRoom('fresh-ended', 'ended');
    (rm as unknown as { rooms: Map<string, Room> }).rooms.set('fresh-ended', freshEnded);

    // Advance 5 minutes to trigger cleanup interval
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(rm.getRoom('old-ended')).toBeUndefined();
    expect(rm.getRoom('fresh-ended')).toBeDefined();

    rm.destroy();
  });

  it('removes old lobby rooms where all players are disconnected', () => {
    vi.useFakeTimers();
    const rm = new RoomManager();

    const oldLobby = makeRoom('old-lobby', 'lobby');
    oldLobby.createdAt = Date.now() - 61 * 60 * 1000; // > 60 min
    oldLobby.players['p1'].status = 'disconnected';
    (rm as unknown as { rooms: Map<string, Room> }).rooms.set('old-lobby', oldLobby);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(rm.getRoom('old-lobby')).toBeUndefined();

    rm.destroy();
  });

  it('does not remove old lobby with at least one active player', () => {
    vi.useFakeTimers();
    const rm = new RoomManager();

    const oldLobbyActive = makeRoom('old-active', 'lobby');
    oldLobbyActive.createdAt = Date.now() - 61 * 60 * 1000;
    // p1 remains 'active' (not disconnected)
    (rm as unknown as { rooms: Map<string, Room> }).rooms.set('old-active', oldLobbyActive);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(rm.getRoom('old-active')).toBeDefined();

    rm.destroy();
  });
});

describe('RoomManager — destroy', () => {
  it('clears all rooms and stops cleanup interval', () => {
    const rm = new RoomManager();
    rm.createRoom('r1', 'Alice', 'p1');
    rm.destroy();
    expect(rm.getRoomCount()).toBe(0);
  });
});
