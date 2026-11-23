/**
 * 第 63 回合：Gemini 第二意見 G1 `innerBlackEvGate63`（Round63.ts）與 G2 `loyalCopyCap63`（BayesBelief 的派隊概似）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { bayesVoteCriteria } from './BlueRound33';
import { bestCleanWith } from './GoodVoteAlt';
import { bestPassWith63, evGate63, evGateMargin63 } from './Round63';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;

// 同第 59 回合的局面：第 1 局 P1 P2 P3 失敗一張、第 2 局 P5–P8 成功、第 3 局 P4 P5 P9 P10 成功；第 4 局 P4 派第 1 次提議。
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
const r3 = (me: string, team: string[], extra: object = {}) => asObs({
  ...r4(me, team), currentRound: 3, questResults: ['fail', 'success'],
  questHistory: (r4(me, team) as unknown as { questHistory: unknown[] }).questHistory.slice(0, 2), ...extra,
});

describe('round 63 tuning fields', () => {
  it('off by default and in the legacy table; flags parse and describe', () => {
    for (const k of ['innerBlackEvGate63', 'innerBlackEvGate63Mode', 'loyalCopyCap63'] as const) {
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
    }
    expect(parseTuningFlag('innerBlackEvGate63')).toEqual({ innerBlackEvGate63: 1 });
    expect(parseTuningFlag('innerBlackEvGate63=0.5')).toEqual({ innerBlackEvGate63: 0.5 });
    expect(parseTuningFlag('innerBlackEvGate63Mode=3')).toEqual({ innerBlackEvGate63Mode: 3 });
    expect(parseTuningFlag('loyalCopyCap63=2')).toEqual({ loyalCopyCap63: 2 });
    expect(() => parseTuningFlag('loyalCopyCap63=3')).toThrow();
    expect(() => parseTuningFlag('innerBlackEvGate63=4')).toThrow();
    expect(describeAgentTuning({ ...DEFAULT_AGENT_TUNING, loyalCopyCap63: 1 })).toContain('loyalCopyCap63=1');
  });
});

describe('innerBlackEvGate63 (G1)', () => {
  const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);
  it('margins follow the proposal table', () => {
    expect(evGateMargin63(r4('P10', []))).toBe(0.18);
    expect(evGateMargin63(r3('P10', []))).toBe(0.15);
    expect(evGateMargin63(asObs({ ...r3('P10', []), questResults: ['fail', 'fail'] }))).toBe(0.05);
    expect(evGateMargin63(asObs({ ...r3('P10', []), questResults: ['success', 'success'] }))).toBe(0.22);
  });
  it('bestPassWith63 with one fail required equals bestCleanWith; with two it is at least as high', () => {
    const o = r4('P10', ['P4', 'P6', 'P7', 'P8', 'P10']);
    const c1 = bestPassWith63(o, 'P8', 5, 1, opts)!;
    expect(c1).toBeCloseTo(bestCleanWith(o, 'P8', 5, opts)!, 6);
    const c2 = bestPassWith63(o, 'P8', 5, 2, opts)!;
    expect(c2).toBeGreaterThanOrEqual(c1);
    expect(c2).toBeLessThanOrEqual(1 - (bayesRedShare(o, opts).get('P8') ?? 0) + 1e-9);
  });
  it('off, Merlin (public view), off the team or the leader: no gate', () => {
    const o = r4('P10', ['P4', 'P6', 'P7', 'P8', 'P10']);
    const t: AgentTuning = { ...DEFAULT_AGENT_TUNING, innerBlackEvGate63: 1 };
    expect(evGate63(DEFAULT_AGENT_TUNING, o, o.proposedTeam, opts)).toBeNull();
    expect(evGate63(t, asObs({ ...o, publicLoyalView: true }), o.proposedTeam, opts)).toBeNull();
    expect(evGate63(t, r4('P9', ['P4', 'P6', 'P7', 'P8', 'P10']), ['P4', 'P6', 'P7', 'P8', 'P10'], opts)).toBeNull();
    const merlin = asObs({ ...o, publicLoyalView: true });
    expect(bayesVoteCriteria(t, merlin)).toEqual(bayesVoteCriteria(DEFAULT_AGENT_TUNING, merlin));
    const off = r4('P9', ['P4', 'P6', 'P7', 'P8', 'P10']);
    expect(bayesVoteCriteria(t, off)).toEqual(bayesVoteCriteria(DEFAULT_AGENT_TUNING, off));
  });
  it('R4 one-red-likely team: the current default inner-blacks, the gate approves (the tail cannot do clearly better)', () => {
    const o = r4('P10', ['P4', 'P6', 'P7', 'P8', 'P10']);
    const g = evGate63({ ...DEFAULT_AGENT_TUNING, innerBlackEvGate63: 1 }, o, o.proposedTeam, opts)!;
    expect(g.reject).toBe(g.pAlt - g.pNow > 0.18);
    expect(bayesVoteCriteria(DEFAULT_AGENT_TUNING, o)).toEqual({ vote: false, reason: 'bad' });
    if (!g.reject) expect(bayesVoteCriteria({ ...DEFAULT_AGENT_TUNING, innerBlackEvGate63: 1 }, o)).toEqual({ vote: true, reason: 'onDefault' });
  });
  it('a margin of ~0 rejects whenever the tail is better; mode 1 never adds a reject the bar did not make', () => {
    const o = r3('P10', ['P1', 'P2', 'P4', 'P10']);
    const tiny: AgentTuning = { ...DEFAULT_AGENT_TUNING, innerBlackEvGate63: 0.001 };
    const g = evGate63(tiny, o, o.proposedTeam, opts)!;
    expect(g).not.toBeNull();
    const v = bayesVoteCriteria(tiny, o)!;
    if (!(g.pAlt - g.pNow > g.margin)) expect(v).toEqual({ vote: true, reason: 'onDefault' });
    else expect(v.vote === false || v.reason === 'onState').toBe(true);
    const base = bayesVoteCriteria(DEFAULT_AGENT_TUNING, o)!;
    const andMode = bayesVoteCriteria({ ...tiny, innerBlackEvGate63Mode: 1 }, o)!;
    if (base.vote) expect(andMode.vote).toBe(true);
  });
  it('mode 2 (max over later leaders) is never below the tail-only value', () => {
    const o = r3('P10', ['P1', 'P2', 'P4', 'P10']);
    const a = evGate63({ ...DEFAULT_AGENT_TUNING, innerBlackEvGate63: 1 }, o, o.proposedTeam, opts)!;
    const b = evGate63({ ...DEFAULT_AGENT_TUNING, innerBlackEvGate63: 1, innerBlackEvGate63Mode: 2 }, o, o.proposedTeam, opts)!;
    expect(b.pAlt).toBeGreaterThanOrEqual(a.pAlt - 1e-12);
    expect(b.pNow).toBeCloseTo(a.pNow, 12);
  });
});

describe('loyalCopyCap63 (G2)', () => {
  // 第 1 局 P1 P3 P4 成功、第 2 局 P2 P5 P8 P9 失敗；第 3 局 P3 派 P3 P1 P4 P6（整隊包含第 1 局的隊）被否決，P4 整隊照派 P3 又被否決；
  // 觀察者 P10（忠臣）對 P5 的提議投票。真人桌的讀法（`viewpoint53` 關）：基準線的 V3P 在投票時用隊長視角取代一般的派隊概似，那裡這個開關沒有作用。
  const all = Object.fromEntries(IDS.map((id) => [id, true]));
  const yes = (t: string[]) => Object.fromEntries(IDS.map((id) => [id, t.includes(id)]));
  const qh = [{ round: 1, team: ['P1', 'P3', 'P4'], result: 'success', failCount: 0 }, { round: 2, team: ['P2', 'P5', 'P8', 'P9'], result: 'fail', failCount: 1 }];
  const vh = [
    { round: 1, attempt: 1, leader: 'P1', team: ['P1', 'P3', 'P4'], approved: true, votes: all },
    { round: 2, attempt: 1, leader: 'P2', team: ['P2', 'P5', 'P8', 'P9'], approved: true, votes: all },
    { round: 3, attempt: 1, leader: 'P3', team: ['P3', 'P1', 'P4', 'P6'], approved: false, votes: yes(['P3', 'P1', 'P4', 'P6']) },
    { round: 3, attempt: 2, leader: 'P4', team: ['P4', 'P3', 'P1', 'P6'], approved: false, votes: yes(['P3', 'P1', 'P4', 'P6']) },
  ];
  const o = asObs({ ...r3('P10', []), currentLeader: 'P5', failCount: 2, questResults: ['success', 'fail'], questHistory: qh, voteHistory: vh, proposedTeam: ['P5', 'P9', 'P7', 'P8'] });
  const H: AgentTuning = { ...DEFAULT_AGENT_TUNING, viewpoint53: 0, viewpointPow53: 0 };
  const diff = (a: Map<string, number>, b: Map<string, number>) => Math.max(...IDS.map((id) => Math.abs((a.get(id) ?? 0) - (b.get(id) ?? 0))));
  it('human-table reading: off = unchanged; mode 1 and mode 2 change the reading of a table with repeated proposals', () => {
    const base = bayesRedShare(o, bayesOptionsOf(H));
    const m1 = bayesRedShare(o, bayesOptionsOf({ ...H, loyalCopyCap63: 1 }));
    const m2 = bayesRedShare(o, bayesOptionsOf({ ...H, loyalCopyCap63: 2 }));
    expect(diff(base, m1)).toBeGreaterThan(1e-4);
    expect(diff(base, m2)).toBeGreaterThan(1e-4);
    expect(m1.get('P10')).toBe(0);
  });
  it('a table with no repeated proposal reads the same', () => {
    const fresh = asObs({ ...o, voteHistory: vh.slice(1, 3).map((v, i) => (i === 1 ? { ...v, team: ['P3', 'P6', 'P7', 'P9'], votes: yes(['P3', 'P6', 'P7', 'P9']) } : v)) });
    const a = bayesRedShare(fresh, bayesOptionsOf(H));
    const b = bayesRedShare(fresh, bayesOptionsOf({ ...H, loyalCopyCap63: 1 }));
    expect(diff(a, b)).toBeLessThan(1e-12);
  });
  it('red seats are not affected (red frozen)', () => {
    const red = asObs({ ...o, myPlayerId: 'P2', myTeam: 'evil', myRole: 'assassin', knownEvils: ['P5', 'P8', 'P9'], seatTeam: 'evil' });
    const a = bayesRedShare(red, bayesOptionsOf(H));
    const b = bayesRedShare(red, bayesOptionsOf({ ...H, loyalCopyCap63: 2 }));
    expect(diff(a, b)).toBeLessThan(1e-12);
  });
});
