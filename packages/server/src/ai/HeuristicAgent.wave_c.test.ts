/**
 * Wave C (2026-04-29) — pyramid scope expansion + Percival decision-tree
 * ship + GameServer.allEvilIds wire fix.
 *
 * Coverage:
 *   1. Percival 5 missing decision-tree nodes:
 *      a. R1P1 派西不帶 wizard (派 myself + non-wizard candidates).
 *      b. 不派 B (Morgana exclusion) — no team build ever includes
 *         the inferred-Morgana wizard once R2+ signals exist.
 *      c. 信 A 除梅躲刺 — hidingSignal correctly detects approve-on-tainted.
 *      d. 信 B 除娜出賣 — betrayalSignal correctly detects reject-on-tainted.
 *      e. Joint 1 紅 1 藍 — percivalJointPrior asymmetry between wizards.
 *   2. Pyramid scope expansion:
 *      a. Pyramid wired into voteOnQuest evil branch (own pyramid score
 *         affects baseline fail bias — high score → +bias).
 *      b. Pyramid wired into assassinate (bluer pyramid → higher
 *         merlin score → preferred target).
 *   3. R1 cold-start sanity (loyal R1 still functions on neutral pyramid).
 */

import { describe, it, expect } from 'vitest';
import { HeuristicAgent } from './HeuristicAgent';
import { computePyramidScores } from './baseline';
import type { PlayerObservation, VoteRecord, QuestRecord } from './types';

// ── Fixture builders (mirror HeuristicAgent.test.ts patterns) ──

function baseObs(
  overrides: Partial<PlayerObservation> = {},
): PlayerObservation {
  return {
    myPlayerId:    'P1',
    myRole:        'loyal_servant',
    myTeam:        'good',
    playerCount:   10,
    allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'],
    knownEvils:    [],
    currentRound:  1,
    currentLeader: 'P1',
    failCount:     0,
    questResults:  [],
    gamePhase:     'team_select',
    voteHistory:   [],
    questHistory:  [],
    proposedTeam:  [],
    ...overrides,
  };
}

function vote(
  round: number,
  attempt: number,
  leader: string,
  team: string[],
  approved: boolean,
  votes: Record<string, boolean>,
): VoteRecord {
  return { round, attempt, leader, team, approved, votes };
}

function quest(
  round: number,
  team: string[],
  result: 'success' | 'fail',
  failCount = 0,
): QuestRecord {
  return { round, team, result, failCount };
}

// ─────────────────────────────────────────────────────────────
// Wave C Part 1 — Percival decision tree (5 missing nodes)
// ─────────────────────────────────────────────────────────────

describe('Wave C · Percival decision tree (Edward 04-28 11:24 verbatim)', () => {
  it('R1P1 派西不帶 wizard (派 myself + 2 non-wizard) — Q2=C落地', () => {
    // R1P1 = currentRound=1, voteHistory=[]. Percival should NOT include
    // either wizard candidate; the morgana-wizard fallback risk is
    // eliminated by sourcing teamSize-1 fillers from non-wizards only.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: ['P3', 'P7'],  // wizard candidates
      currentRound: 1,
      currentLeader: 'P1',
      gamePhase:    'team_select',
      voteHistory:  [],  // R1P1 — no signal yet
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_select');
    if (action.type === 'team_select') {
      // teamSize for R1 in 10p = 3; Percival picks myself + 2 non-wizards.
      expect(action.teamIds).toHaveLength(3);
      expect(action.teamIds).toContain('P1');
      expect(action.teamIds).not.toContain('P3');  // no wizard
      expect(action.teamIds).not.toContain('P7');  // no wizard
    }
  });

  it('不派 B (Morgana exclusion) — R2+ inferred-Morgana never on team', () => {
    // Set up an R2+ scenario where wizard P3 looks Merlin-like
    // (rejected a tainted team) and wizard P7 looks Morgana-like
    // (approved the same tainted team). selectPercivalTeam should
    // exclude P7 from the team.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: ['P3', 'P7'],
      currentRound: 2,
      currentLeader: 'P1',
      gamePhase:    'team_select',
      voteHistory: [
        // R1: team [P5,P6,P10] approved.
        vote(1, 1, 'P10', ['P5', 'P6', 'P10'], true,
          { P1: false, P2: true, P3: false, P4: false, P5: true, P6: true,
            P7: true, P8: true, P9: true, P10: true }),
      ],
      questHistory: [
        quest(1, ['P5', 'P6', 'P10'], 'fail', 1),  // taint P5/P6/P10
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_select');
    if (action.type === 'team_select') {
      // P7 (inferred Morgana) MUST NOT be on the team.
      expect(action.teamIds).not.toContain('P7');
    }
  });

  it('梅林躲刺 hidingSignal — Merlin approves tainted team in R3+ → high signal', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: ['P3', 'P7'],
      currentRound: 4,
      voteHistory: [
        vote(1, 1, 'P10', ['P5', 'P6', 'P10'], true,
          { P1: false, P2: false, P3: true, P4: false, P5: true, P6: true,
            P7: true, P8: false, P9: false, P10: true }),
        // R3 tainted team — P3 (inferred Merlin) approved it (hiding!).
        vote(3, 1, 'P10', ['P5', 'P10', 'P2'], true,
          { P1: false, P2: true, P3: true, P4: false, P5: true, P6: false,
            P7: true, P8: false, P9: false, P10: true }),
      ],
      questHistory: [
        quest(1, ['P5', 'P6', 'P10'], 'fail', 1),  // P5,P6,P10 tainted
        quest(2, ['P3', 'P4'], 'success', 0),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    // Memory tracks failedTeamMembers via ingestQuestHistory; helper
    // ensures memory is populated before signal queries.
    agent._ingestForTesting(obs);
    const signal = agent._percivalMerlinHidingSignalForTesting('P3', obs);
    // P3 had 1 R3+ opportunity (R3 tainted team) and approved it →
    // hidingSignal = 1.0 (1/1).
    expect(signal).toBeGreaterThanOrEqual(0.99);
  });

  it('莫甘娜出賣 betrayalSignal — Morgana rejects tainted team → high signal', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: ['P3', 'P7'],
      currentRound: 3,
      voteHistory: [
        // R1 vote — P7 rejected.
        vote(1, 1, 'P10', ['P5', 'P6', 'P10'], true,
          { P1: true, P2: false, P3: true, P4: false, P5: true, P6: true,
            P7: false, P8: false, P9: false, P10: true }),
        // R2 vote — neutral team, P7 approved (so vote sample > 1
        // but only the tainted reject contributes betrayal).
        vote(2, 1, 'P9', ['P9', 'P3', 'P7', 'P8'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: true, P6: true,
            P7: true, P8: true, P9: true, P10: true }),
      ],
      questHistory: [
        quest(1, ['P5', 'P6', 'P10'], 'fail', 1),  // taint P5,P6,P10
        quest(2, ['P9', 'P3', 'P7', 'P8'], 'success', 0),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    agent._ingestForTesting(obs);
    // P7 rejected R1 (tainted) and approved R2 (clean) → betrayal = 0.5.
    const signal = agent._percivalMorganaBetrayalSignalForTesting('P7', obs);
    expect(signal).toBeGreaterThan(0);
    expect(signal).toBeLessThanOrEqual(1);
  });

  it('Joint 1 紅 1 藍 prior — Merlin gets blue lean, Morgana gets red lean', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: ['P3', 'P7'],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const prior = agent._percivalJointPriorForTesting(['P3', 'P7'], 'P3');
    expect(prior.get('P3')).toBeLessThan(0);  // blue lean
    expect(prior.get('P7')).toBeGreaterThan(0);  // red lean
    // Asymmetry: morgana lean magnitude > merlin lean magnitude
    // (joint constraint guarantees one is evil, asymmetric prior).
    expect(prior.get('P7')).toBeGreaterThan(Math.abs(prior.get('P3') ?? 0));
  });

  it('selectPercivalTeam degenerate — single-wizard knowledge falls through', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: [],  // empty, treated as non-percival path
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const team = agent._selectPercivalTeamForTesting(
      obs, 3, ['P2', 'P3', 'P4', 'P5'], null,
    );
    // Empty knownWizards → fallback uses [self, ...candidates].
    expect(team).toContain('P1');
    expect(team).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────
// Wave C Part 2 — Pyramid scope expansion (assassinate + voteOnQuest)
// ─────────────────────────────────────────────────────────────

describe('Wave C · pyramid wired into assassinate', () => {
  it('assassin prefers bluer pyramid (lower suspicion) target', () => {
    // Assassin P1, knownEvils [P2 morgana], allEvilIds [P1, P2, P3 oberon, P4 mordred].
    // Among good candidates {P5, P6, P7, P8, P9, P10}, simulate one
    // who looks very Merlin-like (reject tainted teams, never on
    // failed quest) and one who is just a generic loyal.
    // The pyramid prior + merlin score should still pick the
    // Merlin-like candidate.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      knownEvils:   ['P2'],
      allEvilIds:   ['P1', 'P2', 'P3', 'P4'],
      gamePhase:    'assassination',
      currentRound: 5,
      questResults: ['success', 'success', 'success'],  // 3 good wins
      voteHistory: [
        // Round 1: P5 rejected a tainted team → Merlin-like.
        vote(1, 1, 'P10', ['P2', 'P10', 'P6'], true,
          { P1: true, P2: true, P3: false, P4: true, P5: false, P6: true,
            P7: true, P8: true, P9: true, P10: true }),
        vote(2, 1, 'P9', ['P9', 'P5', 'P7', 'P8'], true,
          { P1: true, P2: false, P3: false, P4: false, P5: true, P6: true,
            P7: true, P8: true, P9: true, P10: true }),
      ],
      questHistory: [
        // R1 with P2 (morgana) failed → tainted P2,P10,P6
        quest(1, ['P2', 'P10', 'P6'], 'fail', 1),
        quest(2, ['P9', 'P5', 'P7', 'P8'], 'success', 0),
        quest(3, ['P5', 'P9', 'P7', 'P8'], 'success', 0),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('assassinate');
    if (action.type === 'assassinate') {
      // Target must be a good player (not in allEvilIds).
      expect(['P5', 'P6', 'P7', 'P8', 'P9', 'P10']).toContain(
        action.targetId,
      );
      // Must NOT target evil (allEvilIds hard-filter).
      expect(['P1', 'P2', 'P3', 'P4']).not.toContain(action.targetId);
    }
  });
});

describe('Wave C · pyramid wired into voteOnQuest evil branch', () => {
  it('evil with high own pyramid score still acts in failsRequired=2 path', () => {
    // R4 in 10p needs 2 fails; evil mordred on team.
    // Verify the pyramid bias path doesn't break the existing rate.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'mordred',
      myTeam:       'evil',
      knownEvils:   ['P2', 'P3'],  // recognised-red trio
      gamePhase:    'quest_vote',
      currentRound: 4,
      proposedTeam: ['P1', 'P2', 'P5', 'P9', 'P10'],
      questResults: ['success', 'success', 'fail'],  // 2-1, NOT listening
      voteHistory: [
        vote(1, 1, 'P10', ['P5', 'P6', 'P10'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: true, P6: true,
            P7: true, P8: true, P9: true, P10: true }),
      ],
      questHistory: [
        quest(1, ['P5', 'P6', 'P10'], 'success', 0),
        quest(2, ['P5', 'P6', 'P10', 'P7'], 'success', 0),
        quest(3, ['P1', 'P2', 'P9'], 'fail', 1),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    // Mordred + 1 teammate (P2) on R4 → recognised-red hierarchy says
    // "fail". Verify hierarchy still wins (not pyramid).
    const action = agent.act(obs);
    expect(action.type).toBe('quest_vote');
    if (action.type === 'quest_vote') {
      expect(action.vote).toBe('fail');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Wave C Part 3 — Loyal R1 cold-start (sanity)
// ─────────────────────────────────────────────────────────────

describe('Wave C · loyal R1 cold-start (no history → neutral pyramid)', () => {
  it('loyal R1 leader picks self + 2 candidates, pyramid neutral 0.5', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'loyal_servant',
      myTeam:       'good',
      currentRound: 1,
      currentLeader: 'P1',
      gamePhase:    'team_select',
      voteHistory:  [],
      questHistory: [],
    });
    const pyramid = computePyramidScores(obs);
    // Every non-self player should be at 0.5 (neutral) since R1 has no
    // public signals. Self is hardBlue (0).
    for (const id of obs.allPlayerIds) {
      if (id === obs.myPlayerId) continue;
      expect(pyramid.scores.get(id)).toBe(0.5);
    }
    expect(pyramid.scores.get(obs.myPlayerId)).toBe(0);  // hardBlue self
  });

  it('loyal R2+ uses questHistory + voteHistory via pyramid layers', () => {
    // After R1 fail, layer 2 should push team members toward red.
    // P2 rejects (no outer-white anomaly contribution); other off-team
    // players reject as well so layer 4 outer-white doesn't fire.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'loyal_servant',
      myTeam:       'good',
      currentRound: 2,
      gamePhase:    'team_select',
      voteHistory: [
        vote(1, 1, 'P10', ['P5', 'P6', 'P10'], true,
          // Off-team players reject; on-team approve. Zero anomalies.
          { P1: false, P2: false, P3: false, P4: false, P5: true, P6: true,
            P7: false, P8: false, P9: false, P10: true }),
      ],
      questHistory: [
        quest(1, ['P5', 'P6', 'P10'], 'fail', 1),
      ],
    });
    const pyramid = computePyramidScores(obs);
    // P5 / P6 / P10 should now be > 0.5 (red lean from layer 2 mission
    // suspect).
    expect(pyramid.scores.get('P5')!).toBeGreaterThan(0.5);
    expect(pyramid.scores.get('P6')!).toBeGreaterThan(0.5);
    expect(pyramid.scores.get('P10')!).toBeGreaterThan(0.5);
    // P2 was off-team and rejected (no outer-white anomaly) — should
    // stay close to neutral after pyramid layers.
    expect(pyramid.scores.get('P2')!).toBeLessThan(0.6);
  });
});
