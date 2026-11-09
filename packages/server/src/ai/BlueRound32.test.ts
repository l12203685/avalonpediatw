/**
 * 優化迴圈第 32 回合・藍方（Edward 2026-11-05 新方向）：
 * - 藍方持湖 `goodLakeChain`：之後整場的共同資訊（被湖的人拿下一次湖；每一次宣告都把持湖者可不可信算在裡面）；
 * - 忠臣／派西 `goodOnTeamSuspect`：在隊上的內黑要指得出是誰。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { lakeChainParts, lakeChainSpec, lakeChainValues, lakesLeft, onTeamSuspectKeeps, pickGoodLakeTargetChain } from './BlueRound32';
import { goodCleanVoteReject, goodKeyVoteReject } from './GoodCleanVote';
import { publicLakeGain } from './BlueRound30';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;

describe('round 32 tuning fields', () => {
  it('off in the legacy table; flags parse and describe', () => {
    expect(LEGACY_AGENT_TUNING.goodLakeChain).toBe(0);
    expect(LEGACY_AGENT_TUNING.goodLakeChainFuture).toBe(0);
    expect(LEGACY_AGENT_TUNING.goodOnTeamSuspect).toBe(0);
    expect(LEGACY_AGENT_TUNING.goodOnTeamSuspectKey).toBe(0);
    expect(DEFAULT_AGENT_TUNING.goodOnTeamSuspectKey).toBe(0);
    expect(parseTuningFlag('goodOnTeamSuspectKey=0.9')).toEqual({ goodOnTeamSuspectKey: 0.9 });
    expect(parseTuningFlag('goodLakeChain')).toEqual({ goodLakeChain: 1 });
    expect(parseTuningFlag('goodLakeChain=4')).toEqual({ goodLakeChain: 4 });
    expect(() => parseTuningFlag('goodLakeChain=6')).toThrow();
    expect(parseTuningFlag('goodLakeChainFuture=3')).toEqual({ goodLakeChainFuture: 3 });
    expect(parseTuningFlag('goodOnTeamSuspect')).toEqual({ goodOnTeamSuspect: 0.8 });
    expect(parseTuningFlag('goodOnTeamSuspect=0.7')).toEqual({ goodOnTeamSuspect: 0.7 });
    expect(() => parseTuningFlag('goodOnTeamSuspect=2')).toThrow();
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, goodLakeChain: 4, goodOnTeamSuspect: 0.8 })).toBe('goodOnTeamSuspect=0.8,goodLakeChain=4');
  });
});

describe('goodLakeChain (round 32, blue lake holder; Edward 2026-11-05「好人湖中鏈」)', () => {
  // After R2: R1 P1 P2 P3 failed with one fail card, R2 P5 P6 P7 P8 succeeded. The lake holder is P10 (clean) or P1 (on the failed team).
  const lake = (holder: string, round = 2) => asObs({
    myPlayerId: holder, myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: round, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'lady_of_the_lake',
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
  });
  const cands = ['P2', 'P3', 'P4', 'P5', 'P6', 'P9'];
  it('lakes left: three after R2 in a 10-player game, one after R4', () => {
    expect(lakesLeft(lake('P10', 2))).toBe(3);
    expect(lakesLeft(lake('P10', 4))).toBe(1);
    expect(lakeChainSpec(1, 3)).toEqual({ depth: 3, untrusted: true, measure: 'joint' });
    expect(lakeChainSpec(3, 3)).toEqual({ depth: 2, untrusted: true, measure: 'joint' });
    expect(lakeChainSpec(4, 2)).toEqual({ depth: 2, untrusted: true, measure: 'seat' });
    expect(lakeChainSpec(2, 2)?.untrusted).toBe(false);
    expect(lakeChainSpec(0, 3)).toBeNull();
  });
  it('the last lake has no continuation; with lakes after it the continuation is non-negative and the pick is the argmax', () => {
    const on: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodLakeChain: 1 };
    const last = lakeChainParts(on, lake('P10', 4), cands, { depth: 1, untrusted: true, measure: 'joint' });
    for (const v of last.values()) { expect(v.future).toBe(0); expect(v.now).toBeGreaterThanOrEqual(-1e-9); }
    const vals = lakeChainValues(on, lake('P10'), cands);
    const parts = lakeChainParts(on, lake('P10'), cands, lakeChainSpec(1, 3)!);
    for (const c of cands) { expect(parts.get(c)!.future).toBeGreaterThanOrEqual(-1e-9); expect(vals.get(c)).toBeCloseTo(parts.get(c)!.now + parts.get(c)!.future, 9); }
    const best = cands.reduce((a, b) => (vals.get(b)! > vals.get(a)! + 1e-9 ? b : a));
    expect(pickGoodLakeTargetChain(on, lake('P10'), cands)).toBe(best);
    expect(pickGoodLakeTargetChain(DEFAULT_AGENT_TUNING, lake('P10'), cands)).toBeNull();
    expect(pickGoodLakeTargetChain(on, asObs({ ...lake('P10'), myTeam: 'evil', myRole: 'assassin' }), cands)).toBeNull();
  });
  it('the red-cell reading at depth 1 is the round-30 public gain; under the untrusted reading a suspected holder adds less', () => {
    const spec = lakeChainSpec(1, 3)!;
    const un = lakeChainParts({ ...DEFAULT_AGENT_TUNING, goodLakeChain: 1 }, lake('P10'), cands, { ...spec, depth: 1 });
    const cell = lakeChainParts({ ...DEFAULT_AGENT_TUNING, goodLakeChain: 2 }, lake('P10'), cands, { ...spec, depth: 1, untrusted: false });
    // the cell reading at depth 1 is the round-30 public gain
    for (const c of cands) expect(cell.get(c)!.now).toBeCloseTo(publicLakeGain(DEFAULT_AGENT_TUNING, lake('P10'), c), 9);
    const others = ['P4', 'P5', 'P6', 'P9'];
    const fromClean = Math.max(...others.map((c) => un.get(c)!.now));
    const sus = lakeChainParts({ ...DEFAULT_AGENT_TUNING, goodLakeChain: 1 }, lake('P1'), others, { ...spec, depth: 1 });
    expect(Math.max(...others.map((c) => sus.get(c)!.now))).toBeLessThan(fromClean);
  });
  it('the future weight scales only the continuation', () => {
    const t1: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodLakeChain: 4 };
    const t3: AgentTuning = { ...t1, goodLakeChainFuture: 3 };
    const parts = lakeChainParts(t1, lake('P10'), cands, lakeChainSpec(4, 3)!);
    const v3 = lakeChainValues(t3, lake('P10'), cands);
    for (const c of cands) expect(v3.get(c)).toBeCloseTo(parts.get(c)!.now + 3 * parts.get(c)!.future, 9);
  });
});

describe('goodOnTeamSuspect (round 32, loyal / Percival on-team votes)', () => {
  // R3 attempt 1: R1 P1 P2 P3 succeeded, R2 P4 P5 P6 P7 failed with one fail card. P1 proposes P1 P2 P4 P8; P2 (loyal) votes.
  const vote = (me = 'P2', team = ['P1', 'P2', 'P4', 'P8']) => asObs({
    myPlayerId: me, myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['success', 'fail'], gamePhase: 'team_vote',
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 },
      { round: 2, team: ['P4', 'P5', 'P6', 'P7'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [], proposedTeam: team, lakeHistory: [], myLakeResults: [],
  });
  const top = (o: PlayerObservation) => Math.max(...(o.proposedTeam ?? []).filter((id) => id !== o.myPlayerId).map((id) => bayesRedShare(o, bayesOptionsOf(DEFAULT_AGENT_TUNING)).get(id) ?? 0));
  it('keeps the white only while no other member reaches the suspect threshold', () => {
    const o = vote();
    const t = top(o);
    expect(t).toBeGreaterThan(0);
    expect(onTeamSuspectKeeps({ ...DEFAULT_AGENT_TUNING, goodOnTeamSuspect: Math.min(1, t + 0.01) }, o)).toBe(true);
    expect(onTeamSuspectKeeps({ ...DEFAULT_AGENT_TUNING, goodOnTeamSuspect: Math.max(0.001, t - 0.01) }, o)).toBe(false);
    expect(onTeamSuspectKeeps(DEFAULT_AGENT_TUNING, o)).toBe(false);
  });
  it('only on the team, from R3, non-forced', () => {
    const on: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodOnTeamSuspect: 1 };
    expect(onTeamSuspectKeeps(on, vote())).toBe(true);
    expect(onTeamSuspectKeeps(on, vote('P3'))).toBe(false);
    expect(onTeamSuspectKeeps(on, asObs({ ...vote(), currentRound: 2 }))).toBe(false);
    expect(onTeamSuspectKeeps(on, asObs({ ...vote(), failCount: 4 }))).toBe(false);
  });
  it('key votes (red has two fails) keep their own threshold: goodOnTeamSuspect alone leaves goodKeyVote as it was', () => {
    const key = asObs({ ...vote(), questResults: ['fail', 'fail'], questHistory: [
      { round: 1, team: ['P5', 'P6', 'P3'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P4', 'P5', 'P6', 'P7'], result: 'fail', failCount: 1 },
    ] });
    const strict: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodKeyVote: 0.99 };
    expect(goodKeyVoteReject(strict, key)).toBe(true);
    expect(goodKeyVoteReject({ ...strict, goodOnTeamSuspect: 1 }, key)).toBe(true);
    expect(goodKeyVoteReject({ ...strict, goodOnTeamSuspectKey: 1 }, key)).toBe(false);
    expect(onTeamSuspectKeeps({ ...DEFAULT_AGENT_TUNING, goodOnTeamSuspectKey: 1 }, key, true)).toBe(true);
    expect(onTeamSuspectKeeps({ ...DEFAULT_AGENT_TUNING, goodOnTeamSuspectKey: 1 }, key)).toBe(false);
  });
  it('turns a goodCleanVote black into white when no member is a named suspect', () => {
    const strict: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodCleanVote: 0.99 };
    expect(goodCleanVoteReject(strict, vote())).toBe(true);
    expect(goodCleanVoteReject({ ...strict, goodOnTeamSuspect: 1 }, vote())).toBe(false);
    expect(goodCleanVoteReject({ ...strict, goodOnTeamSuspect: 0.001 }, vote())).toBe(true);
  });
});
