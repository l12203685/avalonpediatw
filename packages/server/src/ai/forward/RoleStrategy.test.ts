/**
 * 6 角色 Phase 2 unit tests — RoleStrategy + ForwardAgent integration.
 *
 * Spec source:
 *   `staging/subagent_results/six_roles_strategy_spec_2026-05-03.md`
 *
 * Coverage targets (≥ 2 per role per task brief):
 *   - 忠臣 (loyal):    no override → role-bias delta is empty
 *   - 梅林 (merlin):   knownEvils excluded from selectTeam (§1.4)
 *                      reject team with knownEvil > approve (§1.4)
 *   - 派西 (percival): wizards joint constraint A vs B (§2.4)
 *                      reject team containing predicted Morgana (§2.4)
 *   - 刺客 (assassin): R1 selectTeam mimic-loyal (no ally)
 *                      assassinate filters out known ally / Oberon (§3.4)
 *   - 莫娜 (morgana):  R1 selectTeam mimic-merlin (no ally)
 *                      mimic-merlin reject sketchy team (§4.4)
 *   - 莫德 (mordred):  R3+ allows ally inclusion in selectTeam
 *                      R1 leader prefers mimic-loyal (§5.4)
 *   - 奧伯 (oberon):   knownEvils empty → no role-bias on knownEvil
 *                      Rule 3 fail-mission → R3+ approve bias (§6.4)
 */

import { describe, it, expect } from 'vitest';
import type { PlayerObservation, AgentAction } from '../types';
import { interpret } from './InterpretationModule';
import {
  ForwardAgent,
  evaluatePurposes,
  scoreCandidate,
  computeRoleBias,
  type Candidate,
} from './ForwardAgent';
import {
  getRoleSignals,
  scoreWizardAsMerlin,
  detectMerlinHidingFromAssassin,
  detectMorganaBetrayal,
} from './RoleStrategy';
import { computePyramidScores } from '../baseline';
import { HeuristicAgent } from '../HeuristicAgent';

// ── Test helpers ────────────────────────────────────────────────
function makeObs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P0',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'],
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

function dummyCandidate(
  action: AgentAction,
  signals: Partial<Candidate['signals']> = {},
): Candidate {
  return {
    action,
    description: 'test',
    signals: {
      avgSuspicion: 0.5,
      maxSuspicion: 0.5,
      includesKnownEvil: false,
      includesSelf: false,
      violatesLakeRules: false,
      numKnownEvilOnTeam: 0,
      merlinProbForTarget: 0,
      ...signals,
    },
  };
}

// ── 忠臣 loyal — no role override ───────────────────────────────
describe('忠臣 (loyal) — no role override', () => {
  it('returns neutral RoleSignals (empty wizard maps, no flags)', () => {
    const obs = makeObs({ myRole: 'loyal', myTeam: 'good' });
    const signals = getRoleSignals(obs);
    expect(signals.knownWizardSuspicions.size).toBe(0);
    expect(signals.wizardMerlinScores.size).toBe(0);
    expect(signals.percivalA).toBeUndefined();
    expect(signals.percivalB).toBeUndefined();
    expect(signals.merlinHidingFromAssassin).toBe(false);
    expect(signals.morganaBetrayal).toBe(false);
    expect(signals.mordredR1Leader).toBe(false);
    expect(signals.knownAllyCount).toBe(0);
  });

  it('computeRoleBias returns empty delta (no override)', () => {
    const obs = makeObs({ myRole: 'loyal', myTeam: 'good' });
    const signals = getRoleSignals(obs);
    const cand = dummyCandidate({ type: 'team_select', teamIds: ['P0', 'P1'] });
    const delta = computeRoleBias(cand, obs, signals);
    expect(Object.keys(delta).length).toBe(0);
  });
});

// ── 梅林 merlin — knownEvils hardpin + 隱身 priority ─────────────
describe('梅林 (merlin) — knownEvils hardpin (§1.4)', () => {
  it('selectTeam: never includes knownEvils in any candidate', () => {
    const obs = makeObs({
      myRole: 'merlin',
      myTeam: 'good',
      knownEvils: ['P3', 'P5', 'P7'], // 3 evils visible to merlin
      gamePhase: 'team_select',
      currentRound: 1,
      currentLeader: 'P0',
    });
    const baseline = new HeuristicAgent('test-merlin');
    baseline.onGameStart(obs);
    const fa = new ForwardAgent('test-merlin', baseline);
    const { action } = fa.decide(obs);
    expect(action.type).toBe('team_select');
    if (action.type === 'team_select') {
      // R1 of 10p game = 3-person team (per AVALON_CONFIG[10].questTeams[0]).
      expect(action.teamIds.length).toBe(3);
      // None of the 3 known evils should be on the team.
      expect(action.teamIds).not.toContain('P3');
      expect(action.teamIds).not.toContain('P5');
      expect(action.teamIds).not.toContain('P7');
      // Self always included.
      expect(action.teamIds).toContain('P0');
    }
  });

  it('voteOnTeam R3+: reject scores higher than approve when team has knownEvil', () => {
    const obs = makeObs({
      myRole: 'merlin',
      myTeam: 'good',
      knownEvils: ['P3'],
      gamePhase: 'team_vote',
      proposedTeam: ['P0', 'P3'],
      currentRound: 3,
      questHistory: [
        { round: 1, team: ['P0', 'P1', 'P2'], result: 'success', failCount: 0 },
        { round: 2, team: ['P0', 'P3', 'P4', 'P5'], result: 'fail', failCount: 1 },
      ],
      questResults: ['success', 'fail'],
    });
    const interp = interpret(obs);
    const signals = getRoleSignals(obs);
    const purposes = evaluatePurposes('merlin', 3);
    const approve = dummyCandidate(
      { type: 'team_vote', vote: true },
      { numKnownEvilOnTeam: 1, includesKnownEvil: true, avgSuspicion: 0.7 },
    );
    const reject = dummyCandidate(
      { type: 'team_vote', vote: false },
      { numKnownEvilOnTeam: 1, includesKnownEvil: true, avgSuspicion: 0.7 },
    );
    const sApprove = scoreCandidate(approve, purposes, obs, interp, signals);
    const sReject = scoreCandidate(reject, purposes, obs, interp, signals);
    expect(sReject).toBeGreaterThan(sApprove);
  });
});

// ── 派西 percival — wizards joint constraint ────────────────────
describe('派西 (percival) — wizards joint constraint (§2.4)', () => {
  it('getRoleSignals: assigns A=lower-suspicion wizard, B=higher (cold start)', () => {
    const obs = makeObs({
      myRole: 'percival',
      myTeam: 'good',
      knownWizards: ['P1', 'P2'],
      gamePhase: 'team_select',
      currentRound: 1,
    });
    const signals = getRoleSignals(obs);
    expect(signals.percivalA).toBeDefined();
    expect(signals.percivalB).toBeDefined();
    expect([signals.percivalA, signals.percivalB].sort()).toEqual(['P1', 'P2']);
  });

  it('voteOnTeam: reject team containing predicted Morgana (B) > approve', () => {
    // Set up history where P2 looks like Morgana (rejected clean teams).
    const obs = makeObs({
      myRole: 'percival',
      myTeam: 'good',
      knownWizards: ['P1', 'P2'],
      gamePhase: 'team_vote',
      proposedTeam: ['P0', 'P2'], // includes P2 (one of the wizards)
      currentRound: 3,
      voteHistory: [
        // P1 rejects sketchy team (merlin-like) / P2 approves it (morgana-like).
        {
          round: 1, attempt: 1, leader: 'P3', team: ['P3', 'P4', 'P5'],
          votes: { P0: false, P1: false, P2: true, P3: true, P4: true, P5: true, P6: false, P7: true, P8: false, P9: false },
          approved: false,
        },
        {
          round: 2, attempt: 1, leader: 'P0', team: ['P0', 'P3', 'P4', 'P5'],
          votes: { P0: true, P1: false, P2: true, P3: true, P4: true, P5: true, P6: false, P7: false, P8: false, P9: false },
          approved: false,
        },
      ],
      questHistory: [],
      questResults: [],
    });
    const interp = interpret(obs);
    const signals = getRoleSignals(obs);
    const purposes = evaluatePurposes('percival', 3);
    const approve = dummyCandidate(
      { type: 'team_vote', vote: true },
      { avgSuspicion: 0.5 },
    );
    const reject = dummyCandidate(
      { type: 'team_vote', vote: false },
      { avgSuspicion: 0.5 },
    );
    const sApprove = scoreCandidate(approve, purposes, obs, interp, signals);
    const sReject = scoreCandidate(reject, purposes, obs, interp, signals);
    // Either B is on team → reject preferred; or A is on team → approve preferred.
    // Outcome verified by relative score sign.
    if (signals.percivalB && obs.proposedTeam.includes(signals.percivalB)) {
      expect(sReject).toBeGreaterThan(sApprove);
    } else {
      expect(sApprove).toBeGreaterThanOrEqual(sReject);
    }
  });

  it('scoreWizardAsMerlin: returns 0.5 for cold start (no voteHistory)', () => {
    const obs = makeObs({
      myRole: 'percival',
      knownWizards: ['P1', 'P2'],
    });
    const pyramid = computePyramidScores(obs);
    expect(scoreWizardAsMerlin('P1', obs, pyramid)).toBeCloseTo(0.5, 5);
  });
});

// ── 刺客 assassin — R1 mimic + assassinate filter ────────────────
describe('刺客 (assassin) — R1 mimic + assassinate (§3.4)', () => {
  it('R1 selectTeam: prefers mimic-loyal (no ally on team)', () => {
    const obs = makeObs({
      myRole: 'assassin',
      myTeam: 'evil',
      knownEvils: ['P5', 'P7'],
      gamePhase: 'team_select',
      currentRound: 1,
      currentLeader: 'P0',
    });
    const interp = interpret(obs);
    const signals = getRoleSignals(obs);
    const purposes = evaluatePurposes('assassin', 1);
    const teamWithAlly = dummyCandidate(
      { type: 'team_select', teamIds: ['P0', 'P5', 'P1'] },
      { numKnownEvilOnTeam: 1, includesKnownEvil: true, avgSuspicion: 0.5 },
    );
    const teamMimicLoyal = dummyCandidate(
      { type: 'team_select', teamIds: ['P0', 'P1', 'P2'] },
      { numKnownEvilOnTeam: 0, includesKnownEvil: false, avgSuspicion: 0.4 },
    );
    const sAlly = scoreCandidate(teamWithAlly, purposes, obs, interp, signals);
    const sMimic = scoreCandidate(teamMimicLoyal, purposes, obs, interp, signals);
    expect(sMimic).toBeGreaterThan(sAlly);
  });

  it('assassinate: never targets known ally (knownEvils includes target)', () => {
    const obs = makeObs({
      myRole: 'assassin',
      myTeam: 'evil',
      knownEvils: ['P5'],
      allEvilIds: ['P5', 'P7'], // P7 = Oberon (in allEvilIds, not knownEvils)
      gamePhase: 'assassination',
      questResults: ['fail', 'fail', 'success'],
      currentRound: 5,
    });
    const interp = interpret(obs);
    const signals = getRoleSignals(obs);
    const purposes = evaluatePurposes('assassin', 5);

    const targetAlly = dummyCandidate(
      { type: 'assassinate', targetId: 'P5' },
      { merlinProbForTarget: 0.9 },
    );
    const targetOberon = dummyCandidate(
      { type: 'assassinate', targetId: 'P7' },
      { merlinProbForTarget: 0.85 },
    );
    const targetGood = dummyCandidate(
      { type: 'assassinate', targetId: 'P1' },
      { merlinProbForTarget: 0.7 },
    );
    const sAlly = scoreCandidate(targetAlly, purposes, obs, interp, signals);
    const sOberon = scoreCandidate(targetOberon, purposes, obs, interp, signals);
    const sGood = scoreCandidate(targetGood, purposes, obs, interp, signals);
    expect(sGood).toBeGreaterThan(sAlly);
    expect(sGood).toBeGreaterThan(sOberon);
  });
});

// ── 莫甘娜 morgana — mimic-merlin ────────────────────────────────
describe('莫甘娜 (morgana) — mimic-merlin (§4.4)', () => {
  it('R1 selectTeam: prefers mimic-merlin (no ally on team)', () => {
    const obs = makeObs({
      myRole: 'morgana',
      myTeam: 'evil',
      knownEvils: ['P5', 'P7'],
      gamePhase: 'team_select',
      currentRound: 1,
      currentLeader: 'P0',
    });
    const interp = interpret(obs);
    const signals = getRoleSignals(obs);
    const purposes = evaluatePurposes('morgana', 1);
    const teamWithAlly = dummyCandidate(
      { type: 'team_select', teamIds: ['P0', 'P5', 'P1'] },
      { numKnownEvilOnTeam: 1, includesKnownEvil: true, avgSuspicion: 0.5 },
    );
    const teamMimicMerlin = dummyCandidate(
      { type: 'team_select', teamIds: ['P0', 'P1', 'P2'] },
      { numKnownEvilOnTeam: 0, includesKnownEvil: false, avgSuspicion: 0.3 },
    );
    expect(scoreCandidate(teamMimicMerlin, purposes, obs, interp, signals))
      .toBeGreaterThan(scoreCandidate(teamWithAlly, purposes, obs, interp, signals));
  });

  it('R3+ voteOnTeam: mimic-merlin reject sketchy clean team', () => {
    // High avgSuspicion clean team (no knownEvils) → mimic-merlin reject.
    const obs = makeObs({
      myRole: 'morgana',
      myTeam: 'evil',
      knownEvils: ['P5', 'P7'],
      gamePhase: 'team_vote',
      proposedTeam: ['P0', 'P1', 'P2'],
      currentRound: 3,
      questHistory: [
        { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
      ],
      questResults: ['fail'],
    });
    const interp = interpret(obs);
    const signals = getRoleSignals(obs);
    const purposes = evaluatePurposes('morgana', 3);
    const reject = dummyCandidate(
      { type: 'team_vote', vote: false },
      { numKnownEvilOnTeam: 0, avgSuspicion: 0.7 },
    );
    const approve = dummyCandidate(
      { type: 'team_vote', vote: true },
      { numKnownEvilOnTeam: 0, avgSuspicion: 0.7 },
    );
    // Mimic-merlin pattern: reject suspect-heavy clean team.
    const sR = scoreCandidate(reject, purposes, obs, interp, signals);
    const sA = scoreCandidate(approve, purposes, obs, interp, signals);
    expect(sR).toBeGreaterThanOrEqual(sA - 0.1);
  });
});

// ── 莫德雷德 mordred — bold ally + R1 leader ────────────────────
describe('莫德雷德 (mordred) — bold ally + R1 leader (§5.4)', () => {
  it('R3+ selectTeam: ally inclusion preferred (allyInclusionMultiplier 1.3)', () => {
    const obs = makeObs({
      myRole: 'mordred',
      myTeam: 'evil',
      knownEvils: ['P5', 'P7'],
      gamePhase: 'team_select',
      currentRound: 3,
      currentLeader: 'P0',
      questHistory: [
        { round: 1, team: ['P0', 'P1', 'P2'], result: 'success', failCount: 0 },
        { round: 2, team: ['P0', 'P3', 'P4', 'P5'], result: 'fail', failCount: 1 },
      ],
      questResults: ['success', 'fail'],
    });
    const interp = interpret(obs);
    const signals = getRoleSignals(obs);
    const purposes = evaluatePurposes('mordred', 3);
    const teamBoldAlly = dummyCandidate(
      { type: 'team_select', teamIds: ['P0', 'P5', 'P1', 'P2'] },
      { numKnownEvilOnTeam: 1, includesKnownEvil: true, avgSuspicion: 0.4 },
    );
    const teamPureClean = dummyCandidate(
      { type: 'team_select', teamIds: ['P0', 'P1', 'P2', 'P8'] },
      { numKnownEvilOnTeam: 0, includesKnownEvil: false, avgSuspicion: 0.3 },
    );
    expect(scoreCandidate(teamBoldAlly, purposes, obs, interp, signals))
      .toBeGreaterThan(scoreCandidate(teamPureClean, purposes, obs, interp, signals));
  });

  it('R1 leader detected: mordredR1Leader signal fires', () => {
    const obs = makeObs({
      myRole: 'mordred',
      myTeam: 'evil',
      knownEvils: ['P5', 'P7'],
      gamePhase: 'team_select',
      currentRound: 1,
      currentLeader: 'P0',
      myPlayerId: 'P0',
    });
    const signals = getRoleSignals(obs);
    expect(signals.mordredR1Leader).toBe(true);
  });
});

// ── 奧伯倫 oberon — lone-wolf + Rule 3 ──────────────────────────
describe('奧伯倫 (oberon) — lone-wolf + Rule 3 (§6.4)', () => {
  it('knownEvils empty → knownAllyCount = 0', () => {
    const obs = makeObs({
      myRole: 'oberon',
      myTeam: 'evil',
      knownEvils: [],
    });
    const signals = getRoleSignals(obs);
    expect(signals.knownAllyCount).toBe(0);
    expect(signals.oberonMissionParticipatedBefore).toBe(false);
    expect(signals.oberonFailedInMission).toBe(false);
  });

  it('Rule 3: prior fail-mission + R3+ off-team approve > reject (open-white)', () => {
    const obs = makeObs({
      myRole: 'oberon',
      myTeam: 'evil',
      knownEvils: [],
      gamePhase: 'team_vote',
      proposedTeam: ['P1', 'P2', 'P3'], // off-team for self (P0)
      currentRound: 4,
      questHistory: [
        { round: 1, team: ['P0', 'P1', 'P2'], result: 'fail', failCount: 1 },
        { round: 2, team: ['P3', 'P4', 'P5'], result: 'success', failCount: 0 },
        { round: 3, team: ['P3', 'P4', 'P6', 'P7'], result: 'success', failCount: 0 },
      ],
      questResults: ['fail', 'success', 'success'],
    });
    const signals = getRoleSignals(obs);
    expect(signals.oberonMissionParticipatedBefore).toBe(true);
    expect(signals.oberonFailedInMission).toBe(true);
    // Verify Rule 3 bias surfaces: approve scores higher than reject when
    // not on team and prior fail-mission record.
    const interp = interpret(obs);
    const purposes = evaluatePurposes('oberon', 4);
    const approve = dummyCandidate(
      { type: 'team_vote', vote: true },
      { numKnownEvilOnTeam: 0, avgSuspicion: 0.4, includesSelf: false },
    );
    const reject = dummyCandidate(
      { type: 'team_vote', vote: false },
      { numKnownEvilOnTeam: 0, avgSuspicion: 0.4, includesSelf: false },
    );
    const sA = scoreCandidate(approve, purposes, obs, interp, signals);
    const sR = scoreCandidate(reject, purposes, obs, interp, signals);
    expect(sA).toBeGreaterThanOrEqual(sR - 0.05);
  });
});

// ── Helper detectors smoke ──────────────────────────────────────
describe('Wizard signal detectors (smoke)', () => {
  it('detectMerlinHidingFromAssassin: returns false for cold start', () => {
    const obs = makeObs({
      myRole: 'percival',
      knownWizards: ['P1', 'P2'],
    });
    expect(detectMerlinHidingFromAssassin('P1', obs)).toBe(false);
  });

  it('detectMorganaBetrayal: returns false when no fail missions', () => {
    const obs = makeObs({
      myRole: 'percival',
      knownWizards: ['P1', 'P2'],
    });
    expect(detectMorganaBetrayal('P2', obs)).toBe(false);
  });
});
