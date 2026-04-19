import { Room, Role, AVALON_CONFIG, Player, GameState, VoteRecord, QuestRecord, CANONICAL_ROLES, isCanonicalRole } from '@avalon/shared';

/**
 * Error thrown when a role outside the canonical 7-role Avalon scope is
 * about to be assigned to a player. The lock is enforced at assignment
 * time so that even if an upstream change leaks a non-canonical role into
 * AVALON_CONFIG or roleOptions, the game refuses to start loudly.
 *
 * Memory: project_avalon_scope_canonical_7.md. Do NOT relax.
 */
export class CanonicalRoleLockError extends Error {
  constructor(public readonly offendingRoles: string[]) {
    super(
      `Canonical 7-role scope violation: ${offendingRoles.join(', ')}. ` +
      `Allowed: ${CANONICAL_ROLES.join(', ')}. ` +
      `See packages/shared/src/types/game.ts CANONICAL_ROLES and memory ` +
      `project_avalon_scope_canonical_7.md before modifying.`
    );
    this.name = 'CanonicalRoleLockError';
  }
}

const TEAM_SELECT_TIMEOUT_MS = 90000; // 90秒隊伍選擇時限（隊長AFK保護）
const VOTE_TIMEOUT_MS = 60000; // 60秒隊伍投票時限
const QUEST_TIMEOUT_MS = 60000; // 60秒任務投票時限
const ASSASSINATION_TIMEOUT_MS = 120000; // 2分鐘刺殺時限
const LADY_OF_THE_LAKE_TIMEOUT_MS = 60000; // 60秒湖中女神時限

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

export interface GameEngineState {
  version: number;
  roomId: string;
  roleAssignments: Record<string, Role>;
  questVotes: QuestVote[];
  currentLeaderIndex: number;
  voteAttemptInRound: number;
  eventBuffer: GameEventRecord[];
  eventSeq: number;
}

export class GameEngine {
  private room: Room;
  private roleAssignments: Map<string, Role> = new Map();
  private teamSelectTimeout: NodeJS.Timeout | null = null;
  private voteTimeout: NodeJS.Timeout | null = null;
  private questVoteTimeout: NodeJS.Timeout | null = null;
  private assassinationTimeout: NodeJS.Timeout | null = null;
  private ladyOfTheLakeTimeout: NodeJS.Timeout | null = null;
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

    // Lady of the Lake is OUTSIDE the canonical 7-role scope lock
    // (memory project_avalon_scope_canonical_7.md). Default OFF; only
    // enabled when the host explicitly opts in (=== true). The prior
    // default of "enabled unless disabled" caused accidental activation.
    const ladyEnabled = this.room.roleOptions?.ladyOfTheLake === true && playerCount >= 7;
    this.room.ladyOfTheLakeEnabled = ladyEnabled;
    if (ladyEnabled) {
      // Lady starts with the player to the right of the first leader (index 1 in player list, wrapping)
      const playerIds = Object.keys(this.room.players);
      const ladyStartIndex = (0 + playerIds.length - 1) % playerIds.length; // player to the "right" of leader
      this.room.ladyOfTheLakeHolder = playerIds[ladyStartIndex];
      this.room.ladyOfTheLakeUsed = [playerIds[ladyStartIndex]]; // holder cannot be targeted
    } else {
      this.room.ladyOfTheLakeHolder = undefined;
      this.room.ladyOfTheLakeUsed = [];
    }
    this.room.ladyOfTheLakeTarget = undefined;
    this.room.ladyOfTheLakeResult = undefined;
    this.room.ladyOfTheLakeHistory = [];

    // Build player name map for replay readability
    const playerNames: Record<string, string> = {};
    for (const [id, p] of Object.entries(this.room.players)) {
      playerNames[id] = p.name;
    }
    this.logEvent('game_started', {
      playerCount,
      roles: Array.from(this.roleAssignments.values()),
      playerNames,
      leaderId: Object.keys(this.room.players)[0],
      leaderName: Object.values(this.room.players)[0]?.name ?? '',
    });

    // Don't start vote timer yet — it starts when leader confirms the quest team
    // Start team-selection timer to handle AFK leader
    this.startTeamSelectPhase();
  }

  private startTeamSelectPhase(): void {
    if (this.teamSelectTimeout) {
      clearTimeout(this.teamSelectTimeout);
      this.teamSelectTimeout = null;
    }
    this.teamSelectTimeout = setTimeout(() => {
      if (this.room.state === 'voting' && this.room.questTeam.length === 0) {
        // Auto-select: leader + random other players to fill required size
        const playerCount = Object.keys(this.room.players).length;
        const config = AVALON_CONFIG[playerCount];
        const requiredSize = config?.questTeams[this.room.currentRound - 1] ?? 2;
        const leaderId = this.getLeaderId();
        const others = Object.keys(this.room.players).filter(id => id !== leaderId);
        const shuffled = this.shuffleArray(others);
        const autoTeam = [leaderId, ...shuffled].slice(0, requiredSize);
        this.room.questTeam = autoTeam;
        this.logEvent('team_auto_selected', {
          round: this.room.currentRound,
          leaderId,
          team: autoTeam,
          reason: 'leader_afk_timeout',
        });
        this.startVotingPhase();
        this.onStateChange?.(this.room);
      }
    }, TEAM_SELECT_TIMEOUT_MS);
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

    // Log voting phase start (include leaderId and failedVotes for replay display)
    const playerIds = Object.keys(this.room.players);
    const leaderId = playerIds[this.currentLeaderIndex % playerIds.length];
    this.logEvent('voting_phase_started', {
      round: this.room.currentRound,
      failedVotes: this.room.failCount,
      failCount: this.room.failCount,
      playerCount: playerIds.length,
      leaderId,
      leaderName: this.room.players[leaderId]?.name ?? leaderId,
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

    // Default all canonical evil toggles ON so the legacy 'minion'
    // substitution never triggers on the happy path. A caller that wants
    // a reduced-role game must explicitly disable a toggle.
    const opts = this.room.roleOptions ?? {
      percival: true, morgana: true, oberon: true, mordred: true, ladyOfTheLake: false
    };
    // Build role list from config, substituting disabled optional roles
    const roles = config.roles.map(role => {
      if (role === 'percival'  && !opts.percival)  return 'loyal' as Role;
      if (role === 'morgana'   && !opts.morgana)   return 'minion' as Role;
      if (role === 'oberon'    && !opts.oberon)    return 'minion' as Role;
      if (role === 'mordred'   && !opts.mordred)   return 'minion' as Role;
      return role;
    });

    // Canonical 7-role scope assertion. Throws CanonicalRoleLockError if
    // any role outside CANONICAL_ROLES would be assigned. This is the
    // backstop that rejects future Lancelot/Galahad/Troublemaker/etc.
    // additions. See memory project_avalon_scope_canonical_7.md.
    const offending = roles.filter(r => !isCanonicalRole(r));
    if (offending.length > 0) {
      throw new CanonicalRoleLockError(Array.from(new Set(offending)));
    }

    const playerIds = Object.keys(this.room.players);
    const rolesShuffled = this.shuffleArray([...roles]);

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
        // Start new team-select window for the new leader
        this.startTeamSelectPhase();
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

    // Clear AFK timeout — leader has responded
    if (this.teamSelectTimeout) {
      clearTimeout(this.teamSelectTimeout);
      this.teamSelectTimeout = null;
    }

    this.room.questTeam = teamMemberIds;

    const teamNames = teamMemberIds.map(id => this.room.players[id]?.name ?? id);
    this.logEvent('quest_team_selected', {
      round: this.room.currentRound,
      teamSize: teamMemberIds.length,
      leaderId: this.getLeaderId(),
      team: teamNames,
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
      // Lady of the Lake: after quest 2+ (currentRound >= 2), holder must inspect a player
      if (this.room.ladyOfTheLakeEnabled && this.room.currentRound >= 2 && this.room.ladyOfTheLakeHolder) {
        this.startLadyOfTheLakePhase();
      } else {
        this.advanceToNextRound();
      }
    }
  }

  /**
   * Advance to next voting round (extracted so Lady of the Lake can call it after inspection)
   */
  private advanceToNextRound(): void {
    const prevRound = this.room.currentRound;
    this.room.currentRound++;
    this.room.state = 'voting';
    this.room.votes = {};
    this.room.questTeam = [];
    this.questVotes = [];
    this.voteAttemptInRound = 0;

    // Rotate leader for next round
    this.rotateLeader();
    // New leader must select a team -- start AFK timer
    this.startTeamSelectPhase();

    this.logEvent('round_ended', {
      round: prevRound,
      questResults: this.room.questResults,
      nextRound: this.room.currentRound,
    });
  }

  /**
   * Lady of the Lake phase: holder must choose a player to inspect
   */
  private startLadyOfTheLakePhase(): void {
    this.room.state = 'lady_of_the_lake';
    this.room.ladyOfTheLakeTarget = undefined;
    this.room.ladyOfTheLakeResult = undefined;

    this.logEvent('lady_of_the_lake_started', {
      round: this.room.currentRound,
      holderId: this.room.ladyOfTheLakeHolder,
    });

    // Timeout: if holder doesn't choose, skip the phase
    if (this.ladyOfTheLakeTimeout) {
      clearTimeout(this.ladyOfTheLakeTimeout);
      this.ladyOfTheLakeTimeout = null;
    }
    this.ladyOfTheLakeTimeout = setTimeout(() => {
      if (this.room.state === 'lady_of_the_lake') {
        this.logEvent('lady_of_the_lake_timeout', { holderId: this.room.ladyOfTheLakeHolder });
        this.room.ladyOfTheLakeTarget = undefined;
        this.room.ladyOfTheLakeResult = undefined;
        this.advanceToNextRound();
        this.onStateChange?.(this.room);
      }
    }, LADY_OF_THE_LAKE_TIMEOUT_MS);
  }

  /**
   * Lady of the Lake: holder chooses a target to inspect
   */
  public submitLadyOfTheLakeTarget(holderId: string, targetId: string): void {
    if (this.room.state !== 'lady_of_the_lake') {
      throw new Error('Not in Lady of the Lake phase');
    }
    if (holderId !== this.room.ladyOfTheLakeHolder) {
      throw new Error(`Player ${holderId} is not the Lady of the Lake holder`);
    }
    if (!(targetId in this.room.players)) {
      throw new Error(`Target player ${targetId} not found`);
    }
    if (this.room.ladyOfTheLakeUsed?.includes(targetId)) {
      throw new Error(`Player ${targetId} has already been inspected / held the Lady`);
    }
    if (targetId === holderId) {
      throw new Error('Cannot inspect yourself');
    }

    // Clear timeout
    if (this.ladyOfTheLakeTimeout) {
      clearTimeout(this.ladyOfTheLakeTimeout);
      this.ladyOfTheLakeTimeout = null;
    }

    // Reveal target's team to the holder
    const targetTeam = this.room.players[targetId]?.team ?? this.getRoleTeam(this.roleAssignments.get(targetId) ?? 'loyal');
    this.room.ladyOfTheLakeTarget = targetId;
    this.room.ladyOfTheLakeResult = targetTeam;

    // Record in history (the result is public knowledge since holder can claim anything)
    this.room.ladyOfTheLakeHistory = [
      ...(this.room.ladyOfTheLakeHistory ?? []),
      { round: this.room.currentRound, holderId, targetId, result: targetTeam },
    ];

    this.logEvent('lady_of_the_lake_inspected', {
      holderId,
      targetId,
      targetTeam,
      round: this.room.currentRound,
    });

    // Transfer the Lady token to the inspected player
    this.room.ladyOfTheLakeUsed = [...(this.room.ladyOfTheLakeUsed ?? []), targetId];
    this.room.ladyOfTheLakeHolder = targetId;

    // Broadcast the result so the holder can see it, then advance after a short delay
    this.onStateChange?.(this.room);

    // Auto-advance to next round after 3 seconds (let the holder see the result)
    setTimeout(() => {
      if (this.room.state === 'lady_of_the_lake') {
        this.room.ladyOfTheLakeTarget = undefined;
        this.room.ladyOfTheLakeResult = undefined;
        this.advanceToNextRound();
        this.onStateChange?.(this.room);
      }
    }, 3000);
  }

  /**
   * Force-advance the Lady of the Lake phase immediately (skips the 3-second display delay).
   * Used by SelfPlayEngine to avoid waiting for the timeout in automated games.
   */
  public completeLadyPhase(): void {
    if (this.room.state !== 'lady_of_the_lake') return;
    if (this.ladyOfTheLakeTimeout) {
      clearTimeout(this.ladyOfTheLakeTimeout);
      this.ladyOfTheLakeTimeout = null;
    }
    this.room.ladyOfTheLakeTarget = undefined;
    this.room.ladyOfTheLakeResult = undefined;
    this.advanceToNextRound();
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

  /**
   * Serialize engine-private state into a plain object for persistence (e.g. Firebase).
   * Room state is NOT included — persist the Room object separately.
   */
  public serialize(): GameEngineState {
    const roleAssignments: Record<string, Role> = {};
    for (const [id, role] of this.roleAssignments) {
      roleAssignments[id] = role;
    }
    return {
      version: 1,
      roomId: this.room.id,
      roleAssignments,
      questVotes: [...this.questVotes],
      currentLeaderIndex: this.currentLeaderIndex,
      voteAttemptInRound: this.voteAttemptInRound,
      eventBuffer: [...this.eventBuffer],
      eventSeq: this.eventSeq,
    };
  }

  /**
   * Restore a GameEngine from a serialized snapshot + the live Room object.
   */
  public static restore(snapshot: GameEngineState, room: Room): GameEngine {
    if (snapshot.roomId !== room.id) {
      throw new Error(
        `Snapshot roomId "${snapshot.roomId}" does not match room.id "${room.id}"`
      );
    }
    const engine = new GameEngine(room);
    for (const [id, role] of Object.entries(snapshot.roleAssignments)) {
      engine.roleAssignments.set(id, role);
    }
    engine.questVotes = [...snapshot.questVotes];
    engine.currentLeaderIndex = snapshot.currentLeaderIndex;
    engine.voteAttemptInRound = snapshot.voteAttemptInRound;
    engine.eventBuffer = [...snapshot.eventBuffer];
    engine.eventSeq = snapshot.eventSeq;
    return engine;
  }

  public cleanup(): void {
    if (this.teamSelectTimeout) {
      clearTimeout(this.teamSelectTimeout);
      this.teamSelectTimeout = null;
    }
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
    if (this.ladyOfTheLakeTimeout) {
      clearTimeout(this.ladyOfTheLakeTimeout);
      this.ladyOfTheLakeTimeout = null;
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
