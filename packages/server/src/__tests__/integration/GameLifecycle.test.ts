import { describe, it, expect, afterEach, vi } from 'vitest';
import { GameEngine } from '../../game/GameEngine';
import { Room, Player, AVALON_CONFIG, Role } from '@avalon/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAYER_NAMES = ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank', 'Grace', 'Hank', 'Iris', 'Jack'];

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
    id: 'room-lifecycle',
    name: 'Lifecycle Test',
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

/** Find the player ID with a given role after startGame. */
function findByRole(room: Room, role: Role): string {
  const entry = Object.entries(room.players).find(([_, p]) => p.role === role);
  if (!entry) throw new Error(`No player with role ${role}`);
  return entry[0];
}

/** Run one full quest round: select team, vote approve, all quest votes succeed/fail. */
function playQuestRound(
  engine: GameEngine,
  room: Room,
  roundIndex: number,
  questVote: 'success' | 'fail' = 'success'
): void {
  const config = AVALON_CONFIG[Object.keys(room.players).length];
  const teamSize = config.questTeams[roundIndex];
  const playerIds = Object.keys(room.players);
  const team = playerIds.slice(0, teamSize);

  engine.selectQuestTeam(team);
  voteAll(engine, room, true);
  team.forEach((id) => engine.submitQuestVote(id, questVote));
}

// ---------------------------------------------------------------------------
// Full 5-player game lifecycle
// ---------------------------------------------------------------------------

describe('Integration: Full 5-player game lifecycle', () => {
  afterEach(() => vi.clearAllTimers());

  it('create room -> assign roles -> voting -> quest -> discussion -> good wins (assassination miss)', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);

    // Start game
    engine.startGame();
    expect(room.state).toBe('voting');
    expect(room.currentRound).toBe(1);

    // Verify all 5 roles assigned
    const roles = Object.values(room.players).map((p) => p.role!).sort();
    expect(roles).toEqual([...AVALON_CONFIG[5].roles].sort());

    // Verify team assignments
    const goodCount = Object.values(room.players).filter((p) => p.team === 'good').length;
    const evilCount = Object.values(room.players).filter((p) => p.team === 'evil').length;
    expect(goodCount).toBe(3);
    expect(evilCount).toBe(2);

    // Play 3 successful quest rounds
    for (let round = 0; round < 3; round++) {
      expect(room.state).toBe('voting');
      playQuestRound(engine, room, round, 'success');
    }

    // Should be in discussion phase
    expect(room.state).toBe('discussion');
    expect(room.questResults.filter((r) => r === 'success')).toHaveLength(3);

    // Assassin picks wrong target -> good wins
    const assassinId = findByRole(room, 'assassin');
    const merlinId = findByRole(room, 'merlin');
    const wrongTarget = Object.keys(room.players).find(
      (id) => id !== assassinId && id !== merlinId
    )!;

    engine.submitAssassination(assassinId, wrongTarget);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);

    engine.cleanup();
  });

  it('create room -> 3 failed quests -> evil wins', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Play 3 failed quest rounds (evil team member votes fail)
    for (let round = 0; round < 3; round++) {
      expect(room.state).toBe('voting');
      playQuestRound(engine, room, round, 'fail');
    }

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);

    engine.cleanup();
  });

  it('create room -> good wins 3 quests -> assassin kills Merlin -> evil wins', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Play 3 successful quest rounds
    for (let round = 0; round < 3; round++) {
      playQuestRound(engine, room, round, 'success');
    }

    expect(room.state).toBe('discussion');

    // Assassin correctly identifies Merlin
    const assassinId = findByRole(room, 'assassin');
    const merlinId = findByRole(room, 'merlin');

    engine.submitAssassination(assassinId, merlinId);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);

    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Role assignments for all player counts
// ---------------------------------------------------------------------------

describe('Integration: Role assignments work for all player counts', () => {
  afterEach(() => vi.clearAllTimers());

  it.each([5, 6, 7, 8, 9, 10])('%i-player game assigns correct roles', (count) => {
    const room = makeRoom(count);
    const engine = new GameEngine(room);
    engine.startGame();

    const config = AVALON_CONFIG[count];
    const assignedRoles = Object.values(room.players).map((p) => p.role!).sort();
    expect(assignedRoles).toEqual([...config.roles].sort());

    // Verify Merlin and Assassin always present
    expect(assignedRoles).toContain('merlin');
    expect(assignedRoles).toContain('assassin');

    // Verify every player has a team
    Object.values(room.players).forEach((p) => {
      expect(p.team).not.toBeNull();
      expect(['good', 'evil']).toContain(p.team);
    });

    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Vote approval/rejection flows
// ---------------------------------------------------------------------------

describe('Integration: Vote approval and rejection flows', () => {
  afterEach(() => vi.clearAllTimers());

  it('approved vote transitions to quest phase', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const teamSize = config.questTeams[0];
    const team = Object.keys(room.players).slice(0, teamSize);
    engine.selectQuestTeam(team);

    voteAll(engine, room, true);

    expect(room.state).toBe('quest');
    expect(room.votes).toEqual({});

    engine.cleanup();
  });

  it('rejected vote increments failCount and rotates leader', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const initialLeader = engine.getCurrentLeaderId();
    voteAll(engine, room, false);

    expect(room.state).toBe('voting');
    expect(room.failCount).toBe(1);
    expect(engine.getCurrentLeaderId()).not.toBe(initialLeader);

    engine.cleanup();
  });

  it('3 consecutive rejections ends game with evil win', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Reject 3 times
    voteAll(engine, room, false); // failCount = 1
    voteAll(engine, room, false); // failCount = 2
    voteAll(engine, room, false); // failCount = 3

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);
    expect(room.failCount).toBe(3);

    engine.cleanup();
  });

  it('mixed votes: majority reject fails, majority approve passes', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // First vote: 2 approve, 3 reject -> rejected
    engine.submitVote('p1', true);
    engine.submitVote('p2', true);
    engine.submitVote('p3', false);
    engine.submitVote('p4', false);
    engine.submitVote('p5', false);

    expect(room.state).toBe('voting');
    expect(room.failCount).toBe(1);

    // Second vote: 3 approve, 2 reject -> approved
    const config = AVALON_CONFIG[5];
    const team = Object.keys(room.players).slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team);

    engine.submitVote('p1', true);
    engine.submitVote('p2', true);
    engine.submitVote('p3', true);
    engine.submitVote('p4', false);
    engine.submitVote('p5', false);

    expect(room.state).toBe('quest');

    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Quest success/failure
// ---------------------------------------------------------------------------

describe('Integration: Quest success and failure', () => {
  afterEach(() => vi.clearAllTimers());

  it('all success votes -> quest succeeds, next round starts', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    playQuestRound(engine, room, 0, 'success');

    expect(room.questResults).toEqual(['success']);
    expect(room.currentRound).toBe(2);
    expect(room.state).toBe('voting');

    engine.cleanup();
  });

  it('one fail vote -> quest fails', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const teamSize = config.questTeams[0];
    const playerIds = Object.keys(room.players);
    const team = playerIds.slice(0, teamSize);

    engine.selectQuestTeam(team);
    voteAll(engine, room, true);

    // Mixed quest votes: one success, one fail
    engine.submitQuestVote(team[0], 'success');
    engine.submitQuestVote(team[1], 'fail');

    expect(room.questResults).toEqual(['fail']);
    expect(room.currentRound).toBe(2);

    engine.cleanup();
  });

  it('quest results accumulate across rounds', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Round 1: success
    playQuestRound(engine, room, 0, 'success');
    expect(room.questResults).toEqual(['success']);

    // Round 2: fail
    playQuestRound(engine, room, 1, 'fail');
    expect(room.questResults).toEqual(['success', 'fail']);

    engine.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Assassination phase
// ---------------------------------------------------------------------------

describe('Integration: Assassination phase', () => {
  afterEach(() => vi.clearAllTimers());

  function reachDiscussion(): { room: Room; engine: GameEngine } {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    for (let round = 0; round < 3; round++) {
      playQuestRound(engine, room, round, 'success');
    }

    expect(room.state).toBe('discussion');
    return { room, engine };
  }

  it('assassin kills Merlin -> evil wins', () => {
    const { room, engine } = reachDiscussion();
    const assassinId = findByRole(room, 'assassin');
    const merlinId = findByRole(room, 'merlin');

    engine.submitAssassination(assassinId, merlinId);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(true);
    engine.cleanup();
  });

  it('assassin kills Percival -> good wins', () => {
    const { room, engine } = reachDiscussion();
    const assassinId = findByRole(room, 'assassin');
    const percivalId = findByRole(room, 'percival');

    engine.submitAssassination(assassinId, percivalId);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);
    engine.cleanup();
  });

  it('assassin kills Loyal servant -> good wins', () => {
    const { room, engine } = reachDiscussion();
    const assassinId = findByRole(room, 'assassin');
    const loyalId = findByRole(room, 'loyal');

    engine.submitAssassination(assassinId, loyalId);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);
    engine.cleanup();
  });

  it('non-assassin cannot submit assassination', () => {
    const { room, engine } = reachDiscussion();
    const merlinId = findByRole(room, 'merlin');
    const loyalId = findByRole(room, 'loyal');

    expect(() => engine.submitAssassination(merlinId, loyalId)).toThrow('not the assassin');
    engine.cleanup();
  });

  it('assassination timeout -> good wins (via onUpdate callback)', () => {
    vi.useFakeTimers();

    const onUpdate = vi.fn();
    const room = makeRoom(5);
    const engine = new GameEngine(room, onUpdate);
    engine.startGame();

    const config = AVALON_CONFIG[5];
    const playerIds = Object.keys(room.players);

    for (let round = 0; round < 3; round++) {
      if (room.state !== 'voting') break;
      const teamSize = config.questTeams[round];
      const team = playerIds.slice(0, teamSize);
      engine.selectQuestTeam(team);
      playerIds.forEach((id) => engine.submitVote(id, true));
      if (room.state === 'quest') {
        team.forEach((id) => engine.submitQuestVote(id, 'success'));
      }
    }

    expect(room.state).toBe('discussion');

    // Advance past assassination timeout (30s)
    vi.advanceTimersByTime(31_000);

    expect(room.state).toBe('ended');
    expect(room.evilWins).toBe(false);
    expect(onUpdate).toHaveBeenCalled();

    engine.cleanup();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Multi-round game with mixed results
// ---------------------------------------------------------------------------

describe('Integration: Multi-round game with rejection + quest interleaving', () => {
  afterEach(() => vi.clearAllTimers());

  it('vote rejection then approval then quest completes correctly', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    // Round 1: reject first, then approve
    voteAll(engine, room, false);
    expect(room.failCount).toBe(1);
    expect(room.state).toBe('voting');

    const config = AVALON_CONFIG[5];
    const team = Object.keys(room.players).slice(0, config.questTeams[0]);
    engine.selectQuestTeam(team);
    voteAll(engine, room, true);

    expect(room.state).toBe('quest');

    // Complete quest
    team.forEach((id) => engine.submitQuestVote(id, 'success'));
    expect(room.questResults).toEqual(['success']);
    expect(room.currentRound).toBe(2);

    // failCount should still be 1 (only resets to 0 on new game, not new round)
    expect(room.failCount).toBe(1);

    engine.cleanup();
  });

  it('leader rotates correctly across multiple rejections', () => {
    const room = makeRoom(5);
    const engine = new GameEngine(room);
    engine.startGame();

    const playerIds = Object.keys(room.players);
    const leaders: string[] = [];

    leaders.push(engine.getCurrentLeaderId());
    voteAll(engine, room, false);
    leaders.push(engine.getCurrentLeaderId());
    voteAll(engine, room, false);
    leaders.push(engine.getCurrentLeaderId());

    // All leaders should be different (rotating through player list)
    expect(new Set(leaders).size).toBe(3);

    engine.cleanup();
  });
});
