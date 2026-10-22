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
  findTeamHardRuleViolations,
  checkHardRulesForLeader,
  findRule3Violators,
  setRule3DiagnosticOptions,
} from './lakeChainTracker';
import { layer4Score } from './voteInferer';
import {
  computePyramidScores,
  PYRAMID_HARD_RED,
  PYRAMID_HARD_BLUE,
  PYRAMID_VIOLATOR_FLOOR,
} from './pyramidScorer';
import { LEGACY_BELIEF_OPTIONS } from '../belief/BeliefOptions';
import { CERTAINTY_EPS } from '../belief/Certainty';

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

  it('no cycle tagging (S1-11, 2026-10-14): a lake target can never be an earlier holder', () => {
    // This record is impossible in a real game (path rule C7: P1 held the
    // lake, so P2 cannot inspect P1). The old cycle detection tagged both;
    // it could never fire on a legal record and is gone. Contradictions are
    // the certainty layer's job (belief/Certainty.ts).
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 3, holderId: 'P2', targetId: 'P1', declaredClaim: 'evil' },
      ],
    });
    const state = analyzeLakeChain(obs);
    expect(state.violators.size).toBe(0);
    expect(state.declaredBlueByHolder.get('P1')?.has('P2')).toBe(true);
    expect(state.declaredRedByHolder.get('P2')?.has('P1')).toBe(true);
  });

  it('undeclared lakes (declaredClaim none, S1-9c) carry no claim', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'none' },
        { round: 3, holderId: 'P2', targetId: 'P3', declaredClaim: 'good' },
      ],
    });
    const state = analyzeLakeChain(obs);
    expect(state.records).toHaveLength(1);
    expect(state.declaredBlueByHolder.has('P1')).toBe(false);
    expect(state.declaredRedByHolder.has('P1')).toBe(false);
    expect(state.declaredBlueByHolder.get('P2')?.has('P3')).toBe(true);
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

  it('findTeamHardRuleViolations — 硬1 transitive: any team member binds 硬1', () => {
    // Edward 2026-04-29 post-fix scenario:
    //   湖中 0>2 o (P0 declared P2 blue)
    //   Leader P3 picks team [P3, P0, P6, P9] — contains P0 but not P2
    //   → 硬1 violation (transitive): including P0 forces P2.
    const obs = makeObs({
      lakeHistory: [
        { round: 1, holderId: 'P0', targetId: 'P2', declaredClaim: 'good' },
      ],
    });
    const state = analyzeLakeChain(obs);
    const violations = findTeamHardRuleViolations(state, ['P3', 'P0', 'P6', 'P9']);
    expect(
      violations.find(
        (v) => v.rule === 1 && v.holderId === 'P0' && v.targetId === 'P2',
      ),
    ).toBeDefined();
  });

  it('findTeamHardRuleViolations — 硬2 transitive: any team member binds 硬2', () => {
    // Edward 2026-04-29 post-fix scenario:
    //   湖中 2>4 x (P2 declared P4 red)
    //   Leader picks team [P3, P2, P4, P9] — contains both P2 and P4
    //   → 硬2 violation (transitive): including P2 with P4 contradicts.
    const obs = makeObs({
      lakeHistory: [
        { round: 1, holderId: 'P2', targetId: 'P4', declaredClaim: 'evil' },
      ],
    });
    const state = analyzeLakeChain(obs);
    const violations = findTeamHardRuleViolations(state, ['P3', 'P2', 'P4', 'P9']);
    expect(
      violations.find(
        (v) => v.rule === 2 && v.holderId === 'P2' && v.targetId === 'P4',
      ),
    ).toBeDefined();
  });

  it('findTeamHardRuleViolations — clean team yields empty', () => {
    // Two declarations, but the proposed team avoids both 硬1 + 硬2.
    const obs = makeObs({
      lakeHistory: [
        { round: 1, holderId: 'P0', targetId: 'P2', declaredClaim: 'good' },
        { round: 2, holderId: 'P2', targetId: 'P4', declaredClaim: 'evil' },
      ],
    });
    const state = analyzeLakeChain(obs);
    // Team includes P0 + P2 (硬1 satisfied) and excludes P4 (硬2 OK).
    const violations = findTeamHardRuleViolations(state, ['P0', 'P2', 'P3']);
    expect(violations.length).toBe(0);
  });

  it('findTeamHardRuleViolations — multiple holders scanned independently', () => {
    // Bug 2/4 root: leader-only check (`findHardRuleViolations`) would
    // miss a non-leader's declarations. Universal sweep catches both.
    const obs = makeObs({
      lakeHistory: [
        { round: 1, holderId: 'P0', targetId: 'P2', declaredClaim: 'good' },
        { round: 2, holderId: 'P5', targetId: 'P7', declaredClaim: 'evil' },
      ],
    });
    const state = analyzeLakeChain(obs);
    // Leader P3, team contains P0 (no P2) AND P5+P7 → both rules fire.
    const violations = findTeamHardRuleViolations(
      state,
      ['P3', 'P0', 'P5', 'P7'],
    );
    expect(violations.find((v) => v.rule === 1 && v.holderId === 'P0')).toBeDefined();
    expect(violations.find((v) => v.rule === 2 && v.holderId === 'P5')).toBeDefined();
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

  it('setRule3DiagnosticOptions (diagnosis script only): off / holderFilter / postLakeOnly', () => {
    const vote = (round: number, leader: string, team: string[]) => ({
      round, attempt: 1, leader, team, approved: true,
      votes: { P0: true, P1: true, P2: true, P3: true, P4: true },
    });
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 2, holderId: 'P3', targetId: 'P4', declaredClaim: 'good' },
      ],
      voteHistory: [
        vote(1, 'P1', ['P1', 'P3']), // P1 left P2 off before the lake
        vote(3, 'P3', ['P3', 'P0']), // P3 left P4 off after the lake
      ],
    });
    const state = analyzeLakeChain(obs);
    // The legacy rule (batch 1C's `rule3PostLakeOnly` off): every team the holder ever led.
    const flagged = (): string[] =>
      [...findRule3Violators(state, obs, LEGACY_BELIEF_OPTIONS)].filter(([, v]) => v >= 0.85).map(([id]) => id).sort();
    expect(flagged()).toEqual(['P1', 'P3']);
    try {
      setRule3DiagnosticOptions({ off: true });
      expect(findRule3Violators(state, obs, LEGACY_BELIEF_OPTIONS).size).toBe(0);
      setRule3DiagnosticOptions({ holderFilter: (id) => id === 'P3' });
      expect(flagged()).toEqual(['P3']);
      setRule3DiagnosticOptions({ postLakeOnly: true });
      expect(flagged()).toEqual(['P3']); // P1's team came before its declaration
    } finally {
      setRule3DiagnosticOptions(undefined);
    }
    expect(flagged()).toEqual(['P1', 'P3']);
  });

  it('S1-2 (rule3PostLakeOnly): only post-lake, strictly dominated omissions flag the holder; no clause (b)', () => {
    const vote = (round: number, attempt: number, leader: string, team: string[]) => ({
      round, attempt, leader, team, approved: true,
      votes: { P0: true, P1: true, P2: true, P3: true, P4: true },
    });
    const post = { ...LEGACY_BELIEF_OPTIONS, rule3PostLake: true };
    const base = {
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' as const },
        { round: 2, holderId: 'P3', targetId: 'P4', declaredClaim: 'good' as const },
      ],
    };
    // P1 left P2 off before its lake (R1), P3 left P4 off after (R3): only P3.
    const obs = makeObs({
      ...base,
      voteHistory: [vote(1, 1, 'P1', ['P1', 'P3']), vote(3, 1, 'P3', ['P3', 'P0'])],
    });
    const flagged = (o: PlayerObservation): string[] =>
      [...findRule3Violators(analyzeLakeChain(o), o, post)].map(([id]) => id).sort();
    expect(flagged(obs)).toEqual(['P3']);
    // Metamorphic (INV-H3a): any number of pre-lake teams by P1 changes nothing.
    const morePre = makeObs({
      ...base,
      voteHistory: [vote(1, 1, 'P1', ['P1', 'P3']), vote(1, 2, 'P1', ['P1', 'P4']), vote(2, 1, 'P1', ['P1', 'P0']), vote(3, 1, 'P3', ['P3', 'P0'])],
    });
    expect(flagged(morePre)).toEqual(['P3']);
    // Strict dominance (X4): P3's post-lake team without P4 holds only seats P3
    // could prove good at the time — R1 {P1, P2} with two fail cards makes P1
    // and P2 the two reds of a 5-player game, so P0 is certainly good and
    // swapping it for P4 (seen blue) changes nothing: a tie, not a violation.
    const tie = makeObs({
      lakeHistory: [{ round: 2, holderId: 'P3', targetId: 'P4', declaredClaim: 'good' }],
      questHistory: [{ round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 2 }],
      voteHistory: [vote(3, 1, 'P3', ['P3', 'P0'])],
    });
    expect(flagged(tie)).toEqual([]);
    // Clause (b) is gone: leading a team that failed, with B on it, flags nobody.
    const ledFail = makeObs({
      lakeHistory: [{ round: 2, holderId: 'P3', targetId: 'P4', declaredClaim: 'good' }],
      questHistory: [{ round: 3, team: ['P3', 'P4', 'P1'], result: 'fail', failCount: 1 }],
      voteHistory: [vote(3, 1, 'P3', ['P3', 'P4', 'P1'])],
    });
    expect(flagged(ledFail)).toEqual([]);
    expect([...findRule3Violators(analyzeLakeChain(ledFail), ledFail, LEGACY_BELIEF_OPTIONS).values()]).toEqual([0.5]);
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

  it('no lake-cycle violators any more (S1-11): an impossible cycle record pins nobody by itself', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 3, holderId: 'P2', targetId: 'P1', declaredClaim: 'evil' },
      ],
    });
    const py = computePyramidScores(obs, LEGACY_BELIEF_OPTIONS);
    expect(py.scores.get('P1') ?? 0).toBeLessThan(PYRAMID_VIOLATOR_FLOOR);
    expect(py.scores.get('P2') ?? 0).toBeLessThan(PYRAMID_VIOLATOR_FLOOR);
    // Batch 1C (S1-1): the certainty layer, not a cycle rule, settles it under
    // A0 — P1 good ⇒ P2 good ⇒ P2 truthful ⇒ P1 red — so P1 is pinned 1 − ε;
    // P2 stays open.
    const facts = computePyramidScores(obs, { ...LEGACY_BELIEF_OPTIONS, certainFacts: true });
    expect(facts.scores.get('P1')).toBe(1 - CERTAINTY_EPS);
    expect(facts.hardRed.has('P1')).toBe(true);
    expect(facts.hardRed.has('P2')).toBe(false);
    expect(facts.hardBlue.has('P2')).toBe(false);
  });

  it('S1-1 (certainFacts): proven facts are pinned — L0 at 1 / 0, A0-only at 1 − ε / ε; layer 2 counts fail cards', () => {
    // 5 players, 2 reds. R1 {P1, P2} showed two fail cards: both red (C4),
    // so P3 and P4 are certainly good (C6).
    const two = makeObs({ questHistory: [{ round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 2 }] });
    const py = computePyramidScores(two, { ...LEGACY_BELIEF_OPTIONS, certainFacts: true });
    expect(py.scores.get('P1')).toBe(PYRAMID_HARD_RED);
    expect(py.scores.get('P2')).toBe(PYRAMID_HARD_RED);
    expect(py.scores.get('P3')).toBe(PYRAMID_HARD_BLUE);
    expect(py.scores.get('P4')).toBe(PYRAMID_HARD_BLUE);
    expect(py.certainty?.certRed()).toEqual(['P1', 'P2']);
    // Off: the flat +0.15 of the old layer 2 (0.65), nobody pinned.
    const legacy = computePyramidScores(two, LEGACY_BELIEF_OPTIONS);
    expect(legacy.scores.get('P1')).toBeCloseTo(0.65, 9);
    expect(legacy.hardRed.size).toBe(0);
    // A0-only fact: P1 declared me (P0, good) red ⇒ P1 is red under A0 (P3) → 1 − ε.
    const accuser = makeObs({ lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P0', declaredClaim: 'evil' }] });
    const acc = computePyramidScores(accuser, { ...LEGACY_BELIEF_OPTIONS, certainFacts: true });
    expect(acc.scores.get('P1')).toBe(1 - CERTAINTY_EPS);
    // Own lake result (P2, no A0 needed): L0 pin at 0.
    const own = makeObs({
      lakeHistory: [{ round: 2, holderId: 'P0', targetId: 'P3', declaredClaim: 'good' }],
      myLakeResults: [{ round: 2, targetId: 'P3', result: 'good' }],
    });
    expect(computePyramidScores(own, { ...LEGACY_BELIEF_OPTIONS, certainFacts: true }).scores.get('P3')).toBe(PYRAMID_HARD_BLUE);
    // Layer 2 by fail cards (C2 / C5): one card on a 3-seat team spreads ⅓
    // each (+0.15, the old flat step); an R4 success with a card on a 4-seat
    // team counts (+0.1125); a card explained by a pinned red adds nothing to
    // the others.
    const one = makeObs({ questHistory: [{ round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 }] });
    expect(computePyramidScores(one, { ...LEGACY_BELIEF_OPTIONS, certainFacts: true }).scores.get('P1')).toBeCloseTo(0.5 + 0.45 / 3, 9);
    const r4 = makeObs({ questHistory: [{ round: 4, team: ['P1', 'P2', 'P3', 'P4'], result: 'success', failCount: 1 }] });
    expect(computePyramidScores(r4, { ...LEGACY_BELIEF_OPTIONS, certainFacts: true }).scores.get('P1')).toBeCloseTo(0.5 + 0.45 / 4, 9);
    expect(computePyramidScores(r4, LEGACY_BELIEF_OPTIONS).scores.get('P1')).toBe(0.5);
    const explained = makeObs({
      myRole: 'merlin', knownEvils: ['P1'],
      questHistory: [{ round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 }],
    });
    expect(computePyramidScores(explained, { ...LEGACY_BELIEF_OPTIONS, certainFacts: true }).scores.get('P2')).toBe(0.5);
  });

  it('S1-3 (chainProjection): s(C) ≤ s(B) ≤ s(A) along a declared-blue chain, s(A) + s(B) ≥ 1 for a declared-red pair', () => {
    const vote = (round: number, attempt: number, leader: string, team: string[], votes: Record<string, boolean>) =>
      ({ round, attempt, leader, team, approved: false, votes });
    // Votes push P2 (outer-white twice) above P1 and P3 above P2 in the plain pyramid.
    const obs = makeObs({
      currentRound: 4,
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 3, holderId: 'P2', targetId: 'P3', declaredClaim: 'good' },
      ],
      voteHistory: [
        vote(1, 1, 'P4', ['P4', 'P0'], { P0: true, P1: false, P2: true, P3: true, P4: true }),
        vote(1, 2, 'P0', ['P0', 'P4'], { P0: true, P1: false, P2: true, P3: true, P4: true }),
      ],
    });
    const plain = computePyramidScores(obs, LEGACY_BELIEF_OPTIONS);
    expect(plain.scores.get('P2')!).toBeGreaterThan(plain.scores.get('P1')!);
    const proj = computePyramidScores(obs, { ...LEGACY_BELIEF_OPTIONS, chainProjection: true });
    expect(proj.scores.get('P2')!).toBeLessThanOrEqual(proj.scores.get('P1')! + 1e-9);
    expect(proj.scores.get('P3')!).toBeLessThanOrEqual(proj.scores.get('P2')! + 1e-9);
    // Pinned seats never move: with Merlin seeing P3 red, P3 stays at 1 and
    // the K5 reversal (P2 declared P3 blue ⇒ P2 red) comes from the certainty
    // layer at 1 − ε; P1 (no declaration) is left to the projection.
    const merlin = computePyramidScores(
      { ...obs, myRole: 'merlin', knownEvils: ['P3'], lakeHistory: [{ round: 3, holderId: 'P2', targetId: 'P3', declaredClaim: 'good' }] },
      { ...LEGACY_BELIEF_OPTIONS, chainProjection: true, certainFacts: true },
    );
    expect(merlin.scores.get('P3')).toBe(PYRAMID_HARD_RED);
    expect(merlin.scores.get('P2')).toBe(1 - CERTAINTY_EPS);
    expect(merlin.hardRed.has('P1')).toBe(false);
    // Declared red pair: both free seats are raised until they sum to 1.
    const red = makeObs({
      currentRound: 3,
      lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'evil' }],
    });
    const pr = computePyramidScores(red, { ...LEGACY_BELIEF_OPTIONS, chainProjection: true });
    expect(pr.scores.get('P1')! + pr.scores.get('P2')!).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it('S1-9a (forcedVotesZero): the synthetic votes of a forced fifth proposal change no score', () => {
    const forced = (votes: Record<string, boolean>) =>
      ({ round: 2, attempt: 5, leader: 'P3', team: ['P3', 'P4'], approved: true, votes });
    const base = makeObs({
      currentRound: 3,
      voteHistory: [
        { round: 1, attempt: 1, leader: 'P1', team: ['P1', 'P2'], approved: true, votes: { P0: false, P1: true, P2: true, P3: true, P4: false } },
      ],
    });
    const a = { ...base, voteHistory: [...base.voteHistory, forced({ P0: true, P1: true, P2: true, P3: true, P4: true })] };
    const b = { ...base, voteHistory: [...base.voteHistory, forced({ P0: false, P1: false, P2: false, P3: false, P4: false })] };
    const on = { ...LEGACY_BELIEF_OPTIONS, forcedVotesZero: true };
    for (const id of base.allPlayerIds) {
      expect(computePyramidScores(a, on).scores.get(id)).toBeCloseTo(computePyramidScores(b, on).scores.get(id)!, 12);
    }
    // Off: the forced record counts as outer-whites for P0 / P1 / P2.
    expect(computePyramidScores(a, LEGACY_BELIEF_OPTIONS).scores.get('P1')).not.toBeCloseTo(computePyramidScores(b, LEGACY_BELIEF_OPTIONS).scores.get('P1')!, 6);
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
