/**
 * Regression — self-play "Team size must be N, got N−1" crash (2026-10-10).
 *
 * Root cause: ForwardAgent.generateTeamSelectCandidates hard-excluded, for
 * a Percival leader, the predicted-Morgana wizard AND every seat flagged by
 * `inferRedsFromTaskFails`. In 5-8 player games one failed mission flags its
 * whole team, so the remaining pool could not fill teamSize-1 slots; the
 * enumeration produced no combination and the legacy fallback returned an
 * undersized team, which GameEngine.selectQuestTeam rejects (aborting the
 * whole self-play game: 28% of 5p, 45% of 6p, 7.5% of 8p games).
 */

import { describe, it, expect } from 'vitest';
import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation, VoteRecord } from '../types';
import { ForwardAgent } from './ForwardAgent';
import { SelfPlayEngine } from '../SelfPlayEngine';

const IDS_5P = ['P1', 'P2', 'P3', 'P4', 'P5'];

/** Vote record with default votes (on-team approve / off-team reject). */
function vr(
  round: number,
  attempt: number,
  leader: string,
  team: string[],
  approved: boolean,
): VoteRecord {
  const votes: Record<string, boolean> = {};
  for (const id of IDS_5P) votes[id] = approved ? true : team.includes(id);
  return { round, attempt, leader, team, approved, votes };
}

/**
 * Captured from a crashing 5p self-play game: Percival P3 leads R4
 * (team of 3). Wizards P2/P4; the only failed mission (R2) was
 * [P5, P4, P2], so all three are "inferred red" and wizard B is excluded
 * too — only P1 remained, producing the 2-member team [P3, P1].
 */
function crashObservation(knownEvils: string[]): PlayerObservation {
  return {
    myPlayerId: 'P3',
    myRole: 'percival',
    myTeam: 'good',
    playerCount: 5,
    allPlayerIds: IDS_5P,
    knownEvils,
    knownWizards: ['P2', 'P4'],
    currentRound: 4,
    currentLeader: 'P3',
    failCount: 1,
    questResults: ['success', 'fail', 'success'],
    gamePhase: 'team_select',
    voteHistory: [
      vr(1, 1, 'P5', ['P5', 'P1'], false),
      vr(1, 2, 'P2', ['P2', 'P5'], false),
      vr(1, 3, 'P3', ['P3', 'P5'], false),
      vr(1, 4, 'P1', ['P1', 'P3'], false),
      vr(1, 5, 'P4', ['P4', 'P5'], true),
      vr(2, 1, 'P5', ['P5', 'P4', 'P2'], true),
      vr(3, 1, 'P2', ['P2', 'P1'], false),
      vr(3, 2, 'P3', ['P3', 'P1'], false),
      vr(3, 3, 'P1', ['P1', 'P2'], false),
      vr(3, 4, 'P4', ['P4', 'P3'], false),
      vr(3, 5, 'P5', ['P5', 'P3'], true),
      vr(4, 1, 'P2', ['P2', 'P3', 'P1'], false),
    ],
    questHistory: [
      { round: 1, team: ['P4', 'P5'], result: 'success', failCount: 0 },
      { round: 2, team: ['P5', 'P4', 'P2'], result: 'fail', failCount: 1 },
      { round: 3, team: ['P5', 'P3'], result: 'success', failCount: 0 },
    ],
    proposedTeam: [],
    lakeHistory: [],
  };
}

describe('ForwardAgent — team size invariant (self-play crash regression)', () => {
  // Self-play wires Percival knownEvils = both wizards; production
  // (GameServer.buildBotObservation) wires knownEvils = [].
  for (const [label, knownEvils] of [
    ['self-play wiring', ['P2', 'P4']],
    ['production wiring', []],
  ] as const) {
    it(`Percival fills a legal 3-member team when 鐵咬 empties the pool (${label})`, () => {
      const obs = crashObservation([...knownEvils]);
      const decision = new ForwardAgent('P3').decide(obs);
      expect(decision.action.type).toBe('team_select');
      if (decision.action.type !== 'team_select') return;
      const team = decision.action.teamIds;
      expect(team).toHaveLength(AVALON_CONFIG[5].questTeams[3]);
      expect(new Set(team).size).toBe(team.length);
      expect(team).toContain('P3');
      // The clean seat is still preferred over any excluded seat.
      expect(team).toContain('P1');
      // Forward pipeline handled it itself (no illegal-team fallback).
      expect(decision.reasoningTrace.usedFallback).toBe(false);
    });
  }

  it('self-play with ForwardAgent seats completes 5p / 6p / 8p games without a team-size error', async () => {
    const engine = new SelfPlayEngine();
    for (const playerCount of [5, 6, 8]) {
      for (let g = 0; g < 25; g++) {
        const agents = Array.from(
          { length: playerCount },
          (_, i) => new ForwardAgent(`F${i + 1}`),
        );
        const result = await engine.runGame(agents, false);
        expect(['good', 'evil']).toContain(result.winner);
      }
    }
  }, 60_000);
});
