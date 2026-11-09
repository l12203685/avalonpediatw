/**
 * 優化迴圈第 34 回合・藍方：遞迴讀人＋重定的策略（`beliefRecursiveNoLead`）、第 1 局提議的資訊價值改用 INFL 讀票模型（`loyalR1Spread=4`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { loyalFlowPickTeam, r1InflCtx, r1InfoValueInfl } from './BlueRound34';
import { r1SpreadTeam } from './BlueRound33';
import { merlinVoteFatal } from './MerlinLoyalStyle';
import { mixModels, RoleMixtureReader } from './infl/recursiveRead';
import { FlowFeatures } from './infl/voteFeatures';
import { flowOfObs } from './infl/flow';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
// R1 attempt 3: earlier proposals P1 P2 P3 and P2 P3 P4 (both rejected); leader P3, tail (5 家) P5.
const r1 = asObs({
  myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 1, currentLeader: 'P3', failCount: 2, questResults: [], gamePhase: 'team_select', evilCount: 4,
  questHistory: [], lakeHistory: [], myLakeResults: [], proposedTeam: [],
  voteHistory: [vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3', 'P7']), vote(1, 2, 'P2', ['P2', 'P3', 'P4'], ['P2', 'P3', 'P4'])],
});

describe('round 34 tuning fields', () => {
  it('off in the legacy table and the default; flags parse', () => {
    expect(LEGACY_AGENT_TUNING.beliefRecursiveNoLead).toBe(false);
    expect(parseTuningFlag('beliefRecursiveNoLead')).toEqual({ beliefRecursiveNoLead: true });
    expect(parseTuningFlag('loyalR1Spread=4')).toEqual({ loyalR1Spread: 4 });
    expect(() => parseTuningFlag('loyalR1Spread=5')).toThrow();
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 1, beliefRecursiveNoLead: true }).recursiveNoLead).toBe(true);
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursiveNoLead: true }).recursiveNoLead).toBeUndefined();
  });
});

describe('beliefRecursiveNoLead (round 34)', () => {
  it('a team pick reads the level-0 posterior; a vote reads the recursive one', () => {
    const lvl0 = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    const rec = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 1, beliefRecursiveNoLead: true });
    const pick = () => asObs({ ...(r1 as object) });
    const a = bayesRedShare(pick(), lvl0);
    const b = bayesRedShare(pick(), rec);
    for (const id of IDS) expect(b.get(id)).toBeCloseTo(a.get(id)!, 12);
    const v = () => asObs({ ...(r1 as object), gamePhase: 'team_vote', proposedTeam: ['P3', 'P6', 'P8'] });
    const c = bayesRedShare(v(), rec);
    const d = bayesRedShare(v(), bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 1 }));
    for (const id of IDS) expect(c.get(id)).toBeCloseTo(d.get(id)!, 12);
  });
});

describe('loyalR1Spread=4 (round 34: R1 information value with the INFL vote model)', () => {
  it('is a non-negative information value; the tail seat (5 家) is not counted', () => {
    const ctx = r1InflCtx(DEFAULT_AGENT_TUNING, r1);
    expect(ctx.tailBit).toBe(1 << 4);
    expect(ctx.record.attempt).toBe(3);
    for (const t of [['P3', 'P1', 'P2'], ['P3', 'P8', 'P9'], ['P3', 'P5', 'P9']]) {
      const v = r1InfoValueInfl(t, ctx);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
  it('the loyal leader picks the highest-value team (with the leader on it)', () => {
    const draft = { type: 'team_select' as const, teamIds: ['P3', 'P2', 'P4'] };
    const a = r1SpreadTeam({ ...DEFAULT_AGENT_TUNING, loyalR1Spread: 4 }, r1, draft);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P3');
    const ctx = r1InflCtx(DEFAULT_AGENT_TUNING, r1);
    const best = r1InfoValueInfl(a.teamIds, ctx);
    expect(best).toBeGreaterThanOrEqual(r1InfoValueInfl(['P3', 'P2', 'P4'], ctx) - 1e-9);
  });
});

describe('merlinFatalR4 (round 34, basic consistency)', () => {
  // R4 after fail, fail, success: red has two fails. Merlin P1 sees P3 P7 P9; the R4 team (two fail cards needed) holds one seen red.
  const m = (team: string[]) => asObs({
    myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P3', 'P7', 'P9'],
    currentRound: 4, currentLeader: 'P4', failCount: 0, questResults: ['fail', 'fail', 'success'], gamePhase: 'team_vote',
    questHistory: [], voteHistory: [], proposedTeam: team, lakeHistory: [],
  });
  it('one seen red on a two-fail R4 team is not fatal with the fix; two are; the old reading calls one fatal', () => {
    expect(merlinVoteFatal(m(['P1', 'P2', 'P3', 'P4', 'P5']))).toBe(true);
    expect(merlinVoteFatal(m(['P1', 'P2', 'P3', 'P4', 'P5']), { merlinFatalR4: true })).toBe(false);
    expect(merlinVoteFatal(m(['P1', 'P2', 'P3', 'P7', 'P5']), { merlinFatalR4: true })).toBe(true);
    // R5 (one fail card) with red on two fails: one seen red stays fatal
    expect(merlinVoteFatal(asObs({ ...(m(['P1', 'P2', 'P3']) as object), currentRound: 5, questResults: ['fail', 'fail', 'success', 'success'] }), { merlinFatalR4: true })).toBe(true);
    expect(LEGACY_AGENT_TUNING.merlinFatalR4).toBe(false);
  });
});

describe('beliefRecursive=4 (round 34: the role-mixture reader, Edward 11/09「每個角色的視角分開讀」)', () => {
  // R2 after an R1 success; P5 has proposed twice, each time leaving P7 P8 P9 off.
  const obs = (me: string, role: string, extra: object = {}) => asObs({
    myPlayerId: me, myRole: role, myTeam: role === 'assassin' ? 'evil' : 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 2, currentLeader: 'P6', failCount: 2, questResults: ['success'], gamePhase: 'team_vote', evilCount: 4,
    questHistory: [{ round: 1, team: ['P1', 'P2', 'P5'], result: 'success', failCount: 0 }],
    voteHistory: [
      vote(1, 1, 'P5', ['P5', 'P1', 'P2'], ['P5', 'P1', 'P2', 'P3', 'P4', 'P6']),
      vote(2, 1, 'P5', ['P5', 'P1', 'P2', 'P3'], ['P5', 'P1', 'P2', 'P3', 'P4']),
      vote(2, 2, 'P10', ['P10', 'P7', 'P8', 'P4'], ['P10', 'P7', 'P8']),
    ],
    proposedTeam: ['P6', 'P1', 'P2', 'P3'], lakeHistory: [], myLakeResults: [], ...extra,
  });
  it('is a distribution for a loyal, a Merlin and a Percival viewer', () => {
    for (const o of [obs('P4', 'loyal'), obs('P4', 'merlin', { knownEvils: ['P7', 'P8', 'P9'] }), obs('P4', 'percival', { knownWizards: ['P5', 'P9'] })]) {
      const share = bayesRedShare(o, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRecursive: 4 }));
      let s = 0;
      for (const id of IDS) { s += share.get(id)!; expect(share.get(id)!).toBeGreaterThanOrEqual(0); }
      expect(s).toBeCloseTo(4, 6);
      expect(share.get('P4')).toBe(0);
    }
  });
  it('a leader who keeps leaving the same seats off is read as possibly Merlin: worlds where his teams hold reds lose weight', () => {
    const o = obs('P4', 'loyal');
    const ff = new FlowFeatures(flowOfObs(o), { useBayesView: true, bayesViewOptions: bayesOptionsOf(DEFAULT_AGENT_TUNING) });
    const real = mixModels();
    const blindMerlin = { ...real, proposal: { ...real.proposal, merlin: Float64Array.from(real.proposal.loyal) } };
    const viewer = { id: 'P4', role: 'loyal', seesReds: 0, thumbs: 0 };
    const bit = (ids: string[]) => ids.reduce((m, id) => m | (1 << (Number(id.slice(1)) - 1)), 0);
    const wOff = bit(['P7', 'P8', 'P9', 'P10']); // P5 left exactly the reds off
    const wOn = bit(['P1', 'P2', 'P3', 'P10']); // P5's teams were full of reds
    const n = o.voteHistory.length;
    const gap = (m: typeof real) => { const r = new RoleMixtureReader(m, ff); return r.worldLog(viewer, n, wOff, () => false) - r.worldLog(viewer, n, wOn, () => false); };
    expect(gap(real)).toBeGreaterThan(gap(blindMerlin));
  });
});

describe('loyalFlowPick (round 34, wiki-24: 反對／尊重／認同 toward the earlier proposals)', () => {
  const draft = { type: 'team_select' as const, teamIds: ['P3', 'P2', 'P4'] };
  it('off by default; mode 2 never re-proposes or fully reverses the round and keeps at most one of a blue-looking previous leader\'s team', () => {
    expect(loyalFlowPickTeam(DEFAULT_AGENT_TUNING, r1, draft)).toBe(draft);
    const a = loyalFlowPickTeam({ ...DEFAULT_AGENT_TUNING, loyalFlowPick: 2 }, r1, draft);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P3');
    const key = (t: readonly string[]) => [...t].sort().join(',');
    expect(r1.voteHistory.some((v) => key(v.team) === key(a.teamIds))).toBe(false);
    const seen = new Set(r1.voteHistory.flatMap((v) => v.team));
    expect(a.teamIds.filter((id) => id !== 'P3').some((id) => seen.has(id))).toBe(true);
    // previous leader P2 (team P2 P3 P4): respect = at most one of P2 / P4 (P3 is the leader himself)
    const share = bayesRedShare(r1, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    if ((share.get('P2') ?? 0) < 0.5) expect(a.teamIds.filter((id) => id === 'P2' || id === 'P4').length).toBeLessThanOrEqual(1);
  });
  it('not on the forced fifth, not for a non-loyal, and (mode 2) not from R3', () => {
    const t = { ...DEFAULT_AGENT_TUNING, loyalFlowPick: 2 };
    expect(loyalFlowPickTeam(t, asObs({ ...(r1 as object), failCount: 4 }), draft)).toBe(draft);
    expect(loyalFlowPickTeam(t, asObs({ ...(r1 as object), myRole: 'percival' }), draft)).toBe(draft);
    expect(loyalFlowPickTeam(t, asObs({ ...(r1 as object), currentRound: 3 }), draft)).toBe(draft);
  });
});
