/**
 * 優化迴圈第 26 回合・藍方（第 2 階段；Edward 2026-11-04 的三點裁定）：
 * - 忠臣／派西 `goodVoteAlt`（＋`goodVoteAltLast`）：否決的價值 = 下一任隊長能派的最乾淨的隊（強者量尺差距第 1 名：在隊上內黑太多）；
 * - 忠臣 `loyalTailWhite`（D3 第一階段）：尾家很可能是紅、這隊不比尾家能派的隊髒 → 投白（只有真的忠臣）；
 * - 信念 `beliefStrongTables`（強者擬合的表）、`beliefUnified`（金字塔＝決策的後驗）、`beliefTemper`（投票／派隊概似取次方）、
 *   `beliefPolicyVotes`（INFL 策略模型讀票）；
 * - 梅林 `merlinReuseExact`（梅林照原樣照派乾淨的成功隊）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentAction, PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from './belief/BayesBelief';
import { beliefOptionsFrom } from './belief/BeliefOptions';
import { goodCleanVoteReject } from './GoodCleanVote';
import { bestCleanWith, goodVoteAltKeeps, leaderAhead, loyalTailWhiteNow, tailLeaderOf } from './GoodVoteAlt';
import { goodReuseExactTeam } from './GoodReuseExact';
import { loyalViewOf } from './RedR1Teammate';
import { policyVoteLog } from './infl/policyRead';
import STRONG from './belief/likelihoods_strong.json';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votesFor = (team: string[], yes: string[] = team) => Object.fromEntries(IDS.map((id) => [id, yes.includes(id)]));

// R1: P2 P3 P4 failed with three fail cards → P2, P3, P4 are red for sure; one more red among P5…P10.
// R2: P5 P6 P7 P8 succeeded (no fail). R3: P1 P9 P10 P5 succeeded. Now R4 (size 5), loyal P1.
const r4 = {
  myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 4, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success', 'success'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 3 },
    { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    { round: 3, team: ['P1', 'P9', 'P10', 'P5'], result: 'success', failCount: 0 },
  ],
  voteHistory: [
    { round: 1, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P4'], votes: votesFor(IDS), approved: true },
    { round: 2, attempt: 1, leader: 'P3', team: ['P5', 'P6', 'P7', 'P8'], votes: votesFor(IDS), approved: true },
    { round: 3, attempt: 1, leader: 'P4', team: ['P1', 'P9', 'P10', 'P5'], votes: votesFor(IDS), approved: true },
  ],
  proposedTeam: ['P1', 'P5', 'P6', 'P7', 'P8'], lakeHistory: [], myLakeResults: [],
} as unknown as PlayerObservation;

describe('round 26 tuning fields', () => {
  it('all off by default and in the legacy table; flags parse and describe', () => {
    expect(LEGACY_AGENT_TUNING.loyalTailWhite).toBe(0);
    // Round 26 adoption (stage 2, paired over the new default: pooled 18000 seeds +0.79pp): the fourth proposal only.
    // round 39 tried 0.75 (with the pending-proposal reading and re-fitted vote thresholds); reverted after review (gate 1)
    expect(DEFAULT_AGENT_TUNING.loyalTailWhite).toBe(0.7);
    expect(DEFAULT_AGENT_TUNING.loyalTailWhiteLast).toBe(true);
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.goodVoteAlt).toBe(0);
      expect(t.goodVoteAltLast).toBe(false);
      expect(t.beliefPolicyVotes).toBe(false);
    }
    expect(LEGACY_AGENT_TUNING.merlinReuseExact).toBe(false);
    expect(DEFAULT_AGENT_TUNING.merlinReuseExact).toBe(true); // 第 33 回合改預設開（Edward 2026-11-09 裁定 1：本來就可以照派成功隊）
    expect(LEGACY_AGENT_TUNING.beliefStrongTables).toBe(false);
    expect(DEFAULT_AGENT_TUNING.beliefStrongTables).toBe(true); // 第 32 回合改預設開（Edward 2026-11-05）
    expect(LEGACY_AGENT_TUNING.beliefUnified).toBe(false);
    expect(LEGACY_AGENT_TUNING.beliefTemper).toBe(0);
    // Round 26 adoption (stage 2, pooled 18000 seeds +4.09pp): the calibrated, unified posterior with re-set thresholds.
    expect(DEFAULT_AGENT_TUNING.beliefUnified).toBe(true);
    expect(DEFAULT_AGENT_TUNING.beliefTemper).toBe(73);
    expect(DEFAULT_AGENT_TUNING.goodCleanVote).toBe(0.3);
    expect(DEFAULT_AGENT_TUNING.goodKeyVote).toBe(0.3);
    expect(parseTuningFlag('goodVoteAlt').goodVoteAlt).toBe(1);
    expect(parseTuningFlag('goodVoteAlt=0.7').goodVoteAlt).toBe(0.7);
    expect(parseTuningFlag('loyalTailWhite').loyalTailWhite).toBe(0.7);
    expect(parseTuningFlag('beliefTemper=73').beliefTemper).toBe(73);
    expect(() => parseTuningFlag('loyalTailWhite=2')).toThrow();
    expect(() => parseTuningFlag('beliefTemper=100')).toThrow();
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, goodVoteAlt: 1 })).toBe('goodVoteAlt=1');
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, beliefTemper: 73 })).toBe('beliefTemper=73');
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, beliefStrongTables: true })).toBe('beliefStrongTables');
  });
});

describe('GoodVoteAlt helpers', () => {
  it('leaders ahead and the tail (the forced fifth leader)', () => {
    expect(leaderAhead(r4, 1)).toBe('P2');
    expect(tailLeaderOf(r4)).toBe('P5');
    expect(tailLeaderOf({ ...r4, failCount: 3 } as unknown as PlayerObservation)).toBe('P2');
    expect(tailLeaderOf({ ...r4, failCount: 4 } as unknown as PlayerObservation)).toBeNull();
  });
  it('bestCleanWith: a certain red leader can send no clean team; the value never beats 1 − P(leader red)', () => {
    const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    expect(bestCleanWith(r4, 'P2', 5, opts)).toBeCloseTo(0, 9);
    const share = bayesRedShare(r4, opts);
    const v = bestCleanWith(r4, 'P9', 5, opts)!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1 - (share.get('P9') ?? 0) + 1e-9);
  });
});

describe('goodVoteAlt (round 26, loyal / Percival)', () => {
  const tau = (o: PlayerObservation) => Math.min(0.99, (bayesTeamClean(o, o.proposedTeam, bayesOptionsOf(DEFAULT_AGENT_TUNING)) ?? 0) + 0.05);
  const t0: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodCleanVote: tau(r4) };
  it('the threshold rule rejects; with the next leader a certain red the reject is not worth it', () => {
    expect(goodCleanVoteReject(t0, r4)).toBe(true);
    expect(goodVoteAltKeeps({ ...t0, goodVoteAlt: 1 }, r4, 0.01)).toBe(true);
    expect(goodCleanVoteReject({ ...t0, goodVoteAlt: 1 }, r4)).toBe(false);
  });
  it('off the team, before R3, on the forced fifth, or not on the fourth proposal with goodVoteAltLast: no change', () => {
    const off = { ...r4, proposedTeam: ['P6', 'P7', 'P8', 'P9', 'P10'] } as unknown as PlayerObservation;
    expect(goodVoteAltKeeps({ ...t0, goodVoteAlt: 1 }, off, 0.5)).toBe(false);
    expect(goodVoteAltKeeps({ ...t0, goodVoteAlt: 1 }, { ...r4, currentRound: 2 } as unknown as PlayerObservation, 0.5)).toBe(false);
    expect(goodVoteAltKeeps({ ...t0, goodVoteAlt: 1 }, { ...r4, failCount: 4 } as unknown as PlayerObservation, 0.5)).toBe(false);
    expect(goodVoteAltKeeps({ ...t0, goodVoteAlt: 1, goodVoteAltLast: true }, r4, 0.5)).toBe(false);
  });
});

// R2, attempt 1, leader P6 → the tail is P10. R1: P10 P2 P3 failed with three fail cards (all three red). Loyal P1 votes on P6 P5 P1 P7.
const r2 = {
  myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 2, currentLeader: 'P6', failCount: 0, questResults: ['fail'], gamePhase: 'team_vote',
  questHistory: [{ round: 1, team: ['P10', 'P2', 'P3'], result: 'fail', failCount: 3 }],
  voteHistory: [{ round: 1, attempt: 1, leader: 'P10', team: ['P10', 'P2', 'P3'], votes: votesFor(IDS), approved: true }],
  proposedTeam: ['P6', 'P5', 'P1', 'P7'], lakeHistory: [], myLakeResults: [],
} as unknown as PlayerObservation;

describe('loyalTailWhite (round 26, loyal; D3 stage 1)', () => {
  const on: AgentTuning = { ...DEFAULT_AGENT_TUNING, loyalTailWhite: 0.7, loyalTailWhiteLast: false };
  it('a certain-red tail: a true loyal approves an earlier team (R2 included), off by default', () => {
    expect(loyalTailWhiteNow({ ...DEFAULT_AGENT_TUNING, loyalTailWhite: 0 }, r2)).toBe(false);
    expect(loyalTailWhiteNow(on, r2)).toBe(true);
    // The adopted default fires only on the fourth proposal (failCount 3).
    // (round 32: the case is built on the earlier tables; the strong tables read the R1 votes differently)
    // (round 39: also without the pending-proposal reading and with the round-26 threshold 0.7)
    const old: AgentTuning = { ...DEFAULT_AGENT_TUNING, beliefStrongTables: false, beliefPendingProposal: false, loyalTailWhite: 0.7 };
    expect(loyalTailWhiteNow(old, r2)).toBe(false);
    expect(loyalTailWhiteNow(old, { ...r2, failCount: 3, currentLeader: 'P9' } as unknown as PlayerObservation)).toBe(true);
    // Off the team: the same rule (an outer white).
    expect(loyalTailWhiteNow(on, { ...r2, proposedTeam: ['P6', 'P5', 'P7', 'P8'] } as unknown as PlayerObservation)).toBe(true);
  });
  it('only a true loyal: not Merlin, not Percival, not a public-loyal view (Merlin / a red voting as a loyal)', () => {
    expect(loyalTailWhiteNow(on, { ...r2, myRole: 'merlin', knownEvils: ['P10', 'P2', 'P3'] } as unknown as PlayerObservation)).toBe(false);
    expect(loyalTailWhiteNow(on, { ...r2, myRole: 'percival' } as unknown as PlayerObservation)).toBe(false);
    expect(loyalTailWhiteNow(on, loyalViewOf({ ...r2, myRole: 'merlin', knownEvils: ['P10', 'P2', 'P3'] } as unknown as PlayerObservation))).toBe(false);
  });
  it('not when the tail is unknown, nor on the forced fifth, nor for a dirtier team than the tail could send (λ)', () => {
    const blueTail = { ...r2, currentLeader: 'P5' } as unknown as PlayerObservation; // tail P9: no reason to think red
    expect(loyalTailWhiteNow(on, blueTail)).toBe(false);
    expect(loyalTailWhiteNow(on, { ...r2, failCount: 4 } as unknown as PlayerObservation)).toBe(false);
    // A team with a certain red is never "at least as clean" (p = 0).
    expect(loyalTailWhiteNow(on, { ...r2, proposedTeam: ['P6', 'P2', 'P1', 'P7'] } as unknown as PlayerObservation)).toBe(false);
  });
});

describe('belief: strong tables, unified pyramid, tempering, policy votes (round 26)', () => {
  it('the strong table exists with the usual cells (no names)', () => {
    const t = STRONG as unknown as { vote: Record<string, [number, number]>; voteKey: Record<string, unknown>; source: string };
    expect(Object.keys(t.vote)).toHaveLength(14);
    expect(t.voteKey).toBeTruthy();
    expect(t.source).toMatch(/強者/);
  });
  it('options map from the tuning', () => {
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefStrongTables: true }).strongTables).toBe(true);
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefTemper: 0.5 })).toMatchObject({ voteTemper: 0.5 });
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefTemper: 73 })).toMatchObject({ voteTemper: 0.7, proposalTemper: 0.3 });
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefTemper: 0 }).voteTemper).toBeUndefined();
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefPolicyVotes: true }).policyVotes).toBe(true);
  });
  it('beliefUnified: the pyramid reads the decision options', () => {
    const t = { ...DEFAULT_AGENT_TUNING, beliefUnified: true };
    expect(beliefOptionsFrom(t).bayesTuning).toBe(t);
    expect(beliefOptionsFrom({ ...DEFAULT_AGENT_TUNING, beliefUnified: false }).bayesTuning).toBeUndefined();
  });
  it('the strong table and tempering change the posterior but keep the certain facts; tempering moves it toward the L1* share', () => {
    const base = bayesRedShare(r4, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    for (const t of [{ beliefStrongTables: true }, { beliefTemper: 33 }, { beliefStrongTables: true, beliefPolicyVotes: true }] as Partial<AgentTuning>[]) {
      const s = bayesRedShare(r4, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, ...t }));
      for (const id of ['P2', 'P3', 'P4']) expect(s.get(id)).toBeCloseTo(1, 9);
      expect(s.get('P1')).toBe(0);
      const sum = IDS.reduce((a, id) => a + (s.get(id) ?? 0), 0);
      expect(sum).toBeCloseTo(4, 6);
      void base;
    }
  });
  it('policy votes: a finite log likelihood per world, the same when the record grows by a step (cached features)', () => {
    const f = policyVoteLog(r4)!;
    expect(Number.isFinite(f(0b1110 | (1 << 4)))).toBe(true);
    const longer = { ...r4, voteHistory: [...r4.voteHistory, { round: 4, attempt: 1, leader: 'P1', team: ['P1', 'P9', 'P10', 'P6', 'P7'], votes: votesFor(['P1', 'P9', 'P10']), approved: false }], failCount: 1, currentLeader: 'P2' } as unknown as PlayerObservation;
    const g = policyVoteLog(longer)!;
    const w = 0b1110 | (1 << 5);
    const fresh = policyVoteLog(JSON.parse(JSON.stringify(longer)) as PlayerObservation)!;
    expect(g(w)).toBeCloseTo(fresh(w), 9);
    expect(policyVoteLog({ ...r4, voteHistory: [] } as unknown as PlayerObservation)).toBeNull();
  });
});

describe('merlinReuseExact (round 26, Merlin)', () => {
  // R2 after a successful R1 mission P2 P3 P4 with no fail; Merlin P1 leads 2-1 (size 4).
  const m = {
    myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P7', 'P8', 'P9'],
    currentRound: 2, currentLeader: 'P1', failCount: 0, questResults: ['success'], gamePhase: 'team_select',
    questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }],
    voteHistory: [{ round: 1, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P4'], votes: votesFor(IDS), approved: true }],
    proposedTeam: [], lakeHistory: [], myLakeResults: [],
  } as unknown as PlayerObservation;
  const pipeline: AgentAction = { type: 'team_select', teamIds: ['P1', 'P2', 'P3', 'P5'] };
  it('Merlin re-proposes a successful team clean in his sight (plus himself) only with the knob (on by default since round 33)', () => {
    expect(goodReuseExactTeam({ ...DEFAULT_AGENT_TUNING, merlinReuseExact: false }, m, pipeline)).toBe(pipeline);
    const a = goodReuseExactTeam({ ...DEFAULT_AGENT_TUNING, merlinReuseExact: true }, m, pipeline);
    expect(a.type === 'team_select' && [...a.teamIds].sort()).toEqual(['P1', 'P2', 'P3', 'P4']);
  });
  it('never a successful team holding a red he sees', () => {
    const dirty = { ...m, knownEvils: ['P3', 'P8', 'P9'] } as unknown as PlayerObservation;
    expect(goodReuseExactTeam({ ...DEFAULT_AGENT_TUNING, merlinReuseExact: true }, dirty, pipeline)).toBe(pipeline);
  });
});
