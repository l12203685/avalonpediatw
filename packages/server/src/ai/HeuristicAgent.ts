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
  VoteRecord,
} from './types';
import { AVALON_CONFIG } from '@avalon/shared';

export class HeuristicAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;
  private readonly difficulty: 'normal' | 'hard';

  // Suspicion score per player: higher = more likely evil (from this agent's perspective)
  private suspicion: Map<string, number> = new Map();

  constructor(agentId: string, difficulty: 'normal' | 'hard' = 'normal') {
    this.agentId = agentId;
    this.difficulty = difficulty;
  }

  onGameStart(obs: PlayerObservation): void {
    // Initialize suspicion for all players (reconstructed from initial obs)
    // Known evils get max suspicion, known good (self if good) get 0
    this.suspicion = new Map();
    for (const knownEvil of obs.knownEvils) {
      this.suspicion.set(knownEvil, 10);
    }
  }

  act(obs: PlayerObservation): AgentAction {
    // Update suspicion from latest vote history
    this.updateSuspicion(obs);

    switch (obs.gamePhase) {
      case 'team_select':  return this.selectTeam(obs);
      case 'team_vote':    return this.voteOnTeam(obs);
      case 'quest_vote':   return this.voteOnQuest(obs);
      case 'assassination': return this.assassinate(obs);
    }
  }

  onGameEnd(_obs: PlayerObservation, _won: boolean): void {
    this.suspicion.clear();
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
    const { proposedTeam, myTeam, knownEvils, knownWizards, failCount } = obs;

    if (myTeam === 'good') {
      // Approve if no known evils on team
      const hasKnownEvil = proposedTeam.some(id => knownEvils.includes(id));
      if (hasKnownEvil) {
        return { type: 'team_vote', vote: false };
      }

      // Percival: be skeptical of large teams with no wizard candidate (Merlin/Morgana)
      // A team without either potential Merlin is suspicious — they may be hiding evil.
      if (knownWizards && knownWizards.length > 0 && proposedTeam.length >= 3) {
        const hasWizard = proposedTeam.some(id => knownWizards.includes(id));
        if (!hasWizard) {
          // Reject with high probability — teams without Merlin candidates are risky
          return { type: 'team_vote', vote: this.difficulty === 'hard' ? false : Math.random() > 0.65 };
        }
      }

      // Calculate average suspicion of proposed team
      const avgSuspicion = proposedTeam.reduce((s, id) => s + this.getSuspicion(id), 0) / proposedTeam.length;
      // Hard mode: stricter suspicion threshold, also considers current round (later rounds = more info)
      const threshold = failCount >= 4
        ? 5
        : this.difficulty === 'hard'
          ? 2.5  // harder: reject more suspicious teams
          : 3;

      return { type: 'team_vote', vote: avgSuspicion < threshold };
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

  // ── Suspicion Tracking ───────────────────────────────────────

  private updateSuspicion(obs: PlayerObservation): void {
    // Only update from new votes (last entry in history)
    if (obs.voteHistory.length === 0) return;
    const latest = obs.voteHistory[obs.voteHistory.length - 1];

    // If a quest failed, suspect everyone who voted to approve that team
    if (obs.questHistory.length > 0) {
      const lastQuest = obs.questHistory[obs.questHistory.length - 1];
      if (lastQuest.result === 'fail') {
        for (const [pid, approved] of Object.entries(latest.votes)) {
          if (approved && latest.team.includes(pid)) {
            this.addSuspicion(pid, 1.5);
          }
        }
        for (const teamMember of lastQuest.team) {
          this.addSuspicion(teamMember, 2);
        }
      }
    }

    // Players who always approve teams are slightly suspicious (covering for evil)
    for (const [pid, approved] of Object.entries(latest.votes)) {
      if (approved && !this.getSuspicion(pid)) {
        this.addSuspicion(pid, 0.1);
      } else if (!approved) {
        // Rejecting teams = slightly less suspicious
        this.addSuspicion(pid, -0.2);
      }
    }
  }

  private getSuspicion(playerId: string): number {
    return this.suspicion.get(playerId) ?? 0;
  }

  private addSuspicion(playerId: string, delta: number): void {
    this.suspicion.set(playerId, Math.max(0, (this.suspicion.get(playerId) ?? 0) + delta));
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
