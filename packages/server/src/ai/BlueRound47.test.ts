/**
 * 第 47 回合（藍方）：站長「AI 哪裡想錯」的五項＋`goodCleanLead` 第 4 局兩張失敗的修正（`BlueRound47.ts`，預設全部關）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { AgentAction, PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean, bayesTeamRedsBelow } from './belief/BayesBelief';
import { goodCleanLeadTeam } from './GoodRound5';
import {
  currentLakeHolder, lakePlanValue47, overlay47, publicFeatures47, teamRedsBelow47, weightedWorlds47, W47,
} from './BlueRound47';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const KEYS = ['missedOpp47', 'standing47', 'respectRead47', 'r1SuccessTrust47', 'lakePlanLead47', 'goodCleanLeadR4Fix47'] as const;

// Loyal P3. R1: P1..P4 talk, P5 forced team P5 P6 P7 succeeded; R2: P6..P9 talk, P10 forced team P10 P8 P9 P2 failed (1 fail).
function obsAt(round: number, over: Partial<PlayerObservation> = {}): PlayerObservation {
  const v = (r: number, a: number, leader: string, team: string[], approved = false) => ({ round: r, attempt: a, leader, team, approved, votes: Object.fromEntries(IDS.map((id) => [id, team.includes(id)])) });
  return {
    myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: round, currentLeader: 'P3', gamePhase: 'team_select', failCount: 0, questResults: ['success', 'fail'],
    questHistory: [
      { round: 1, team: ['P5', 'P6', 'P7'], result: 'success', failCount: 0 },
      { round: 2, team: ['P10', 'P8', 'P9', 'P2'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [
      v(1, 1, 'P1', ['P1', 'P2', 'P3']), v(1, 2, 'P2', ['P2', 'P3', 'P9']), v(1, 3, 'P3', ['P3', 'P4', 'P2']), v(1, 4, 'P4', ['P4', 'P8', 'P10']),
      { ...v(1, 5, 'P5', ['P5', 'P6', 'P7'], true), votes: {} },
      v(2, 1, 'P6', ['P6', 'P5', 'P7', 'P2']), v(2, 2, 'P7', ['P7', 'P6', 'P5', 'P2']), v(2, 3, 'P8', ['P8', 'P9', 'P10', 'P4']), v(2, 4, 'P9', ['P9', 'P2', 'P5', 'P6']),
      { ...v(2, 5, 'P10', ['P10', 'P8', 'P9', 'P2'], true), votes: {} },
    ],
    lakeHistory: [], myLakeResults: [], proposedTeam: [],
    ...over,
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('exist, are off in the legacy and default tables, and parse', () => {
    for (const k of KEYS) { expect(LEGACY_AGENT_TUNING[k]).toBe(0); expect(DEFAULT_AGENT_TUNING[k]).toBe(0); }
    expect(parseTuningFlag('standing47')).toEqual({ standing47: 1 });
    expect(parseTuningFlag('lakePlanLead47')).toEqual({ lakePlanLead47: 0.02 });
    expect(parseTuningFlag('goodCleanLeadR4Fix47')).toEqual({ goodCleanLeadR4Fix47: 1 });
    expect(() => parseTuningFlag('standing47=6')).toThrow();
    expect(() => parseTuningFlag('goodCleanLeadR4Fix47=2')).toThrow();
  });
});

describe('publicFeatures47', () => {
  const f = publicFeatures47(obsAt(3));
  it('missed opportunity: the forced leader on his own successful team', () => {
    expect(f.get('P5')!.missed).toBe(1);
    expect(f.get('P10')!.missed).toBe(0); // his forced team failed
  });
  it('standing: share of the others\' proposals that include the seat', () => {
    // P2 is on 6 of the 9 proposals not led by P2 (P1, P3, P6, P7, P9 talk + P10 forced)
    expect(f.get('P2')!.share).toBeCloseTo(6 / 9);
    expect(f.get('P2')!.shareBucket).toBe(2);
    expect(f.get('P1')!.shareBucket).toBe(0);
  });
  it('ignore: a 2nd–4th proposal with nobody from the earlier proposals of that round', () => {
    expect(f.get('P4')!.ignore).toBe(1); // R1: P4 P8 P10 shares nobody with 123 / 239 / 342
    expect(f.get('P8')!.ignore).toBe(1); // R2: P8 P9 P10 P4 shares nobody with 6572 / 7652
    expect(f.get('P7')!.ignore).toBe(0);
  });
  it('round-1 success members', () => {
    expect(f.get('P6')!.r1succ).toBe(true);
    expect(f.get('P1')!.r1succ).toBe(false);
  });
});

describe('overlay47 and the weighted worlds', () => {
  const opts = bayesOptionsOf(T());
  it('off: no adjustment, and the weighted worlds give the posterior back', () => {
    expect(overlay47(T(), obsAt(3)).size).toBe(0);
    const ww = weightedWorlds47(obsAt(3), opts, new Map())!;
    const team = ['P3', 'P1', 'P4', 'P6'];
    expect(teamRedsBelow47(ww, team, 1)).toBeCloseTo(bayesTeamClean(obsAt(3), team, opts)!, 9);
    expect(teamRedsBelow47(ww, team, 2)).toBeCloseTo(bayesTeamRedsBelow(obsAt(3), team, 2, opts)!, 9);
  });
  it('on: the signs follow the weights; the viewer is never adjusted', () => {
    const adj = overlay47(T({ missedOpp47: 1, standing47: 1, respectRead47: 1, r1SuccessTrust47: 1 }), obsAt(3));
    expect(adj.has('P3')).toBe(false);
    expect(Math.sign(adj.get('P4') ?? 0)).toBe(Math.sign(W47.standing[0] + W47.ignore));
    const ww = weightedWorlds47(obsAt(3), opts, new Map([['P1', 3]]))!;
    const base = weightedWorlds47(obsAt(3), opts, new Map())!;
    expect(teamRedsBelow47(ww, ['P3', 'P1', 'P4', 'P6'], 1)).toBeLessThan(teamRedsBelow47(base, ['P3', 'P1', 'P4', 'P6'], 1));
  });
});

describe('goodCleanLead with the round-47 switches', () => {
  const start: AgentAction = { type: 'team_select', teamIds: ['P3', 'P1', 'P4', 'P6', 'P7'] };
  it('R4 fix: the team maximizes P(fewer than two reds)', () => {
    const o = obsAt(4, { questResults: ['success', 'fail', 'success'], questHistory: [...obsAt(3).questHistory, { round: 3, team: ['P3', 'P1', 'P4', 'P6'], result: 'success', failCount: 0 }] });
    const opts = bayesOptionsOf(T());
    const off = goodCleanLeadTeam(T(), o, start);
    const on = goodCleanLeadTeam(T({ goodCleanLeadR4Fix47: 1 }), o, start);
    if (off.type !== 'team_select' || on.type !== 'team_select') throw new Error('team');
    expect(bayesTeamRedsBelow(o, on.teamIds, 2, opts)!).toBeGreaterThanOrEqual(bayesTeamRedsBelow(o, off.teamIds, 2, opts)! - 1e-12);
    // R3 needs one fail: the fix changes nothing
    const r3 = goodCleanLeadTeam(T({ goodCleanLeadR4Fix47: 1 }), obsAt(3), { type: 'team_select', teamIds: ['P3', 'P1', 'P4', 'P6'] });
    expect(r3).toEqual(goodCleanLeadTeam(T(), obsAt(3), { type: 'team_select', teamIds: ['P3', 'P1', 'P4', 'P6'] }));
  });
  it('lake plan: only when this leader holds the lake; the pick stays within ε of the cleanest', () => {
    const o = obsAt(3, { lakeHistory: [{ round: 3, holderId: 'P2', targetId: 'P3', declaredClaim: 'good' }] });
    expect(currentLakeHolder(o)).toBe('P3');
    expect(currentLakeHolder(obsAt(3))).toBe('P10'); // no lake yet: the seat before the first leader P1
    const opts = bayesOptionsOf(T());
    const a = goodCleanLeadTeam(T({ lakePlanLead47: 0.05 }), o, { type: 'team_select', teamIds: ['P3', 'P1', 'P4', 'P6'] });
    const b = goodCleanLeadTeam(T(), o, { type: 'team_select', teamIds: ['P3', 'P1', 'P4', 'P6'] });
    if (a.type !== 'team_select' || b.type !== 'team_select') throw new Error('team');
    expect(bayesTeamClean(o, a.teamIds, opts)!).toBeGreaterThanOrEqual(bayesTeamClean(o, b.teamIds, opts)! - 0.05 - 1e-9);
    const ww = weightedWorlds47(o, opts, new Map())!;
    expect(lakePlanValue47(ww, o, a.teamIds)).toBeGreaterThanOrEqual(lakePlanValue47(ww, o, b.teamIds) - 1e-12);
  });
});
