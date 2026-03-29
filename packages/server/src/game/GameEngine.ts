import { Room, Role, AVALON_CONFIG, Player, GameState, VoteRecord, QuestRecord } from '@avalon/shared';

const VOTE_TIMEOUT_MS = 60000; // 60秒隊伍投票時限
const QUEST_TIMEOUT_MS = 60000; // 60秒任務投票時限
const ASSASSINATION_TIMEOUT_MS = 120000; // 2分鐘刺殺時限

interface QuestVote {
  playerId: string;
  vote: 'success' | 'fail';
}

export interface GameEventRecord {
  seq:        number;
  event_type: string;
  actor_id:   string | null;
  event_data: Record<string, unknown>;
}

export class GameEngine {
  private room: Room;
  private roleAssignments: Map<string, Role> = new Map();
  private voteTimeout: NodeJS.Timeout | null = null;
  private questVoteTimeout: NodeJS.Timeout | null = null;
  private assassinationTimeout: NodeJS.Timeout | null = null;
  private onStateChange: ((room: Room) => void) | null = null;

  // Quest phase tracking
  private questVotes: QuestVote[] = [];
  private currentLeaderIndex: number = 0;
  private voteAttemptInRound: number = 0; // tracks attempt number within a round

  // In-memory event buffer (flushed to Supabase on game end)
  private eventBuffer: GameEventRecord[] = [];
  private eventSeq: number = 0;

  constructor(room: Room, onStateChange?: (room: Room) => void) {
    this.room = room;
    this.onStateChange = onStateChange ?? null;
  }

  /** Returns the buffered event log for persistence */
  public getEventLog(): GameEventRecord[] {
    return this.eventBuffer;
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
    this.room.voteHistory = [];
    this.room.questHistory = [];
    this.room.questVotedCount = 0;
    this.questVotes = [];
    this.currentLeaderIndex = 0;
    this.voteAttemptInRound = 0;

    this.logEvent('game_started', {
      playerCount,
      roles: Array.from(this.roleAssignments.values())
    });

    // Don't start vote timer yet — it starts when leader confirms the quest team
  }

  private startQuestPhase(): void {
    if (this.questVoteTimeout) {
      clearTimeout(this.questVoteTimeout);
      this.questVoteTimeout = null;
    }

    this.questVoteTimeout = setTimeout(() => {
      if (this.room.state === 'quest') {
        // Auto-vote success for any team members who didn't vote in time
        const unvoted = this.room.questTeam.filter(
          id => !this.questVotes.some(q => q.playerId === id)
        );
        unvoted.forEach(id => {
          this.questVotes.push({ playerId: id, vote: 'success' });
        });
        this.resolveQuestPhase();
        this.onStateChange?.(this.room);
      }
    }, QUEST_TIMEOUT_MS);
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
    // Auto-vote for players who didn't vote (reject as default)
    const unvotedPlayers = Object.keys(this.room.players).filter(
      (id) => !(id in this.room.votes)
    );

    unvotedPlayers.forEach((playerId) => {
      this.room.votes[playerId] = false;
    });

    // Resolve voting and broadcast
    this.resolveVoting();
    this.onStateChange?.(this.room);
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

    // Record this vote round in public history
    this.voteAttemptInRound++;
    const voteRecord: VoteRecord = {
      round:    this.room.currentRound,
      attempt:  this.voteAttemptInRound,
      leader:   this.getLeaderId(),
      team:     [...this.room.questTeam],
      approved,
      votes:    { ...this.room.votes },
    };
    this.room.voteHistory.push(voteRecord);

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

      // Move to quest phase; reset consecutive reject counter
      this.room.state = 'quest';
      this.room.votes = {};
      this.room.failCount = 0;
      this.room.questVotedCount = 0;
      this.questVotes = [];
      this.startQuestPhase();
    } else {
      // Team rejected - another voting round
      this.room.failCount++;
      this.room.votes = {};
      this.room.questTeam = []; // Clear team so new leader can propose fresh team

      // Rotate leader
      this.rotateLeader();

      if (this.room.failCount >= 5) {
        // 5 consecutive rejections = evil wins (standard Avalon rules)
        this.room.state = 'ended';
        this.room.evilWins = true;
        this.room.endReason = 'vote_rejections';
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
    // Start the approval vote timer now that team is proposed
    this.startVotingPhase();
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
    this.room.questVotedCount = this.questVotes.length;

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

    // Count fail votes — some rounds require 2 fails (round 4 in 7+ player games)
    const playerCount = Object.keys(this.room.players).length;
    const config = AVALON_CONFIG[playerCount];
    const failsRequired = config?.questFailsRequired[this.room.currentRound - 1] ?? 1;
    const failCount = this.questVotes.filter((q) => q.vote === 'fail').length;
    const questFailed = failCount >= failsRequired;

    const result: 'success' | 'fail' = questFailed ? 'fail' : 'success';
    this.room.questResults.push(result);

    // Record quest outcome in public history
    const questRecord: QuestRecord = {
      round:     this.room.currentRound,
      team:      [...this.room.questTeam],
      result,
      failCount,
    };
    this.room.questHistory.push(questRecord);

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
      this.room.endReason = 'failed_quests';
      this.logEvent('game_ended', {
        winner: 'evil',
        reason: 'failed_quests_limit'
      });
    } else {
      // Continue to next voting round
      this.room.currentRound++;
      this.room.state = 'voting';
      this.room.votes = {};
      this.room.questTeam = [];
      this.questVotes = [];
      this.voteAttemptInRound = 0;

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
        this.onStateChange?.(this.room);
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
      this.room.endReason = 'assassination_timeout';
      this.logEvent('game_ended', {
        winner: 'good',
        reason: 'assassination_timeout'
      });
    } else {
      // room.players is authoritative as it can be updated externally
      const targetRole = this.room.players[targetId]?.role ?? this.roleAssignments.get(targetId);
      this.room.assassinTargetId = targetId;

      if (targetRole === 'merlin') {
        // Assassinated Merlin - evil wins
        this.room.evilWins = true;
        this.room.endReason = 'merlin_assassinated';
        this.logEvent('game_ended', {
          winner: 'evil',
          reason: 'merlin_assassinated',
          targetId,
          targetRole
        });
      } else {
        // Killed non-Merlin - good wins
        this.room.evilWins = false;
        this.room.endReason = 'assassination_failed';
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
    this.onStateChange = null;
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

  private logEvent(event: string, data: Record<string, unknown>, actorId: string | null = null): void {
    const record: GameEventRecord = {
      seq:        this.eventSeq++,
      event_type: event,
      actor_id:   actorId,
      event_data: { roomId: this.room.id, timestamp: new Date().toISOString(), ...data },
    };
    this.eventBuffer.push(record);
    console.log(JSON.stringify({ ...record.event_data, event }));
  }
}
