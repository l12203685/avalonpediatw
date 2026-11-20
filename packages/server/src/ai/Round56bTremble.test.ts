/**
 * 第 56b 回合 B（站長 2026-11-18／11-20）：A0「好人持湖說實話」、A1「兩敗後紅方必出失敗」在信念裡維持 100% 硬，
 * 只有 A2「還湖」照 `beliefConventionTremble` 變軟（`trembleConventions56b` 位元 4）。
 *
 * 局面（同 ReturnLake.test.ts）：10 人、4 紅；第 1、2 局失敗（P7 P8 P9／P7 P8 P9 P10），第 3 局 P3 P4 P5 P6 成功（A1：四個都是藍）；
 * 第 1 湖 P1 → P2 宣紅，第 2 湖 P2 沒有還湖（湖 P7、宣好）→ A2：P2 認壞。觀察者 P3（忠臣，第 3 局成功隊上）。
 * P2 是藍的世界：P1 是紅（A0）、P7 是藍（A0），紅 = P1 P8 P9 P10——只有 A2 把它刪掉。
 */
import { describe, expect, it } from 'vitest';
import type { LakePublicRecord, PlayerObservation, QuestRecord } from './types';
import { DEFAULT_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesWorlds } from './belief/BayesBelief';
import { admittedReds, buildCertainty, conventionCounter } from './belief/Certainty';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const quest = (round: number, team: string[], failCount: number): QuestRecord => ({ round, team, result: failCount > 0 ? 'fail' : 'success', failCount });
const QUESTS = [quest(1, ['P7', 'P8', 'P9'], 1), quest(2, ['P7', 'P8', 'P9', 'P10'], 1), quest(3, ['P3', 'P4', 'P5', 'P6'], 0)];
const ACCUSED: LakePublicRecord = { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'evil' };
const NOT_RETURNED: LakePublicRecord = { round: 3, holderId: 'P2', targetId: 'P7', declaredClaim: 'good' };

function obs(partial: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 4, currentLeader: 'P3', failCount: 0, questResults: ['fail', 'fail', 'success'],
    gamePhase: 'team_select', voteHistory: [], questHistory: QUESTS, proposedTeam: [], lakeHistory: [ACCUSED, NOT_RETURNED], myLakeResults: [],
    ...partial,
  } as PlayerObservation;
}
/** 預設之上只改顫抖的兩個開關（其他照現行預設）。 */
const T = (eps: number, mask: number): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, beliefConventionTremble: eps, trembleConventions56b: mask });

describe('trembleConventions56b: flag', () => {
  it('parses 0–7 (default value 4 = A2 only), rejects others; the description names it', () => {
    expect(parseTuningFlag('trembleConventions56b')).toEqual({ trembleConventions56b: 4 });
    expect(parseTuningFlag('trembleConventions56b=6')).toEqual({ trembleConventions56b: 6 });
    expect(() => parseTuningFlag('trembleConventions56b=8')).toThrow();
    expect(() => parseTuningFlag('trembleConventions56b=0.5')).toThrow();
    expect(describeAgentTuning(T(0.1, 4))).toContain('trembleConventions56b=4');
  });
  it('the mask only reaches the posterior options together with ε > 0', () => {
    expect(bayesOptionsOf(T(0.1, 4)).conventionTrembleMask).toBe(4);
    expect(bayesOptionsOf(T(0, 4)).conventionTrembleMask).toBeUndefined();
    expect(bayesOptionsOf(T(0.1, 0)).conventionTrembleMask).toBeUndefined();
    expect(bayesOptionsOf(T(0.1, 7)).conventionTrembleMask).toBeUndefined();
  });
});

describe('conventionCounter splits the broken conventions', () => {
  it('a world where the admitted red P2 is blue breaks A2 once (and nothing else)', () => {
    const o = obs();
    expect(admittedReds(o)).toEqual(['P2']);
    const mask = (ids: string[]): number => ids.reduce((m, id) => m | (1 << IDS.indexOf(id)), 0);
    const count = conventionCounter(o);
    // P1 P7 P8 P9 red: P2 blue (A2 broken), P1's red claim on P2 is a red holder's (binds nothing), P2's claim on P7 is a blue holder lying (A0).
    expect(count(mask(['P1', 'P7', 'P8', 'P9']))).toMatchObject({ a0: 1, a1: 0, a2: 1, broken: 2 });
    // P2 P7 P8 P9 red: P1 (blue) told the truth, everything kept.
    expect(count(mask(['P2', 'P7', 'P8', 'P9']))).toMatchObject({ a0: 0, a1: 0, a2: 0, broken: 0, kept: 1 });
    // P2 red, P3 red: P3 sat on the R3 success after two fails (A1).
    expect(count(mask(['P2', 'P3', 'P7', 'P8']))).toMatchObject({ a1: 1, a2: 0 });
  });
});

describe('A2 only (mask 4): A0 / A1 stay hard, the admitted red is no longer certain', () => {
  const o = obs();
  const hard = bayesRedShare(o, bayesOptionsOf(DEFAULT_AGENT_TUNING));
  const a2 = bayesRedShare(o, bayesOptionsOf(T(0.1, 4)));
  const all = bayesRedShare(o, bayesOptionsOf(T(0.1, 0)));
  it('P2 (A2): certain red in the hard posterior, high but below 1 with A2 soft', () => {
    expect(buildCertainty(o).isCertRed('P2', 'L1*')).toBe(true);
    expect(hard.get('P2')!).toBeCloseTo(1, 12);
    expect(a2.get('P2')!).toBeLessThan(1);
    expect(a2.get('P2')!).toBeGreaterThan(0.5);
  });
  it('P4–P6 (A1) stay exactly 0, unlike the round-48 tremble of all three', () => {
    for (const id of ['P4', 'P5', 'P6']) {
      expect(hard.get(id)).toBe(0);
      expect(a2.get(id)).toBe(0);
      expect(all.get(id)!).toBeGreaterThan(0);
    }
  });
  it('no world breaks A0 or A1; the worlds are the hard ones plus the A2-breaking ones', () => {
    const view = buildCertainty(o);
    const count = conventionCounter(o);
    const w = bayesWorlds(o, bayesOptionsOf(T(0.1, 4)));
    for (const m of w.worlds) expect(count(m)).toMatchObject({ a0: 0, a1: 0 });
    const hardSet = new Set(view.worlds('L1*'));
    expect(view.worlds('L1*').every((m) => w.worlds.includes(m))).toBe(true);
    expect(w.worlds.some((m) => !hardSet.has(m))).toBe(true);
  });
  it('a smaller ε keeps the A2-breaking worlds lighter', () => {
    const small = bayesRedShare(o, bayesOptionsOf(T(0.01, 4)));
    expect(small.get('P2')!).toBeGreaterThan(a2.get('P2')!);
  });
  it('without an A2 admission the posterior is exactly the hard one (A0 / A1 hard, nothing soft left)', () => {
    const noA2 = obs({ lakeHistory: [ACCUSED, { round: 3, holderId: 'P2', targetId: 'P4', declaredClaim: 'good' }] });
    expect(admittedReds(noA2)).toEqual([]);
    const h = bayesWorlds(noA2, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    const s = bayesWorlds(noA2, bayesOptionsOf(T(0.1, 4)));
    expect(s.worlds).toEqual(h.worlds);
    expect(s.wts).toEqual(h.wts);
  });
  it('red seats are unchanged (red frozen)', () => {
    const red = obs({ myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P7', 'P8', 'P9'] });
    expect([...bayesRedShare(red, bayesOptionsOf(T(0.1, 4)))]).toEqual([...bayesRedShare(red, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefConventionTremble: 0 }))]);
  });
});
