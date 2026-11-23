/**
 * 第 59 回合：藍方在隊上的投票（`onTeamVote59` 第 4 局照字面讀、`onTeamVote59R3` 第 3 局門檻；Round59.ts）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamRedsBelow } from './belief/BayesBelief';
import { bayesVoteCriteria } from './BlueRound33';
import { onTeamBar59 } from './Round59';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;

// 第 3 局 1:1 之後的第 4 局：第 1 局 P1 P2 P3 失敗一張、第 2 局 P5 P6 P7 P8 成功、第 3 局 P4 P5 P9 P10 成功。P4 派第 4 局第 1 次提議。
const r4 = (me: string, team: string[], extra: object = {}) => asObs({
  myPlayerId: me, myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 4, currentLeader: 'P4', failCount: 0, questResults: ['fail', 'success', 'success'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    { round: 3, team: ['P4', 'P5', 'P9', 'P10'], result: 'success', failCount: 0 },
  ],
  voteHistory: [], proposedTeam: team, lakeHistory: [], myLakeResults: [], ...extra,
});

describe('round 59 tuning fields', () => {
  it('off by default and in the legacy table; flags parse and describe', () => {
    expect(DEFAULT_AGENT_TUNING.onTeamVote59).toBe(0);
    expect(DEFAULT_AGENT_TUNING.onTeamVote59R3).toBe(0);
    expect(LEGACY_AGENT_TUNING.onTeamVote59).toBe(0);
    expect(parseTuningFlag('onTeamVote59')).toEqual({ onTeamVote59: 0.8 });
    expect(parseTuningFlag('onTeamVote59R3=0.85')).toEqual({ onTeamVote59R3: 0.85 });
    expect(() => parseTuningFlag('onTeamVote59=1.2')).toThrow();
    expect(describeAgentTuning({ ...DEFAULT_AGENT_TUNING, onTeamVote59: 0.8 })).toContain('onTeamVote59=0.8');
  });
  it('onTeamBar59: R4 literal (two fails), R3 bar, null elsewhere or when off', () => {
    const t: AgentTuning = { ...DEFAULT_AGENT_TUNING, onTeamVote59: 0.8, onTeamVote59R3: 0.9 };
    expect(onTeamBar59(t, r4('P10', []), 2)).toEqual({ req: 2, bar: 0.8 });
    expect(onTeamBar59(t, asObs({ ...r4('P10', []), currentRound: 3 }), 1)).toEqual({ req: 1, bar: 0.9 });
    expect(onTeamBar59(t, asObs({ ...r4('P10', []), currentRound: 5 }), 1)).toBeNull();
    expect(onTeamBar59(DEFAULT_AGENT_TUNING, r4('P10', []), 2)).toBeNull();
  });
  it('Merlin keeps the current rule: his on-team normal vote goes through the public loyal view, which the switch skips', () => {
    const t: AgentTuning = { ...DEFAULT_AGENT_TUNING, onTeamVote59: 0.8, onTeamVote59R3: 0.9 };
    const o = asObs({ ...r4('P10', ['P4', 'P6', 'P7', 'P8', 'P10']), publicLoyalView: true });
    expect(onTeamBar59(t, o, 2)).toBeNull();
    expect(bayesVoteCriteria(t, o)).toEqual(bayesVoteCriteria(DEFAULT_AGENT_TUNING, o));
  });
});

describe('onTeamVote59: R4 on the team reads the two-fail requirement literally', () => {
  // P10 on a five-seat team with three of the R1 failed seats' neighbours: P(a red among the other four) is high, P(≥ 2 reds) is not.
  const o = r4('P10', ['P4', 'P6', 'P7', 'P8', 'P10']);
  const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);
  const p1 = 1 - (bayesTeamRedsBelow(o, ['P4', 'P6', 'P7', 'P8', 'P10'], 1, opts) ?? 1);
  const p2 = 1 - (bayesTeamRedsBelow(o, ['P4', 'P6', 'P7', 'P8', 'P10'], 2, opts) ?? 1);
  it('the fixture: P(a red) clears the current bar, P(≥ 2 reds) does not', () => {
    expect(p1).toBeGreaterThanOrEqual(0.8);
    expect(p2).toBeLessThan(0.8);
  });
  it('current default: inner black (reads R4 as one fail); with the switch: approve', () => {
    expect(bayesVoteCriteria(DEFAULT_AGENT_TUNING, o)).toEqual({ vote: false, reason: 'bad' });
    expect(bayesVoteCriteria({ ...DEFAULT_AGENT_TUNING, onTeamVote59: 0.8 }, o)).toEqual({ vote: true, reason: 'onDefault' });
  });
  it('still inner black when P(≥ 2 reds) clears the bar', () => {
    expect(bayesVoteCriteria({ ...DEFAULT_AGENT_TUNING, onTeamVote59: Math.max(0.01, p2 - 0.01) }, o)).toEqual({ vote: false, reason: 'bad' });
  });
  it('a team the public logic proves holds a red keeps its reject (provFail unchanged)', () => {
    const t = ['P1', 'P2', 'P3', 'P4', 'P10'];
    expect(bayesVoteCriteria({ ...DEFAULT_AGENT_TUNING, onTeamVote59: 0.99 }, r4('P10', t))?.vote).toBe(false);
  });
  it('off the team nothing changes', () => {
    const off = r4('P9', ['P4', 'P6', 'P7', 'P8', 'P10']);
    expect(bayesVoteCriteria({ ...DEFAULT_AGENT_TUNING, onTeamVote59: 0.8, onTeamVote59R3: 0.9 }, off)).toEqual(bayesVoteCriteria(DEFAULT_AGENT_TUNING, off));
  });
});

describe('onTeamVote59R3: the R3 on-team bar', () => {
  const o = asObs({ ...r4('P10', ['P4', 'P5', 'P9', 'P10']), currentRound: 3, questResults: ['fail', 'success'], questHistory: (r4('P10', []) as unknown as { questHistory: unknown[] }).questHistory.slice(0, 2) });
  it('the bar replaces goodBayesBad at R3', () => {
    expect(bayesVoteCriteria({ ...DEFAULT_AGENT_TUNING, onTeamVote59R3: 0.01 }, o)).toEqual({ vote: false, reason: 'bad' });
    expect(bayesVoteCriteria({ ...DEFAULT_AGENT_TUNING, goodBayesBad: 0.01, onTeamVote59R3: 1 }, o)).toEqual({ vote: true, reason: 'onDefault' });
  });
});
