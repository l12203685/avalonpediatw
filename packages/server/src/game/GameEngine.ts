import { Room, Role, AVALON_CONFIG, Player, GameState, VoteRecord, QuestRecord, LadyOfTheLakeRecord, CANONICAL_ROLES, isCanonicalRole, TimerMultiplier } from '@avalon/shared';

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

// Base phase-timer limits (at 1x multiplier). Effective timeout = base * multiplier.
// A `null` multiplier disables the timer entirely (unlimited thinking time).
// Spec (Edward 2026-04-20):
//   Team vote (派票) = 90s, Quest vote (黑白球) = 30s,
//   Lady of the Lake (湖中女神) = 90s, Assassin (刺殺) = 180s.
// TEAM_SELECT keeps the 90s AFK guard (same kind of operation as team vote).
const TEAM_SELECT_TIMEOUT_MS = 90000;
const VOTE_TIMEOUT_MS = 90000;
const QUEST_TIMEOUT_MS = 30000;
const ASSASSINATION_TIMEOUT_MS = 180000;
const LADY_OF_THE_LAKE_TIMEOUT_MS = 90000;

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
  /**
   * Per-game quest-size snapshot (see `effectiveQuestSizes` field).
   * Optional for backward-compat with pre-#90 snapshots; when absent,
   * restore leaves the engine field as null and getEffectiveQuestSizes
   * falls back to AVALON_CONFIG.
   */
  effectiveQuestSizes?: number[];
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

  /**
   * Per-room quest-size snapshot, computed at startGame() so host toggles
   * like `swapR1R2` and the 9-player `oberonMandatory` variant can override
   * the shared AVALON_CONFIG without mutating the global object. All
   * downstream quest logic reads `getEffectiveQuestSizes()` instead of
   * AVALON_CONFIG directly.
   */
  private effectiveQuestSizes: number[] | null = null;

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

  /**
   * Resolve the configured timer multiplier, defaulting to 1x when the room
   * has no explicit timerConfig (backward compat for rooms created before
   * this feature shipped).
   */
  private getTimerMultiplier(): TimerMultiplier {
    const m = this.room.timerConfig?.multiplier;
    if (m === null) return null;
    if (m === 0.5 || m === 1 || m === 1.5 || m === 2) return m;
    return 1;
  }

  /**
   * Compute the effective timeout in ms for a given base value, honoring the
   * room's multiplier. Returns `null` when the room selects "unlimited"
   * (callers MUST skip scheduling a setTimeout in that case).
   */
  private getTimeoutMs(base: number): number | null {
    const m = this.getTimerMultiplier();
    if (m === null) return null;
    return Math.round(base * m);
  }

  public startGame(): void {
    const playerCount = Object.keys(this.room.players).length;

    if (playerCount < 5 || playerCount > 10) {
      throw new Error(`Invalid player count: ${playerCount}. Must be between 5-10`);
    }

    // Randomize seat order (Edward 2026-04-24): host should NOT always be
    // seat 1. Rebuild `room.players` with a Fisher-Yates shuffled key order
    // so every downstream reader of `Object.keys(room.players)` (seat index,
    // first leader, Lady of the Lake start seat, scoresheet display) sees a
    // random arrangement. The Player objects themselves are not mutated —
    // only the insertion order of the record is re-keyed.
    this.shufflePlayerSeats();

    // Compute effective quest sizes once per game so downstream logic never
    // mutates the shared AVALON_CONFIG object. Honours `swapR1R2` and the
    // 9-player `oberonMandatory` variant.
    this.effectiveQuestSizes = this.computeEffectiveQuestSizes(playerCount);

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

    // Lady of the Lake (Edward 2026-04-24 "7 人以上預設勾選"):
    //   - explicit true  → on (host opted in)
    //   - explicit false → off (host opted out — always honoured)
    //   - undefined      → auto-on when playerCount ≥ 7, off otherwise
    // The <7-player hard lockout stays engine-enforced (official Avalon
    // rule: Lady only exists in 7+ player games) so an errant UI or
    // socket cannot activate Lady in a 5/6-player game.
    const ladyFlag = this.room.roleOptions?.ladyOfTheLake;
    const ladyRequested = ladyFlag === true
      || (ladyFlag === undefined && playerCount >= 7);
    const ladyEnabled = ladyRequested && playerCount >= 7;
    this.room.ladyOfTheLakeEnabled = ladyEnabled;
    if (ladyEnabled) {
      const playerIds = Object.keys(this.room.players);
      const ladyStartIndex = this.resolveLadyStartIndex(playerIds.length);
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
    const timeoutMs = this.getTimeoutMs(TEAM_SELECT_TIMEOUT_MS);
    if (timeoutMs === null) {
      // Unlimited mode — no AFK auto-select.
      return;
    }
    this.teamSelectTimeout = setTimeout(() => {
      if (this.room.state === 'voting' && this.room.questTeam.length === 0) {
        // Auto-select: leader + random other players to fill required size.
        // Read via getEffectiveQuestSizes so host overrides (swapR1R2 +
        // 9-variant) are honoured.
        const sizes = this.getEffectiveQuestSizes();
        const requiredSize = sizes[this.room.currentRound - 1] ?? 2;
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
    }, timeoutMs);
  }

  private startQuestPhase(): void {
    if (this.questVoteTimeout) {
      clearTimeout(this.questVoteTimeout);
      this.questVoteTimeout = null;
    }

    const timeoutMs = this.getTimeoutMs(QUEST_TIMEOUT_MS);
    if (timeoutMs === null) {
      // Unlimited mode — wait indefinitely for quest team votes.
      return;
    }
    this.questVoteTimeout = setTimeout(() => {
      if (this.room.state === 'quest') {
        // Auto-vote success for any team members who didn't vote in time.
        // Default = success is the safe fallback: it does NOT bypass the
        // server-side good-player guard and avoids handing evil an easy fail.
        const unvoted = this.room.questTeam.filter(
          id => !this.questVotes.some(q => q.playerId === id)
        );
        unvoted.forEach(id => {
          this.questVotes.push({ playerId: id, vote: 'success' });
        });
        this.resolveQuestPhase();
        this.onStateChange?.(this.room);
      }
    }, timeoutMs);
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
    const timeoutMs = this.getTimeoutMs(VOTE_TIMEOUT_MS);
    if (timeoutMs === null) {
      // Unlimited mode — wait indefinitely for all players to vote.
      return;
    }
    this.voteTimeout = setTimeout(() => {
      if (this.room.state === 'voting') {
        this.handleVoteTimeout();
      }
    }, timeoutMs);
  }

  private handleVoteTimeout(): void {
    // Auto-vote for players who didn't vote. Edward 2026-04-20 spec:
    //   Players IN the proposed quest team default to APPROVE (they are
    //   already signed onto going, so silence ~= "fine by me").
    //   Players OUT of the team default to REJECT (silent non-team member
    //   is treated as implicit opposition, keeping the failed-vote counter
    //   honest).
    const teamSet = new Set(this.room.questTeam);
    const unvotedPlayers = Object.keys(this.room.players).filter(
      (id) => !(id in this.room.votes)
    );

    unvotedPlayers.forEach((playerId) => {
      this.room.votes[playerId] = teamSet.has(playerId);
    });

    // Resolve voting and broadcast
    this.resolveVoting();
    this.onStateChange?.(this.room);
  }

  /**
   * Compute the effective quest-team sizes for this game, honoring:
   *   1. 9-player `oberonMandatory` variant → override to [4,3,4,5,5]
   *      (reflects the 5 good / 4 evil split with forced Oberon).
   *   2. `swapR1R2` host toggle → swap rounds 1 and 2 sizes.
   *
   * Always returns a FRESH array — never mutates AVALON_CONFIG (shared
   * global, read by other rooms).
   */
  private computeEffectiveQuestSizes(playerCount: number): number[] {
    const config = AVALON_CONFIG[playerCount];
    if (!config) {
      throw new Error(`No config for ${playerCount} players`);
    }
    // Shallow copy — we will potentially overwrite slots below.
    let sizes: number[] = [...config.questTeams];

    // Part 6 · 9-player variant override: 5 good / 4 evil with Oberon
    // forced on uses a non-standard quest-size sequence. Safe to apply
    // unconditionally for that specific variant only.
    if (playerCount === 9 && this.room.roleOptions?.variant9Player === 'oberonMandatory') {
      sizes = [4, 3, 4, 5, 5];
    }

    // Part 5 · Host-selected R1/R2 swap. Applied AFTER the 9-variant
    // override so the swap operates on the final size-sequence the host
    // actually sees (symmetric either way for [a,b,...] → [b,a,...]).
    if (this.room.roleOptions?.swapR1R2 === true && sizes.length >= 2) {
      const tmp = sizes[0];
      sizes[0] = sizes[1];
      sizes[1] = tmp;
    }

    return sizes;
  }

  /**
   * Public accessor used throughout the engine + tests to read quest
   * sizes without touching AVALON_CONFIG directly. Falls back to the
   * shared config if the engine hasn't computed a snapshot yet (i.e.
   * before startGame — shouldn't happen in practice).
   */
  public getEffectiveQuestSizes(): number[] {
    if (this.effectiveQuestSizes) {
      return this.effectiveQuestSizes;
    }
    const playerCount = Object.keys(this.room.players).length;
    const config = AVALON_CONFIG[playerCount];
    return config ? [...config.questTeams] : [];
  }

  /**
   * Resolve the starting Lady of the Lake holder index into
   * `Object.keys(this.room.players)` based on the `ladyStart` roleOption.
   *
   *   - `seat0` → canonical "leader's right" = last entry in playerIds
   *     (matches the existing Avalon convention where seat 0 sits to the
   *     right of the first leader). UI label: "隊長右手邊".
   *     Self-play scripts pin to `seat0` for deterministic first-holder
   *     start (Edward 2026-04-24 "湖中女神先固定從 0 家開始" +
   *     batch 5 「起始湖中不是隨機的」).
   *   - `seatN` (1..9) → playerIds[N-1], clamped to valid range.
   *   - `random` or unset → random index in [0, playerCount).
   */
  private resolveLadyStartIndex(playerCount: number): number {
    const ladyStart = this.room.roleOptions?.ladyStart;
    if (!ladyStart || ladyStart === 'random') {
      return Math.floor(Math.random() * playerCount);
    }
    if (ladyStart === 'seat0') {
      // Canonical leader's right = last player in the list.
      return playerCount - 1;
    }
    const match = /^seat([1-9])$/.exec(ladyStart);
    if (match) {
      const n = parseInt(match[1], 10);
      // seat1..seat9 → index 0..8, but clamp to [0, playerCount-1].
      return Math.min(n - 1, playerCount - 1);
    }
    // Defensive: unknown value → random fallback.
    return Math.floor(Math.random() * playerCount);
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

    // Part 6 · 9-player `oberonMandatory` variant:
    //   - Swap team sizes to 5 good / 4 evil (default is 6 good / 3 evil).
    //   - Oberon is FORCED into the evil pool (even if host left the
    //     `oberon` toggle off).
    //   - Quest sizes already shifted to [4,3,4,5,5] in
    //     computeEffectiveQuestSizes, independent of this block.
    const is9Variant = playerCount === 9 && opts.variant9Player === 'oberonMandatory';
    let baseRoles: Role[];
    if (is9Variant) {
      // Build a 5-good / 4-evil layout with Oberon forced in. Good pool:
      //   merlin, percival, loyal, loyal, loyal (3 loyal to hit 5 good).
      // Evil pool:
      //   assassin, morgana, mordred, oberon (all four canonical evil +
      //   honouring percival/morgana/mordred toggles below the usual way).
      baseRoles = [
        'merlin', 'percival', 'loyal', 'loyal', 'loyal',
        'assassin', 'morgana', 'mordred', 'oberon',
      ];
    } else {
      baseRoles = [...config.roles];
      // #90 Part 1 — 9-player "standard" variant: let host opt-in Oberon
      //   even without the oberonMandatory balance shift. Conversion:
      //   swap one loyal slot for oberon → 5 good / 4 evil while keeping
      //   the canonical [3,4,4,5,5] quest sizes. Only fires for 9p when
      //   the host ticked `oberon` AND is NOT on the mandatory variant.
      //   5/6/7/8/10p are untouched (their AVALON_CONFIG already includes
      //   oberon where canonical or disables it where not in the pool).
      //   Why swap instead of append: preserves 9-player total seat count
      //   (config has 9 roles; we never add/remove entries).
      if (
        playerCount === 9 &&
        opts.variant9Player !== 'oberonMandatory' &&
        opts.oberon === true
      ) {
        const loyalIdx = baseRoles.indexOf('loyal');
        if (loyalIdx !== -1) {
          baseRoles[loyalIdx] = 'oberon';
        }
      }
    }

    // Build role list from config, substituting disabled optional roles.
    // Skip the oberon disable when the 9-variant forces it in.
    const roles = baseRoles.map(role => {
      if (role === 'percival'  && !opts.percival)  return 'loyal' as Role;
      if (role === 'morgana'   && !opts.morgana)   return 'minion' as Role;
      if (role === 'oberon'    && !opts.oberon && !is9Variant) return 'minion' as Role;
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

    // Read via getEffectiveQuestSizes so host overrides (swapR1R2 +
    // 9-variant) are honoured.
    const effectiveSizes = this.getEffectiveQuestSizes();
    const expectedTeamSize = effectiveSizes[this.room.currentRound - 1];

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

    // Edward 2026-04-24 batch 8 — forced mission skip vote.
    // Verbatim:「強制局也不用投票」「R1~R2 是不能有異常票的」.
    // When the previous 4 proposals in this round were rejected (failCount
    // === 4), the 5th proposal is a FORCED approval — Avalon rules mandate
    // the quest runs regardless of votes (rejecting a 5th time would end
    // the game in evil's favour, so there is literally nothing to vote
    // on). Previously the engine still ran the vote phase and every AI
    // coerced itself to approve; this wasted a round-trip and produced
    // legitimately-zero but still-present vote records. Batch 8 skips
    // the vote entirely and records a synthetic unanimous-approve in
    // voteHistory so downstream readers (scoresheet, replays, tests)
    // continue to see a 5th-attempt vote record with approved=true.
    //
    // Safeguards: we only trigger when failCount === 4 (exactly 5th
    // attempt, matching the `failCount >= 5 → evil wins` rule in
    // resolveVoting). Cleared votes + rotated leader + fresh questTeam
    // are already guaranteed by advanceToNextRound / rotateLeader so
    // the synthetic record does not collide with prior state.
    if (this.room.failCount >= 4) {
      // Clear any team-select / vote timeouts that may still be live.
      if (this.teamSelectTimeout) {
        clearTimeout(this.teamSelectTimeout);
        this.teamSelectTimeout = null;
      }
      if (this.voteTimeout) {
        clearTimeout(this.voteTimeout);
        this.voteTimeout = null;
      }

      // Synthesize a unanimous-approve vote record so replays &
      // scoresheet downstream reader logic still sees a "5th proposal
      // approved" record in voteHistory.
      const unanimousVotes: Record<string, boolean> = {};
      for (const pid of Object.keys(this.room.players)) {
        unanimousVotes[pid] = true;
      }
      this.room.votes = { ...unanimousVotes };

      this.voteAttemptInRound++;
      const forcedRecord: VoteRecord = {
        round:    this.room.currentRound,
        attempt:  this.voteAttemptInRound,
        leader:   this.getLeaderId(),
        team:     [...teamMemberIds],
        approved: true,
        votes:    { ...unanimousVotes },
      };
      this.room.voteHistory.push(forcedRecord);

      this.logEvent('forced_mission_auto_approved', {
        round:   this.room.currentRound,
        attempt: this.voteAttemptInRound,
        leader:  this.getLeaderId(),
        team:    teamMemberIds,
        reason:  '5th_proposal_forced_approve',
      });

      // Transition straight into quest phase, mirroring the approved
      // branch of resolveVoting().
      this.room.state = 'quest';
      this.room.votes = {};
      this.room.failCount = 0;
      this.room.questVotedCount = 0;
      this.questVotes = [];
      this.startQuestPhase();
      return;
    }

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

    // House-rule override: when `oberonAlwaysFail` is on, any Oberon
    // player's vote is coerced to `'fail'` regardless of what the caller
    // submitted. This is the single choke-point covering both AI (which
    // goes through GameEngine.submitQuestVote directly via the server
    // bot scheduler) and human players (whose votes flow through the
    // socket handler into this same method). Kept out of HeuristicAgent
    // so AI decision code is untouched — the engine is authoritative.
    // Role is read from `room.players` (same source used everywhere
    // else in the engine) so externally-mutated roles are honoured.
    const voterRole = this.room.players[playerId]?.role
      ?? this.roleAssignments.get(playerId);
    const effectiveVote: 'success' | 'fail' =
      this.room.roleOptions?.oberonAlwaysFail === true && voterRole === 'oberon'
        ? 'fail'
        : vote;

    this.questVotes.push({ playerId, vote: effectiveVote });
    this.room.questVotedCount = this.questVotes.length;

    this.logEvent('quest_vote_submitted', {
      round: this.room.currentRound,
      playerId,
      vote: effectiveVote,
      submittedVote: vote,
      coerced: effectiveVote !== vote,
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

    // 9-player variant · Option 2 ("inverted protection"): on rounds
    // 1/2/3/5 in a 9-player oberonMandatory game with the flag set,
    // EXACTLY ONE fail vote flips the quest to failed; 0 or 2+ fails all
    // count as success. Round 4 keeps its standard 2-fail protection rule.
    // All other configurations fall through to the classic
    // `failCount >= failsRequired` check.
    const roundIdx = this.room.currentRound - 1;
    const isProtectionRound = roundIdx === 3;
    const isInvert9Option2 =
      playerCount === 9 &&
      this.room.roleOptions?.variant9Player === 'oberonMandatory' &&
      (this.room.roleOptions as Partial<{ variant9Option2: boolean }> | undefined)
        ?.variant9Option2 === true &&
      !isProtectionRound;
    const questFailed = isInvert9Option2
      ? failCount === 1
      : failCount >= failsRequired;

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

    // Timeout: if holder doesn't choose, skip the phase.
    // Spec: Lady auto-pick is NOT allowed — unlimited mode simply waits.
    if (this.ladyOfTheLakeTimeout) {
      clearTimeout(this.ladyOfTheLakeTimeout);
      this.ladyOfTheLakeTimeout = null;
    }
    const timeoutMs = this.getTimeoutMs(LADY_OF_THE_LAKE_TIMEOUT_MS);
    if (timeoutMs === null) {
      return;
    }
    this.ladyOfTheLakeTimeout = setTimeout(() => {
      if (this.room.state === 'lady_of_the_lake') {
        this.logEvent('lady_of_the_lake_timeout', { holderId: this.room.ladyOfTheLakeHolder });
        this.room.ladyOfTheLakeTarget = undefined;
        this.room.ladyOfTheLakeResult = undefined;
        this.advanceToNextRound();
        this.onStateChange?.(this.room);
      }
    }, timeoutMs);
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

    // Broadcast the result so the holder can see it. The phase stays in
    // `lady_of_the_lake` until the declarer either publicly declares (via
    // `declareLakeResult`) or skips (via `skipLakeDeclaration`) — the
    // declaration step is a spec-required part of the Lady flow
    // (Edward 2026-04-24 "還有為什麼湖中完全沒宣告"). A 90s declaration
    // timeout auto-advances the phase if the holder AFKs.
    this.startLakeDeclarationTimeout(holderId);
    this.onStateChange?.(this.room);
  }

  /**
   * Start the declaration-phase AFK timeout. After the holder inspects a
   * target, they have LADY_OF_THE_LAKE_TIMEOUT_MS (90s, subject to timer
   * multiplier) to publicly declare or explicitly skip. Timeout silently
   * skips the declaration and advances the game so AFK players cannot
   * hang the table.
   */
  private startLakeDeclarationTimeout(declarerId: string): void {
    if (this.ladyOfTheLakeTimeout) {
      clearTimeout(this.ladyOfTheLakeTimeout);
      this.ladyOfTheLakeTimeout = null;
    }
    const timeoutMs = this.getTimeoutMs(LADY_OF_THE_LAKE_TIMEOUT_MS);
    if (timeoutMs === null) {
      return; // Unlimited thinking time — declarer waits as long as they want.
    }
    this.ladyOfTheLakeTimeout = setTimeout(() => {
      if (this.room.state !== 'lady_of_the_lake') return;
      // Still waiting on a declaration — silently advance as a skip.
      this.logEvent('lady_of_the_lake_declaration_timeout', {
        declarerId,
        round: this.room.currentRound,
      });
      this.finalizeLakePhase();
      this.onStateChange?.(this.room);
    }, timeoutMs);
  }

  /**
   * Final advance out of the Lady of the Lake phase — shared by
   * declaration, explicit skip, and AFK timeout paths. Clears the
   * private inspection result before moving the room forward so that
   * the next state broadcast does not leak `ladyOfTheLakeResult` to
   * other players' clients.
   */
  private finalizeLakePhase(): void {
    if (this.ladyOfTheLakeTimeout) {
      clearTimeout(this.ladyOfTheLakeTimeout);
      this.ladyOfTheLakeTimeout = null;
    }
    this.room.ladyOfTheLakeTarget = undefined;
    this.room.ladyOfTheLakeResult = undefined;
    this.advanceToNextRound();
  }

  /**
   * Force-advance the Lady of the Lake phase immediately (skips the
   * declaration AFK timeout). Used by SelfPlayEngine after bots have
   * finished both inspection and optional declaration in the same tick.
   */
  public completeLadyPhase(): void {
    if (this.room.state !== 'lady_of_the_lake') return;
    this.finalizeLakePhase();
  }

  /**
   * Public "skip declaration" path for live games. The holder who just
   * inspected a target may prefer to keep the result private; this
   * cleanly advances the phase without recording a declaration.
   *
   * Accepts the declarer's playerId so other players cannot force-skip
   * on the holder's behalf. No-op (does not throw) when the state is
   * already past the Lady phase so a late click after the AFK timeout
   * races cleanly.
   */
  public skipLakeDeclaration(playerId: string): void {
    if (this.room.state !== 'lady_of_the_lake') return;
    if (!this.room.ladyOfTheLakeHistory || this.room.ladyOfTheLakeHistory.length === 0) return;
    const last = this.room.ladyOfTheLakeHistory[this.room.ladyOfTheLakeHistory.length - 1];
    if (last.holderId !== playerId) {
      throw new Error(`Player ${playerId} is not the declarer of the last Lady of the Lake inspection`);
    }
    this.logEvent('lady_of_the_lake_declaration_skipped', {
      declarerId: playerId,
      targetId: last.targetId,
      round: last.round,
    }, playerId);
    this.finalizeLakePhase();
    this.onStateChange?.(this.room);
  }

  /**
   * Public declaration by the current Lady of the Lake holder (Part 4 of
   * #90). After inspecting a target, the holder can publicly claim that
   * the inspected player was 'good' or 'evil' (or keep it private by not
   * calling this at all). The claim need not match reality — that is the
   * social-deduction point. The engine records the declaration on the
   * most-recent history entry and logs an event so replays and the system
   * chat can surface it.
   *
   * Returns the mutated `LadyOfTheLakeRecord` (so the socket layer can
   * emit a system-chat message) or `null` if nothing to update (caller
   * should treat this as a no-op).
   */
  public declareLakeResult(playerId: string, claim: 'good' | 'evil'): LadyOfTheLakeRecord | null {
    if (!this.room.ladyOfTheLakeHistory || this.room.ladyOfTheLakeHistory.length === 0) {
      throw new Error('No Lady of the Lake inspection to declare');
    }
    // The declarer must be the player who *performed* the most-recent
    // inspection (stored in history[last].holderId). After the inspection
    // the token transfers to the target, so room.ladyOfTheLakeHolder is
    // no longer reliable for this check.
    const lastIdx = this.room.ladyOfTheLakeHistory.length - 1;
    const last = this.room.ladyOfTheLakeHistory[lastIdx];
    if (last.holderId !== playerId) {
      throw new Error(`Player ${playerId} is not the declarer of the last Lady of the Lake inspection`);
    }
    if (last.declared === true) {
      // Already declared — treat as no-op to keep the UI idempotent.
      return null;
    }
    if (claim !== 'good' && claim !== 'evil') {
      throw new Error(`Invalid claim "${claim}"; expected 'good' or 'evil'`);
    }
    const updated: LadyOfTheLakeRecord = {
      ...last,
      declared: true,
      declaredClaim: claim,
    };
    // Immutable replace of the last history entry.
    this.room.ladyOfTheLakeHistory = [
      ...this.room.ladyOfTheLakeHistory.slice(0, lastIdx),
      updated,
    ];

    this.logEvent('lady_of_the_lake_declared', {
      declarerId: playerId,
      targetId: last.targetId,
      claim,
      actualResult: last.result,
      round: last.round,
    }, playerId);

    // Broadcast the declaration first so every client sees it on the
    // Lady overlay, then advance the phase. Declaration is the terminal
    // action of the Lady step in live games; SelfPlay calls this before
    // `completeLadyPhase` and the second call becomes a noop because
    // state is already back to `voting`.
    this.onStateChange?.(this.room);
    if (this.room.state === 'lady_of_the_lake') {
      this.finalizeLakePhase();
      this.onStateChange?.(this.room);
    }
    return updated;
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

    // Set assassination timeout. Default on timeout = don't assassinate =>
    // good wins (handled by resolveAssassination(null)).
    const timeoutMs = this.getTimeoutMs(ASSASSINATION_TIMEOUT_MS);
    if (timeoutMs === null) {
      // Unlimited mode — assassin takes as long as needed.
      return;
    }
    this.assassinationTimeout = setTimeout(() => {
      if (this.room.state === 'discussion') {
        // If assassin doesn't choose in time, good wins
        this.resolveAssassination(null);
        this.onStateChange?.(this.room);
      }
    }, timeoutMs);
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

  /**
   * Randomize the seat order by rebuilding `room.players` with a Fisher-Yates
   * shuffled key order. Seat number in this codebase is derived from
   * `Object.keys(room.players)` insertion order + 1, so re-keying the record
   * is sufficient to randomize every downstream consumer (first leader, Lady
   * of the Lake start seat, scoresheet badges, nomination shorthand).
   *
   * Player objects themselves are NOT cloned or mutated — only the container
   * `room.players` is replaced with a fresh Record whose keys are inserted in
   * shuffled order. This preserves any external references to individual
   * Player objects (sockets, bot adapters) that hold them by id.
   *
   * Called once per game at the top of `startGame()`. See Edward 2026-04-24
   * "起始位置應該要隨機 而不是房主永遠1家 所有人都要隨機".
   */
  private shufflePlayerSeats(): void {
    const ids = Object.keys(this.room.players);
    if (ids.length <= 1) return;
    const shuffledIds = this.shuffleArray(ids);
    const reordered: Record<string, typeof this.room.players[string]> = {};
    for (const id of shuffledIds) {
      reordered[id] = this.room.players[id];
    }
    this.room.players = reordered;
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
      effectiveQuestSizes: this.effectiveQuestSizes
        ? [...this.effectiveQuestSizes]
        : undefined,
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
    engine.effectiveQuestSizes = snapshot.effectiveQuestSizes
      ? [...snapshot.effectiveQuestSizes]
      : null;
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
