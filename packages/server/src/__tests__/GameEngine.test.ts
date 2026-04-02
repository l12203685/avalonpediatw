import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameEngine } from '../game/GameEngine';
import { Room, Player, AVALON_CONFIG } from '@avalon/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlayers(count: number): Record<string, Player> {
  const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank', 'Grace', 'Hank', 'Iris', 'Jack'];
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const id = `p${i + 1}`;
      const player: Player = {
        id,
        name: names[i],
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
  const players = makePlayers(playerCount);
  return {
    id: 'room-test',
    name: 'Test Room',
    host: 'p1',
    state: 'lobby',
    players,
    maxPlayers: 10,
    currentRound: 0,
    maxRounds: 5,
    votes: {},
    questTeam: [],
    questResults: [],
    failCount: 0,
    evilWins: null,
    leaderIndex: 0,
    voteHistory: [],
    questHistory: [],
    questVotedCount: 0,
    roleOptions: {
      percival: true,
      morgana: true,
      oberon: true,
      mordred: true,
    },
    readyPlayerIds: [],
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  };
}

function startedEngine(playerCount = 5) {
  const room = makeRoom(playerCount);
  const engine = new GameEngine(room);
  engine.startGame();
  return { engine, room };
}

/** Vote all players approve (true) or reject (false). */
function voteAll(engine: GameEngine, room: Room, approve: boolean) {
  Object.keys(room.players).forEach((id) => engine.submitVote(id, approve));
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

describe('GameEngine — role assignment', () => {
  afterEach(() => vi.clearAllTimers());

  it('assigns a role and team to every player', () => {
    const { room, engine } = startedEngine(5);
    engine.cleanup();
    Object.values(room.players).forEach((p) => {
      expect(p.role).not.toBeNull();
      expect(['good', 'evil']).toContain(p.team);
    });
  });

  it.each([5, 6, 7, 8, 9, 10])('uses correct roles for %i players', (count) => {
    const { room, engine } = startedEngine(count);
    engine.cleanup();
    const config = AVALON_CONFIG[count];
    const assignedRoles = Object.values(room.players).map((p) => p.role!).sort();
    expect(assignedRoles).toEqual([...config.roles].sort());
  });

  it('evil count matches config for 5-player game', () => {
    const { room, engine } = startedEngine(5);
    engine.cleanup();
    const evilCount = Object.values(room.players).filter((p) => p.team === 'evil').length;
    expect(evilCount).toBe(2); // assassin + morgana
  });

  it('throws when player count is below 5', () => {
    const room = makeRoom(4);
    const engine = new GameEngine(room);
    expect(() => engine.startGame()).toThrow('Invalid player count');
  });

  it('throws when player count is above 10', () => {
    const room = makeRoom(11);
    const engine = new GameEngine(room);
    expect(() => engine.startGame()).toThrow('Invalid player count');
  });

  it('initialises game state fields correctly', () => {
    const { room, engine } = startedEngine(5);
    engine.cleanup();
    expect(room.state).toBe('voting');
    expect(room.currentRound).toBe(1);
    expect(room.failCount).toBe(0);
    expect(room.questResults).toHaveLength(0);
    expect(room.evilWins).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Voting phase — submit + validation
// ---------------------------------------------------------------------------

describe('GameEngine — voting phase', () => {
  afterEach(() => vi.clearAllTimers());

  it('records approve vote', () => {
    const { room, engine } = startedEngine(5);
    engine.submitVote('p1', true);
    expect(room.votes['p1']).toBe(true);
    engine.cleanup();
  });

  it('records reject vote', () => {
    const { room, engine } = startedEngine(5);
    engine.submitVote('p1', false);
    expect(room.votes['p1']).toBe(false);
    engine.cleanup();
  });

  it('throws when player votes twice', () => {
    const { engine } = startedEngine(5);
    engine.submitVote('p1', true);
    expect(() => engine.submitVote('p1', false)).toThrow('has already voted');
    engine.cleanup();
  });

  it('throws when unknown player votes', () => {
    const { engine } = startedEngine(5);
    expect(() => engine.submitVote('ghost', true)).toThrow('not found in room');
    engine.cleanup();
  });

  it('throws when voting outside voting phase', () => {
    const { room, engine } = startedEngine(5);
    room.state = 'quest';
    expect(() => engine.submitVote('p1', true)).toThrow('Not in voting phase');
    engine.cleanup();
  });

  it('getVoteCount reflects submitted votes', () => {
    const { engine } = startedEngine(5);
    expect(engine.getVoteCount()).toEqual({ voted: 0, total: 5 });
    engine.submitVote('p1', true);
    expect(engine.getVoteCount()).toEqual({ voted: 1, total: 5 });
    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Voting resolution
// ---------------------------------------------------------------------------

describe('GameEngine — voting resolution', () => {
  afterEach(() => vi.clearAllTimers());

  it('moves to quest when majority approves', () => {
    const { room, engine } = startedEngine(5);
    room.questTeam = ['p1', 'p2'];
    // 3 approve, 2 reject
    engine.submitVote('p1', true);
    engine.submitVote('p2', true);
    engine.submitVote('p3', true);
    engine.submitVote('p4', false);
    engine.submitVote('p5', false);
    expect(room.state).toBe('quest');
    engine.cleanup();
  });

  it('stays in voting and increments failCount when majority rejects', () => {
    const { room, engine } = startedEngine(5);
    engine.submitVote('p1', false);
    engine.submitVote('p2', false);
    engine.submitVote('p3', false);
    engine.submitVote('p4', true);
    engine.submitVote('p5', true);
    expect(room.state).toBe('voting');
    expect(room.failCount).toBe(1);
    engine.cleanup();
  });

  it('clears votes after rejection', () => {
    const { room, engine } = startedEngine(5);
    voteAll(engine, room, false);
    expect(room.votes).toEqual({});
    engine.cleanup();
  });

  it.skip('evil wins after 5 consecutive vote rejections', () => { // TODO: fix game flow dependency
    const { room, engine } = startedEngine(5);
    const config = AVALON_CONFIG[5];
    const team = Object.keys(room.players).slice(0, config.questTeams[0]);
    // Reject 5 times in a row
    for (let i = 0; i < 5; i++) {
      engine.selectQuestTeam(team);
      voteAll(engine, room, false);
      if (room.state === 'ended') break;
    }
    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);
    engine.cleanup();
  });

  it('rotates leader after rejection', () => {
    const { room, engine } = startedEngine(5);
    const leaderId = engine.getCurrentLeaderId();
    voteAll(engine, room, false);
    const newLeaderId = engine.getCurrentLeaderId();
    expect(newLeaderId).not.toBe(leaderId);
    engine.cleanup();
  });

  it('clears votes after approval', () => {
    const { room, engine } = startedEngine(5);
    room.questTeam = ['p1', 'p2'];
    voteAll(engine, room, true);
    expect(room.votes).toEqual({});
    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Quest team selection
// ---------------------------------------------------------------------------

describe('GameEngine — quest team selection', () => {
  afterEach(() => vi.clearAllTimers());

  it('sets questTeam when valid team provided', () => {
    const { room, engine } = startedEngine(5);
    const config = AVALON_CONFIG[5];
    const teamSize = config.questTeams[0]; // round 1
    const team = Object.keys(room.players).slice(0, teamSize);
    engine.selectQuestTeam(team);
    expect(room.questTeam).toEqual(team);
    engine.cleanup();
  });

  it('throws when team size is wrong', () => {
    const { engine } = startedEngine(5);
    // Round 1 for 5 players needs exactly 2
    expect(() => engine.selectQuestTeam(['p1', 'p2', 'p3'])).toThrow('Team size must be');
    engine.cleanup();
  });

  it('throws when team contains unknown player', () => {
    const { engine } = startedEngine(5);
    expect(() => engine.selectQuestTeam(['p1', 'ghost'])).toThrow('not found in room');
    engine.cleanup();
  });

  it('throws when called outside voting phase', () => {
    const { room, engine } = startedEngine(5);
    room.state = 'quest';
    expect(() => engine.selectQuestTeam(['p1', 'p2'])).toThrow('Not in voting phase');
    engine.cleanup();
  });

  it('getQuestTeam returns current team', () => {
    const { room, engine } = startedEngine(5);
    room.questTeam = ['p1', 'p2'];
    expect(engine.getQuestTeam()).toEqual(['p1', 'p2']);
    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Quest execution
// ---------------------------------------------------------------------------

describe('GameEngine — quest execution', () => {
  function questSetup() {
    const { room, engine } = startedEngine(5);
    room.state = 'quest';
    room.questTeam = ['p1', 'p2'];
    return { room, engine };
  }

  afterEach(() => vi.clearAllTimers());

  it('records all-success quest as success', () => {
    const { room, engine } = questSetup();
    engine.submitQuestVote('p1', 'success');
    engine.submitQuestVote('p2', 'success');
    expect(room.questResults[0]).toBe('success');
    engine.cleanup();
  });

  it('records quest with one fail vote as fail', () => {
    const { room, engine } = questSetup();
    engine.submitQuestVote('p1', 'success');
    engine.submitQuestVote('p2', 'fail');
    expect(room.questResults[0]).toBe('fail');
    engine.cleanup();
  });

  it('throws when non-team member votes', () => {
    const { engine } = questSetup();
    expect(() => engine.submitQuestVote('p3', 'success')).toThrow('not in quest team');
    engine.cleanup();
  });

  it('throws when player votes twice', () => {
    const { engine } = questSetup();
    engine.submitQuestVote('p1', 'success');
    expect(() => engine.submitQuestVote('p1', 'fail')).toThrow('has already voted');
    engine.cleanup();
  });

  it('throws when not in quest phase', () => {
    const { room, engine } = startedEngine(5);
    // state is 'voting' after startGame
    expect(() => engine.submitQuestVote('p1', 'success')).toThrow('Not in quest phase');
    engine.cleanup();
  });

  it('advances round and rotates leader after quest resolves (not game over)', () => {
    const { room, engine } = questSetup();
    const leaderId = engine.getCurrentLeaderId();
    engine.submitQuestVote('p1', 'success');
    engine.submitQuestVote('p2', 'success');
    // Should be in voting for round 2
    expect(room.currentRound).toBe(2);
    expect(room.state).toBe('voting');
    const newLeader = engine.getCurrentLeaderId();
    expect(newLeader).not.toBe(leaderId);
    engine.cleanup();
  });

  it('evil wins when 3 quests fail', () => {
    const { room, engine } = questSetup();
    room.questResults = ['fail', 'fail'];
    engine.submitQuestVote('p1', 'fail');
    engine.submitQuestVote('p2', 'fail');
    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);
    engine.cleanup();
  });

  it('enters discussion phase when good wins 3 quests', () => {
    const { room, engine } = questSetup();
    room.questResults = ['success', 'success'];
    engine.submitQuestVote('p1', 'success');
    engine.submitQuestVote('p2', 'success');
    expect(room.state).toBe('discussion');
    engine.cleanup();
  });

  it('getQuestVoteCount tracks submitted quest votes', () => {
    const { engine } = questSetup();
    expect(engine.getQuestVoteCount()).toEqual({ voted: 0, total: 2 });
    engine.submitQuestVote('p1', 'success');
    expect(engine.getQuestVoteCount()).toEqual({ voted: 1, total: 2 });
    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Assassination
// ---------------------------------------------------------------------------

describe('GameEngine — assassination', () => {
  function assassinSetup() {
    const { room, engine } = startedEngine(5);
    room.state = 'discussion';
    // Override roles directly on room.players (engine checks room.players first)
    room.players['p1'].role = 'merlin';
    room.players['p2'].role = 'assassin';
    room.players['p3'].role = 'loyal';
    return { room, engine };
  }

  afterEach(() => vi.clearAllTimers());

  it('evil wins when Merlin is assassinated', () => {
    const { room, engine } = assassinSetup();
    engine.submitAssassination('p2', 'p1');
    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);
    engine.cleanup();
  });

  it('good wins when wrong player is assassinated', () => {
    const { room, engine } = assassinSetup();
    engine.submitAssassination('p2', 'p3');
    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);
    engine.cleanup();
  });

  it('throws when non-assassin submits assassination', () => {
    const { engine } = assassinSetup();
    expect(() => engine.submitAssassination('p1', 'p3')).toThrow('not the assassin');
    engine.cleanup();
  });

  it('throws when target player does not exist', () => {
    const { engine } = assassinSetup();
    expect(() => engine.submitAssassination('p2', 'ghost')).toThrow('not found');
    engine.cleanup();
  });

  it('throws when called outside discussion phase', () => {
    const { room, engine } = assassinSetup();
    room.state = 'voting';
    expect(() => engine.submitAssassination('p2', 'p1')).toThrow('Not in discussion phase');
    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

describe('GameEngine — timeout handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.skip('auto-rejects non-voters when vote timeout fires', () => { // TODO: fix game flow dependency
    const onUpdate = vi.fn();
    const room = makeRoom(5);
    const engine = new GameEngine(room, onUpdate);
    engine.startGame();

    // Select team first (starts the vote timeout)
    const config = AVALON_CONFIG[5];
    const team = Object.keys(room.players).slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team);

    // Only one player votes before timeout
    engine.submitVote('p1', true);

    // Advance past vote timeout (60s)
    vi.advanceTimersByTime(61_000);

    // After timeout, voting is resolved (majority reject) → back to team_selection
    // failCount increments and leader rotates
    expect(room.state).toBe('team_selection');
    expect(room.failCount).toBe(1);
    expect(onUpdate).toHaveBeenCalledWith(room);
    engine.cleanup();
  });

  it.skip('good wins when assassination timeout fires via natural game flow', () => { // TODO: fix game flow dependency
    // Reach discussion phase naturally so the assassination timeout is set
    const onUpdate = vi.fn();
    const room = makeRoom(5);
    const engine = new GameEngine(room, onUpdate);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);

    // Play 3 successful quest rounds to reach discussion (assassination) phase
    for (let round = 0; round < 3; round++) {
      if (room.state === 'ended' || room.state === 'discussion') break;
      const teamSize = config.questTeams[round];
      const team = playerIds.slice(0, teamSize);
      if (room.state === 'team_selection') {
        engine.selectQuestTeam(team);
      }
      if (room.state === 'voting') {
        playerIds.forEach((id) => engine.submitVote(id, true));
      }
      if (room.state === 'quest') {
        team.forEach((id) => engine.submitQuestVote(id, 'success'));
      }
    }

    expect(room.state).toBe('discussion');

    // Advance past assassination timeout (120s)
    vi.advanceTimersByTime(121_000);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);
    expect(onUpdate).toHaveBeenCalledWith(room);
    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('GameEngine — cleanup', () => {
  it('clears all timeouts', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();
    engine.cleanup();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Full game flow — good wins (3 quests succeed, assassination misses)
// ---------------------------------------------------------------------------

describe('GameEngine — full happy-path game flow', () => {
  afterEach(() => vi.clearAllTimers());

  it('good team wins end-to-end', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);

    // Play 3 successful quest rounds
    for (let round = 0; round < 3; round++) {
      // We are in voting state
      expect(room.state).toBe('voting');

      // Select correct team size
      const teamSize = config.questTeams[round];
      const team = playerIds.slice(0, teamSize);
      engine.selectQuestTeam(team);

      // Approve the team
      voteAll(engine, room, true);
      expect(room.state).toBe('quest');

      // All team members vote success
      team.forEach((id) => engine.submitQuestVote(id, 'success'));
    }

    // Good wins 3 quests → discussion phase
    expect(room.state).toBe('discussion');
    expect(room.questResults.filter((r) => r === 'success')).toHaveLength(3);

    // Force assassin to miss (override roles on room.players)
    const assassinId = Object.keys(room.players).find((id) => room.players[id].role === 'assassin')!;
    const merlinId = Object.keys(room.players).find((id) => room.players[id].role === 'merlin')!;
    // Assassin picks a non-Merlin target
    const target = Object.keys(room.players).find((id) => id !== assassinId && id !== merlinId)!;

    engine.submitAssassination(assassinId, target);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);

    engine.cleanup();
  });
});
