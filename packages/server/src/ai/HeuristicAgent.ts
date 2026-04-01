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

  // Suspicion score per player: higher = more likely evil (from this agent's perspective)
  private suspicion: Map<string, number> = new Map();

  constructor(agentId: string) {
    this.agentId = agentId;
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
    const { playerCount, currentRound, myPlayerId, myTeam, knownEvils } = obs;
    const teamSize = this.getTeamSize(playerCount, currentRound);
    const allIds   = this.getPlayerIds(obs);

    if (myTeam === 'good') {
      // Good: include self + lowest-suspicion players
      const candidates = allIds
        .filter(id => id !== myPlayerId)
        .sort((a, b) => this.getSuspicion(a) - this.getSuspicion(b));
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
    const { proposedTeam, myTeam, knownEvils, failCount } = obs;

    if (myTeam === 'good') {
      // Approve if no known evils on team
      const hasKnownEvil = proposedTeam.some(id => knownEvils.includes(id));
      if (hasKnownEvil) {
        return { type: 'team_vote', vote: false };
      }

      // Calculate average suspicion of proposed team
      const avgSuspicion = proposedTeam.reduce((s, id) => s + this.getSuspicion(id), 0) / proposedTeam.length;
      const threshold = failCount >= 4 ? 5 : 3; // more lenient when 5th reject would hand evil victory

      return { type: 'team_vote', vote: avgSuspicion < threshold };
    } else {
      // Evil: approve if own ally or self is on team, reject otherwise (80%)
      const hasSelf  = proposedTeam.includes(obs.myPlayerId);
      const hasAlly  = proposedTeam.some(id => knownEvils.includes(id));

      if (hasSelf || hasAlly) return { type: 'team_vote', vote: true };

      // Sometimes approve to not look suspicious
      return { type: 'team_vote', vote: Math.random() > 0.7 };
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

      // If they voted against a team that later failed, that's Merlin behavior
      if (!theirVote && !vote.approved) score += 0.5;
      // If they rejected a team — cautious behavior
      if (!theirVote) score += 0.3;
    }

    // Never on a failed quest → suspicious of being the protected Merlin
    const onFailedQuest = obs.questHistory.some(q => q.result === 'fail' && q.team.includes(playerId));
    if (!onFailedQuest && obs.questHistory.length > 0) score += 1;

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
    const ids = new Set<string>([obs.myPlayerId, obs.currentLeader]);
    obs.knownEvils.forEach(id => ids.add(id));
    obs.proposedTeam.forEach(id => ids.add(id));
    obs.voteHistory.forEach((v: VoteRecord) => {
      ids.add(v.leader);
      v.team.forEach(id => ids.add(id));
      Object.keys(v.votes).forEach(id => ids.add(id));
    });
    obs.questHistory.forEach(q => q.team.forEach(id => ids.add(id)));
    return Array.from(ids);
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
