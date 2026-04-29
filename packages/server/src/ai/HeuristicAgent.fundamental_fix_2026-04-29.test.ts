/**
 * Edward 2026-04-29 13:35 — fundamental AI bugs found from 1 self-play game.
 *
 * Bug 1 (this file): leader auto-approves their own team unless a hard rule
 * (lake 硬1/硬2) violation exists. Pre-fix the leader fell through to the
 * generic suspicion-threshold path, where a pyramid neutral 0.47 average
 * could push them to reject their OWN team — absurd because the team is
 * what they themselves picked and includes themselves.
 *
 * Bug 2 (covered by SelfPlayEngine.lake.test.ts) — lake target prefers
 * LOW red suspicion, not high.
 */

import { describe, it, expect } from 'vitest';
import { HeuristicAgent } from './HeuristicAgent';
import type { PlayerObservation } from './types';

function baseObs(overrides: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId:    'P1',
    myRole:        'loyal',
    myTeam:        'good',
    playerCount:   10,
    allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'],
    knownEvils:    [],
    currentRound:  3,
    currentLeader: 'P1',
    failCount:     0,
    questResults:  [],
    gamePhase:     'team_vote',
    voteHistory:   [],
    questHistory:  [],
    proposedTeam:  [],
    ...overrides,
  };
}

describe('Edward 2026-04-29 fundamental fix #1 — leader auto-approves own team', () => {
  it('good leader approves their own team even when no signal exists', () => {
    // R3, no history. Pre-fix: pyramid neutral 0.5 + legacy 0 →
    // average suspicion = 0 → on-team threshold check could still
    // trigger reject under noise. Post-fix: short-circuit approve.
    const obs = baseObs({
      myPlayerId:    'P1',
      myTeam:        'good',
      myRole:        'loyal',
      currentLeader: 'P1', // SELF
      proposedTeam:  ['P1', 'P5', 'P9'],
      currentRound:  3,
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(true);
    }
  });

  it('good leader approves own team even on R3+ when avg-suspicion would reject', () => {
    // Construct a scenario where the leader's own team contains
    // pyramid-suspicious members (members of failed missions). Pre-fix
    // logic would reject. Post-fix: leader's own pick auto-approves.
    const obs = baseObs({
      myPlayerId:    'P1',
      myTeam:        'good',
      myRole:        'loyal',
      currentLeader: 'P1', // SELF
      proposedTeam:  ['P1', 'P2', 'P3'],
      currentRound:  3,
      questHistory: [
        // P2, P3 on a previously-failed mission → pyramid scores
        // them as red, would normally drive avg-suspicion above the
        // strict-reject threshold for an on-team good player. But
        // since I (P1) AM the leader, I picked this team — auto-approve.
        { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 1 },
      ],
      voteHistory: [
        // Approval record for the failing R1 attempt to give the
        // pyramid layer-4 some signal.
        {
          round: 1, attempt: 1, leader: 'P4',
          team: ['P2', 'P3', 'P4'], approved: true,
          votes: {
            P1: false, P2: true, P3: true, P4: true,
            P5: true,  P6: false, P7: false, P8: true,
            P9: false, P10: true,
          },
        },
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(true);
    }
  });

  it('non-leader good player still uses normal logic (regression guard)', () => {
    // Sanity: if the leader is someone else, the standard threshold
    // logic kicks in. We don't assert a specific outcome here because
    // it depends on the tuned thresholds; we just check the behaviour
    // PATH is not the leader-self short-circuit (i.e. action shape is
    // a vote and the function returned without crashing).
    const obs = baseObs({
      myPlayerId:    'P1',
      myTeam:        'good',
      myRole:        'loyal',
      currentLeader: 'P3', // NOT self
      proposedTeam:  ['P3', 'P5', 'P7'],
      currentRound:  3,
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    // No specific value assertion — behaviour depends on baseline.
    if (action.type === 'team_vote') {
      expect(typeof action.vote).toBe('boolean');
    }
  });

  it('leader-self does NOT auto-approve when hard lake rule violated (precedence)', () => {
    // Hard rule check sits ABOVE the leader-self short-circuit, so a
    // team that violates 硬1 (declared-blue B excluded) MUST still
    // reject — even when self is the leader. This protects the
    // already-shipped Wave B / post-fix invariant.
    const obs = baseObs({
      myPlayerId:    'P1',
      myTeam:        'good',
      myRole:        'loyal',
      currentLeader: 'P1', // SELF leader
      proposedTeam:  ['P1', 'P5', 'P9'], // includes P5 but excludes P7
      currentRound:  3,
      lakeHistory: [
        // P5 declared P7 blue → 硬1 says any team with P5 must include P7.
        { round: 2, holderId: 'P5', targetId: 'P7', declaredClaim: 'good' },
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(false);
    }
  });

  it('evil leader also auto-approves own team (cross-faction)', () => {
    // Edward's spec: leaderId === myId → APPROVE unless hard rule
    // violation. Applies to ALL factions — a red leader will not
    // self-vote against their own pick. (The strategic incentive for
    // red is also to push their own team through.)
    const obs = baseObs({
      myPlayerId:    'P1',
      myTeam:        'evil',
      myRole:        'assassin',
      currentLeader: 'P1', // SELF
      knownEvils:    ['P1', 'P5'],
      proposedTeam:  ['P1', 'P3', 'P7'],
      currentRound:  3,
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(true);
    }
  });

  it('R1-R2 cross-faction guard still functions for non-leader players', () => {
    // Regression guard: the leader-self short-circuit should NOT
    // disturb the existing R1/R2 cross-faction anomaly suppression
    // for non-leader players.
    const obs = baseObs({
      myPlayerId:    'P1',
      myTeam:        'good',
      myRole:        'loyal',
      currentLeader: 'P3', // NOT self
      proposedTeam:  ['P3', 'P5', 'P7'],
      currentRound:  1,
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    // R1 off-team → should reject (Edward batch-2 rule preserved).
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(false);
    }
  });
});
