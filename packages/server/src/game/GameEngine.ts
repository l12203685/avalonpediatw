import { Room, Role, AVALON_CONFIG, Player, GameState } from '@avalon/shared';

const VOTE_TIMEOUT_MS = 30000; // 30秒投票時限
const QUEST_TIMEOUT_MS = 30000; // 30秒任務投票時限
const ASSASSINATION_TIMEOUT_MS = 30000; // 30秒刺殺時限

interface QuestVote {
  playerId: string;
  vote: 'success' | 'fail';
}

export class GameEngine {
  private room: Room;
  private roleAssignments: Map<string, Role> = new Map();
  private voteTimeout: NodeJS.Timeout | null = null;
  private questVoteTimeout: NodeJS.Timeout | null = null;
  private assassinationTimeout: NodeJS.Timeout | null = null;

  // Quest phase tracking
  private questVotes: QuestVote[] = [];
  private currentLeaderIndex: number = 0;

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

    // Initialize game state
    this.room.state = 'voting';
    this.room.currentRound = 1;
    this.room.votes = {};
    this.room.questTeam = [];
    this.room.questResults = [];
    this.room.failCount = 0;
    this.room.evilWins = null;
    this.room.leaderIndex = 0;
    this.questVotes = [];
    this.currentLeaderIndex = 0;

    this.logEvent('game_started', {
      playerCount,
      roles: Array.from(this.roleAssignments.values())
    });

    // Start voting phase with timeout
    this.startVotingPhase();
  }

  private startVotingPhase(): void {
    // Clear existing timeout
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }

    // Log voting phase start
    this.logEvent('voting_phase_started', {
      round: this.room.currentRound,
      failCount: this.room.failCount,
      playerCount: Object.keys(this.room.players).length
    });

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

    // Clear voting timeout
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }

    this.logEvent('voting_resolved', {
      round: this.room.currentRound,
      approvals,
      rejections,
      result: approved ? 'approved' : 'rejected'
    });

    if (approved) {
      // Team is approved - transition to quest phase
      this.logEvent('team_approved', {
        round: this.room.currentRound,
        leaderId: this.getLeaderId()
      });

      // Move to quest phase
      this.room.state = 'quest';
      this.room.votes = {};
      this.questVotes = [];
    } else {
      // Team rejected - another voting round
      this.room.failCount++;
      this.room.votes = {};

      // Rotate leader
      this.rotateLeader();

      if (this.room.failCount >= 3) {
        // 3 failed votes = evil wins
        this.room.state = 'ended';
        this.room.evilWins = true;
        this.logEvent('game_ended', {
          winner: 'evil',
          reason: 'vote_rejections_limit'
        });
      } else {
        // Start new voting round with new leader
        this.startVotingPhase();
      }
    }
  }

  /**
   * 隊長選擇任務隊伍
   */
  public selectQuestTeam(teamMemberIds: string[]): void {
    if (this.room.state !== 'voting') {
      throw new Error('Not in voting phase - cannot select team yet');
    }

    const config = AVALON_CONFIG[Object.keys(this.room.players).length];
    const expectedTeamSize = config.questTeams[this.room.currentRound - 1];

    if (teamMemberIds.length !== expectedTeamSize) {
      throw new Error(`Team size must be ${expectedTeamSize}, got ${teamMemberIds.length}`);
    }

    // Validate all players exist in room
    teamMemberIds.forEach((id) => {
      if (!(id in this.room.players)) {
        throw new Error(`Player ${id} not found in room`);
      }
    });

    this.room.questTeam = teamMemberIds;

    this.logEvent('quest_team_selected', {
      round: this.room.currentRound,
      teamSize: teamMemberIds.length,
      leaderId: this.getLeaderId()
    });
    // State stays 'voting' - voting will transition to 'quest' when approved
  }

  /**
   * 隊伍成員投票：成功或失敗
   */
  public submitQuestVote(playerId: string, vote: 'success' | 'fail'): void {
    if (this.room.state !== 'quest') {
      throw new Error('Not in quest phase');
    }

    // Validate player is in quest team
    if (!this.room.questTeam.includes(playerId)) {
      throw new Error(`Player ${playerId} is not in quest team`);
    }

    // Validate player hasn't voted yet
    if (this.questVotes.some((q) => q.playerId === playerId)) {
      throw new Error(`Player ${playerId} has already voted`);
    }

    this.questVotes.push({ playerId, vote });

    this.logEvent('quest_vote_submitted', {
      round: this.room.currentRound,
      playerId,
      vote,
      votedCount: this.questVotes.length,
      totalInTeam: this.room.questTeam.length
    });

    // Check if all team members have voted
    if (this.questVotes.length === this.room.questTeam.length) {
      this.resolveQuestPhase();
    }
  }

  /**
   * 解決任務階段 - 計算任務結果
   */
  private resolveQuestPhase(): void {
    // Clear quest timeout
    if (this.questVoteTimeout) {
      clearTimeout(this.questVoteTimeout);
      this.questVoteTimeout = null;
    }

    // Count fail votes
    const failCount = this.questVotes.filter((q) => q.vote === 'fail').length;
    const questFailed = failCount >= 1; // 1 fail = quest fails

    const result: 'success' | 'fail' = questFailed ? 'fail' : 'success';
    this.room.questResults.push(result);

    this.logEvent('quest_resolved', {
      round: this.room.currentRound,
      result,
      failVotes: failCount,
      successVotes: this.questVotes.length - failCount
    });

    // Check win conditions
    const successCount = this.room.questResults.filter((r) => r === 'success').length;
    const failCount_total = this.room.questResults.filter((r) => r === 'fail').length;

    if (successCount >= 3) {
      // Good wins 3 quests - enter discussion phase for assassination
      this.startDiscussionPhase();
    } else if (failCount_total >= 3) {
      // Evil wins 3 quests - game over
      this.room.state = 'ended';
      this.room.evilWins = true;
      this.logEvent('game_ended', {
        winner: 'evil',
        reason: 'failed_quests_limit'
      });
    } else {
      // Continue to next voting round
      this.room.currentRound++;
      this.room.state = 'voting';
      this.room.votes = {};
      this.questVotes = [];

      // Rotate leader for next round
      this.rotateLeader();

      this.logEvent('round_ended', {
        round: this.room.currentRound - 1,
        questResults: this.room.questResults,
        nextRound: this.room.currentRound
      });
    }
  }

  /**
   * 開始討論階段（好人贏得3次任務後）
   */
  private startDiscussionPhase(): void {
    this.room.state = 'discussion';
    this.questVotes = [];

    // Find assassin
    const assassinId = Array.from(this.roleAssignments.entries())
      .find(([_, role]) => role === 'assassin')?.[0];

    this.logEvent('discussion_phase_started', {
      assassinId,
      questResults: this.room.questResults
    });

    // Set assassination timeout
    this.assassinationTimeout = setTimeout(() => {
      if (this.room.state === 'discussion') {
        // If assassin doesn't choose in time, good wins
        this.resolveAssassination(null);
      }
    }, ASSASSINATION_TIMEOUT_MS);
  }

  /**
   * 刺客選擇要暗殺的目標
   */
  public submitAssassination(assassinId: string, targetId: string): void {
    if (this.room.state !== 'discussion') {
      throw new Error('Not in discussion phase');
    }

    // Validate assassin (room.players is authoritative as it can be updated)
    const assassinRole = this.room.players[assassinId]?.role ?? this.roleAssignments.get(assassinId);
    if (assassinRole !== 'assassin') {
      throw new Error(`Player ${assassinId} is not the assassin`);
    }

    // Validate target exists
    if (!(targetId in this.room.players)) {
      throw new Error(`Target player ${targetId} not found`);
    }

    this.logEvent('assassination_submitted', {
      assassinId,
      targetId
    });

    this.resolveAssassination(targetId);
  }

  /**
   * 解決刺殺結果
   */
  private resolveAssassination(targetId: string | null): void {
    // Clear assassination timeout
    if (this.assassinationTimeout) {
      clearTimeout(this.assassinationTimeout);
      this.assassinationTimeout = null;
    }

    this.room.state = 'ended';

    if (targetId === null) {
      // No target - good wins
      this.room.evilWins = false;
      this.logEvent('game_ended', {
        winner: 'good',
        reason: 'assassination_timeout'
      });
    } else {
      // room.players is authoritative as it can be updated externally
      const targetRole = this.room.players[targetId]?.role ?? this.roleAssignments.get(targetId);

      if (targetRole === 'merlin') {
        // Assassinated Merlin - evil wins
        this.room.evilWins = true;
        this.logEvent('game_ended', {
          winner: 'evil',
          reason: 'merlin_assassinated',
          targetId,
          targetRole
        });
      } else {
        // Killed non-Merlin - good wins
        this.room.evilWins = false;
        this.logEvent('game_ended', {
          winner: 'good',
          reason: 'assassination_failed',
          targetId,
          targetRole
        });
      }
    }

    // Log final stats
    this.logFinalStats();
  }

  /**
   * 獲取當前隊長 ID
   */
  private getLeaderId(): string {
    const playerIds = Object.keys(this.room.players);
    return playerIds[this.currentLeaderIndex % playerIds.length];
  }

  /**
   * 輪換隊長
   */
  private rotateLeader(): void {
    this.currentLeaderIndex++;
    this.room.leaderIndex = this.currentLeaderIndex;
  }

  /**
   * 記錄最終遊戲統計
   */
  private logFinalStats(): void {
    const stats = {
      roomId: this.room.id,
      duration: this.room.updatedAt - this.room.createdAt,
      winner: this.room.evilWins ? 'evil' : 'good',
      questResults: this.room.questResults,
      roles: Object.entries(this.room.players).reduce(
        (acc, [id, player]) => {
          acc[id] = this.roleAssignments.get(id);
          return acc;
        },
        {} as Record<string, Role | undefined>
      )
    };

    this.logEvent('game_final_stats', stats);
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
    if (this.questVoteTimeout) {
      clearTimeout(this.questVoteTimeout);
      this.questVoteTimeout = null;
    }
    if (this.assassinationTimeout) {
      clearTimeout(this.assassinationTimeout);
      this.assassinationTimeout = null;
    }
  }

  public getVoteCount(): { voted: number; total: number } {
    return {
      voted: Object.keys(this.room.votes).length,
      total: Object.keys(this.room.players).length,
    };
  }

  public getQuestVoteCount(): { voted: number; total: number } {
    return {
      voted: this.questVotes.length,
      total: this.room.questTeam.length,
    };
  }

  public getCurrentLeaderId(): string {
    return this.getLeaderId();
  }

  public getQuestTeam(): string[] {
    return this.room.questTeam;
  }

  private logEvent(event: string, data: Record<string, unknown>): void {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      roomId: this.room.id,
      event,
      ...data
    }));
  }
}
