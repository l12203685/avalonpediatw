/**
 * Edward 2026-04-29 post-fix — universal lake hard-rule integration.
 *
 * Validates the wired behaviour after the lakeChainTracker change:
 *
 *   1. `voteOnTeam` rejects teams whose ANY member's lake declarations
 *      are violated by the proposed roster (硬1 transitive enforcement).
 *      Pre-fix only the leader's declarations were checked.
 *
 *   2. Players inside a violating team also reject (Bug 3 — internal
 *      black). The reject path triggers regardless of self-on-team.
 *
 *   3. `selectTeam` (good loyal branch) avoids producing teams that
 *      embed declared-blue/red contradictions among non-leader members.
 *
 *   4. Red exception (Q11) — when `mayBreakHardRules(obs)` opens for a
 *      recognised-red role (evilWins>=2 or R5+1fail), the lake check
 *      stands down and the agent reverts to normal evil cover logic.
 */

import { describe, it, expect } from 'vitest';
import { HeuristicAgent } from './HeuristicAgent';
import type { PlayerObservation } from './types';

// Fixture: 10-player observation skeleton.
function baseObs(overrides: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId:    'P1',
    myRole:        'loyal',
    myTeam:        'good',
    playerCount:   10,
    allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'],
    knownEvils:    [],
    currentRound:  3,
    currentLeader: 'P3',
    failCount:     0,
    questResults:  ['success', 'fail'],
    gamePhase:     'team_vote',
    voteHistory:   [],
    questHistory:  [],
    proposedTeam:  [],
    ...overrides,
  };
}

describe('Edward 2026-04-29 post-fix — universal lake hard-rule', () => {
  it('voteOnTeam rejects when any member (NOT only leader) violates 硬1', () => {
    // Player P5 declared P7 blue at R2 lake. Leader P3 picks team
    // [P3, P5, P8, P9] which includes P5 but excludes P7 → 硬1 transitive
    // violation. Pre-fix this would pass because P3 (the leader) had no
    // declarations of their own.
    const obs = baseObs({
      myPlayerId:    'P9', // ON team (loyal good)
      myRole:        'loyal',
      currentLeader: 'P3',
      proposedTeam:  ['P3', 'P5', 'P8', 'P9'],
      currentRound:  3,
      gamePhase:     'team_vote',
      lakeHistory: [
        { round: 2, holderId: 'P5', targetId: 'P7', declaredClaim: 'good' },
      ],
    });
    const agent = new HeuristicAgent('P9');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(false);
    }
  });

  it('voteOnTeam rejects 硬2 transitive (declared-red co-team)', () => {
    // P5 declared P7 red at R2 lake. Team [P3, P5, P7, P9] has both →
    // 硬2 violation.
    const obs = baseObs({
      myPlayerId:    'P10', // off-team good observer
      myRole:        'loyal',
      currentLeader: 'P3',
      proposedTeam:  ['P3', 'P5', 'P7', 'P9'],
      currentRound:  3,
      gamePhase:     'team_vote',
      lakeHistory: [
        { round: 2, holderId: 'P5', targetId: 'P7', declaredClaim: 'evil' },
      ],
    });
    const agent = new HeuristicAgent('P10');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(false);
    }
  });

  it('voteOnTeam — innocent good player ON the violating team also rejects (Bug 3)', () => {
    // Pre-fix Bug 3: a good player on a violating team would not open
    // inner-black even though the team obviously contradicts the lake.
    // Post-fix the universal sweep triggers reject regardless of self
    // being on team.
    const obs = baseObs({
      myPlayerId:    'P3', // ON team, loyal good (the leader actually)
      myRole:        'loyal',
      currentLeader: 'P3',
      proposedTeam:  ['P3', 'P5', 'P8', 'P9'], // P5 declared P7 blue, P7 missing
      currentRound:  3,
      gamePhase:     'team_vote',
      lakeHistory: [
        { round: 2, holderId: 'P5', targetId: 'P7', declaredClaim: 'good' },
      ],
    });
    const agent = new HeuristicAgent('P3');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(false); // inner-black on violating team
    }
  });

  it('Red exception (Q11) — assassin at evilWins>=2 bypasses lake reject', () => {
    // P5 declared P7 blue. Team [P3, P5, P9, P10] missing P7 → 硬1.
    // BUT myRole=assassin, evilWins=2 (R1+R2 fails) → mayBreakHardRules
    // opens. Lake check skipped. Normal evil branch runs.
    //
    // Sample many votes — assassin's normal evil branch has stochastic
    // inner-black probability, so the assertion is "majority approve"
    // (i.e. lake reject is NOT the dominant path), not a strict equality.
    const obs = baseObs({
      myPlayerId:    'P5',
      myRole:        'assassin',
      myTeam:        'evil',
      knownEvils:    ['P5', 'P8'],
      currentLeader: 'P3',
      proposedTeam:  ['P3', 'P5', 'P9', 'P10'],
      currentRound:  3,
      gamePhase:     'team_vote',
      questResults:  ['fail', 'fail'],
      lakeHistory: [
        { round: 2, holderId: 'P5', targetId: 'P7', declaredClaim: 'good' },
      ],
    });
    let approveCount = 0;
    const samples = 200;
    for (let i = 0; i < samples; i++) {
      const agent = new HeuristicAgent('P5');
      agent.onGameStart(obs);
      const action = agent.act(obs);
      if (action.type === 'team_vote' && action.vote === true) approveCount++;
    }
    // If lake check were firing, approve rate would be ~0%. With Q11
    // exception the assassin runs normal evil cover (hasSelf → approve)
    // with small inner-black flip probability — overwhelmingly approve.
    expect(approveCount / samples).toBeGreaterThan(0.5);
  });

  it('selectTeam — good leader does not produce team that violates 硬1 via non-self holder', () => {
    // Edward bug 2/4 scenario: P5 declared P7 blue at R2 lake. Leader
    // P3 should NOT produce a team that includes P5 without P7.
    // Pre-fix: filter only checked leader's own declarations.
    // Post-fix: fixupTeamHardRules sweep ensures any holder's
    // declarations are honoured.
    const obs = baseObs({
      myPlayerId:    'P3',
      myRole:        'loyal',
      currentLeader: 'P3',
      currentRound:  3,
      gamePhase:     'team_select',
      proposedTeam:  [],
      questResults:  ['success', 'fail'],
      lakeHistory: [
        { round: 2, holderId: 'P5', targetId: 'P7', declaredClaim: 'good' },
      ],
      questHistory: [
        { round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 },
        { round: 2, team: ['P5', 'P6', 'P9'], result: 'fail', failCount: 1 },
      ],
    });
    const agent = new HeuristicAgent('P3');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_select');
    if (action.type === 'team_select') {
      const team = action.teamIds;
      // If team includes P5 (the holder), it MUST also include P7.
      if (team.includes('P5')) {
        expect(team.includes('P7')).toBe(true);
      }
    }
  });
});
