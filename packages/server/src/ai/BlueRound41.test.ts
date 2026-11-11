/**
 * 優化迴圈第 41 回合・藍方：藍方持湖的湖中分數（`goodLake41`）、持湖者後驗的分湖單調校準（`beliefLakeIso41`）、
 * 梅林在紅方已兩勝、自己在隊上、隊上有他看得到的紅時照比例贊成（`merlinKeyApprove41`，只量）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { goodLake41Pick, lake41Prefs, lake41Score, lake41Weight, merlinKeyApprove41Now, type Lake41Explain } from './BlueRound41';
import { pickLakeTarget } from './LakePolicy';
import { bayesOptionsOf, bayesRedShare, lakeIso41Map } from './belief/BayesBelief';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const base = {
  myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [], evilCount: 4,
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
  vote(2, 5, 'P10', ['P10', 'P1', 'P3', 'P4'], IDS),
];
const VALID = IDS.filter((id) => id !== 'P10');
const T = (over: object) => ({ ...DEFAULT_AGENT_TUNING, ...over });
/** Lake 1 (holder P10) after R1 (P5/P1/P8) and R2 (P10/P1/P3/P4) with the given results and fail cards. */
const lake1 = (r1: 'success' | 'fail', f1: number, r2: 'success' | 'fail', f2: number) => asObs({
  ...base, currentRound: 2, gamePhase: 'lake', questResults: [r1, r2], voteHistory: [...R1, ...R2],
  questHistory: [{ round: 1, team: ['P5', 'P1', 'P8'], result: r1, failCount: f1 }, { round: 2, team: ['P10', 'P1', 'P3', 'P4'], result: r2, failCount: f2 }],
});

describe('round 41 tuning fields', () => {
  it('off in the legacy table and the default; flags parse', () => {
    for (const k of ['goodLake41', 'beliefLakeIso41', 'merlinKeyApprove41'] as const) {
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
    }
    expect(parseTuningFlag('goodLake41=2')).toEqual({ goodLake41: 2 });
    expect(parseTuningFlag('beliefLakeIso41')).toEqual({ beliefLakeIso41: 1 });
    expect(parseTuningFlag('merlinKeyApprove41')).toEqual({ merlinKeyApprove41: 0.6 });
    expect(() => parseTuningFlag('goodLake41=256')).toThrow();
    expect(() => parseTuningFlag('merlinKeyApprove41=1.5')).toThrow();
  });
});

describe('goodLake41: the lake score and the per-state pool', () => {
  it('weight 2 while red has fewer than two wins and a lake follows; 0 at red-two and at the last lake', () => {
    expect(lake41Weight(lake1('success', 0, 'fail', 1))).toBe(2);
    expect(lake41Weight(lake1('fail', 1, 'fail', 1))).toBe(0);
    expect(lake41Weight(asObs({ ...(lake1('success', 0, 'fail', 1) as object), currentRound: 4, questResults: ['success', 'fail', 'fail', 'success'] }))).toBe(0);
    // w = 2: the score peaks at P(red) = 0.2; red-two: information (peak 0.5) or the most likely red
    expect(lake41Score(0.2, 2, false, 1)).toBeGreaterThan(lake41Score(0.05, 2, false, 1));
    expect(lake41Score(0.2, 2, false, 1)).toBeGreaterThan(lake41Score(0.5, 2, false, 1));
    expect(lake41Score(0.5, 0, true, 1)).toBeGreaterThan(lake41Score(0.8, 0, true, 1));
    expect(lake41Score(0.8, 0, true, 2)).toBeGreaterThan(lake41Score(0.5, 0, true, 2));
  });
  it('L1 FS: the overlap member first (wiki-208 §2), else R2-only; L1 FF: failed-mission members not on the two-fail team', () => {
    const fs = lake1('fail', 1, 'success', 0);
    expect(lake41Prefs(fs, 1)).toEqual(['FS', 'S']);
    // P1 sat on the failed R1 and the successful R2: the only overlap member
    expect(goodLake41Pick(T({ goodLake41: 1 }), fs, VALID)).toBe('P1');
    const ff = lake1('fail', 2, 'fail', 1);
    for (const mode of [1, 2]) {
      const pick = goodLake41Pick(T({ goodLake41: mode }), ff, VALID);
      expect(['P3', 'P4']).toContain(pick);
    }
  });
  it('uses no seat order or randomness: the same pick for any Math.random, and only holder-visible facts', () => {
    const sf = lake1('success', 0, 'fail', 1);
    const orig = Math.random;
    const picks = new Set<string | null>();
    try {
      for (const r of [0.01, 0.5, 0.99]) { Math.random = () => r; picks.add(goodLake41Pick(T({ goodLake41: 1 }), sf, VALID)); }
    } finally { Math.random = orig; }
    expect(picks.size).toBe(1);
    let ex: Lake41Explain | undefined;
    goodLake41Pick(T({ goodLake41: 1 }), sf, VALID, (e) => { ex = e; });
    const share = bayesRedShare(sf, bayesOptionsOf(T({})));
    for (const s of ex!.scores) expect(s.pRed).toBeCloseTo(share.get(s.id) ?? 0.5, 9);
  });
  it('Percival skips the thumb his read gives as Morgana at confidence >= 0.7; Merlin ranks by the public view; red seats untouched; off = unchanged', () => {
    const sf = lake1('success', 0, 'fail', 1);
    expect(goodLake41Pick(T({ goodLake41: 1 }), asObs({ ...(sf as object), seatTeam: 'evil' }), VALID)).toBeNull();
    expect(goodLake41Pick(T({}), sf, VALID)).toBeNull();
    expect(pickLakeTarget(sf, VALID, T({}))).toBe(pickLakeTarget(sf, VALID, T({ goodLake41: 0 })));
    const merlin = asObs({ ...(sf as object), myRole: 'merlin', knownEvils: ['P1', 'P5', 'P8'] });
    let ex: Lake41Explain | undefined;
    const pick = pickLakeTarget(merlin, VALID, T({ goodLake41: 1 }));
    expect(['P1', 'P5', 'P8']).not.toContain(pick);
    goodLake41Pick(T({ goodLake41: 1 }), merlin, VALID.filter((id) => !['P1', 'P5', 'P8'].includes(id)), (e) => { ex = e; });
    const pub = bayesRedShare(asObs({ ...(sf as object), publicLoyalView: true }), bayesOptionsOf(T({})));
    for (const s of ex!.scores) expect(s.pRed).toBeCloseTo(pub.get(s.id) ?? 0.5, 9);
  });
});

describe('beliefLakeIso41 (per-lake isotonic recalibration of another holder\'s P(red))', () => {
  it('the maps are monotone with 0 -> 0 and 1 -> 1; lake 2 lifts a near-certain blue holder', () => {
    for (const lake of [1, 2, 3]) {
      let prev = -1;
      for (let p = 0; p <= 1.0001; p += 0.01) { const q = lakeIso41Map(lake, Math.min(1, p)); expect(q).toBeGreaterThanOrEqual(prev - 1e-12); prev = q; }
      expect(lakeIso41Map(lake, 0)).toBe(0);
      expect(lakeIso41Map(lake, 1)).toBe(1);
    }
    expect(lakeIso41Map(2, 0.01)).toBeGreaterThan(0.05);
  });
  it('moves the holder share for a loyal seat only; red seats and Merlin unchanged', () => {
    const obs = asObs({
      ...(lake1('success', 0, 'fail', 1) as object), myPlayerId: 'P2', currentRound: 3, gamePhase: 'team_vote', proposedTeam: ['P3', 'P4', 'P6', 'P7'], currentLeader: 'P3',
      lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P5', declaredClaim: 'evil' }],
    });
    const d = bayesRedShare(obs, bayesOptionsOf(T({}))).get('P10')!;
    const c = bayesRedShare(obs, bayesOptionsOf(T({ beliefLakeIso41: 1 }))).get('P10')!;
    expect(c).toBeCloseTo(lakeIso41Map(1, d), 6);
    const red = asObs({ ...(obs as object), seatTeam: 'evil' });
    expect(bayesRedShare(red, bayesOptionsOf(T({ beliefLakeIso41: 1 }))).get('P10')).toBeCloseTo(bayesRedShare(red, bayesOptionsOf(T({}))).get('P10')!, 12);
  });
});

describe('merlinKeyApprove41 (measured only)', () => {
  const key = asObs({
    ...base, myPlayerId: 'P3', myRole: 'merlin', knownEvils: ['P5', 'P8', 'P9'], currentRound: 3, gamePhase: 'team_vote',
    questResults: ['fail', 'fail'], proposedTeam: ['P2', 'P3', 'P5', 'P6'], currentLeader: 'P2',
  });
  it('only Merlin, on the team, rounds 3-4 with red on two wins, non-forced; deterministic; off = never', () => {
    expect(merlinKeyApprove41Now(T({}), key)).toBe(false);
    expect(merlinKeyApprove41Now(T({ merlinKeyApprove41: 1 }), key)).toBe(true);
    expect(merlinKeyApprove41Now(T({ merlinKeyApprove41: 1 }), asObs({ ...(key as object), proposedTeam: ['P2', 'P4', 'P5', 'P6'] }))).toBe(false);
    expect(merlinKeyApprove41Now(T({ merlinKeyApprove41: 1 }), asObs({ ...(key as object), questResults: ['fail', 'success'] }))).toBe(false);
    expect(merlinKeyApprove41Now(T({ merlinKeyApprove41: 1 }), asObs({ ...(key as object), failCount: 4 }))).toBe(false);
    expect(merlinKeyApprove41Now(T({ merlinKeyApprove41: 1 }), asObs({ ...(key as object), myRole: 'loyal' }))).toBe(false);
    expect(merlinKeyApprove41Now(T({ merlinKeyApprove41: 1 }), asObs({ ...(key as object), seatTeam: 'evil' }))).toBe(false);
    const a = merlinKeyApprove41Now(T({ merlinKeyApprove41: 0.5 }), key);
    expect(merlinKeyApprove41Now(T({ merlinKeyApprove41: 0.5 }), key)).toBe(a);
  });
});
