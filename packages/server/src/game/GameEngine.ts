import { Room, Role, AVALON_CONFIG, Player } from '@avalon/shared';

export class GameEngine {
  private room: Room;
  private roleAssignments: Map<string, Role> = new Map();

  constructor(room: Room) {
    this.room = room;
  }

  public startGame(): void {
    const playerCount = Object.keys(this.room.players).length;

    if (playerCount < 5 || playerCount > 10) {
      throw new Error(`Invalid player count: ${playerCount}. Must be between 5-10`);
    }

    // Assign roles
    this.assignRoles(playerCount);

    // Set initial state
    this.room.state = 'voting';
    this.room.currentRound = 1;
  }

  private assignRoles(playerCount: number): void {
    const config = AVALON_CONFIG[playerCount];
    if (!config) {
      throw new Error(`No config for ${playerCount} players`);
    }

    const playerIds = Object.keys(this.room.players);
    const rolesShuffled = this.shuffleArray([...config.roles]);

    // Assign roles to players
    playerIds.forEach((playerId, index) => {
      const role = rolesShuffled[index];
      const player = this.room.players[playerId];

      player.role = role;
      player.team = this.getRoleTeam(role);

      this.roleAssignments.set(playerId, role);
    });
  }

  private getRoleTeam(role: Role): 'good' | 'evil' {
    const goodRoles: Role[] = ['merlin', 'percival', 'loyal'];
    return goodRoles.includes(role) ? 'good' : 'evil';
  }

  public submitVote(playerId: string, vote: boolean): void {
    if (this.room.state !== 'voting') {
      throw new Error('Not in voting phase');
    }

    this.room.votes[playerId] = vote;

    // Check if all players have voted
    const allVoted = Object.keys(this.room.players).every((id) => id in this.room.votes);

    if (allVoted) {
      this.resolveVoting();
    }
  }

  private resolveVoting(): void {
    const votes = Object.values(this.room.votes);
    const approvals = votes.filter((v) => v).length;
    const rejections = votes.filter((v) => !v).length;

    const approved = approvals > rejections;

    if (approved) {
      // Move to quest phase
      this.room.state = 'quest';
    } else {
      // Another voting round
      this.room.failCount++;
      this.room.votes = {};

      if (this.room.failCount >= this.room.maxRounds) {
        // Evil wins
        this.room.state = 'ended';
        this.room.evilWins = true;
      }
    }
  }

  public submitQuestResult(result: 'success' | 'fail'): void {
    if (this.room.state !== 'quest') {
      throw new Error('Not in quest phase');
    }

    this.room.questResults.push(result === 'success' ? 'success' : 'fail');
    this.room.currentRound++;

    // Check if game is over
    const goodWins = this.room.questResults.filter((r) => r === 'success').length >= 3;
    const evilWins = this.room.questResults.filter((r) => r === 'fail').length >= 3;

    if (goodWins) {
      this.room.state = 'discussion';
      // Assassin can kill now
    } else if (evilWins) {
      this.room.state = 'ended';
      this.room.evilWins = true;
    } else {
      // Next voting round
      this.room.state = 'voting';
      this.room.votes = {};
    }
  }

  public submitAssassination(targetId: string): void {
    if (this.room.state !== 'discussion') {
      throw new Error('Not in discussion phase');
    }

    const targetRole = this.room.players[targetId].role;

    if (targetRole === 'merlin') {
      // Evil wins
      this.room.evilWins = true;
    } else {
      // Good wins
      this.room.evilWins = false;
    }

    this.room.state = 'ended';
  }

  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  public getRoom(): Room {
    return this.room;
  }
}
