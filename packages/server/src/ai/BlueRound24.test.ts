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
  it('flag takes 0–2', () => {
    expect(parseTuningFlag('goodR4TwoFail').goodR4TwoFail).toBe(1);
    expect(parseTuningFlag('goodR4TwoFail=2').goodR4TwoFail).toBe(2);
    expect(() => parseTuningFlag('goodR4TwoFail=3')).toThrow();
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
