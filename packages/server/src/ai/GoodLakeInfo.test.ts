/**
 * GoodLakeInfo — the `goodLakeInfoMax` good-holder lake model (Edward
 * 2026-10-13: 「好人湖中的最大原則就是使場上的好人視角能夠更清晰 …
 * 極大化共同資訊」) and its wiring in `LakePolicy`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MISSION_FAIL_COUNTS,
  analyzeGoodLake,
  evilCountFor,
  missionLikelihood,
  pickGoodLakeTargetInfoMax,
} from './GoodLakeInfo';
import { estimateSuspicionFromHistory, pickLakeTarget, pickLakeTargetForTeam } from './LakePolicy';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, getDefaultAgentTuning, parseTuningFlag } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import type { PlayerObservation, QuestRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
/** Legal targets at the first lake: everyone but the holder P1 and the first holder P10. */
const CANDS = IDS.filter((id) => id !== 'P1' && id !== 'P10');

function obs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P1',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: [],
    currentRound: 2,
    currentLeader: 'P1',
    failCount: 0,
    questResults: ['success', 'fail'],
    gamePhase: 'team_select',
    voteHistory: [],
    questHistory: [],
    proposedTeam: [],
    lakeHistory: [],
    ...partial,
  };
}

/** 1-1: R1 {P2,P3,P4} passed, R2 {P5..P8} failed with one fail card. */
const Q_1_1: QuestRecord[] = [
  { round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 },
  { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'fail', failCount: 1 },
];
/** 0-2: R1 {P2,P3,P4} and R2 {P4..P7} both failed with one fail card. */
const Q_0_2: QuestRecord[] = [
  { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 1 },
  { round: 2, team: ['P4', 'P5', 'P6', 'P7'], result: 'fail', failCount: 1 },
];

const byId = (a: NonNullable<ReturnType<typeof analyzeGoodLake>>, id: string) => {
  const c = a.candidates.find((x) => x.id === id);
  if (!c) throw new Error(`no candidate ${id}`);
  return c;
};

describe('GoodLakeInfo — mission likelihood and world counts', () => {
  it('fail cards never exceed the reds on the team; the table is a distribution', () => {
    expect(missionLikelihood(2, 1, 2)).toBe(0);
    expect(missionLikelihood(3, 0, 0)).toBe(1);
    expect(missionLikelihood(3, 0, 1)).toBe(0);
    for (let r = 1; r <= 5; r++) {
      for (let k = 1; k <= 4; k++) {
        let sum = 0;
        for (let f = 0; f <= k; f++) sum += missionLikelihood(r, k, f);
        expect(sum).toBeCloseTo(1, 10);
      }
    }
    // A lone red fails R2 most of the time but hides on R4 (two fails needed).
    expect(missionLikelihood(2, 1, 1)).toBeGreaterThan(0.8);
    expect(missionLikelihood(4, 1, 0)).toBeGreaterThan(0.5);
    expect(MISSION_FAIL_COUNTS).toHaveLength(5);
  });

  it('evil count follows AVALON_CONFIG', () => {
    expect(evilCountFor(10)).toBe(4);
    expect(evilCountFor(7)).toBe(3);
    expect(evilCountFor(5)).toBe(2);
  });
});

describe('GoodLakeInfo — holder belief', () => {
  it('a passed mission lowers its members\' red probability, a failed one raises it', () => {
    const a = analyzeGoodLake(obs({ questHistory: Q_1_1 }), CANDS)!;
    expect(byId(a, 'P2').pEvil).toBeLessThan(4 / 9);
    expect(byId(a, 'P5').pEvil).toBeGreaterThan(byId(a, 'P2').pEvil);
  });

  it('Merlin\'s known reds and Percival\'s thumb pair enter the belief only, not the common picture', () => {
    const merlin = analyzeGoodLake(
      obs({ myRole: 'merlin', knownEvils: ['P3', 'P5', 'P9'], questHistory: Q_1_1 }),
      ['P2', 'P3', 'P6'],
    )!;
    expect(byId(merlin, 'P3').pEvil).toBeCloseTo(1, 10);
    expect(byId(merlin, 'P3').pEvilCommon).toBeLessThan(0.5);
    // Mordred is the only red Merlin cannot see: 1 of the 6 unseen seats.
    expect(byId(merlin, 'P6').pEvil).toBeLessThan(byId(merlin, 'P6').pEvilCommon);

    const percival = analyzeGoodLake(obs({ myRole: 'percival', knownWizards: ['P2', 'P6'] }), CANDS)!;
    expect(byId(percival, 'P2').pEvil + byId(percival, 'P6').pEvil).toBeCloseTo(1, 10);
  });

  it('a previous holder who declared the (good) holder red must be red', () => {
    const o = obs({
      myPlayerId: 'P3',
      currentRound: 3,
      questResults: ['success', 'fail', 'success'],
      questHistory: [...Q_1_1, { round: 3, team: ['P2', 'P3', 'P4', 'P9'], result: 'success', failCount: 0 }],
      lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P3', declaredClaim: 'evil' }],
    });
    // P10 is not a legal target any more; pass it only to read its belief.
    const a = analyzeGoodLake(o, ['P10', 'P2'])!;
    expect(byId(a, 'P10').pEvil).toBeCloseTo(1, 10);
  });

  it('an earlier holder\'s claim weighs ½ in the worlds where that holder is red', () => {
    // P10 laked the (good) holder P1 after R2 and said "good". Worlds where
    // P10 is blue: the claim is true for sure (weight 1); worlds where P10
    // is red: no information (weight ½). With no missions on record:
    // P(P10 red) = C(8,3)·½ / (C(8,4) + C(8,3)·½) = 28 / 98 = 2/7 (< 4/9).
    const o = obs({
      currentRound: 3,
      questResults: ['success', 'fail', 'success'],
      lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P1', declaredClaim: 'good' }],
    });
    const a = analyzeGoodLake(o, ['P10', 'P2'])!;
    expect(a.droppedLakes).toBe(false);
    expect(byId(a, 'P10').pEvil).toBeCloseTo(2 / 7, 10);
    expect(byId(a, 'P10').pEvilCommon).toBeCloseTo(2 / 7, 10);
    // The other seats share the remaining reds: (4 − 2/7) / 8.
    expect(byId(a, 'P2').pEvil).toBeCloseTo((4 - 2 / 7) / 8, 10);
  });

  it('drops the lake declarations when they contradict the holder\'s own knowledge', () => {
    // Merlin sees four reds (P2–P5); P10 laked him and called him red, so
    // P10 would have to be a fifth red — impossible. The model rebuilds both
    // pictures without the lake declarations and still picks a seat.
    const on = { ...LEGACY_AGENT_TUNING, goodLakeInfoMax: true };
    const o = obs({
      myRole: 'merlin',
      knownEvils: ['P2', 'P3', 'P4', 'P5'],
      currentRound: 3,
      questResults: ['success', 'fail', 'success'],
      questHistory: [...Q_1_1, { round: 3, team: ['P6', 'P7', 'P8', 'P9'], result: 'success', failCount: 0 }],
      lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P1', declaredClaim: 'evil' }],
    });
    const pool = CANDS.filter((id) => !o.knownEvils.includes(id));
    const a = analyzeGoodLake(o, pool)!;
    expect(a.droppedLakes).toBe(true);
    expect(a.trustWeight).toBe(1);
    for (const c of a.candidates) expect(c.pEvil).toBeCloseTo(0, 10);
    const pick = pickGoodLakeTargetInfoMax(o, pool);
    expect(pick).not.toBeNull();
    expect(pickLakeTarget(o, CANDS, on)).toBe(pick);
    expect(o.knownEvils).not.toContain(pick);
  });

  it('returns null for a record no evil set can explain (falls back to the old rule)', () => {
    const bad = obs({ questHistory: [{ round: 2, team: ['P2', 'P3'], result: 'fail', failCount: 3 }] });
    expect(analyzeGoodLake(bad, CANDS)).toBeNull();
    expect(pickGoodLakeTargetInfoMax(bad, CANDS)).toBeNull();
    const both = { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true, goodLakeInfoMax: true };
    const mostSuspicious = { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true };
    expect(pickLakeTargetForTeam('good', bad, [...CANDS], both))
      .toBe(pickLakeTargetForTeam('good', bad, [...CANDS], mostSuspicious));
  });
});

describe('GoodLakeInfo — score states (Edward 2026-10-13)', () => {
  it('1-1 with another lake to come: the trust chain counts, the pick went on a mission and is likely good', () => {
    const o = obs({ questHistory: Q_1_1 });
    const a = analyzeGoodLake(o, CANDS)!;
    expect(a.trustWeight).toBe(1);
    const pick = pickGoodLakeTargetInfoMax(o, CANDS)!;
    const c = byId(a, pick);
    expect(c.wentOnMission).toBe(true);
    expect(c.pEvil).toBeLessThan(0.5);
    // The trust term rewards likely-good seats and penalises likely-red ones.
    expect(byId(a, 'P2').trust).toBeGreaterThan(0);
    expect(byId(a, 'P9').trust).toBeLessThan(0);
  });

  it('兩紅 (red has two missions): no trust-chain term, pure information', () => {
    const o = obs({ questHistory: Q_0_2, questResults: ['fail', 'fail'] });
    const a = analyzeGoodLake(o, CANDS)!;
    expect(a.trustWeight).toBe(0);
    for (const c of a.candidates) {
      expect(c.trust).toBe(0);
      expect(c.score).toBe(c.infoGain);
    }
    const best = Math.max(...a.candidates.map((c) => c.infoGain));
    expect(byId(a, pickGoodLakeTargetInfoMax(o, CANDS)!).infoGain).toBe(best);
  });

  it('last lake (after R4): nothing follows, no trust-chain term', () => {
    const o = obs({
      currentRound: 4,
      questResults: ['success', 'fail', 'success', 'fail'],
      questHistory: [
        ...Q_1_1,
        { round: 3, team: ['P2', 'P3', 'P4', 'P9'], result: 'success', failCount: 0 },
        { round: 4, team: ['P2', 'P5', 'P6', 'P7', 'P8'], result: 'fail', failCount: 2 },
      ],
    });
    expect(analyzeGoodLake(o, ['P2', 'P5', 'P9'])!.trustWeight).toBe(0);
  });

  it('second lake (after R3): the trust chain counts at 2:1, not at 1:2 (兩紅)', () => {
    const lakeHistory = [{ round: 2, holderId: 'P10', targetId: 'P1', declaredClaim: 'good' as const }];
    const blueLead = obs({
      currentRound: 3,
      questResults: ['success', 'fail', 'success'],
      questHistory: [...Q_1_1, { round: 3, team: ['P2', 'P3', 'P4', 'P9'], result: 'success', failCount: 0 }],
      lakeHistory,
    });
    const a = analyzeGoodLake(blueLead, CANDS)!;
    expect(a.trustWeight).toBe(1);
    expect(a.candidates.some((c) => c.trust !== 0)).toBe(true);
    const redTwo = obs({
      currentRound: 3,
      questResults: ['success', 'fail', 'fail'],
      questHistory: [...Q_1_1, { round: 3, team: ['P5', 'P6', 'P7', 'P9'], result: 'fail', failCount: 1 }],
      lakeHistory,
    });
    const b = analyzeGoodLake(redTwo, CANDS)!;
    expect(b.trustWeight).toBe(0);
    for (const c of b.candidates) expect(c.score).toBe(c.infoGain);
  });

  it('loyal holder (belief = common picture): the information gain is never negative', () => {
    // ΔH is a mutual information only when the holder forecasts with the
    // common picture; Merlin / Percival can see slightly negative values
    // (module comment), which the trust term and V = max(0, ·) absorb.
    for (const o of [obs({ questHistory: Q_1_1 }), obs({ questHistory: Q_0_2, questResults: ['fail', 'fail'] })]) {
      const a = analyzeGoodLake(o, CANDS)!;
      expect(a.uncertainty).toBeGreaterThan(0);
      for (const c of a.candidates) {
        expect(c.pEvil).toBeCloseTo(c.pEvilCommon, 12);
        expect(c.infoGain).toBeGreaterThanOrEqual(-1e-12);
      }
    }
  });
});

describe('LakePolicy — goodLakeInfoMax switch', () => {
  afterEach(() => vi.restoreAllMocks());
  const on = { ...LEGACY_AGENT_TUNING, goodLakeInfoMax: true };

  it('ties go by seat order; no history → the first legal seat', () => {
    expect(pickLakeTargetForTeam('good', obs({ questResults: [] }), [...CANDS], on)).toBe('P2');
  });

  it('takes precedence over goodLakeTargetMostSuspicious and matches the model pick', () => {
    const o = obs({ questHistory: Q_1_1 });
    const both = { ...on, goodLakeTargetMostSuspicious: true };
    const pick = pickLakeTargetForTeam('good', o, [...CANDS], both);
    expect(pick).toBe(pickGoodLakeTargetInfoMax(o, CANDS));
    const mostSuspicious = pickLakeTargetForTeam('good', o, [...CANDS], { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true });
    const score = (id: string): number => estimateSuspicionFromHistory(id, o);
    expect(score(mostSuspicious)).toBe(Math.max(...CANDS.map(score)));
    expect(pick).not.toBe(mostSuspicious);
  });

  it('keeps the avoid-set: Merlin never lakes a red he sees, Percival skips both thumbs', () => {
    for (const questHistory of [Q_1_1, Q_0_2]) {
      const merlin = obs({ myRole: 'merlin', knownEvils: ['P2', 'P3', 'P6'], questHistory });
      expect(['P2', 'P3', 'P6']).not.toContain(pickLakeTarget(merlin, CANDS, on));
      const percival = obs({ myRole: 'percival', knownWizards: ['P2', 'P5'], questHistory });
      expect(['P2', 'P5']).not.toContain(pickLakeTarget(percival, CANDS, on));
    }
  });

  it('does not touch Math.random (switch on or off) and leaves red holders alone', () => {
    const spy = vi.spyOn(Math, 'random');
    const o = obs({ questHistory: Q_1_1 });
    pickLakeTargetForTeam('good', o, [...CANDS], on);
    pickLakeTargetForTeam('good', o, [...CANDS], { ...DEFAULT_AGENT_TUNING, goodLakeInfoMax: false });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const evil = obs({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P3'], questHistory: Q_1_1 });
    const seq = (): (() => number) => { let i = 0; return () => [0.1, 0.7, 0.3, 0.9][i++ % 4]; };
    vi.spyOn(Math, 'random').mockImplementation(seq());
    const off = pickLakeTargetForTeam('evil', evil, [...CANDS], { ...LEGACY_AGENT_TUNING });
    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockImplementation(seq());
    expect(pickLakeTargetForTeam('evil', evil, [...CANDS], on)).toBe(off);
  });

  it('HeuristicAgent.pickLakeTarget honours its own tuning', () => {
    const o = obs({ questHistory: Q_1_1 });
    const agent = new HeuristicAgent('P1', undefined, undefined, on);
    expect(agent.pickLakeTarget(o, CANDS)).toBe(pickGoodLakeTargetInfoMax(o, CANDS));
  });

  it('flag / env plumbing', () => {
    expect(parseTuningFlag('goodLakeInfoMax')).toEqual({ goodLakeInfoMax: true });
    expect(LEGACY_AGENT_TUNING.goodLakeInfoMax).toBe(false);
    expect(getDefaultAgentTuning({ AVALON_TUNING_GOOD_LAKE_INFO_MAX: '1' } as NodeJS.ProcessEnv).goodLakeInfoMax).toBe(true);
    expect(getDefaultAgentTuning({ AVALON_TUNING_GOOD_LAKE_INFO_MAX: '0' } as NodeJS.ProcessEnv).goodLakeInfoMax).toBe(false);
  });
});
