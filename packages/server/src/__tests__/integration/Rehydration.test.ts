import { describe, it, expect, afterEach, vi } from 'vitest';
import { GameEngine, GameEngineState } from '../../game/GameEngine';
import { Room, Player, AVALON_CONFIG, Role } from '@avalon/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAYER_NAMES = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];

function makePlayers(count: number): Record<string, Player> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const id = `p${i + 1}`;
      const player: Player = {
        id,
        name: PLAYER_NAMES[i],
        role: null,
        team: null,
        status: 'active',
        createdAt: Date.now(),
      };
      return [id, player];
    })
  );
}

function makeRoom(playerCount = 5): Room {
  return {
    id: 'room-rehydrate',
    name: 'Rehydration Test',
    host: 'p1',
    state: 'lobby',
    players: makePlayers(playerCount),
    maxPlayers: 10,
    currentRound: 0,
    maxRounds: 5,
    votes: {},
    questTeam: [],
    questResults: [],
    failCount: 0,
    evilWins: null,
    leaderIndex: 0,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  };
}

function voteAll(engine: GameEngine, room: Room, approve: boolean): void {
  Object.keys(room.players).forEach((id) => engine.submitVote(id, approve));
}

function findByRole(room: Room, role: Role): string {
  const entry = Object.entries(room.players).find(([_, p]) => p.role === role);
  if (!entry) throw new Error(`No player with role ${role}`);
  return entry[0];
}

// ---------------------------------------------------------------------------
// Serialization round-trip preserves state
// ---------------------------------------------------------------------------

describe('Integration: Rehydration — serialize/restore round-trip', () => {
  afterEach(() => vi.clearAllTimers());

  it('serialize immediately after startGame preserves role assignments', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const snapshot = engine.serialize();

    // Verify snapshot structure
    expect(snapshot.version).toBe(1);
    expect(snapshot.roomId).toBe('room-rehydrate');
    expect(Object.keys(snapshot.roleAssignments)).toHaveLength(5);
    expect(snapshot.questVotes).toEqual([]);
    expect(snapshot.currentLeaderIndex).toBe(0);

    // Restore into a new engine with the same room
    const restored = GameEngine.restore(snapshot, room);
    const restoredRoom = restored.getRoom();

    // Room reference should be the same object
    expect(restoredRoom).toBe(room);

    // Leader should match
    expect(restored.getCurrentLeaderId()).toBe(engine.getCurrentLeaderId());

    engine.cleanup();
    restored.cleanup();
  });

  it('serialize after one quest round preserves questVotes and leaderIndex', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Complete round 1
    const config = AVALON_CONFIG[5];
    const team = Object.keys(room.players).slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team);
    voteAll(engine, room, true);
    team.forEach((id) => engine.submitQuestVote(id, 'success'));

    // Now in round 2, voting phase
    expect(room.currentRound).toBe(2);
    expect(room.state).toBe('voting');

    const snapshot = engine.serialize();

    // Leader should have rotated
    expect(snapshot.currentLeaderIndex).toBe(1);

    // Restore
    const restored = GameEngine.restore(snapshot, room);
    expect(restored.getCurrentLeaderId()).toBe(engine.getCurrentLeaderId());

    engine.cleanup();
    restored.cleanup();
  });

  it('mid-voting state can be saved and restored, then game continues', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Submit 2 votes out of 5
    engine.submitVote('p1', true);
    engine.submitVote('p2', false);

    const snapshot = engine.serialize();

    // Restore engine (room still has partial votes)
    const restored = GameEngine.restore(snapshot, room);

    // Room state persists (room object is shared)
    expect(room.votes['p1']).toBe(true);
    expect(room.votes['p2']).toBe(false);
    expect(restored.getVoteCount()).toEqual({ voted: 2, total: 5 });

    // Continue voting with restored engine
    restored.submitVote('p3', true);
    restored.submitVote('p4', true);
    restored.submitVote('p5', false);

    // 3 approve vs 2 reject -> approved -> quest phase
    expect(room.state).toBe('quest');

    engine.cleanup();
    restored.cleanup();
  });

  it('players list survives rehydration', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const snapshot = engine.serialize();
    const originalPlayerIds = Object.keys(room.players).sort();
    const originalRoles = Object.values(room.players).map((p) => p.role).sort();

    const restored = GameEngine.restore(snapshot, room);
    const restoredRoom = restored.getRoom();

    expect(Object.keys(restoredRoom.players).sort()).toEqual(originalPlayerIds);
    expect(Object.values(restoredRoom.players).map((p) => p.role).sort()).toEqual(originalRoles);

    engine.cleanup();
    restored.cleanup();
  });

  it('quest results survive rehydration', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Play 2 rounds
    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);

    // Round 1: success
    const team1 = playerIds.slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team1);
    voteAll(engine, room, true);
    team1.forEach((id) => engine.submitQuestVote(id, 'success'));

    // Round 2: fail
    const team2 = playerIds.slice(0, config.questTeams[1]);
    engine.selectQuestTeam(team2);
    voteAll(engine, room, true);
    team2.forEach((id) => engine.submitQuestVote(id, 'fail'));

    expect(room.questResults).toEqual(['success', 'fail']);

    const snapshot = engine.serialize();
    const restored = GameEngine.restore(snapshot, room);
    const restoredRoom = restored.getRoom();

    expect(restoredRoom.questResults).toEqual(['success', 'fail']);
    expect(restoredRoom.currentRound).toBe(3);

    engine.cleanup();
    restored.cleanup();
  });

  it('votes map survives rehydration', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Partial votes
    engine.submitVote('p1', true);
    engine.submitVote('p2', true);

    const snapshot = engine.serialize();
    const restored = GameEngine.restore(snapshot, room);

    // Room.votes persists (shared room object)
    expect(restored.getRoom().votes).toEqual({ p1: true, p2: true });

    engine.cleanup();
    restored.cleanup();
  });

  it('roomId mismatch throws on restore', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const snapshot = engine.serialize();

    // Create a different room
    const otherRoom = makeRoom(5);
    otherRoom.id = 'room-other';

    expect(() => GameEngine.restore(snapshot, otherRoom)).toThrow('does not match room.id');

    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Deep state preservation: restored engine can complete a game
// ---------------------------------------------------------------------------

describe('Integration: Rehydration — restored engine completes a full game', () => {
  afterEach(() => vi.clearAllTimers());

  it('restore mid-game -> finish all quests -> assassination -> game ends', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);

    // Play round 1 with original engine
    const team1 = playerIds.slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team1);
    voteAll(engine, room, true);
    team1.forEach((id) => engine.submitQuestVote(id, 'success'));

    expect(room.currentRound).toBe(2);

    // Serialize and restore
    const snapshot = engine.serialize();
    engine.cleanup();
    const restored = GameEngine.restore(snapshot, room);

    // Play rounds 2 and 3 with restored engine
    for (let round = 1; round < 3; round++) {
      const teamSize = config.questTeams[round];
      const team = playerIds.slice(0, teamSize);
      restored.selectQuestTeam(team);
      voteAll(restored, room, true);
      team.forEach((id) => restored.submitQuestVote(id, 'success'));
    }

    expect(room.state).toBe('discussion');
    expect(room.questResults).toEqual(['success', 'success', 'success']);

    // Assassination
    const assassinId = findByRole(room, 'assassin');
    const merlinId = findByRole(room, 'merlin');
    restored.submitAssassination(assassinId, merlinId);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);

    restored.cleanup();
  });

  it('serialize/restore preserves roleAssignments for assassination logic', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const originalSnapshot = engine.serialize();
    const originalRoles = { ...originalSnapshot.roleAssignments };

    // Restore
    const restored = GameEngine.restore(originalSnapshot, room);
    const restoredSnapshot = restored.serialize();

    expect(restoredSnapshot.roleAssignments).toEqual(originalRoles);

    engine.cleanup();
    restored.cleanup();
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip (simulates Firebase persistence)
// ---------------------------------------------------------------------------

describe('Integration: Rehydration — JSON serialization (Firebase simulation)', () => {
  afterEach(() => vi.clearAllTimers());

  it('snapshot survives JSON.parse(JSON.stringify()) round-trip', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const snapshot = engine.serialize();
    const jsonStr = JSON.stringify(snapshot);
    const parsed = JSON.parse(jsonStr) as GameEngineState;

    expect(parsed.version).toBe(1);
    expect(parsed.roomId).toBe(snapshot.roomId);
    expect(parsed.roleAssignments).toEqual(snapshot.roleAssignments);
    expect(parsed.questVotes).toEqual(snapshot.questVotes);
    expect(parsed.currentLeaderIndex).toBe(snapshot.currentLeaderIndex);

    // Restore from parsed JSON
    const restored = GameEngine.restore(parsed, room);
    expect(restored.getCurrentLeaderId()).toBe(engine.getCurrentLeaderId());

    engine.cleanup();
    restored.cleanup();
  });

  it('room object survives JSON round-trip and can be used with restore', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Play a round
    const config = AVALON_CONFIG[5];
    const team = Object.keys(room.players).slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team);
    voteAll(engine, room, true);
    team.forEach((id) => engine.submitQuestVote(id, 'success'));

    const snapshot = engine.serialize();
    const roomJson = JSON.stringify(room);
    const snapshotJson = JSON.stringify(snapshot);

    const parsedRoom = JSON.parse(roomJson) as Room;
    const parsedSnapshot = JSON.parse(snapshotJson) as GameEngineState;

    // Fix: parsedRoom has a new id that matches
    const restored = GameEngine.restore(parsedSnapshot, parsedRoom);
    const restoredRoom = restored.getRoom();

    expect(restoredRoom.currentRound).toBe(2);
    expect(restoredRoom.questResults).toEqual(['success']);
    expect(Object.keys(restoredRoom.players)).toHaveLength(5);

    engine.cleanup();
    restored.cleanup();
  });
});
