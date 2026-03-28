/**
 * Random Agent — Baseline Avalon AI
 *
 * Makes completely random decisions. Used as:
 * 1. A baseline to compare trained agents against
 * 2. Data generation during early training (exploration)
 * 3. Opponent pool for self-play
 */

import {
  AvalonAgent,
  PlayerObservation,
  AgentAction,
} from './types';

export class RandomAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'random' as const;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  onGameStart(_obs: PlayerObservation): void {
    // No state to initialise for random agent
  }

  act(obs: PlayerObservation): AgentAction {
    const allPlayerIds = this.getPlayerIds(obs);

    switch (obs.gamePhase) {
      case 'team_select': {
        const teamSize = this.getTeamSize(obs.playerCount, obs.currentRound);
        const shuffled = [...allPlayerIds].sort(() => Math.random() - 0.5);
        return { type: 'team_select', teamIds: shuffled.slice(0, teamSize) };
      }

      case 'team_vote':
        return { type: 'team_vote', vote: Math.random() > 0.4 }; // slight approval bias

      case 'quest_vote': {
        // Evil players sometimes send fail (50% chance), good players always succeed
        if (obs.myTeam === 'evil' && obs.myRole !== 'oberon') {
          return { type: 'quest_vote', vote: Math.random() > 0.5 ? 'fail' : 'success' };
        }
        return { type: 'quest_vote', vote: 'success' };
      }

      case 'assassination': {
        const goodPlayers = allPlayerIds.filter(id => !obs.knownEvils.includes(id) && id !== obs.myPlayerId);
        const pool   = goodPlayers.length > 0 ? goodPlayers : allPlayerIds.filter(id => id !== obs.myPlayerId);
        const target = pool[Math.floor(Math.random() * pool.length)] ?? allPlayerIds[0];
        return { type: 'assassinate', targetId: target };
      }
    }
  }

  onGameEnd(_obs: PlayerObservation, _won: boolean): void {
    // Nothing to update for random agent
  }

  private getPlayerIds(obs: PlayerObservation): string[] {
    // Reconstruct player ID list from observations
    const ids = new Set<string>();
    ids.add(obs.myPlayerId);
    ids.add(obs.currentLeader);
    obs.knownEvils.forEach(id => ids.add(id));
    obs.proposedTeam.forEach(id => ids.add(id));
    obs.voteHistory.forEach(v => {
      ids.add(v.leader);
      v.team.forEach(id => ids.add(id));
    });
    obs.questHistory.forEach(q => q.team.forEach(id => ids.add(id)));
    return Array.from(ids);
  }

  private getTeamSize(playerCount: number, round: number): number {
    // Avalon team sizes: [players: [r1, r2, r3, r4, r5]]
    const TEAM_SIZES: Record<number, number[]> = {
      5:  [2, 3, 2, 3, 3],
      6:  [2, 3, 4, 3, 4],
      7:  [2, 3, 3, 4, 4],
      8:  [3, 4, 4, 5, 5],
      9:  [3, 4, 4, 5, 5],
      10: [3, 4, 4, 5, 5],
    };
    const sizes = TEAM_SIZES[playerCount] ?? TEAM_SIZES[5];
    return sizes[Math.min(round - 1, 4)];
  }
}
