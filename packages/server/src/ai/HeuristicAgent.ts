/**
 * Heuristic Agent — Strategy-aware Avalon AI
 *
 * Implements role-appropriate decision heuristics:
 * - Good players: include themselves + safe players on quest teams
 * - Evil players: include self + appear cooperative, occasionally sneak in allies
 * - Merlin: vote against teams containing known evils
 * - Assassin: track who voted against evil teams (likely Merlin behavior)
 * - All roles: use vote history to build suspicion scores
 */

import {
  AvalonAgent,
  PlayerObservation,
  AgentAction,
} from './types';
import { AVALON_CONFIG } from '@avalon/shared';

// ── Strategy thresholds ────────────────────────────────────────
/**
 * Average-team-suspicion rejection threshold for the **on-team** path.
 * Higher = more tolerant. Hard mode is stricter than normal.
 */
const SUSPICION_REJECT_THRESHOLD: Record<'hard' | 'normal', number> = {
  hard:   2.0,
  normal: 3.0,
};

/**
 * Stricter threshold for the **off-team** path — good players are more
 * cautious when not seated, since they can't protect the quest themselves.
 */
const STRICT_THRESHOLD: Record<'hard' | 'normal', number> = {
  hard:   1.5,
  normal: 2.5,
};

/**
 * Baseline **reject** probability when a good player is NOT on the proposed
 * team and no harder signal (knownEvil / failed-member / suspicion) has
 * already forced a decision. Forces the leader to prove the team is clean.
 */
const OFF_TEAM_REJECT_BASELINE: Record<'hard' | 'normal', number> = {
  hard:   0.7,
  normal: 0.55,
};

/** Decision-flip noise rate — higher = more "human error". */
const NOISE_RATE: Record<'hard' | 'normal', number> = {
  hard:   0.05,
  normal: 0.15,
};

/** Above this failCount, good always approves to avoid auto-loss on 5th reject. */
const FORCE_APPROVE_FAIL_COUNT = 4;

// ── Agent Memory ───────────────────────────────────────────────
/**
 * Per-agent, per-game memory. Populated via idempotent ingest methods
 * in `act()` so repeated observations do not double-count.
 *
 * Reset at every `onGameStart()` and cleared at `onGameEnd()`.
 */
interface AgentMemory {
  /** playerId → suspicion score (higher = more likely evil) */
  suspicion: Map<string, number>;
  /** playerId → number of failed quests this player appeared in */
  failedTeamMembers: Map<string, number>;
  /** chronological list of failed quest rounds (for blacklist decay) */
  failedTeamHistory: Array<{ round: number; team: string[] }>;
  /** playerId → times approved a team that was later proven evil-tainted */
  approvedSuspiciousVoters: Map<string, number>;
  /** playerId → times this leader led a team that failed its quest */
  leaderCoverScore: Map<string, number>;
  /** playerId → number of quests this player participated in */
  questsParticipated: Map<string, number>;
  /** last phase seen (dedup helper) */
  lastKnownPhase: 'team_select' | 'team_vote' | 'quest_vote' | 'assassination' | null;
  /** dedup key `${round}-${attempt}` for already-ingested vote records */
  processedVoteAttempts: Set<string>;
  /** dedup key `round` for already-ingested quest records */
  processedQuestRounds: Set<number>;
}

export class HeuristicAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;
  private readonly difficulty: 'normal' | 'hard';

  private memory: AgentMemory = this.createEmptyMemory();

  constructor(agentId: string, difficulty: 'normal' | 'hard' = 'normal') {
    this.agentId = agentId;
    this.difficulty = difficulty;
  }

  onGameStart(obs: PlayerObservation): void {
    this.resetMemory();
    // Known evils get max suspicion, known good (self if good) stay at 0.
    for (const knownEvil of obs.knownEvils) {
      this.memory.suspicion.set(knownEvil, 10);
    }
  }

  act(obs: PlayerObservation): AgentAction {
    // Idempotent ingestion: update cross-round memory from public history.
    this.ingestVoteHistory(obs);
    this.ingestQuestHistory(obs);
    this.ingestLeaderStats(obs);
    this.memory.lastKnownPhase = obs.gamePhase;

    switch (obs.gamePhase) {
      case 'team_select':  return this.selectTeam(obs);
      case 'team_vote':    return this.voteOnTeam(obs);
      case 'quest_vote':   return this.voteOnQuest(obs);
      case 'assassination': return this.assassinate(obs);
    }
  }

  onGameEnd(_obs: PlayerObservation, _won: boolean): void {
    this.resetMemory();
  }

  // ── Memory lifecycle ────────────────────────────────────────

  private createEmptyMemory(): AgentMemory {
    return {
      suspicion:                new Map(),
      failedTeamMembers:        new Map(),
      failedTeamHistory:        [],
      approvedSuspiciousVoters: new Map(),
      leaderCoverScore:         new Map(),
      questsParticipated:       new Map(),
      lastKnownPhase:           null,
      processedVoteAttempts:    new Set(),
      processedQuestRounds:     new Set(),
    };
  }

  private resetMemory(): void {
    this.memory = this.createEmptyMemory();
  }

  // ── Ingest (idempotent) ─────────────────────────────────────

  /**
   * Consume every new vote record since last call. Dedup key = `${round}-${attempt}`.
   * Per record:
   *   - Approvers get +0.1 baseline suspicion (covering evil)
   *   - Rejecters get -0.2 (less suspicious)
   * When a fail quest has already been ingested for this round, approvers of that
   * record's team get accumulated to `approvedSuspiciousVoters`.
   */
  private ingestVoteHistory(obs: PlayerObservation): void {
    for (const record of obs.voteHistory) {
      const key = `${record.round}-${record.attempt}`;
      if (this.memory.processedVoteAttempts.has(key)) continue;
      this.memory.processedVoteAttempts.add(key);

      for (const [pid, approved] of Object.entries(record.votes)) {
        if (approved) {
          this.addSuspicion(pid, 0.1);
        } else {
          this.addSuspicion(pid, -0.2);
        }
      }
    }
  }

  /**
   * Consume every new quest record since last call. Dedup key = `round`.
   * For each fail quest:
   *   - Every team member gets +2 suspicion and +1 failedTeamMembers count
   *   - History entry appended for blacklist decay
   *   - Approvers of the corresponding vote record get +1.5 suspicion
   *     and +1 approvedSuspiciousVoters
   *   - Every participant gets questsParticipated++.
   */
  private ingestQuestHistory(obs: PlayerObservation): void {
    for (const quest of obs.questHistory) {
      if (this.memory.processedQuestRounds.has(quest.round)) continue;
      this.memory.processedQuestRounds.add(quest.round);

      // Participation count (all quests, not just fails)
      for (const pid of quest.team) {
        this.memory.questsParticipated.set(
          pid,
          (this.memory.questsParticipated.get(pid) ?? 0) + 1,
        );
      }

      if (quest.result !== 'fail') continue;

      // Blacklist bookkeeping for failed quests
      for (const pid of quest.team) {
        this.addSuspicion(pid, 2);
        this.memory.failedTeamMembers.set(
          pid,
          (this.memory.failedTeamMembers.get(pid) ?? 0) + 1,
        );
      }
      this.memory.failedTeamHistory.push({ round: quest.round, team: [...quest.team] });

      // Penalise everyone who approved the approved team for this round
      const approvingRecord = obs.voteHistory.find(
        (r) => r.round === quest.round && r.approved,
      );
      if (!approvingRecord) continue;

      for (const [pid, approved] of Object.entries(approvingRecord.votes)) {
        if (approved && approvingRecord.team.includes(pid)) {
          this.addSuspicion(pid, 1.5);
        }
        if (approved) {
          this.memory.approvedSuspiciousVoters.set(
            pid,
            (this.memory.approvedSuspiciousVoters.get(pid) ?? 0) + 1,
          );
        }
      }
    }
  }

  /**
   * Recompute `leaderCoverScore` from authoritative history every call.
   * For every failed quest, the leader of the approved vote record earns +1.
   * Idempotent because the map is overwritten from source each time.
   */
  private ingestLeaderStats(obs: PlayerObservation): void {
    const tally = new Map<string, number>();
    for (const quest of obs.questHistory) {
      if (quest.result !== 'fail') continue;
      const approvingRecord = obs.voteHistory.find(
        (r) => r.round === quest.round && r.approved,
      );
      if (!approvingRecord) continue;
      tally.set(
        approvingRecord.leader,
        (tally.get(approvingRecord.leader) ?? 0) + 1,
      );
    }
    this.memory.leaderCoverScore = tally;
  }

  // ── Noise helper ────────────────────────────────────────────

  /**
   * Flip a decision with probability `rate`. When `critical` is true
   * the rate is forced to 0 (finish-line decisions never flip).
   * Works for any value — only flips when T is boolean.
   */
  private applyNoise<T>(decision: T, rate: number, critical = false): T {
    if (critical || rate <= 0) return decision;
    if (Math.random() >= rate) return decision;
    if (typeof decision === 'boolean') {
      return !decision as unknown as T;
    }
    return decision;
  }

  // ── Team Selection ───────────────────────────────────────────

  private selectTeam(obs: PlayerObservation): AgentAction {
    const { playerCount, currentRound, myPlayerId, myTeam, knownEvils, knownWizards } = obs;
    const teamSize = this.getTeamSize(playerCount, currentRound);
    const allIds   = this.getPlayerIds(obs);

    if (myTeam === 'good') {
      // Good: include self + lowest-suspicion players
      const candidates = allIds
        .filter(id => id !== myPlayerId)
        .sort((a, b) => this.getSuspicion(a) - this.getSuspicion(b));

      // Percival: prioritise including at least one wizard candidate (Merlin or Morgana) on the team
      // so quests can be protected. If a quest fails with a wizard on it, they're more likely Morgana.
      if (knownWizards && knownWizards.length > 0) {
        const team: string[] = [myPlayerId];
        // Always include at least one wizard candidate when there's room
        const preferredWizard = knownWizards[0];
        if (team.length < teamSize) team.push(preferredWizard);
        for (const id of candidates) {
          if (team.length >= teamSize) break;
          if (!team.includes(id)) team.push(id);
        }
        return { type: 'team_select', teamIds: team.slice(0, teamSize) };
      }

      const team = [myPlayerId, ...candidates].slice(0, teamSize);
      return { type: 'team_select', teamIds: team };
    } else {
      // Evil: include self, prefer to include one evil ally on larger teams
      const evilAllies = knownEvils.filter(id => id !== myPlayerId);
      const goodCandidates = allIds
        .filter(id => id !== myPlayerId && !knownEvils.includes(id))
        .sort(() => Math.random() - 0.5); // shuffle to appear random

      const team: string[] = [myPlayerId];

      // On bigger teams (size >= 3), sneak in one evil ally 50% of the time
      if (teamSize >= 3 && evilAllies.length > 0 && Math.random() > 0.5) {
        team.push(evilAllies[Math.floor(Math.random() * evilAllies.length)]);
      }

      // Fill remaining with good-looking players
      for (const id of goodCandidates) {
        if (team.length >= teamSize) break;
        team.push(id);
      }

      return { type: 'team_select', teamIds: team.slice(0, teamSize) };
    }
  }

  // ── Team Vote ────────────────────────────────────────────────

  private voteOnTeam(obs: PlayerObservation): AgentAction {
    const { proposedTeam, myTeam, myPlayerId, knownEvils, knownWizards, failCount } = obs;

    if (myTeam === 'good') {
      // Force approve on 5th attempt — rejecting auto-hands round to evil.
      if (failCount >= FORCE_APPROVE_FAIL_COUNT) {
        return { type: 'team_vote', vote: true };
      }

      // Hard veto: any known evil on team → always reject (critical, no noise).
      const hasKnownEvil = proposedTeam.some(id => knownEvils.includes(id));
      if (hasKnownEvil) {
        return { type: 'team_vote', vote: false };
      }

      // Percival: skeptical of teams without any wizard candidate (Merlin/Morgana).
      if (knownWizards && knownWizards.length > 0 && proposedTeam.length >= 3) {
        const hasWizard = proposedTeam.some(id => knownWizards.includes(id));
        if (!hasWizard) {
          return {
            type: 'team_vote',
            vote: this.difficulty === 'hard' ? false : Math.random() > 0.65,
          };
        }
      }

      // Suspicion + failed-team-member scan used by both on/off-team branches.
      const avgSuspicion = proposedTeam.reduce((s, id) => s + this.getSuspicion(id), 0) / proposedTeam.length;
      const hasFailedMember = proposedTeam.some(
        id => (this.memory.failedTeamMembers.get(id) ?? 0) >= 1,
      );
      const onTeam = proposedTeam.includes(myPlayerId);
      const noise  = NOISE_RATE[this.difficulty];

      if (!onTeam) {
        // Off-team path: default to cautious reject. Leader must prove the
        // team is clean — otherwise the good player holds out their approval.
        const strictThreshold = STRICT_THRESHOLD[this.difficulty];
        if (hasFailedMember || avgSuspicion > strictThreshold) {
          return { type: 'team_vote', vote: this.applyNoise(false, noise) };
        }
        // No hard signal → baseline reject probability. Round 1 has no
        // history yet, so relax the baseline to avoid auto-racing to
        // failCount=5 (which auto-hands the round to evil).
        const hasHistory = this.memory.failedTeamHistory.length > 0
          || this.memory.processedVoteAttempts.size > 0;
        const baseline = hasHistory
          ? OFF_TEAM_REJECT_BASELINE[this.difficulty]
          : OFF_TEAM_REJECT_BASELINE[this.difficulty] * 0.6;
        const baselineVote = Math.random() < baseline ? false : true;
        return { type: 'team_vote', vote: this.applyNoise(baselineVote, noise) };
      }

      // On-team path: keep legacy avg-suspicion check, but also veto teams
      // that contain any previously-failed member.
      if (hasFailedMember) {
        return { type: 'team_vote', vote: this.applyNoise(false, noise) };
      }
      const threshold = SUSPICION_REJECT_THRESHOLD[this.difficulty];
      const decision  = avgSuspicion < threshold;
      return { type: 'team_vote', vote: this.applyNoise(decision, noise) };
    } else {
      // Evil: approve if own ally or self is on team, reject otherwise
      const hasSelf  = proposedTeam.includes(obs.myPlayerId);
      const hasAlly  = proposedTeam.some(id => knownEvils.includes(id));

      if (hasSelf || hasAlly) return { type: 'team_vote', vote: true };

      // Hard mode: more strategically sometimes approves to appear cooperative
      const approveChance = this.difficulty === 'hard' ? 0.35 : 0.3;
      return { type: 'team_vote', vote: Math.random() < approveChance };
    }
  }

  // ── Quest Vote ───────────────────────────────────────────────

  private voteOnQuest(obs: PlayerObservation): AgentAction {
    const { myTeam, myRole, questResults, playerCount, currentRound } = obs;

    if (myTeam === 'good') {
      return { type: 'quest_vote', vote: 'success' };
    }

    // Evil: decide whether to fail based on game state
    const goodQuestWins = questResults.filter(r => r === 'success').length;
    const evilQuestWins = questResults.filter(r => r === 'fail').length;

    // Check if this round requires 2 fail votes (7+ players, round 4)
    const config = AVALON_CONFIG[playerCount];
    const failsRequired = config?.questFailsRequired[currentRound - 1] ?? 1;

    // If 2 fails required this round, a single fail is wasted — be strategic
    if (failsRequired >= 2) {
      // Only fail if we're desperate (evil about to lose or already winning)
      if (evilQuestWins >= 2 || goodQuestWins >= 2) {
        return { type: 'quest_vote', vote: 'fail' };
      }
      // Otherwise appear cooperative to stay hidden (failing alone won't help)
      return { type: 'quest_vote', vote: Math.random() > 0.7 ? 'fail' : 'success' };
    }

    // Standard 1-fail round logic
    // If evil already has 2 failed quests, always fail to win
    if (evilQuestWins >= 2) {
      return { type: 'quest_vote', vote: 'fail' };
    }

    // If good is winning (2 successes), urgently fail
    if (goodQuestWins >= 2) {
      if (myRole === 'oberon') {
        // Oberon acts more randomly since they don't know the game state as well
        return { type: 'quest_vote', vote: Math.random() > 0.3 ? 'fail' : 'success' };
      }
      return { type: 'quest_vote', vote: 'fail' };
    }

    // Early game: sometimes succeed to stay hidden (60% fail, 40% succeed)
    return { type: 'quest_vote', vote: Math.random() > 0.4 ? 'fail' : 'success' };
  }

  // ── Assassination ────────────────────────────────────────────

  private assassinate(obs: PlayerObservation): AgentAction {
    const allIds = this.getPlayerIds(obs);
    const goodPlayers = allIds.filter(id => !obs.knownEvils.includes(id) && id !== obs.myPlayerId);

    if (goodPlayers.length === 0) {
      return { type: 'assassinate', targetId: allIds.find(id => id !== obs.myPlayerId) ?? allIds[0] };
    }

    // Target the good player who behaved most like Merlin:
    // - Voted against teams with evil players
    // - Was never on a failed quest
    // - Was not easily voted through
    const merlinScore = new Map<string, number>();
    for (const id of goodPlayers) {
      merlinScore.set(id, this.getMerlinScore(id, obs));
    }

    const target = goodPlayers.reduce((best, id) =>
      (merlinScore.get(id) ?? 0) > (merlinScore.get(best) ?? 0) ? id : best
    , goodPlayers[0]);

    return { type: 'assassinate', targetId: target };
  }

  /**
   * Score a player on how "Merlin-like" their behavior has been.
   * Higher = more likely to be Merlin.
   */
  private getMerlinScore(playerId: string, obs: PlayerObservation): number {
    let score = 0;

    for (const vote of obs.voteHistory) {
      const theirVote = vote.votes[playerId];
      if (theirVote === undefined) continue;

      if (this.difficulty === 'hard') {
        // Hard: weight by how "informative" the rejection was
        // Rejecting a team that contained an evil player is very Merlin-like
        const teamHadEvil = vote.team.some(id => obs.knownEvils.includes(id));
        if (!theirVote && teamHadEvil) score += 2.0;   // Rejected a team with evil — Merlin behavior
        else if (!theirVote && !vote.approved) score += 0.8; // Rejected a team that was ultimately rejected
        else if (!theirVote) score += 0.4;              // Cautious rejection
        // If they approved a team with evil, they're probably NOT Merlin
        if (theirVote && teamHadEvil) score -= 1.5;
      } else {
        // Normal mode
        if (!theirVote && !vote.approved) score += 0.5;
        if (!theirVote) score += 0.3;
      }
    }

    // Never on a failed quest → suspicious of being the protected Merlin
    const onFailedQuest = obs.questHistory.some(q => q.result === 'fail' && q.team.includes(playerId));
    if (!onFailedQuest && obs.questHistory.length > 0) {
      score += this.difficulty === 'hard' ? 1.5 : 1;
    }

    // Hard: was always on successful quests = likely trusted good role (Merlin is always trusted)
    if (this.difficulty === 'hard') {
      const questAppearances = obs.questHistory.filter(q => q.team.includes(playerId));
      const allSucceeded = questAppearances.every(q => q.result === 'success');
      if (allSucceeded && questAppearances.length >= 2) score += 1.0;
    }

    return score;
  }

  // ── Suspicion accessors ─────────────────────────────────────

  private getSuspicion(playerId: string): number {
    return this.memory.suspicion.get(playerId) ?? 0;
  }

  private addSuspicion(playerId: string, delta: number): void {
    this.memory.suspicion.set(
      playerId,
      Math.max(0, (this.memory.suspicion.get(playerId) ?? 0) + delta),
    );
  }

  // ── Test hooks ──────────────────────────────────────────────

  /** Read-only snapshot of internal memory (tests only — do not call from game code). */
  _memoryForTesting(): Readonly<AgentMemory> {
    return this.memory;
  }

  /** Direct access to ingest / noise helpers (tests only). */
  _ingestForTesting(obs: PlayerObservation): void {
    this.ingestVoteHistory(obs);
    this.ingestQuestHistory(obs);
    this.ingestLeaderStats(obs);
  }

  _applyNoiseForTesting<T>(decision: T, rate: number, critical = false): T {
    return this.applyNoise(decision, rate, critical);
  }

  // ── Helpers ──────────────────────────────────────────────────

  private getPlayerIds(obs: PlayerObservation): string[] {
    return obs.allPlayerIds;
  }

  private getTeamSize(playerCount: number, round: number): number {
    const TEAM_SIZES: Record<number, number[]> = {
      5:  [2, 3, 2, 3, 3],
      6:  [2, 3, 4, 3, 4],
      7:  [2, 3, 3, 4, 4],
      8:  [3, 4, 4, 5, 5],
      9:  [3, 4, 4, 5, 5],
      10: [3, 4, 4, 5, 5],
    };
    return (TEAM_SIZES[playerCount] ?? TEAM_SIZES[5])[Math.min(round - 1, 4)];
  }
}
