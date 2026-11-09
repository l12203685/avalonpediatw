/**
 * 優化迴圈第 33 回合・藍方（Edward 2026-11-09 的裁定）：
 * - 裁定 1：梅林可以照派成功的隊（隊上有他看得到的紅也一樣）→ `merlinReuseNoEarly` 預設關；
 * - 裁定 2：嚴格的貝氏內黑／外白準則 `goodBayesVote`；
 * - 裁定 3：遞迴讀人（第 1 層）`beliefRecursive`（`infl/recursiveRead.ts`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { BAYES_VOTE_DEFAULTS, bayesVoteCriteria, failsRequiredNow } from './BlueRound33';
import { merlinLoyalStyleTeam, merlinReuseNormTeam } from './MerlinLoyalStyle';
import { allTeams, proposalCandidates, RecursiveProposalReader, recursiveLogs } from './infl/recursiveRead';
import { FlowFeatures } from './infl/voteFeatures';
import { flowOfObs } from './infl/flow';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});

describe('round 33 tuning fields', () => {
  it('off in the legacy table; Merlin may re-propose a successful team by default (ruling 1); flags parse and describe', () => {
    for (const k of ['beliefRecursive', 'goodBayesVote', 'goodBayesBad', 'goodBayesBadKey', 'goodBayesGood', 'goodBayesGoodKey'] as const) {
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
    }
    expect(DEFAULT_AGENT_TUNING.merlinReuseNoEarly).toBe(false);
    expect(parseTuningFlag('beliefRecursive')).toEqual({ beliefRecursive: 1 });
    expect(parseTuningFlag('beliefRecursive=2')).toEqual({ beliefRecursive: 2 });
    expect(() => parseTuningFlag('beliefRecursive=4')).toThrow();
    expect(parseTuningFlag('goodBayesVote')).toEqual({ goodBayesVote: 1 });
    expect(parseTuningFlag('goodBayesBad')).toEqual({ goodBayesBad: 0.95 });
    expect(parseTuningFlag('goodBayesGoodKey=0.8')).toEqual({ goodBayesGoodKey: 0.8 });
    expect(() => parseTuningFlag('goodBayesBad=1.5')).toThrow();
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, beliefRecursive: 1, goodBayesVote: 1 })).toContain('beliefRecursive=1');
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 2 }).recursive).toBe(2);
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 2 }).recursiveLevel0?.recursive).toBeUndefined();
    expect(bayesOptionsOf(DEFAULT_AGENT_TUNING).recursive).toBeUndefined();
  });
});

describe('ruling 1: Merlin re-proposes the successful team, seen red and all (merlinReuseNoEarly off by default)', () => {
  // R1 P2 P3 P4 succeeded with the assassin P3 hiding; Merlin P1 sees P3 P7 P9; doomed R2 proposal.
  const mobs = asObs({
    myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P3', 'P7', 'P9'],
    currentRound: 2, currentLeader: 'P1', failCount: 1, questResults: ['success'], gamePhase: 'team_select',
    questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }],
    voteHistory: [], proposedTeam: [], lakeHistory: [],
  });
  const draft = { type: 'team_select' as const, teamIds: ['P1', 'P2', 'P4', 'P5'] };
  it('the default re-proposes the R1 team plus Merlin', () => {
    const a = merlinLoyalStyleTeam(DEFAULT_AGENT_TUNING, mobs, draft);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect([...a.teamIds].sort()).toEqual(['P1', 'P2', 'P3', 'P4']);
  });
  it('the round-28 switch still drops it when turned on', () => {
    expect(merlinReuseNormTeam({ ...DEFAULT_AGENT_TUNING, merlinReuseNoEarly: true }, mobs, 4)).toBeNull();
  });
});

describe('goodBayesVote (ruling 2: strict Bayesian 內黑／外白 criteria)', () => {
  // R3: R1 P1 P2 P3 failed with one fail card, R2 P5 P6 P7 P8 succeeded. Proposal attempt 1 by P4.
  const base = (me: string, team: string[], extra: object = {}) => asObs({
    myPlayerId: me, myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P4', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_vote',
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: team, lakeHistory: [], myLakeResults: [], ...extra,
  });
  const ON: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodBayesVote: 1 };
  it('off by default, and only for blue seats from R3, non-forced, not the leader, not a red voting as a loyal', () => {
    const o = base('P10', ['P4', 'P5', 'P6', 'P7']);
    expect(bayesVoteCriteria(DEFAULT_AGENT_TUNING, o)).toBeNull();
    expect(bayesVoteCriteria(ON, asObs({ ...o, currentRound: 2 }))).toBeNull();
    expect(bayesVoteCriteria(ON, asObs({ ...o, failCount: 4 }))).toBeNull();
    expect(bayesVoteCriteria(ON, asObs({ ...o, myPlayerId: 'P4' }))).toBeNull();
    expect(bayesVoteCriteria(ON, asObs({ ...o, redLoyalView: true }))).toBeNull();
    expect(bayesVoteCriteria(ON, asObs({ ...o, myRole: 'merlin' }))).toBeNull();
    expect(bayesVoteCriteria(ON, o)).not.toBeNull();
  });
  it('on the team: the certainty proves a fail (I was on the failed R1 team, the others are kept) → reject', () => {
    expect(bayesVoteCriteria(ON, base('P1', ['P1', 'P2', 'P3', 'P4']))).toEqual({ vote: false, reason: 'provFail' });
  });
  it('on the team: reject only at P(enough reds to fail) ≥ θ_bad', () => {
    const o = base('P10', ['P10', 'P4', 'P5', 'P9']);
    expect(bayesVoteCriteria({ ...ON, goodBayesBad: 0.01 }, o)).toEqual({ vote: false, reason: 'bad' });
    expect(bayesVoteCriteria({ ...ON, goodBayesBad: 1 }, o)).toEqual({ vote: true, reason: 'onDefault' });
  });
  it('off the team: a team holding a provable red is rejected whatever the threshold; P(clean) ≥ θ_good approves', () => {
    expect(bayesVoteCriteria({ ...ON, goodBayesGood: 0.01 }, base('P10', ['P1', 'P2', 'P3', 'P4']))).toEqual({ vote: false, reason: 'provRed' });
    expect(bayesVoteCriteria({ ...ON, goodBayesGood: 0.01 }, base('P10', ['P4', 'P5', 'P6', 'P9']))?.vote).toBe(true);
  });
  it('off the team: a red declared by a holder who looks blue counts as a public reason to reject', () => {
    const lake = { lakeHistory: [{ round: 2, holderId: 'P5', targetId: 'P9', declaredClaim: 'evil' }] };
    expect(bayesVoteCriteria({ ...ON, goodBayesGood: 0.01 }, base('P10', ['P4', 'P6', 'P7', 'P9'], lake))).toEqual({ vote: false, reason: 'lakeRed' });
  });
  it('the built-in thresholds and fails required', () => {
    expect(BAYES_VOTE_DEFAULTS).toEqual({ bad: 0.95, badKey: 0.9, good: 0.6, goodKey: 0.9 });
    expect(failsRequiredNow(asObs({ ...base('P10', []), currentRound: 4 }))).toBe(2);
    expect(failsRequiredNow(base('P10', []))).toBe(1);
  });
});

describe('beliefRecursive (ruling 3: the level-1 recursive reader)', () => {
  // R2 after an R1 success: three R2 proposals; the viewer P10 is a loyal.
  const obs = asObs({
    myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 2, currentLeader: 'P4', failCount: 3, questResults: ['success'], gamePhase: 'team_vote', evilCount: 4,
    questHistory: [{ round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 }],
    voteHistory: [
      vote(1, 1, 'P6', ['P6', 'P7', 'P8'], ['P6', 'P7', 'P8']),
      vote(1, 5, 'P1', ['P1', 'P2', 'P3'], IDS),
      vote(2, 1, 'P2', ['P1', 'P2', 'P3', 'P4'], ['P1', 'P2', 'P3', 'P4', 'P9']),
      vote(2, 2, 'P3', ['P3', 'P7', 'P8', 'P9'], ['P3', 'P7', 'P8', 'P9']),
    ],
    proposedTeam: ['P4', 'P5', 'P6', 'P7'], lakeHistory: [], myLakeResults: [],
  });
  const level0 = bayesOptionsOf(DEFAULT_AGENT_TUNING);
  it('enumerates every team of the size and finds the proposed one', () => {
    expect(allTeams(10, 4).length).toBe(210);
    expect(allTeams(10, 3).length).toBe(120);
    const ff = new FlowFeatures(flowOfObs(obs), { useBayesView: true, bayesViewOptions: level0 });
    const c = proposalCandidates(ff, 3, 0);
    expect(c).not.toBeNull();
    expect(c!.teams[c!.chosen]).toBe((1 << 2) | (1 << 6) | (1 << 7) | (1 << 8));
    expect(c!.logClean.every((x) => x <= 0)).toBe(true);
    // the R2 re-proposal of the successful R1 team plus the leader is marked as a reuse
    const r = proposalCandidates(ff, 2, 0)!;
    expect(r.reuse[r.chosen]).toBe(1);
  });
  it('a blue leader reads the same in every world (only his own information); a red leader depends on the world', () => {
    const ff = new FlowFeatures(flowOfObs(obs), { useBayesView: true, bayesViewOptions: level0 });
    const beta = { blue: Float64Array.from([2, 0.5, 2, 0, 0, 0]), evil: Float64Array.from([0.5, 1, 2, 1, 1, 1]), oberon: Float64Array.from([0.5, 1, 2, 0, 0, 0]) };
    const reader = new RecursiveProposalReader({ beta }, ff);
    const w1 = (1 << 0) | (1 << 4) | (1 << 5) | (1 << 8);
    const w2 = (1 << 1) | (1 << 4) | (1 << 7) | (1 << 8);
    expect(reader.logProb(3, w1, 'blue')).toBeCloseTo(reader.logProb(3, w2, 'blue')!, 12);
    expect(reader.logProb(3, w1, 'evil')).not.toBeCloseTo(reader.logProb(3, w2, 'evil')!, 6);
    expect(reader.logProb(3, w1, 'blue')!).toBeLessThan(0);
  });
  it('the recursive posterior is a distribution and leaves the level-0 posterior untouched (the table state is restored)', () => {
    const fresh = () => asObs({ ...(obs as object) });
    const before = bayesRedShare(fresh(), level0);
    const rec = bayesRedShare(fresh(), bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 1 }));
    const after = bayesRedShare(fresh(), level0);
    for (const id of IDS) expect(after.get(id)).toBeCloseTo(before.get(id)!, 12);
    let s = 0;
    for (const id of IDS) { s += rec.get(id)!; expect(rec.get(id)!).toBeGreaterThanOrEqual(0); }
    expect(s).toBeCloseTo(4, 6);
    expect(rec.get('P10')).toBe(0);
    const logs = recursiveLogs(fresh(), level0, 1);
    expect(logs.votes).not.toBeNull();
    expect(logs.proposals).not.toBeNull();
    expect(recursiveLogs(fresh(), level0, 3).votes).toBeNull();
  });
});
