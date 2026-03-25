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
      player1: { id: 'player1', name: 'Alice', role: undefined, team: undefined },
      player2: { id: 'player2', name: 'Bob', role: undefined, team: undefined },
      player3: { id: 'player3', name: 'Charlie', role: undefined, team: undefined },
      player4: { id: 'player4', name: 'David', role: undefined, team: undefined },
      player5: { id: 'player5', name: 'Eve', role: undefined, team: undefined },
    };

    // Create mock room
    room = {
      id: 'room1',
      hostId: 'player1',
      players,
      state: 'lobby',
      currentRound: 0,
      maxRounds: 5,
      votes: {},
      questTeam: [],
      questResults: [],
      failCount: 0,
      evilWins: false,
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
      const smallRoom = { ...room, players: { player1, player2, player3 } };
      const engine = new GameEngine(smallRoom);
      expect(() => engine.startGame()).toThrow('Invalid player count');
    });

    it('should assign roles to all players', () => {
      gameEngine.startGame();
      Object.values(room.players).forEach((player) => {
        expect(player.role).toBeDefined();
        expect(player.team).toBeOneOf(['good', 'evil']);
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
      // Set a merlin role for testing
      room.players['player1'].role = 'merlin';
      room.players['player2'].role = 'assassin';
    });

    it('should end game with evil win when merlin is assassinated', () => {
      gameEngine.submitAssassination('player1'); // Assassinate merlin
      expect(room.state).toBe('ended');
      expect(room.evilWins).toBe(true);
    });

    it('should end game with good win when merlin is not assassinated', () => {
      gameEngine.submitAssassination('player3'); // Assassinate wrong player
      expect(room.state).toBe('ended');
      expect(room.evilWins).toBe(false);
    });

    it('should reject assassination outside discussion phase', () => {
      room.state = 'voting';
      expect(() => gameEngine.submitAssassination('player3')).toThrow(
        'Not in discussion phase'
      );
    });
  });

  describe('Quest Phase', () => {
    beforeEach(() => {
      gameEngine.startGame();
      room.state = 'quest';
    });

    it('should track quest results', () => {
      gameEngine.submitQuestResult('success');
      gameEngine.submitQuestResult('fail');

      expect(room.questResults).toHaveLength(2);
      expect(room.questResults[0]).toBe('success');
      expect(room.questResults[1]).toBe('fail');
    });

    it('should end game when good wins 3 quests', () => {
      gameEngine.submitQuestResult('success');
      gameEngine.submitQuestResult('success');
      gameEngine.submitQuestResult('success');

      expect(room.state).toBe('discussion');
      expect(room.questResults.filter((r) => r === 'success')).toHaveLength(3);
    });

    it('should end game when evil wins 3 quests', () => {
      gameEngine.submitQuestResult('fail');
      gameEngine.submitQuestResult('fail');
      gameEngine.submitQuestResult('fail');

      expect(room.state).toBe('ended');
      expect(room.evilWins).toBe(true);
    });
  });

  describe('Cleanup', () => {
    it('should clear vote timeout on cleanup', () => {
      const timeoutSpy = vi.spyOn(global, 'clearTimeout');
      gameEngine.startGame();
      gameEngine.cleanup();
      expect(timeoutSpy).toHaveBeenCalled();
      timeoutSpy.mockRestore();
    });
  });
});
