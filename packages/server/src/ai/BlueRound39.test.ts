/**
 * 優化迴圈第 39 回合・藍方：藍方持湖（`goodLake39`）、派西的拇指讀法與帶拇指的計畫（`percivalRead39`、`percivalCarry39`）、
 * 被別人宣告紅的人不上隊（`loyalLakePair`）、梅林照忠臣整條流程的隊（`merlinPublicPipeline=2`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { goodLake39Bits, goodLake39Pick, lake39Candidates, lake39Prefs, lake39State, lakePairBarred } from './BlueRound39';
import { percivalRead39, percivalThumbFeatures, percivalThumbPlan39, percivalThumbPlanAllows } from './BlueRound39Percival';
import { pickLakeTarget } from './LakePolicy';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const base = {
  myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [], evilCount: 4,
  lakeHistory: [], myLakeResults: [], proposedTeam: [], failCount: 0,
};
const R1 = [
  vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3']), vote(1, 2, 'P2', ['P2', 'P4', 'P6'], ['P2', 'P4', 'P6']),
  vote(1, 3, 'P3', ['P3', 'P5', 'P9'], ['P3', 'P5', 'P9']), vote(1, 4, 'P4', ['P4', 'P7', 'P10'], ['P4', 'P7', 'P10']),
  vote(1, 5, 'P5', ['P5', 'P1', 'P8'], IDS),
];
const R2 = [
  vote(2, 1, 'P6', ['P6', 'P2', 'P3', 'P4'], ['P6', 'P2', 'P3', 'P4']), vote(2, 2, 'P7', ['P7', 'P2', 'P3', 'P9'], ['P7', 'P2', 'P3', 'P9']),
  vote(2, 3, 'P8', ['P8', 'P4', 'P6', 'P9'], ['P8', 'P4', 'P6', 'P9']), vote(2, 4, 'P9', ['P9', 'P2', 'P4', 'P7'], ['P9', 'P2', 'P4', 'P7']),
  vote(2, 5, 'P10', ['P10', 'P2', 'P3', 'P4'], IDS),
];
/** Lake 1 (holder P10) after R1 fail (two fail cards on P1/P5/P8) and R2 fail (one card). */
const lakeFF = asObs({
  ...base, currentRound: 2, gamePhase: 'lake', questResults: ['fail', 'fail'], voteHistory: [...R1, ...R2],
  questHistory: [{ round: 1, team: ['P5', 'P1', 'P8'], result: 'fail', failCount: 2 }, { round: 2, team: ['P10', 'P2', 'P3', 'P4'], result: 'fail', failCount: 1 }],
});
const VALID = IDS.filter((id) => id !== 'P10');
const T = (over: object) => ({ ...DEFAULT_AGENT_TUNING, ...over });

describe('round 39 tuning fields', () => {
  it('off in the legacy table and the default; flags parse', () => {
    for (const k of ['goodLake39', 'percivalRead39', 'percivalCarry39', 'loyalLakePair'] as const) {
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
    }
    expect(DEFAULT_AGENT_TUNING.merlinPublicPipeline).toBe(0);
    expect(parseTuningFlag('goodLake39')).toEqual({ goodLake39: 15 });
    expect(parseTuningFlag('percivalCarry39=1')).toEqual({ percivalCarry39: 1 });
    expect(parseTuningFlag('merlinPublicPipeline=2')).toEqual({ merlinPublicPipeline: 2 });
    expect(() => parseTuningFlag('percivalCarry39=4')).toThrow();
    expect(() => parseTuningFlag('merlinPublicPipeline=3')).toThrow();
  });
});

describe('goodLake39 (blue lake holder)', () => {
  it('reads the state by score order and classes each candidate from holder-visible facts only', () => {
    expect(lake39State(lakeFF)).toEqual({ lake: 0, score: 'FF', redHasTwo: true });
    const cs = lake39Candidates(lakeFF, VALID, T({}));
    expect(cs.find((c) => c.id === 'P1')!.cls).toBe('F2');
    expect(cs.find((c) => c.id === 'P2')!.cls).toBe('F');
    expect(cs.find((c) => c.id === 'P6')!.cls).toBe('N');
    expect(lake39Prefs({ lake: 0, score: 'FS', redHasTwo: false })).toEqual(['S', 'FS']);
    expect(lake39Prefs({ lake: 0, score: 'SF', redHasTwo: false })).toEqual([]);
    expect(lake39Prefs({ lake: 1, score: 'SFF', redHasTwo: true })).toEqual([]);
  });
  it('never lakes a member of a two-fail team at lakes 1-2 (any blue role) and never the seat-order tie', () => {
    for (let s = 0; s < 20; s++) {
      let r = s / 20;
      const pick = goodLake39Pick(T({ goodLake39: 15 }), lakeFF, VALID, () => { r = (r + 0.37) % 1; return r; });
      expect(['P1', 'P5', 'P8']).not.toContain(pick);
      expect(pick).not.toBeNull();
    }
    // Merlin without bit 128 gets bits 1 and 4 only
    expect(goodLake39Bits(T({ goodLake39: 15 }), asObs({ ...(lakeFF as object), myRole: 'merlin' }))).toBe(5);
    expect(goodLake39Bits(T({ goodLake39: 143 }), asObs({ ...(lakeFF as object), myRole: 'merlin' }))).toBe(143);
    // at L1 FF the class pool is the failed-mission members (not the two-fail team), never-on-mission second
    const picks = new Set<string>();
    for (let s = 0; s < 30; s++) picks.add(goodLake39Pick(T({ goodLake39: 3 }), lakeFF, VALID, () => (s + 0.5) / 30)!);
    for (const p of picks) expect(['P2', 'P3', 'P4']).toContain(p);
  });
  it('off: the default lake pick is unchanged', () => {
    expect(goodLake39Pick(T({}), lakeFF, VALID)).toBeNull();
    expect(pickLakeTarget(lakeFF, VALID, T({}))).toBe(pickLakeTarget(lakeFF, VALID, T({ goodLake39: 0 })));
  });
});

// Percival P7; thumbs P3 (Merlin-like) and P6.
const perc = asObs({
  ...base, myPlayerId: 'P7', myRole: 'percival', knownWizards: ['P3', 'P6'], currentRound: 2, gamePhase: 'team_select', failCount: 1,
  questResults: ['success'], voteHistory: [...R1.slice(0, 4), vote(1, 5, 'P5', ['P5', 'P3', 'P8'], IDS), vote(2, 1, 'P6', ['P6', 'P3', 'P2', 'P4'], ['P6', 'P3', 'P2', 'P4'])],
  questHistory: [{ round: 1, team: ['P5', 'P3', 'P8'], result: 'success', failCount: 0 }],
});

describe('percivalRead39 (Percival thumb read fitted on the human records)', () => {
  it('a thumb that proposed the other thumb (not a re-proposal of the success team) reads as Morgana; one on a success as Merlin', () => {
    const f = percivalThumbFeatures(perc, 'P6', 'P3');
    expect(f.propY_nr).toBe(1);
    expect(percivalThumbFeatures(perc, 'P3', 'P6').onSucc).toBe(1);
    const rd = percivalRead39(perc)!;
    expect(rd.fav).toBe('P3');
    expect(rd.conf).toBeGreaterThan(0.85);
  });
  it('own lake on a thumb settles it; a thumb on my failed mission where the fails equal the others is proven red', () => {
    const own = asObs({ ...(perc as object), myLakeResults: [{ round: 2, targetId: 'P3', result: 'evil' }] });
    expect(percivalRead39(own)!.fav).toBe('P6');
    const proven = asObs({ ...(perc as object), questHistory: [{ round: 1, team: ['P7', 'P6', 'P8'], result: 'fail', failCount: 2 }] });
    expect(percivalRead39(proven)!.fav).toBe('P3');
    expect(percivalRead39(asObs({ ...(perc as object), myRole: 'loyal' }))).toBeNull();
  });
  it('carry plan: never both thumbs; the unfavoured one barred at confidence >= 0.7; a fav only on successes is carried; R1 has no plan', () => {
    const plan = percivalThumbPlan39(T({ percivalRead39: 2, percivalCarry39: 2 }), perc, () => 0.99)!;
    expect(plan.carryFav).toBe(true);
    expect(plan.barred.has('P6')).toBe(true);
    expect(percivalThumbPlanAllows(plan, perc, ['P7', 'P3', 'P2', 'P4'])).toBe(true);
    expect(percivalThumbPlanAllows(plan, perc, ['P7', 'P3', 'P6', 'P4'])).toBe(false);
    expect(percivalThumbPlanAllows(plan, perc, ['P7', 'P6', 'P2', 'P4'])).toBe(false);
    // the successful R1 team re-proposed whole keeps the thumb that was on it
    expect(percivalThumbPlanAllows(plan, perc, ['P7', 'P5', 'P3', 'P8'])).toBe(true);
    expect(percivalThumbPlan39(T({ percivalRead39: 2, percivalCarry39: 2 }), asObs({ ...(perc as object), currentRound: 1 }))).toBeNull();
    expect(percivalThumbPlan39(T({ percivalRead39: 0, percivalCarry39: 2 }), perc)).toBeNull();
    // mode 3: same plan, but nothing is hard-barred (logic-first 1E / INV-Pe2): only the A / B weights change
    const soft = percivalThumbPlan39(T({ percivalRead39: 2, percivalCarry39: 3 }), perc)!;
    expect(soft.soft).toBe(true);
    expect(soft.carryFav).toBe(true);
    expect(percivalThumbPlanAllows(soft, perc, ['P7', 'P3', 'P6', 'P4'])).toBe(true);
  });
});

describe('loyalLakePair (the seat another holder declared evil last round stays off this round)', () => {
  const obs = asObs({
    ...base, myPlayerId: 'P2', currentRound: 3, gamePhase: 'team_select', questResults: ['success', 'fail'], voteHistory: [...R1, ...R2],
    questHistory: [{ round: 1, team: ['P5', 'P1', 'P8'], result: 'success', failCount: 0 }, { round: 2, team: ['P10', 'P2', 'P3', 'P4'], result: 'fail', failCount: 1 }],
    lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P5', declaredClaim: 'evil' }],
  });
  it('bars the target for a loyal leader the round after the claim; not for the holder or target, not on the forced proposal, not when off', () => {
    expect(lakePairBarred(T({ loyalLakePair: 1 }), obs)).toBe('P5');
    expect(lakePairBarred(T({}), obs)).toBeNull();
    expect(lakePairBarred(T({ loyalLakePair: 1 }), asObs({ ...(obs as object), myPlayerId: 'P10' }))).toBeNull();
    expect(lakePairBarred(T({ loyalLakePair: 1 }), asObs({ ...(obs as object), failCount: 4 }))).toBeNull();
    expect(lakePairBarred(T({ loyalLakePair: 1 }), asObs({ ...(obs as object), currentRound: 4 }))).toBeNull();
    expect(lakePairBarred(T({ loyalLakePair: 1 }), asObs({ ...(obs as object), myRole: 'percival' }))).toBeNull();
  });
});
