/**
 * 優化迴圈第 24 回合・藍方：
 * - 梅林 `merlinDoomedAvoid`（Edward 2026-11-03：第 1、2 局注定被否決的提議從公開上合理的隊裡挑、盡可能避開看得到的紅）＋信念 `merlinDoomedAvoidMix`；
 * - 忠臣／派西 `goodR4TwoFail`（第 4 局要兩張失敗：關鍵局門檻看「少於 2 紅」）；
 * - 忠臣／派西 `goodTailCleanR3`（第 3 局紅藍、隊外、隊上沒有出過失敗任務的人 → 乾淨就外白）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentAction, PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, describeAgentTuning } from './AgentTuning';
import { merlinDoomedAvoidTeam, merlinDoomedPublicTeam, merlinLoyalStyleTeam } from './MerlinLoyalStyle';
import { bayesOptionsOf, bayesTeamClean, bayesTeamRedsBelow } from './belief/BayesBelief';
import { goodCleanVoteReject, goodKeyVoteReject, goodTailVote, goodTailCleanR3Now } from './GoodCleanVote';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const SEEN = ['P3', 'P7', 'P9'];
const allVotes = (team: string[]) => Object.fromEntries(IDS.map((id) => [id, team.includes(id)]));
const base = {
  myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: SEEN,
  currentRound: 1, currentLeader: 'P1', failCount: 1, questResults: [], gamePhase: 'team_select',
  questHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
} as unknown as PlayerObservation;
// 1-1: P10 proposed P10 P2 P3 (rejected); Merlin P1 leads 1-2 (size 3).
const r1 = { ...base, voteHistory: [{ round: 1, attempt: 1, leader: 'P10', team: ['P10', 'P2', 'P3'], votes: allVotes(['P10', 'P2', 'P3']), approved: false }] } as unknown as PlayerObservation;
// R2 after a successful R1 mission P2 P3 P4 (P3 = seen red), Merlin P1 leads 2-2 (size 4).
const r2 = {
  ...base, currentRound: 2, failCount: 1, questResults: ['success'],
  questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }],
  voteHistory: [
    { round: 1, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P4'], votes: Object.fromEntries(IDS.map((id) => [id, true])), approved: true },
    { round: 2, attempt: 1, leader: 'P10', team: ['P10', 'P2', 'P3', 'P4'], votes: allVotes(['P10', 'P2', 'P3', 'P4']), approved: false },
  ],
} as unknown as PlayerObservation;
const avoid = (r: number) => ({ ...DEFAULT_AGENT_TUNING, merlinDoomedAvoid: r });
const reds = (t: readonly string[] | null) => (t ?? []).filter((id) => SEEN.includes(id)).length;

describe('merlinDoomedAvoid (round 24, Merlin)', () => {
  it('off by default and in the legacy table', () => {
    expect(DEFAULT_AGENT_TUNING.merlinDoomedAvoid).toBe(0);
    expect(LEGACY_AGENT_TUNING.merlinDoomedAvoid).toBe(0);
    expect(merlinDoomedAvoidTeam(DEFAULT_AGENT_TUNING, r1, 3)).toBeNull();
  });
  it('a wide reasonable set (small r) always finds a clean team; r = 1 keeps only the public best', () => {
    for (const o of [r1, r2]) {
      const size = o === r1 ? 3 : 4;
      const wide = merlinDoomedAvoidTeam(avoid(0.01), o, size)!;
      expect(wide[0]).toBe('P1');
      expect(wide).toHaveLength(size);
      expect(reds(wide)).toBe(0);
      // Never more seen reds than the plain public pick (`merlinDoomedPublic`), whatever r.
      const pub = merlinDoomedPublicTeam({ ...DEFAULT_AGENT_TUNING, merlinDoomedPublic: 1 }, o, size);
      for (const r of [0.01, 0.5, 0.9, 1]) expect(reds(merlinDoomedAvoidTeam(avoid(r), o, size))).toBeLessThanOrEqual(reds(pub));
    }
  });
  it('R2 after a success with a seen red on it: the public best extends that team; a narrow set keeps the red, a wide one drops it', () => {
    const narrow = merlinDoomedAvoidTeam(avoid(1), r2, 4)!;
    const pub = merlinDoomedPublicTeam({ ...DEFAULT_AGENT_TUNING, merlinDoomedPublic: 1 }, r2, 4)!;
    expect(reds(narrow)).toBe(reds(pub));
    expect(reds(merlinDoomedAvoidTeam(avoid(0.01), r2, 4))).toBe(0);
  });
  it('merlinLoyalStyleTeam routes doomed R1–R2 proposals to it; not the forced fifth, not R3+, not other roles', () => {
    const pipeline: AgentAction = { type: 'team_select', teamIds: ['P1', 'P2', 'P4'] };
    const styled = merlinLoyalStyleTeam(avoid(0.5), r1, pipeline);
    expect(styled.type === 'team_select' && styled.teamIds).toEqual(merlinDoomedAvoidTeam(avoid(0.5), r1, 3));
    expect(merlinDoomedAvoidTeam(avoid(0.5), { ...r1, failCount: 4 } as unknown as PlayerObservation, 3)).toBeNull();
    expect(merlinDoomedAvoidTeam(avoid(0.5), { ...r1, currentRound: 3 } as unknown as PlayerObservation, 4)).toBeNull();
    expect(merlinDoomedAvoidTeam(avoid(0.5), { ...r1, myRole: 'loyal' } as unknown as PlayerObservation, 3)).toBeNull();
  });
  it('the blues\' reading: merlinDoomedAvoidMix mixes the strict model with the generic one', () => {
    expect(bayesOptionsOf(DEFAULT_AGENT_TUNING).merlinEarlyMix).toBe(1);
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, merlinDoomedAvoidMix: 0.7 }).merlinEarlyMix).toBe(0.7);
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, merlinDoomedAvoidMix: 0.7 }).merlinEarlyStrict).toBe(true);
  });
  it('flags parse and describe', () => {
    expect(parseTuningFlag('merlinDoomedAvoid=0.9').merlinDoomedAvoid).toBe(0.9);
    expect(parseTuningFlag('merlinDoomedAvoidMix=0.8').merlinDoomedAvoidMix).toBe(0.8);
    expect(() => parseTuningFlag('merlinDoomedAvoid=2')).toThrow();
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, merlinDoomedAvoid: 0.9 })).toBe('merlinDoomedAvoid=0.9');
  });
});

// A loyal P5 on R4 (size 5): R1 P1 P2 P3 success, R2 P4 P6 P7 P8 fail (1), R3 P2 P6 P9 P10 fail (1) → red has two wins.
const r4 = {
  myPlayerId: 'P5', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 4, currentLeader: 'P5', failCount: 0, questResults: ['success', 'fail', 'fail'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 },
    { round: 2, team: ['P4', 'P6', 'P7', 'P8'], result: 'fail', failCount: 1 },
    { round: 3, team: ['P2', 'P6', 'P9', 'P10'], result: 'fail', failCount: 1 },
  ],
  voteHistory: [], proposedTeam: ['P5', 'P1', 'P3', 'P6', 'P7'], lakeHistory: [], myLakeResults: [],
} as unknown as PlayerObservation;

describe('goodR4TwoFail (round 24, loyal / Percival)', () => {
  it('off by default; P(fewer than two reds) ≥ P(no red)', () => {
    expect(DEFAULT_AGENT_TUNING.goodR4TwoFail).toBe(0);
    const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    const pc = bayesTeamClean(r4, r4.proposedTeam, opts)!;
    const p2 = bayesTeamRedsBelow(r4, r4.proposedTeam, 2, opts)!;
    expect(p2).toBeGreaterThan(pc);
    expect(bayesTeamRedsBelow(r4, r4.proposedTeam, 1, opts)).toBeCloseTo(pc, 9);
  });
  it('the R4 key vote reads two fail cards: a team with one likely red is no longer rejected', () => {
    const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    const pc = bayesTeamClean(r4, r4.proposedTeam, opts)!;
    const p2 = bayesTeamRedsBelow(r4, r4.proposedTeam, 2, opts)!;
    const tau = (pc + p2) / 2;
    const t0 = { ...DEFAULT_AGENT_TUNING, goodKeyVote: tau, goodCleanVote: tau };
    expect(goodKeyVoteReject(t0, r4)).toBe(true);
    expect(goodKeyVoteReject({ ...t0, goodR4TwoFail: 1 }, r4)).toBe(false);
    // Mode 1 leaves goodCleanVote alone; mode 2 changes it too.
    expect(goodCleanVoteReject({ ...t0, goodR4TwoFail: 1 }, r4)).toBe(true);
    expect(goodCleanVoteReject({ ...t0, goodR4TwoFail: 2 }, r4)).toBe(false);
    // Only R4 (R3 needs one fail card) and only at 7+ players.
    const r3 = { ...r4, currentRound: 3, questResults: ['fail', 'fail'], questHistory: r4.questHistory.slice(1).map((q, i) => ({ ...q, round: i + 1 })), proposedTeam: ['P5', 'P1', 'P3', 'P4'] } as unknown as PlayerObservation;
    expect(goodKeyVoteReject({ ...t0, goodKeyVote: 0.99, goodR4TwoFail: 2 }, r3)).toBe(goodKeyVoteReject({ ...t0, goodKeyVote: 0.99 }, r3));
  });
  it('3 = mode 1 on about half the votes (第 1C 節), deterministic', () => {
    const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    const pc = bayesTeamClean(r4, r4.proposedTeam, opts)!;
    const p2 = bayesTeamRedsBelow(r4, r4.proposedTeam, 2, opts)!;
    const t3 = { ...DEFAULT_AGENT_TUNING, goodKeyVote: (pc + p2) / 2, goodR4TwoFail: 3 };
    let n = 0;
    let N = 0;
    const t = r4.proposedTeam;
    const orders = [t, [...t].reverse(), [t[1], t[0], ...t.slice(2)], [t[2], t[0], t[1], t[3], t[4]], [t[4], t[3], t[0], t[1], t[2]], [t[3], t[1], t[2], t[0], t[4]]];
    for (const team of orders) for (const fc of [0, 1, 2, 3]) {
      const o = { ...r4, proposedTeam: team, failCount: fc } as unknown as PlayerObservation;
      expect(goodKeyVoteReject(t3, o)).toBe(goodKeyVoteReject(t3, o));
      N++;
      if (!goodKeyVoteReject(t3, o)) n++;
    }
    expect(n / N).toBeGreaterThan(0.2);
    expect(n / N).toBeLessThan(0.8);
  });
  it('flag takes 0–3', () => {
    expect(parseTuningFlag('goodR4TwoFail').goodR4TwoFail).toBe(1);
    expect(parseTuningFlag('goodR4TwoFail=2').goodR4TwoFail).toBe(2);
    expect(parseTuningFlag('goodR4TwoFail=3').goodR4TwoFail).toBe(3);
    expect(() => parseTuningFlag('goodR4TwoFail=4')).toThrow();
  });
});

// A loyal P5 on R3 after 紅藍: R1 P1 P2 P3 fail, R2 P4 P6 P8 P10 success. P7 leads P7 P4 P6 P8 (off-team for P5).
const r3rb = {
  myPlayerId: 'P5', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 3, currentLeader: 'P7', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P4', 'P6', 'P8', 'P10'], result: 'success', failCount: 0 },
  ],
  voteHistory: [], proposedTeam: ['P7', 'P4', 'P6', 'P8'], lakeHistory: [], myLakeResults: [],
} as unknown as PlayerObservation;

describe('goodTailCleanR3 (round 24, loyal / Percival)', () => {
  const on = (tau: number) => ({ ...DEFAULT_AGENT_TUNING, goodTailCleanR3: tau });
  it('off by default: the clean off-team R3 紅藍 team is a normal (black) vote unless it washes the tail', () => {
    expect(DEFAULT_AGENT_TUNING.goodTailCleanR3).toBe(0);
    expect(goodTailCleanR3Now(DEFAULT_AGENT_TUNING, r3rb, r3rb.proposedTeam, 0.9)).toBe(false);
  });
  it('on: white when no one on the team was on the failed mission and p ≥ τ', () => {
    expect(goodTailVote(on(0.01), r3rb)).toBe(true);
    expect(goodTailCleanR3Now(on(0.5), r3rb, r3rb.proposedTeam, 0.4)).toBe(false);
    // A failed-mission member on the team, the other mission order, or R4: not this exception.
    expect(goodTailCleanR3Now(on(0.01), r3rb, ['P7', 'P4', 'P6', 'P1'], 0.9)).toBe(false);
    expect(goodTailCleanR3Now(on(0.01), { ...r3rb, questResults: ['success', 'fail'] } as unknown as PlayerObservation, r3rb.proposedTeam, 0.9)).toBe(false);
    expect(goodTailCleanR3Now(on(0.01), { ...r3rb, currentRound: 4 } as unknown as PlayerObservation, r3rb.proposedTeam, 0.9)).toBe(false);
    // The forced fifth stays out of goodTailVote altogether.
    expect(goodTailVote(on(0.01), { ...r3rb, failCount: 4 } as unknown as PlayerObservation)).toBeNull();
  });
  it('flag parses', () => {
    expect(parseTuningFlag('goodTailCleanR3=0.3').goodTailCleanR3).toBe(0.3);
    expect(() => parseTuningFlag('goodTailCleanR3=-1')).toThrow();
  });
});

describe('beliefRedAloneCells (round 24, blue belief)', () => {
  // R3 after 藍藍 (R1 P1 P2 P3, R2 P1 P2 P3 P4 both success); P2 leads P2 P7 P1 P3 — the others sat on both clean missions with the viewer,
  // so a red P7 is most likely alone on it. A loyal P1 reads P7's on-team reject.
  const obs = (reject: boolean) => ({
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P7', failCount: 1, questResults: ['success', 'success'], gamePhase: 'team_vote',
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 },
      { round: 2, team: ['P1', 'P2', 'P3', 'P4'], result: 'success', failCount: 0 },
    ],
    voteHistory: [{ round: 3, attempt: 1, leader: 'P2', team: ['P2', 'P7', 'P1', 'P3'], votes: { ...allVotes(['P2', 'P1', 'P3']), P7: !reject }, approved: false }],
    proposedTeam: ['P7', 'P2', 'P3', 'P1'], lakeHistory: [], myLakeResults: [],
  } as unknown as PlayerObservation);
  it('off by default; the bot table carries the split cells', async () => {
    expect(DEFAULT_AGENT_TUNING.beliefRedAloneCells).toBe(false);
    expect(bayesOptionsOf(DEFAULT_AGENT_TUNING).redAloneCells).toBe(false);
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRedAloneCells: true }).redAloneCells).toBe(true);
    const tb = (await import('./belief/likelihoods_bot.json')).default as unknown as { voteAlone?: Record<string, [number, number]> };
    expect(tb.voteAlone?.['evil|alone|r3']).toBeDefined();
    expect(tb.voteAlone?.['evil|ally|r3']).toBeDefined();
  });
  it('on: an on-team reject clears the voter less (a lone red rejects far more often than the pooled cell says)', async () => {
    const { bayesRedShare } = await import('./belief/BayesBelief');
    const off = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    const on = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefRedAloneCells: true });
    const redOff = bayesRedShare(obs(true), off).get('P7')!;
    const redOn = bayesRedShare(obs(true), on).get('P7')!;
    expect(redOn).toBeGreaterThan(redOff);
    expect(parseTuningFlag('beliefRedAloneCells').beliefRedAloneCells).toBe(true);
  });
});

describe('goodReuseExact (round 24, loyal / Percival; Edward 2026-11-03 practice flag)', async () => {
  const { goodReuseExactTeam } = await import('./GoodReuseExact');
  // R2 team P2 P8 P9 P10 succeeded; R3 (size 4) loyal leader P1 — the pipeline swapped itself in for P10.
  const o = {
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_select',
    questHistory: [
      { round: 1, team: ['P3', 'P4', 'P5'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P2', 'P8', 'P9', 'P10'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
  } as unknown as PlayerObservation;
  const pipe: AgentAction = { type: 'team_select', teamIds: ['P1', 'P2', 'P8', 'P9'] };
  const on = (m: number) => ({ ...DEFAULT_AGENT_TUNING, goodReuseExact: m });
  it('off by default', () => {
    expect(DEFAULT_AGENT_TUNING.goodReuseExact).toBe(0);
    expect(goodReuseExactTeam(DEFAULT_AGENT_TUNING, o, pipe)).toBe(pipe);
  });
  it('1: the leader off the successful team re-proposes it as it was (no self-insertion); grown by one with the leader', () => {
    expect(goodReuseExactTeam(on(1), o, pipe)).toEqual({ type: 'team_select', teamIds: ['P2', 'P8', 'P9', 'P10'] });
    const r4 = { ...o, currentRound: 4, questResults: ['fail', 'success', 'success'], questHistory: [...o.questHistory, { round: 3, team: ['P2', 'P8', 'P9', 'P10'], result: 'success', failCount: 0 }] } as unknown as PlayerObservation;
    const grown = goodReuseExactTeam(on(1), r4, { type: 'team_select', teamIds: ['P1', 'P2', 'P3', 'P8', 'P9'] });
    expect(grown).toEqual({ type: 'team_select', teamIds: ['P1', 'P2', 'P8', 'P9', 'P10'] });
  });
  it('not after a failed mission or one with a fail card, not once that team was rejected this round, not past the gates', () => {
    expect(goodReuseExactTeam(on(1), { ...o, questResults: ['fail', 'fail'] } as unknown as PlayerObservation, pipe)).toBe(pipe);
    const rejected = { ...o, failCount: 1, voteHistory: [{ round: 3, attempt: 1, leader: 'P10', team: ['P10', 'P9', 'P8', 'P2'], votes: {}, approved: false }] } as unknown as PlayerObservation;
    expect(goodReuseExactTeam(on(1), rejected, pipe)).toBe(pipe);
    expect(goodReuseExactTeam(on(1), o, pipe, () => false)).toBe(pipe);
    expect(goodReuseExactTeam(on(1), { ...o, myRole: 'merlin' } as unknown as PlayerObservation, pipe)).toBe(pipe);
  });
  it('2: also the leader on the team (Percival keeps the thumb that sat on the successful mission)', () => {
    const p = { ...o, myPlayerId: 'P2', myRole: 'percival', knownWizards: ['P7', 'P10'], currentLeader: 'P2' } as unknown as PlayerObservation;
    const swap: AgentAction = { type: 'team_select', teamIds: ['P2', 'P7', 'P8', 'P9'] };
    expect(goodReuseExactTeam(on(1), p, swap)).toBe(swap);
    expect(goodReuseExactTeam(on(2), p, swap)).toEqual({ type: 'team_select', teamIds: ['P2', 'P8', 'P9', 'P10'] });
    expect(parseTuningFlag('goodReuseExact=2').goodReuseExact).toBe(2);
    expect(() => parseTuningFlag('goodReuseExact=3')).toThrow();
  });
});

describe('leaderSelfApprove (round 24 hard constraint) and goodLeadConsistent (reuse skip)', async () => {
  const { goodLeadConsistentTeam, leaderSelfApproveReason, ownVoteRejects, leadConsistentSkip } = await import('./GoodLeadConsistent');
  const { teamReusePlan } = await import('./TeamReuse');
  // R3 after R1 success P3 P5 P10, R2 fail P10 P3 P5 P6; 3-2 P2 P3 P5 P10 was rejected with P3 (the leader now) voting black on it.
  const r3 = {
    myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P3', failCount: 2, questResults: ['success', 'fail'], gamePhase: 'team_select',
    questHistory: [
      { round: 1, team: ['P3', 'P5', 'P10'], result: 'success', failCount: 0 },
      { round: 2, team: ['P10', 'P3', 'P5', 'P6'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [
      { round: 3, attempt: 1, leader: 'P1', team: ['P1', 'P2', 'P3', 'P6'], votes: allVotes(['P1', 'P3', 'P9']), approved: false },
      { round: 3, attempt: 2, leader: 'P2', team: ['P2', 'P3', 'P5', 'P10'], votes: { ...allVotes(['P2', 'P9']), P3: false }, approved: false },
    ],
    proposedTeam: [], lakeHistory: [], myLakeResults: [],
  } as unknown as PlayerObservation;
  const tun = (lsa: boolean, tau = 0.45, lc = 0) => ({ ...DEFAULT_AGENT_TUNING, leaderSelfApprove: lsa, goodCleanVote: tau, goodLeadConsistent: lc });
  it('the constraint is on by default (off only in the legacy table); the reuse skip is off', () => {
    expect(DEFAULT_AGENT_TUNING.leaderSelfApprove).toBe(true);
    expect(LEGACY_AGENT_TUNING.leaderSelfApprove).toBe(false);
    expect(DEFAULT_AGENT_TUNING.goodLeadConsistent).toBe(0);
    expect(leadConsistentSkip(DEFAULT_AGENT_TUNING, r3)).toBe(false);
  });
  it('pick: a team the own vote rules reject is replaced by the cleanest own-posterior team', () => {
    const bad: AgentAction = { type: 'team_select', teamIds: ['P3', 'P5', 'P10', 'P2'] };
    const t = tun(true, 0.99);
    expect(ownVoteRejects(t, r3, bad.teamIds)).toBe(true);
    const fixed = goodLeadConsistentTeam(t, r3, bad);
    expect(fixed).not.toBe(bad);
    const opts = bayesOptionsOf(t);
    const team = (fixed as { teamIds: string[] }).teamIds;
    expect(team).toContain('P3');
    expect(bayesTeamClean(r3, team, opts)!).toBeGreaterThanOrEqual(bayesTeamClean(r3, bad.teamIds, opts)!);
    expect(goodLeadConsistentTeam(tun(true, 0.0001), r3, bad)).toBe(bad);
    expect(goodLeadConsistentTeam(tun(false, 0.99), r3, bad)).toBe(bad);
  });
  it('goodLeadConsistent=1: the reuse plan drops the rejected team the leader sat on and voted against', () => {
    const plain = teamReusePlan(r3)!;
    const skip = teamReusePlan(r3, undefined, false, true)!;
    const has = (p: typeof plain) => p.refs.some((x) => [...x.team].sort().join(',') === 'P10,P2,P3,P5');
    expect(has(plain)).toBe(true);
    expect(has(skip)).toBe(false);
    expect(leadConsistentSkip(tun(true, 0.45, 1), r3)).toBe(true);
    expect(parseTuningFlag('goodLeadConsistent').goodLeadConsistent).toBe(1);
    expect(() => parseTuningFlag('goodLeadConsistent=2')).toThrow();
  });
  it('vote: every camp approves its own non-forced proposal and a re-proposal of its own earlier team of the round', () => {
    const vote = { ...r3, gamePhase: 'team_vote', proposedTeam: ['P3', 'P5', 'P10', 'P2'] } as unknown as PlayerObservation;
    expect(leaderSelfApproveReason(tun(true), vote)).not.toBeNull();
    expect(leaderSelfApproveReason(tun(true), { ...vote, myRole: 'mordred', myTeam: 'evil' } as unknown as PlayerObservation)).not.toBeNull();
    expect(leaderSelfApproveReason(tun(false), vote)).toBeNull();
    expect(leaderSelfApproveReason(tun(true), { ...vote, failCount: 4 } as unknown as PlayerObservation)).toBeNull();
    // Someone else's team: only a re-proposal of a team this seat led earlier this round.
    const other = { ...vote, currentLeader: 'P5', failCount: 3, proposedTeam: ['P5', 'P3', 'P6', 'P1'] } as unknown as PlayerObservation;
    expect(leaderSelfApproveReason(tun(true), other)).toBeNull();
    const mine = { ...other, voteHistory: [...r3.voteHistory, { round: 3, attempt: 3, leader: 'P3', team: ['P3', 'P1', 'P6', 'P5'], votes: {}, approved: false }] } as unknown as PlayerObservation;
    expect(leaderSelfApproveReason(tun(true), mine)).not.toBeNull();
    expect(parseTuningFlag('leaderSelfApprove=0').leaderSelfApprove).toBe(false);
  });
});

describe('beliefBiteCell (round 24, blue belief; 鐵咬)', () => {
  // R1 P1 P4 P7 success; R2 P3 P5 P6 P10 failed (1 card). 3-1 P2 leads P2 P3 P5 P10 — drops only P6 (鐵咬 6) — and P6 votes white.
  const obs = (white: boolean) => ({
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P3', failCount: 1, questResults: ['success', 'fail'], gamePhase: 'team_select',
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P7'], result: 'success', failCount: 0 },
      { round: 2, team: ['P3', 'P5', 'P6', 'P10'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [{ round: 3, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P5', 'P10'], votes: { ...allVotes(['P2', 'P3', 'P5', 'P10']), P6: white }, approved: false }],
    proposedTeam: [], lakeHistory: [], myLakeResults: [],
  } as unknown as PlayerObservation);
  it('off by default; the human table carries the cells (red approves far more often)', async () => {
    expect(DEFAULT_AGENT_TUNING.beliefBiteCell).toBe(0);
    const th = (await import('./belief/likelihoods.json')).default as unknown as { voteBite?: Record<string, [number, number]> };
    const [ea, en] = th.voteBite!.evil;
    const [ga, gn] = th.voteBite!.good;
    expect(ea / en).toBeGreaterThan(2 * (ga / gn));
  });
  it('on: a white from the bitten seat makes it redder than a black', async () => {
    const { bayesRedShare } = await import('./belief/BayesBelief');
    const off = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    const on = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefBiteCell: 2 });
    expect(on.biteCell).toBe(2);
    const w0 = bayesRedShare(obs(true), off).get('P6')!;
    const w1 = bayesRedShare(obs(true), on).get('P6')!;
    const b1 = bayesRedShare(obs(false), on).get('P6')!;
    expect(w1).toBeGreaterThan(b1);
    expect(Number.isFinite(w0)).toBe(true);
    expect(parseTuningFlag('beliefBiteCell=2').beliefBiteCell).toBe(2);
  });
});
