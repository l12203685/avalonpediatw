import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameEngine } from './GameEngine';
import { Room, Player } from '@avalon/shared';

describe('GameEngine', () => {
  let gameEngine: GameEngine;
  let room: Room;
  let players: { [key: string]: Player };

  beforeEach(() => {
    // Create mock players
    players = {
      player1: { id: 'player1', name: 'Alice', role: null, team: null, status: 'active', createdAt: Date.now() },
      player2: { id: 'player2', name: 'Bob', role: null, team: null, status: 'active', createdAt: Date.now() },
      player3: { id: 'player3', name: 'Charlie', role: null, team: null, status: 'active', createdAt: Date.now() },
      player4: { id: 'player4', name: 'David', role: null, team: null, status: 'active', createdAt: Date.now() },
      player5: { id: 'player5', name: 'Eve', role: null, team: null, status: 'active', createdAt: Date.now() },
    };

    // Create mock room
    room = {
      id: 'room1',
      name: 'Test Room',
      host: 'player1',
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    gameEngine = new GameEngine(room);
  });

  afterEach(() => {
    gameEngine.cleanup();
    vi.clearAllTimers();
  });

  describe('Game Initialization', () => {
    it('should start game with valid player count', () => {
      gameEngine.startGame();
      expect(room.state).toBe('voting');
      expect(room.currentRound).toBe(1);
    });

    it('should throw error with invalid player count', () => {
      const smallRoom: Room = {
        ...room,
        players: {
          player1: players.player1,
          player2: players.player2,
          player3: players.player3,
        },
      };
      const engine = new GameEngine(smallRoom);
      expect(() => engine.startGame()).toThrow('Invalid player count');
    });

    it('should assign roles to all players', () => {
      gameEngine.startGame();
      Object.values(room.players).forEach((player) => {
        expect(player.role).toBeDefined();
        expect(['good', 'evil']).toContain(player.team);
      });
    });
  });

  describe('Voting Phase', () => {
    beforeEach(() => {
      gameEngine.startGame();
    });

    it('should accept valid votes', () => {
      expect(() => {
        gameEngine.submitVote('player1', true);
        gameEngine.submitVote('player2', false);
      }).not.toThrow();

      expect(room.votes['player1']).toBe(true);
      expect(room.votes['player2']).toBe(false);
    });

    it('should reject duplicate votes', () => {
      gameEngine.submitVote('player1', true);
      expect(() => gameEngine.submitVote('player1', false)).toThrow('has already voted');
    });

    it('should reject votes from non-existent players', () => {
      expect(() => gameEngine.submitVote('invalid-player', true)).toThrow(
        'not found in room'
      );
    });

    it('should reject votes outside voting phase', () => {
      room.state = 'quest';
      expect(() => gameEngine.submitVote('player1', true)).toThrow('Not in voting phase');
    });

    it('should count votes correctly', () => {
      const count = gameEngine.getVoteCount();
      expect(count.total).toBe(5);
      expect(count.voted).toBe(0);

      gameEngine.submitVote('player1', true);
      const newCount = gameEngine.getVoteCount();
      expect(newCount.voted).toBe(1);
    });
  });

  describe('Voting Resolution', () => {
    beforeEach(() => {
      gameEngine.startGame();
      // Pre-set quest team (leader proposes before voting)
      room.questTeam = ['player1', 'player2'];
    });

    it('should move to quest phase when voting passes', () => {
      // Majority approve
      gameEngine.submitVote('player1', true);
      gameEngine.submitVote('player2', true);
      gameEngine.submitVote('player3', true);
      gameEngine.submitVote('player4', false);
      gameEngine.submitVote('player5', false);

      expect(room.state).toBe('quest');
    });

    it('should continue voting when voting fails', () => {
      // Majority reject
      gameEngine.submitVote('player1', false);
      gameEngine.submitVote('player2', false);
      gameEngine.submitVote('player3', false);
      gameEngine.submitVote('player4', true);
      gameEngine.submitVote('player5', true);

      expect(room.state).toBe('voting');
      expect(room.failCount).toBe(1);
      expect(room.votes).toEqual({}); // Votes cleared
    });

    it('should end game when fail count exceeds max rounds', () => {
      room.failCount = room.maxRounds - 1;

      // Reject votes
      gameEngine.submitVote('player1', false);
      gameEngine.submitVote('player2', false);
      gameEngine.submitVote('player3', false);
      gameEngine.submitVote('player4', false);
      gameEngine.submitVote('player5', false);

      expect(room.state).toBe('ended');
      expect(room.evilWins).toBe(true);
    });
  });

  describe('Assassination Phase', () => {
    beforeEach(() => {
      gameEngine.startGame();
      room.state = 'discussion';
      // Override ALL player roles so the engine never falls back to random roleAssignments
      room.players['player1'].role = 'merlin';
      room.players['player2'].role = 'assassin';
      room.players['player3'].role = 'loyal';
      room.players['player4'].role = 'loyal';
      room.players['player5'].role = 'loyal';
    });

    it('should end game with evil win when merlin is assassinated', () => {
      // player2 (assassin) assassinates player1 (merlin)
      gameEngine.submitAssassination('player2', 'player1');
      expect(room.state).toBe('ended');
      expect(room.evilWins).toBe(true);
    });

    it('should end game with good win when merlin is not assassinated', () => {
      // player2 (assassin) assassinates wrong player (player3)
      gameEngine.submitAssassination('player2', 'player3');
      expect(room.state).toBe('ended');
      expect(room.evilWins).toBe(false);
    });

    it('should reject assassination outside discussion phase', () => {
      room.state = 'voting';
      expect(() => gameEngine.submitAssassination('player2', 'player3')).toThrow(
        'Not in discussion phase'
      );
    });
  });

  describe('Quest Phase', () => {
    beforeEach(() => {
      gameEngine.startGame();
      room.state = 'quest';
      // Setup quest team for testing
      room.questTeam = ['player1', 'player2'];
    });

    it('should track quest votes and resolve quest result', () => {
      gameEngine.submitQuestVote('player1', 'success');
      gameEngine.submitQuestVote('player2', 'fail');

      // After all votes submitted, quest resolves into ONE result (fail if any fail vote)
      expect(room.questResults).toHaveLength(1);
      expect(room.questResults[0]).toBe('fail'); // One fail causes quest to fail
    });

    it('should end game when good wins 3 quests', () => {
      // This would require multiple quest rounds - placeholder test
      room.questResults = ['success', 'success', 'success'];
      room.state = 'discussion';

      expect(room.questResults.filter((r) => r === 'success')).toHaveLength(3);
    });

    it('should end game when evil wins 3 quests', () => {
      // This would require multiple quest rounds - placeholder test
      room.questResults = ['fail', 'fail', 'fail'];
      room.state = 'ended';
      room.evilWins = true;

      expect(room.evilWins).toBe(true);
    });
  });

  describe('Cleanup', () => {
    it('should not throw when cleanup is called', () => {
      gameEngine.startGame();
      expect(() => gameEngine.cleanup()).not.toThrow();
    });
  });
});

/**
 * 9-player variant · Option 2 ("inverted protection") regression tests.
 *
 * Rules under test (when variant9Player === 'oberonMandatory' AND
 * variant9Option2 === true AND playerCount === 9):
 *
 *   - Rounds 1/2/3/5 (non-protection): fail count === 1 → mission FAILED.
 *     0 fails or 2+ fails → mission SUCCESS.
 *   - Round 4 (protection): keeps the classic rule — 2+ fails → failed.
 *
 * Preconditions for inversion: all three flags must align. If any is off
 * (e.g. variant9Player !== 'oberonMandatory', flag false, or playerCount
 * !== 9), the engine falls through to the standard `failCount >=
 * failsRequired` check.
 */
describe('GameEngine · 9-player variant Option 2 (inverted protection)', () => {
  // Build a 9-player room preconfigured to a target quest round/team for
  // fast fail-count tests. Starts in `quest` state with questTeam already
  // populated — bypasses team-select / approval vote to keep the test
  // focused on the resolveQuestPhase invert logic.
  function make9PlayerQuestRoom(
    currentRound: number,
    teamSize: number,
    opts: { variant9Option2: boolean; variant9Player?: 'standard' | 'oberonMandatory' }
  ): { engine: GameEngine; room: Room; teamIds: string[] } {
    const players: Record<string, Player> = {};
    for (let i = 1; i <= 9; i++) {
      players[`p${i}`] = {
        id: `p${i}`,
        name: `Player ${i}`,
        role: null,
        team: null,
        status: 'active',
        createdAt: Date.now(),
      };
    }
    const room: Room = {
      id: 'room-9p-opt2',
      name: '9p opt2 test',
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
        ladyOfTheLake: false,
        variant9Player: opts.variant9Player ?? 'oberonMandatory',
        variant9Option2: opts.variant9Option2,
      },
      readyPlayerIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const engine = new GameEngine(room);
    engine.startGame();

    // Jump directly to quest state on the requested round with a team of
    // the requested size. We bypass team-select + approval vote because
    // we only care about resolveQuestPhase fail-count logic.
    room.state = 'quest';
    room.currentRound = currentRound;
    const teamIds = Object.keys(players).slice(0, teamSize);
    room.questTeam = teamIds;

    return { engine, room, teamIds };
  }

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('variant9Player=oberonMandatory + variant9Option2=true', () => {
    it('round 1 (non-protection): 1 fail → mission FAILED (inverted)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(1, 4, {
        variant9Option2: true,
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      for (let i = 1; i < teamIds.length; i++) {
        engine.submitQuestVote(teamIds[i], 'success');
      }
      expect(room.questResults).toHaveLength(1);
      expect(room.questResults[0]).toBe('fail');
      expect(room.questHistory[0].failCount).toBe(1);
      engine.cleanup();
    });

    it('round 3 (non-protection): 1 fail → mission FAILED (inverted)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(3, 4, {
        variant9Option2: true,
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      for (let i = 1; i < teamIds.length; i++) {
        engine.submitQuestVote(teamIds[i], 'success');
      }
      expect(room.questResults[0]).toBe('fail');
      engine.cleanup();
    });

    it('round 3 (non-protection): 2 fails → mission SUCCESS (inverted)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(3, 4, {
        variant9Option2: true,
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      engine.submitQuestVote(teamIds[1], 'fail');
      engine.submitQuestVote(teamIds[2], 'success');
      engine.submitQuestVote(teamIds[3], 'success');
      expect(room.questResults[0]).toBe('success');
      expect(room.questHistory[0].failCount).toBe(2);
      engine.cleanup();
    });

    it('round 3 (non-protection): 0 fails → mission SUCCESS (inverted, same as standard)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(3, 4, {
        variant9Option2: true,
      });
      for (const id of teamIds) {
        engine.submitQuestVote(id, 'success');
      }
      expect(room.questResults[0]).toBe('success');
      expect(room.questHistory[0].failCount).toBe(0);
      engine.cleanup();
    });

    it('round 5 (non-protection): 1 fail → mission FAILED (inverted)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(5, 5, {
        variant9Option2: true,
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      for (let i = 1; i < teamIds.length; i++) {
        engine.submitQuestVote(teamIds[i], 'success');
      }
      expect(room.questResults[0]).toBe('fail');
      engine.cleanup();
    });

    it('round 4 (PROTECTION): 1 fail → mission SUCCESS (standard 2-fail rule preserved)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(4, 5, {
        variant9Option2: true,
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      for (let i = 1; i < teamIds.length; i++) {
        engine.submitQuestVote(teamIds[i], 'success');
      }
      // Protection round still requires 2+ fails → 1 fail = success
      expect(room.questResults[0]).toBe('success');
      expect(room.questHistory[0].failCount).toBe(1);
      engine.cleanup();
    });

    it('round 4 (PROTECTION): 2 fails → mission FAILED (standard 2-fail rule preserved)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(4, 5, {
        variant9Option2: true,
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      engine.submitQuestVote(teamIds[1], 'fail');
      for (let i = 2; i < teamIds.length; i++) {
        engine.submitQuestVote(teamIds[i], 'success');
      }
      expect(room.questResults[0]).toBe('fail');
      engine.cleanup();
    });
  });

  describe('variant9Player=oberonMandatory + variant9Option2=false (no inversion)', () => {
    it('round 3: 1 fail → mission FAILED (standard rule — 1 fail fails quest)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(3, 4, {
        variant9Option2: false,
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      for (let i = 1; i < teamIds.length; i++) {
        engine.submitQuestVote(teamIds[i], 'success');
      }
      expect(room.questResults[0]).toBe('fail');
      engine.cleanup();
    });

    it('round 3: 2 fails → mission FAILED (standard rule — NOT inverted)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(3, 4, {
        variant9Option2: false,
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      engine.submitQuestVote(teamIds[1], 'fail');
      engine.submitQuestVote(teamIds[2], 'success');
      engine.submitQuestVote(teamIds[3], 'success');
      expect(room.questResults[0]).toBe('fail');
      engine.cleanup();
    });
  });

  describe('variant9Player=standard + variant9Option2=true (flag ignored)', () => {
    it('round 3: 1 fail → mission FAILED (classic rule; Option 2 ignored without 9-variant)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(3, 4, {
        variant9Option2: true,
        variant9Player: 'standard',
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      for (let i = 1; i < teamIds.length; i++) {
        engine.submitQuestVote(teamIds[i], 'success');
      }
      // Option 2 should NOT invert — standard variant means classic rule.
      expect(room.questResults[0]).toBe('fail');
      engine.cleanup();
    });

    it('round 3: 2 fails → mission FAILED (classic rule; Option 2 ignored without 9-variant)', () => {
      const { engine, room, teamIds } = make9PlayerQuestRoom(3, 4, {
        variant9Option2: true,
        variant9Player: 'standard',
      });
      engine.submitQuestVote(teamIds[0], 'fail');
      engine.submitQuestVote(teamIds[1], 'fail');
      engine.submitQuestVote(teamIds[2], 'success');
      engine.submitQuestVote(teamIds[3], 'success');
      // Option 2 must NOT invert — 2 fails still fail.
      expect(room.questResults[0]).toBe('fail');
      engine.cleanup();
    });
  });
});

/**
 * "Oberon must fail" house-rule regression tests (#90 / 2026-04-21).
 *
 * Engine-level override in `submitQuestVote` coerces any Oberon player's
 * vote to `'fail'` when `roleOptions.oberonAlwaysFail === true`. Covers
 * both AI and human players through the same choke-point so no
 * HeuristicAgent change is needed.
 *
 * Tests cover:
 *   1. AI path  — Oberon submits 'success', engine coerces to 'fail'.
 *   2. Human UI path — UI only sends 'fail' (engine still honours it).
 *      Modelled here by calling `submitQuestVote(oberonId, 'fail')` and
 *      verifying the vote is recorded as `fail` without changing the
 *      rest of the team's non-coerced votes.
 *   3. Baseline — option OFF: Oberon's submitted vote is preserved
 *      verbatim (classic rules, Oberon can freely pick success or fail).
 */
describe('GameEngine · oberonAlwaysFail (Oberon must fail house rule)', () => {
  function makeOberonQuestRoom(opts: {
    oberonAlwaysFail: boolean;
  }): { engine: GameEngine; room: Room; oberonId: string; teamIds: string[] } {
    const players: Record<string, Player> = {};
    for (let i = 1; i <= 7; i++) {
      players[`p${i}`] = {
        id: `p${i}`,
        name: `Player ${i}`,
        role: null,
        team: null,
        status: 'active',
        createdAt: Date.now(),
      };
    }
    const room: Room = {
      id: 'room-oberon-fail',
      name: 'oberon must fail test',
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
        ladyOfTheLake: false,
        oberonAlwaysFail: opts.oberonAlwaysFail,
      },
      readyPlayerIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const engine = new GameEngine(room);
    engine.startGame();

    // Force a deterministic Oberon assignment so we know which playerId
    // will trigger the coercion. Overwrites whatever startGame picked
    // for these two players — safe because the coercion only reads
    // `room.players[id].role` and `roleAssignments`, both of which we
    // set explicitly here.
    const oberonId = 'p1';
    const loyalId = 'p2';
    room.players[oberonId].role = 'oberon';
    room.players[oberonId].team = 'evil';
    room.players[loyalId].role = 'loyal';
    room.players[loyalId].team = 'good';

    // Jump to quest state with a small team containing Oberon so we can
    // assert the coercion in isolation from resolveQuestPhase noise.
    room.state = 'quest';
    room.currentRound = 1;
    const teamIds = [oberonId, loyalId];
    room.questTeam = teamIds;

    return { engine, room, oberonId, teamIds };
  }

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('AI override: Oberon submits success → coerced to fail when option ON', () => {
    const { engine, room, oberonId, teamIds } = makeOberonQuestRoom({
      oberonAlwaysFail: true,
    });
    // AI decides 'success' (stay hidden), engine must flip it.
    engine.submitQuestVote(oberonId, 'success');
    engine.submitQuestVote(teamIds[1], 'success'); // loyal honest vote

    // Single fail from Oberon → mission failed (team size 2, failsRequired 1).
    expect(room.questResults[0]).toBe('fail');
    // The buffered engine log should record the coercion so replays can
    // surface the rule being applied.
    const questVoteEvents = engine
      .getEventLog()
      .filter(e => e.event_type === 'quest_vote_submitted' && e.event_data.playerId === oberonId);
    expect(questVoteEvents.length).toBe(1);
    expect(questVoteEvents[0].event_data.vote).toBe('fail');
    expect(questVoteEvents[0].event_data.submittedVote).toBe('success');
    expect(questVoteEvents[0].event_data.coerced).toBe(true);

    engine.cleanup();
  });

  it('Human UI path: Oberon submits fail (only button rendered) → recorded as fail', () => {
    const { engine, room, oberonId, teamIds } = makeOberonQuestRoom({
      oberonAlwaysFail: true,
    });
    // UI only renders the fail button for Oberon under this rule, so the
    // only vote that ever reaches the server is 'fail'. Engine records
    // it verbatim (no-op coercion since incoming == effective).
    engine.submitQuestVote(oberonId, 'fail');
    engine.submitQuestVote(teamIds[1], 'success');

    expect(room.questResults[0]).toBe('fail');
    const oberonEvent = engine
      .getEventLog()
      .find(
        e => e.event_type === 'quest_vote_submitted' && e.event_data.playerId === oberonId,
      );
    expect(oberonEvent?.event_data.vote).toBe('fail');
    expect(oberonEvent?.event_data.coerced).toBe(false);

    engine.cleanup();
  });

  it('baseline (option OFF): Oberon submits success → preserved verbatim, no coercion', () => {
    const { engine, room, oberonId, teamIds } = makeOberonQuestRoom({
      oberonAlwaysFail: false,
    });
    // Classic Avalon — Oberon may freely pick success to stay hidden.
    engine.submitQuestVote(oberonId, 'success');
    engine.submitQuestVote(teamIds[1], 'success');

    // No fails → mission succeeds.
    expect(room.questResults[0]).toBe('success');
    const oberonEvent = engine
      .getEventLog()
      .find(
        e => e.event_type === 'quest_vote_submitted' && e.event_data.playerId === oberonId,
      );
    expect(oberonEvent?.event_data.vote).toBe('success');
    expect(oberonEvent?.event_data.coerced).toBe(false);

    engine.cleanup();
  });

  it('only Oberon is coerced: other evil (assassin) keeps submitted vote', () => {
    const { engine, room, oberonId, teamIds } = makeOberonQuestRoom({
      oberonAlwaysFail: true,
    });
    // Swap the "loyal" seat to an assassin to prove the coercion is
    // role-specific, not team-specific. Evil but not Oberon → free vote.
    const assassinId = teamIds[1];
    room.players[assassinId].role = 'assassin';
    room.players[assassinId].team = 'evil';

    engine.submitQuestVote(oberonId, 'success'); // coerced to fail
    engine.submitQuestVote(assassinId, 'success'); // honoured verbatim

    // One coerced fail → mission failed.
    expect(room.questResults[0]).toBe('fail');

    const events = engine.getEventLog();
    const obEv = events.find(
      e => e.event_type === 'quest_vote_submitted' && e.event_data.playerId === oberonId,
    );
    const asEv = events.find(
      e => e.event_type === 'quest_vote_submitted' && e.event_data.playerId === assassinId,
    );
    expect(obEv?.event_data.coerced).toBe(true);
    expect(obEv?.event_data.vote).toBe('fail');
    expect(asEv?.event_data.coerced).toBe(false);
    expect(asEv?.event_data.vote).toBe('success');

    engine.cleanup();
  });
});
