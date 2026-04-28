/**
 * Baseline tool unit tests — Edward 2026-04-28 Wave B.
 *
 * Covers:
 *   - suspectInference (failed-mission, outer-white, loyal union)
 *   - lakeChainTracker (4 hard rules + cycle SAT)
 *   - voteInferer (time-decay weight + vote/pick combination)
 *   - pyramidScorer (5-layer composition + cross-layer override)
 */

import { describe, it, expect } from 'vitest';
import type { PlayerObservation } from '../types';
import {
  getFailedMissionSuspects,
  getOuterWhiteApprovers,
  getLoyalSuspectSet,
} from './suspectInference';
import {
  analyzeLakeChain,
  findHardRuleViolations,
  checkHardRulesForLeader,
  findRule3Violators,
} from './lakeChainTracker';
import { layer4Score } from './voteInferer';
import {
  computePyramidScores,
  PYRAMID_HARD_RED,
  PYRAMID_HARD_BLUE,
  PYRAMID_VIOLATOR_FLOOR,
} from './pyramidScorer';

// Helper: shorten boilerplate for an observation.
function makeObs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P0',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 5,
    allPlayerIds: ['P0', 'P1', 'P2', 'P3', 'P4'],
    knownEvils: [],
    currentRound: 1,
    currentLeader: 'P0',
    failCount: 0,
    questResults: [],
    gamePhase: 'team_select',
    voteHistory: [],
    questHistory: [],
    proposedTeam: [],
    ...partial,
  };
}

describe('suspectInference', () => {
  it('getFailedMissionSuspects returns empty when no fails', () => {
    const obs = makeObs({});
    expect(getFailedMissionSuspects(obs).size).toBe(0);
  });

  it('getFailedMissionSuspects unions members across failed quests', () => {
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 },
        { round: 2, team: ['P2', 'P3'], result: 'success', failCount: 0 },
        { round: 3, team: ['P3', 'P4'], result: 'fail', failCount: 1 },
      ],
    });
    const s = getFailedMissionSuspects(obs);
    expect(s.has('P1')).toBe(true);
    expect(s.has('P2')).toBe(true);
    expect(s.has('P3')).toBe(true);
    expect(s.has('P4')).toBe(true);
    expect(s.size).toBe(4);
  });

  it('getOuterWhiteApprovers excludes self', () => {
    const obs = makeObs({
      myPlayerId: 'P0',
      voteHistory: [
        {
          round: 1,
          attempt: 1,
          leader: 'P0',
          team: ['P1', 'P2'],
          votes: { P0: true, P1: true, P2: true, P3: true, P4: false },
          approved: true,
        },
      ],
    });
    const o = getOuterWhiteApprovers(obs);
    expect(o.has('P0')).toBe(false); // self filtered
    expect(o.has('P3')).toBe(true);  // off-team approver
  });

  it('getLoyalSuspectSet unions failed-mission + outer-white', () => {
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 },
      ],
      voteHistory: [
        {
          round: 1,
          attempt: 1,
          leader: 'P0',
          team: ['P1', 'P2'],
          votes: { P0: true, P1: true, P2: true, P3: true, P4: false },
          approved: true,
        },
      ],
    });
    const s = getLoyalSuspectSet(obs);
    expect(s.has('P1')).toBe(true); // failed-mission member
    expect(s.has('P3')).toBe(true); // outer-white
    expect(s.has('P0')).toBe(false); // self excluded
  });
});

describe('lakeChainTracker', () => {
  it('analyzeLakeChain yields empty state on no records', () => {
    const obs = makeObs({});
    const state = analyzeLakeChain(obs);
    expect(state.records.length).toBe(0);
    expect(state.violators.size).toBe(0);
  });

  it('detects mutual contradiction (cycle SAT)', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 3, holderId: 'P2', targetId: 'P1', declaredClaim: 'evil' },
      ],
    });
    const state = analyzeLakeChain(obs);
    expect(state.violators.has('P1')).toBe(true);
    expect(state.violators.has('P2')).toBe(true);
  });

  it('硬1 — declared-blue MUST be on team led by declarer', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
      ],
    });
    const state = analyzeLakeChain(obs);
    // Team excludes P2 → 硬1 violation.
    const violations = findHardRuleViolations(state, 'P1', ['P0', 'P3']);
    expect(violations.find((v) => v.rule === 1 && v.targetId === 'P2')).toBeDefined();
  });

  it('硬2 — declared-red MUST NOT be on team led by declarer', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'evil' },
      ],
    });
    const state = analyzeLakeChain(obs);
    // Team includes P2 → 硬2 violation.
    const violations = findHardRuleViolations(state, 'P1', ['P1', 'P2']);
    expect(violations.find((v) => v.rule === 2 && v.targetId === 'P2')).toBeDefined();
  });

  it('checkHardRulesForLeader API surfaces must_include / must_exclude', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 3, holderId: 'P1', targetId: 'P3', declaredClaim: 'evil' },
      ],
    });
    const state = analyzeLakeChain(obs);
    expect(checkHardRulesForLeader(state, 'P1', 'P2', false)).toBe('must_include');
    expect(checkHardRulesForLeader(state, 'P1', 'P3', true)).toBe('must_exclude');
    expect(checkHardRulesForLeader(state, 'P1', 'P4', true)).toBe('ok');
  });

  it('findRule3Violators boosts holders who later excluded their endorsement', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
      ],
      voteHistory: [
        {
          round: 3,
          attempt: 1,
          leader: 'P1',
          team: ['P1', 'P3'], // excludes P2
          votes: { P0: true, P1: true, P2: true, P3: true, P4: false },
          approved: true,
        },
      ],
    });
    const state = analyzeLakeChain(obs);
    const r3 = findRule3Violators(state, obs);
    // P1 endorsed P2 then led a team without P2 → 硬3 violation.
    expect((r3.get('P1') ?? 0) >= 0.85).toBe(true);
  });
});

describe('voteInferer', () => {
  it('layer4Score is empty when no vote history', () => {
    const obs = makeObs({});
    expect(layer4Score(obs).size).toBe(0);
  });

  it('outer-white approvers get positive layer-4 score', () => {
    const obs = makeObs({
      voteHistory: [
        {
          round: 1,
          attempt: 1,
          leader: 'P0',
          team: ['P1', 'P2'],
          votes: { P0: true, P1: true, P2: true, P3: true, P4: false },
          approved: true,
        },
      ],
    });
    const s = layer4Score(obs);
    // P3 outer-white approved → positive score.
    expect((s.get('P3') ?? 0) > 0).toBe(true);
    // P4 rejected off-team → no anomaly score.
    expect(s.get('P4') ?? 0).toBe(0);
  });

  it('newer records weigh more (1.5x decay)', () => {
    // Two outer-white approvers, one in oldest record, one in newest.
    // Newest should have a strictly higher score than oldest.
    const obs = makeObs({
      voteHistory: [
        {
          round: 1,
          attempt: 1,
          leader: 'P0',
          team: ['P1', 'P2'],
          votes: { P0: true, P1: true, P2: true, P3: true, P4: false },
          approved: true,
        },
        {
          round: 2,
          attempt: 1,
          leader: 'P0',
          team: ['P1', 'P2'],
          votes: { P0: true, P1: true, P2: true, P3: false, P4: true },
          approved: true,
        },
      ],
    });
    const s = layer4Score(obs);
    // P3 only in record 1 (oldest), P4 only in record 2 (newest).
    expect((s.get('P4') ?? 0) > (s.get('P3') ?? 0)).toBe(true);
  });
});

describe('pyramidScorer', () => {
  it('built-in knownEvils pin at 1.0 (Q9 cross-layer override)', () => {
    const obs = makeObs({
      myRole: 'merlin',
      knownEvils: ['P3'],
    });
    const py = computePyramidScores(obs);
    expect(py.scores.get('P3')).toBe(PYRAMID_HARD_RED);
    expect(py.hardRed.has('P3')).toBe(true);
  });

  it('self pinned at 0.0 when good', () => {
    const obs = makeObs({});
    const py = computePyramidScores(obs);
    expect(py.scores.get('P0')).toBe(PYRAMID_HARD_BLUE);
  });

  it('lake violators boosted to ≥0.85', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 3, holderId: 'P2', targetId: 'P1', declaredClaim: 'evil' },
      ],
    });
    const py = computePyramidScores(obs);
    expect((py.scores.get('P1') ?? 0) >= PYRAMID_VIOLATOR_FLOOR).toBe(true);
    expect((py.scores.get('P2') ?? 0) >= PYRAMID_VIOLATOR_FLOOR).toBe(true);
  });

  it('failed-mission members nudged toward red but not pinned', () => {
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 },
      ],
    });
    const py = computePyramidScores(obs);
    // Both P1 and P2 above neutral 0.5, below 1.0.
    expect((py.scores.get('P1') ?? 0) > 0.5).toBe(true);
    expect((py.scores.get('P1') ?? 0) < 1.0).toBe(true);
  });
});
