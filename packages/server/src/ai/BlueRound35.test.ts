/**
 * 優化迴圈第 35 回合・藍方：角色混合讀人的每人角色後驗（`bayesRoleShares`）、忠臣照 wiki-24 的完整回應（`loyalFlowPick=4`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesRoleShares } from './belief/BayesBelief';
import { classifyLeader, loyalWikiPickTeam, WIKI_AGREE_MERLIN } from './BlueRound35';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const r1 = asObs({
  myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 1, currentLeader: 'P3', failCount: 2, questResults: [], gamePhase: 'team_select', evilCount: 4,
  questHistory: [], lakeHistory: [], myLakeResults: [], proposedTeam: [],
  voteHistory: [vote(1, 1, 'P1', ['P1', 'P4', 'P7'], ['P1', 'P4', 'P7']), vote(1, 2, 'P2', ['P2', 'P6', 'P10'], ['P2', 'P6', 'P10', 'P5'])],
});

describe('bayesRoleShares (round 35)', () => {
  it('needs the role mixture; gives role probabilities that add up', () => {
    expect(bayesRoleShares(r1, bayesOptionsOf(DEFAULT_AGENT_TUNING))).toBeNull();
    const opts = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 5 });
    const sh = bayesRoleShares(r1, opts)!;
    const red = bayesRedShare(r1, opts);
    let merlin = 0; let percival = 0; let oberon = 0;
    for (const id of IDS) {
      const s = sh.get(id)!;
      expect(s.red).toBeCloseTo(red.get(id)!, 9);
      expect(s.merlin + s.percival).toBeLessThanOrEqual(1 - s.red + 1e-9);
      merlin += s.merlin; percival += s.percival; oberon += s.oberon;
    }
    expect(merlin).toBeCloseTo(1, 6);
    expect(percival).toBeCloseTo(1, 6);
    expect(oberon).toBeCloseTo(1, 6);
    expect(sh.get('P3')!.merlin).toBe(0);
  });
});

describe('loyalFlowPick=4 (round 35: the wiki-24 table)', () => {
  it('classifies per the article: good Merlin → agree, good otherwise → respect, red with a teammate → correct, red with two blues → respect', () => {
    const m = (merlin: number, red: number) => new Map([['L', { merlin, percival: 0, red, oberon: 0 }]]);
    expect(classifyLeader(m(WIKI_AGREE_MERLIN * 0.9, 0.1), 'L', 0).response).toBe('agree');
    expect(classifyLeader(m(0.1, 0.1), 'L', 0).response).toBe('respect');
    expect(classifyLeader(m(0, 0.8), 'L', 0.7).response).toBe('correct');
    expect(classifyLeader(m(0, 0.8), 'L', 0.2).response).toBe('respect');
    expect(parseTuningFlag('loyalFlowPick=4')).toEqual({ loyalFlowPick: 4 });
  });
  it('keeps the leader on the team, never re-proposes or fully reverses the round; R1 only', () => {
    const t = { ...DEFAULT_AGENT_TUNING, loyalFlowPick: 4 };
    const draft = { type: 'team_select' as const, teamIds: ['P3', 'P2', 'P6'] };
    const a = loyalWikiPickTeam(t, r1, draft);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P3');
    const key = (x: readonly string[]) => [...x].sort().join(',');
    expect(r1.voteHistory.some((v) => key(v.team) === key(a.teamIds))).toBe(false);
    expect(loyalWikiPickTeam(t, asObs({ ...(r1 as object), currentRound: 2 }), draft)).toBe(draft);
    expect(loyalWikiPickTeam({ ...t, loyalFlowPick: 2 }, r1, draft)).toBe(draft);
  });
  it('mode 5 also answers in R2 after an R1 fail (not after an R1 success)', () => {
    const t = { ...DEFAULT_AGENT_TUNING, loyalFlowPick: 5 };
    const draft = { type: 'team_select' as const, teamIds: ['P3', 'P2', 'P6', 'P9'] };
    const r2 = (res: 'fail' | 'success') => asObs({
      ...(r1 as object), currentRound: 2, failCount: 1, questResults: [res],
      questHistory: [{ round: 1, team: ['P1', 'P4', 'P7'], result: res, failCount: res === 'fail' ? 1 : 0 }],
      voteHistory: [vote(1, 1, 'P1', ['P1', 'P4', 'P7'], ['P1', 'P4', 'P7', 'P2', 'P5', 'P6']), vote(2, 1, 'P2', ['P2', 'P5', 'P8', 'P10'], ['P2', 'P5', 'P8', 'P10'])],
    });
    const a = loyalWikiPickTeam(t, r2('fail'), draft);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P3');
    expect(a.teamIds).toHaveLength(4);
    expect(loyalWikiPickTeam(t, r2('success'), draft)).toBe(draft);
    expect(loyalWikiPickTeam({ ...t, loyalFlowPick: 4 }, r2('fail'), draft)).toBe(draft);
    expect(parseTuningFlag('loyalFlowPick=5')).toEqual({ loyalFlowPick: 5 });
  });
});
