import { describe, it, expect, afterEach, vi } from 'vitest';
import { GameEngine, GameEngineState } from '../../game/GameEngine';
import { Room, Player, AVALON_CONFIG, Role, PlayerStatus } from '@avalon/shared';

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
    id: 'room-reconnect',
    name: 'Reconnect Test',
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

/**
 * Simulate disconnect: set player status to 'disconnected'.
 * In the real system, GameServer.handleDisconnect does this.
 */
function simulateDisconnect(room: Room, playerId: string): void {
  room.players[playerId].status = 'disconnected';
}

/**
 * Simulate reconnect: set player status back to 'active'.
 * In the real system, GameServer.handleJoinRoom restores status.
 */
function simulateReconnect(room: Room, playerId: string): void {
  room.players[playerId].status = 'active';
}

// ---------------------------------------------------------------------------
// Disconnect does not lose game state
// ---------------------------------------------------------------------------

describe('Integration: Reconnect — disconnect preserves game state', () => {
  afterEach(() => vi.clearAllTimers());

  it('player disconnect does not alter room state or round', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    expect(room.state).toBe('voting');
    expect(room.currentRound).toBe(1);

    // Player 3 disconnects
    simulateDisconnect(room, 'p3');

    // Game state unchanged
    expect(room.state).toBe('voting');
    expect(room.currentRound).toBe(1);
    expect(Object.keys(room.players)).toHaveLength(5);
    expect(room.players['p3'].status).toBe('disconnected');

    // Roles still assigned
    expect(room.players['p3'].role).not.toBeNull();
    expect(room.players['p3'].team).not.toBeNull();

    engine.cleanup();
  });

  it('disconnected player role and team are preserved', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const p2Role = room.players['p2'].role;
    const p2Team = room.players['p2'].team;

    simulateDisconnect(room, 'p2');

    expect(room.players['p2'].role).toBe(p2Role);
    expect(room.players['p2'].team).toBe(p2Team);

    engine.cleanup();
  });

  it('quest results are preserved when a player disconnects mid-game', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Complete round 1
    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);
    const team = playerIds.slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team);
    voteAll(engine, room, true);
    team.forEach((id) => engine.submitQuestVote(id, 'success'));

    expect(room.questResults).toEqual(['success']);

    // Player disconnects
    simulateDisconnect(room, 'p4');

    // Quest results still intact
    expect(room.questResults).toEqual(['success']);
    expect(room.currentRound).toBe(2);

    engine.cleanup();
  });

  it('votes are preserved when a player disconnects after voting', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // p1 and p2 vote
    engine.submitVote('p1', true);
    engine.submitVote('p2', false);

    simulateDisconnect(room, 'p1');

    // Votes still recorded
    expect(room.votes['p1']).toBe(true);
    expect(room.votes['p2']).toBe(false);
    expect(engine.getVoteCount()).toEqual({ voted: 2, total: 5 });

    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Reconnect restores player view
// ---------------------------------------------------------------------------

describe('Integration: Reconnect — player reconnect restores view', () => {
  afterEach(() => vi.clearAllTimers());

  it('reconnected player sees current game state', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    simulateDisconnect(room, 'p3');
    expect(room.players['p3'].status).toBe('disconnected');

    // Game continues (other players vote)
    engine.submitVote('p1', true);
    engine.submitVote('p2', true);

    // Player reconnects
    simulateReconnect(room, 'p3');
    expect(room.players['p3'].status).toBe('active');

    // Reconnected player's view: room state is consistent
    const reconnectedView = engine.getRoom();
    expect(reconnectedView.state).toBe('voting');
    expect(reconnectedView.votes['p1']).toBe(true);
    expect(reconnectedView.votes['p2']).toBe(true);
    expect(reconnectedView.players['p3'].role).not.toBeNull();

    engine.cleanup();
  });

  it('reconnected player can continue voting', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    simulateDisconnect(room, 'p3');
    simulateReconnect(room, 'p3');

    // Player 3 can vote after reconnect
    engine.submitVote('p3', true);
    expect(room.votes['p3']).toBe(true);

    engine.cleanup();
  });

  it('reconnected player retains role assignment', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const originalRole = room.players['p4'].role;
    const originalTeam = room.players['p4'].team;

    simulateDisconnect(room, 'p4');
    simulateReconnect(room, 'p4');

    expect(room.players['p4'].role).toBe(originalRole);
    expect(room.players['p4'].team).toBe(originalTeam);

    engine.cleanup();
  });

  it('multiple disconnects/reconnects do not corrupt state', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Disconnect and reconnect multiple times
    for (let i = 0; i < 3; i++) {
      simulateDisconnect(room, 'p2');
      simulateReconnect(room, 'p2');
    }

    // State should be intact
    expect(room.state).toBe('voting');
    expect(room.currentRound).toBe(1);
    expect(room.players['p2'].status).toBe('active');
    expect(room.players['p2'].role).not.toBeNull();

    // Engine still works
    engine.submitVote('p2', true);
    expect(room.votes['p2']).toBe(true);

    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Game continues correctly after reconnect
// ---------------------------------------------------------------------------

describe('Integration: Reconnect — game continues after reconnect', () => {
  afterEach(() => vi.clearAllTimers());

  it('game completes normally after disconnect/reconnect during voting', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // p3 disconnects and reconnects during voting
    simulateDisconnect(room, 'p3');
    simulateReconnect(room, 'p3');

    // Complete 3 quest rounds
    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);

    for (let round = 0; round < 3; round++) {
      const teamSize = config.questTeams[round];
      const team = playerIds.slice(0, teamSize);
      engine.selectQuestTeam(team);
      voteAll(engine, room, true);
      team.forEach((id) => engine.submitQuestVote(id, 'success'));
    }

    expect(room.state).toBe('discussion');

    // Assassination
    // 2026-04-26 spec 32: target must be on good team (engine rejects evil
    // teammates).
    const assassinId = findByRole(room, 'assassin');
    const merlinId = findByRole(room, 'merlin');
    const wrongTarget = Object.keys(room.players).find(
      (id) => id !== assassinId && id !== merlinId && room.players[id].team === 'good',
    )!;
    engine.submitAssassination(assassinId, wrongTarget);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);

    engine.cleanup();
  });

  it('game completes after disconnect/reconnect during quest phase', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);
    const team = playerIds.slice(0, config.questTeams[0]);

    // Start quest
    engine.selectQuestTeam(team);
    voteAll(engine, room, true);
    expect(room.state).toBe('quest');

    // p1 (team member) disconnects mid-quest
    simulateDisconnect(room, team[0]);

    // p1 reconnects
    simulateReconnect(room, team[0]);

    // Quest votes can continue
    team.forEach((id) => engine.submitQuestVote(id, 'success'));

    expect(room.questResults).toEqual(['success']);
    expect(room.currentRound).toBe(2);

    engine.cleanup();
  });

  it('game completes after disconnect/reconnect during discussion phase', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);

    // Reach discussion phase
    for (let round = 0; round < 3; round++) {
      const teamSize = config.questTeams[round];
      const team = playerIds.slice(0, teamSize);
      engine.selectQuestTeam(team);
      voteAll(engine, room, true);
      team.forEach((id) => engine.submitQuestVote(id, 'success'));
    }

    expect(room.state).toBe('discussion');

    // Assassin disconnects and reconnects
    const assassinId = findByRole(room, 'assassin');
    simulateDisconnect(room, assassinId);
    simulateReconnect(room, assassinId);

    // Assassin can still assassinate
    const merlinId = findByRole(room, 'merlin');
    engine.submitAssassination(assassinId, merlinId);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);

    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Reconnect + Rehydration combined (server restart scenario)
// ---------------------------------------------------------------------------

describe('Integration: Reconnect — server restart with disconnected players', () => {
  afterEach(() => vi.clearAllTimers());

  it('serialize/restore preserves disconnected player status', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    simulateDisconnect(room, 'p3');

    const snapshot = engine.serialize();

    // Simulate server restart: restore engine
    const restored = GameEngine.restore(snapshot, room);
    const restoredRoom = restored.getRoom();

    expect(restoredRoom.players['p3'].status).toBe('disconnected');
    expect(restoredRoom.players['p3'].role).not.toBeNull();

    // Reconnect after restore
    simulateReconnect(restoredRoom, 'p3');
    expect(restoredRoom.players['p3'].status).toBe('active');

    // Game continues
    voteAll(restored, restoredRoom, true);
    // State should have transitioned (either to quest or remained voting depending on team)

    restored.cleanup();
    engine.cleanup();
  });

  it('full cycle: start -> disconnect -> serialize -> restore -> reconnect -> finish', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);

    // Play round 1
    const team1 = playerIds.slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team1);
    voteAll(engine, room, true);
    team1.forEach((id) => engine.submitQuestVote(id, 'success'));

    // p2 disconnects
    simulateDisconnect(room, 'p2');

    // Serialize (simulating server crash)
    const snapshot = engine.serialize();
    engine.cleanup();

    // Restore (simulating server restart)
    const restored = GameEngine.restore(snapshot, room);

    // p2 reconnects
    simulateReconnect(room, 'p2');

    // Play rounds 2 and 3
    for (let round = 1; round < 3; round++) {
      const teamSize = config.questTeams[round];
      const team = playerIds.slice(0, teamSize);
      restored.selectQuestTeam(team);
      voteAll(restored, room, true);
      team.forEach((id) => restored.submitQuestVote(id, 'success'));
    }

    expect(room.state).toBe('discussion');

    // Finish game
    const assassinId = findByRole(room, 'assassin');
    const loyalId = findByRole(room, 'loyal');
    restored.submitAssassination(assassinId, loyalId);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);

    restored.cleanup();
  });
});
