import { Room, Role, AVALON_CONFIG, Player } from '@avalon/shared';

const VOTE_TIMEOUT_MS = 30000; // 30秒投票時限

export class GameEngine {
  private room: Room;
  private roleAssignments: Map<string, Role> = new Map();
  private voteTimeout: NodeJS.Timeout | null = null;

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
    this.room.votes = {};

    // Start voting phase with timeout
    this.startVotingPhase();
  }

  private startVotingPhase(): void {
    // Clear existing timeout
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
    }

    // Set vote timeout
    this.voteTimeout = setTimeout(() => {
      if (this.room.state === 'voting') {
        this.handleVoteTimeout();
      }
    }, VOTE_TIMEOUT_MS);
  }

  private handleVoteTimeout(): void {
    const playerCount = Object.keys(this.room.players).length;
    const votedCount = Object.keys(this.room.votes).length;

    // Auto-vote for players who didn't vote (reject as default)
    const unvotedPlayers = Object.keys(this.room.players).filter(
      (id) => !(id in this.room.votes)
    );

    unvotedPlayers.forEach((playerId) => {
      this.room.votes[playerId] = false;
    });

    // Resolve voting
    this.resolveVoting();
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
    // Validate game state
    if (this.room.state !== 'voting') {
      throw new Error('Not in voting phase');
    }

    // Validate player exists
    if (!(playerId in this.room.players)) {
      throw new Error(`Player ${playerId} not found in room`);
    }

    // Validate player hasn't already voted
    if (playerId in this.room.votes) {
      throw new Error(`Player ${playerId} has already voted`);
    }

    // Record vote
    this.room.votes[playerId] = vote;

    // Check if all players have voted
    const playerCount = Object.keys(this.room.players).length;
    const votedCount = Object.keys(this.room.votes).length;

    if (votedCount === playerCount) {
      // Clear timeout and resolve voting
      if (this.voteTimeout) {
        clearTimeout(this.voteTimeout);
        this.voteTimeout = null;
      }
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
      if (this.voteTimeout) {
        clearTimeout(this.voteTimeout);
        this.voteTimeout = null;
      }
    } else {
      // Another voting round
      this.room.failCount++;
      this.room.votes = {};

      if (this.room.failCount >= this.room.maxRounds) {
        // Evil wins
        this.room.state = 'ended';
        this.room.evilWins = true;
        if (this.voteTimeout) {
          clearTimeout(this.voteTimeout);
          this.voteTimeout = null;
        }
      } else {
        // Start new voting round with timeout
        this.startVotingPhase();
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

  public cleanup(): void {
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }
  }

  public getVoteCount(): { voted: number; total: number } {
    return {
      voted: Object.keys(this.room.votes).length,
      total: Object.keys(this.room.players).length,
    };
  }
}
