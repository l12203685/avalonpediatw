/**
 * 優化迴圈第 30 回合・藍方（第 2 階段）：
 * - 忠臣／派西 `loyalR2Reuse`：第 2 局照派第 1 局成功的隊不再是 100%——「含自己、不含整個第 1 局隊」的最乾淨的隊夠接近時改派那一隊
 *   （第 29 回合紅方 `assassinReuseRead=12` 讀「照派了 = 不是梅林」；強者真人忠臣整隊保留 68%、派西 83%，機器人約 100%）；
 * - 忠臣／派西 `goodReuseNoMatchPoint`：紅方已兩紅時不照 `goodReuseExact` 照派上一局成功的隊（自我對打第 5 局照派的隊乾淨 79.7%、後驗最乾淨的隊 93.5%）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentAction, PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { loyalR2ReuseTeam, merlinR2PublicTeam, pickGoodLakeTargetEntropy, publicLakeGain, r1SuccessTeam } from './BlueRound30';
import { loyalViewOf } from './RedR1Teammate';
import { goodReuseExactTeam } from './GoodReuseExact';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votesFor = (yes: string[]) => Object.fromEntries(IDS.map((id) => [id, yes.includes(id)]));
const asObs = (o: object) => o as unknown as PlayerObservation;

// R2 attempt 1, loyal leader P5 (off the R1 team). R1: P2 P3 P4 succeeded with no fail card on the forced fifth proposal; the four
// doomed R1 proposals before it read P8 (approved every one of them off the team) as suspect.
const r1Votes = [
  { round: 1, attempt: 1, leader: 'P10', team: ['P10', 'P6', 'P7'], votes: votesFor(['P10', 'P6', 'P7', 'P8']), approved: false },
  { round: 1, attempt: 2, leader: 'P1', team: ['P1', 'P6', 'P9'], votes: votesFor(['P1', 'P6', 'P9', 'P8']), approved: false },
  { round: 1, attempt: 3, leader: 'P2', team: ['P2', 'P3', 'P8'], votes: votesFor(['P2', 'P3', 'P8']), approved: false },
  { round: 1, attempt: 4, leader: 'P3', team: ['P3', 'P2', 'P9'], votes: votesFor(['P3', 'P2', 'P9', 'P8']), approved: false },
  { round: 1, attempt: 5, leader: 'P4', team: ['P4', 'P2', 'P3'], votes: votesFor(IDS), approved: true },
];
const r2 = asObs({
  myPlayerId: 'P5', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 2, currentLeader: 'P5', failCount: 0, questResults: ['success'], gamePhase: 'team_select',
  questHistory: [{ round: 1, team: ['P4', 'P2', 'P3'], result: 'success', failCount: 0 }],
  voteHistory: r1Votes, proposedTeam: [], lakeHistory: [], myLakeResults: [],
});
const reuse: AgentAction = { type: 'team_select', teamIds: ['P5', 'P2', 'P3', 'P4'] };
const at = (lambda: number): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, loyalR2Reuse: lambda });

describe('round 30 adoption: beliefLeadStrong (Edward 2026-11-05「強者真人表如果你覺得對優化有幫助就切換」)', () => {
  it('the team pick reads the strong tables by default (round 32: the full strong tables are the default too)', () => {
    expect(DEFAULT_AGENT_TUNING.beliefLeadStrong).toBe(true);
    expect(LEGACY_AGENT_TUNING.beliefLeadStrong).toBe(false);
    expect(DEFAULT_AGENT_TUNING.beliefStrongTables).toBe(true);
    expect(bayesOptionsOf(DEFAULT_AGENT_TUNING).leadStrongTables).toBe(true);
  });
});

describe('round 30 tuning fields', () => {
  it('off in the legacy table and in the default; flags parse and describe', () => {
    expect(LEGACY_AGENT_TUNING.loyalR2Reuse).toBe(0);
    expect(LEGACY_AGENT_TUNING.goodReuseNoMatchPoint).toBe(false);
    expect(LEGACY_AGENT_TUNING.merlinR2Public).toBe(false);
    expect(parseTuningFlag('merlinR2Public')).toEqual({ merlinR2Public: true });
    expect(LEGACY_AGENT_TUNING.goodLakeEntropy).toBe(0);
    expect(parseTuningFlag('goodLakeEntropy')).toEqual({ goodLakeEntropy: 1 });
    expect(parseTuningFlag('goodLakeEntropy=2')).toEqual({ goodLakeEntropy: 2 });
    expect(parseTuningFlag('loyalR2Reuse')).toEqual({ loyalR2Reuse: 0.8 });
    expect(parseTuningFlag('loyalR2Reuse=0.85')).toEqual({ loyalR2Reuse: 0.85 });
    expect(() => parseTuningFlag('loyalR2Reuse=3')).toThrow();
    expect(parseTuningFlag('goodReuseNoMatchPoint')).toEqual({ goodReuseNoMatchPoint: true });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, loyalR2Reuse: 0.85, goodReuseNoMatchPoint: true })).toBe('loyalR2Reuse=0.85,goodReuseNoMatchPoint');
  });
});

describe('loyalR2Reuse (round 30, loyal / Percival)', () => {
  const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);
  const base = bayesTeamClean(r2, reuse.teamIds, opts)!;
  it('r1SuccessTeam: only a non-forced R2 pick after a clean R1 success', () => {
    expect(r1SuccessTeam(r2)).toEqual(['P4', 'P2', 'P3']);
    expect(r1SuccessTeam(asObs({ ...r2, failCount: 4 }))).toBeNull();
    expect(r1SuccessTeam(asObs({ ...r2, questResults: ['fail'], questHistory: [{ round: 1, team: ['P4', 'P2', 'P3'], result: 'fail', failCount: 1 }] }))).toBeNull();
    expect(r1SuccessTeam(asObs({ ...r2, questHistory: [{ round: 1, team: ['P4', 'P2', 'P3'], result: 'success', failCount: 1 }] }))).toBeNull();
    expect(r1SuccessTeam(asObs({ ...r2, currentRound: 3 }))).toBeNull();
  });
  it('switches to the cleanest team with the leader and without the whole R1 team when it is at least λ × as clean', () => {
    const alt = loyalR2ReuseTeam(at(0.01), r2, reuse);
    expect(alt).not.toBe(reuse);
    if (alt.type !== 'team_select') throw new Error('team');
    expect(alt.teamIds).toContain('P5');
    expect(alt.teamIds).toHaveLength(4);
    expect(['P2', 'P3', 'P4'].every((id) => alt.teamIds.includes(id))).toBe(false);
    const pAlt = bayesTeamClean(r2, alt.teamIds, opts)!;
    // The cleanest such team: no other team without the whole R1 team (with the leader) reads cleaner.
    expect(pAlt).toBeGreaterThan(0);
    // λ above the ratio keeps the re-proposal; λ at or below it switches.
    expect(loyalR2ReuseTeam(at(Math.min(2, pAlt / base + 0.01)), r2, reuse)).toBe(reuse);
    expect(loyalR2ReuseTeam(at(Math.max(0.001, pAlt / base - 0.01)), r2, reuse)).toEqual(alt);
  });
  it('off at 0 (the default); not for Merlin, red, the forced proposal, a team without the whole R1 team, or past the gates', () => {
    expect(DEFAULT_AGENT_TUNING.loyalR2Reuse).toBe(0);
    expect(loyalR2ReuseTeam(DEFAULT_AGENT_TUNING, r2, reuse)).toBe(reuse);
    expect(loyalR2ReuseTeam(at(0.01), asObs({ ...r2, myRole: 'merlin', knownEvils: ['P8', 'P9', 'P10'] }), reuse)).toBe(reuse);
    expect(loyalR2ReuseTeam(at(0.01), asObs({ ...r2, myRole: 'assassin', myTeam: 'evil' }), reuse)).toBe(reuse);
    expect(loyalR2ReuseTeam(at(0.01), asObs({ ...r2, failCount: 4 }), reuse)).toBe(reuse);
    const other: AgentAction = { type: 'team_select', teamIds: ['P5', 'P2', 'P3', 'P1'] };
    expect(loyalR2ReuseTeam(at(0.01), r2, other)).toBe(other);
    expect(loyalR2ReuseTeam(at(0.01), r2, reuse, () => false)).toBe(reuse);
    // Percival uses it too.
    expect(loyalR2ReuseTeam(at(0.01), asObs({ ...r2, myRole: 'percival', knownWizards: ['P1', 'P6'] }), reuse)).not.toBe(reuse);
  });
  it('keeps the leader\'s own lake word', () => {
    const vouched = asObs({ ...r2, lakeHistory: [{ round: 1, holderId: 'P5', targetId: 'P2', declaredClaim: 'good' }], myLakeResults: [{ round: 1, targetId: 'P2', result: 'good' }] });
    const alt = loyalR2ReuseTeam(at(0.01), vouched, reuse);
    if (alt.type === 'team_select' && alt !== reuse) expect(alt.teamIds).toContain('P2');
  });
});

describe('merlinR2Public (round 30, Merlin; with loyalR2Reuse)', () => {
  // Merlin P5 sees P8 P9 P10 (Mordred hides among the others); the R1 team P2 P3 P4 holds no red he sees.
  const merlin = asObs({ ...r2, myRole: 'merlin', knownEvils: ['P8', 'P9', 'P10'] });
  const both = (lambda: number): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, loyalR2Reuse: lambda, merlinR2Public: true });
  it('passes the clean R1 team over exactly when the public loyal of his seat would, with the same team', () => {
    const pub = loyalR2ReuseTeam(at(0.01), loyalViewOf(merlin), reuse);
    const got = merlinR2PublicTeam(both(0.01), merlin, reuse);
    if (pub.type === 'team_select' && pub.teamIds.some((id) => ['P8', 'P9', 'P10'].includes(id))) expect(got).toBe(reuse);
    else expect(got).toEqual(pub);
    expect(merlinR2PublicTeam(both(2), merlin, reuse)).toBe(reuse);
  });
  it('off without the flag or without loyalR2Reuse; never with a seen red on the R1 team or on the alternative', () => {
    expect(merlinR2PublicTeam({ ...DEFAULT_AGENT_TUNING, loyalR2Reuse: 0.01 }, merlin, reuse)).toBe(reuse);
    expect(merlinR2PublicTeam({ ...DEFAULT_AGENT_TUNING, merlinR2Public: true }, merlin, reuse)).toBe(reuse);
    const seen = asObs({ ...merlin, knownEvils: ['P2', 'P9', 'P10'] });
    expect(merlinR2PublicTeam(both(0.01), seen, reuse)).toBe(reuse);
    for (const evils of [['P1', 'P6', 'P7'], ['P6', 'P7', 'P8'], ['P1', 'P9', 'P10']]) {
      const got = merlinR2PublicTeam(both(0.01), asObs({ ...merlin, knownEvils: evils }), reuse);
      if (got.type === 'team_select') expect(got.teamIds.some((id) => evils.includes(id))).toBe(false);
    }
    expect(merlinR2PublicTeam(both(0.01), r2, reuse)).toBe(reuse); // a loyal: not this rule
  });
});

describe('goodReuseNoMatchPoint (round 30, loyal / Percival)', () => {
  // R5 at 2–2: R4 P2 P3 P6 P8 P9 succeeded with no fail card; loyal leader P1 (off that team) — the pipeline's own team below.
  const r5 = asObs({
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 5, currentLeader: 'P1', failCount: 0, questResults: ['success', 'fail', 'fail', 'success'], gamePhase: 'team_select',
    questHistory: [
      { round: 1, team: ['P2', 'P3', 'P6'], result: 'success', failCount: 0 },
      { round: 2, team: ['P4', 'P5', 'P7', 'P10'], result: 'fail', failCount: 1 },
      { round: 3, team: ['P4', 'P7', 'P8', 'P9'], result: 'fail', failCount: 1 },
      { round: 4, team: ['P2', 'P3', 'P6', 'P8', 'P9'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
  });
  const pipe: AgentAction = { type: 'team_select', teamIds: ['P1', 'P2', 'P3', 'P6', 'P9'] };
  it('goodReuseExact re-proposes the R4 team without the knob; with it the pipeline\'s team stays (red has two fails)', () => {
    expect(DEFAULT_AGENT_TUNING.goodReuseNoMatchPoint).toBe(true); // 第 33 回合改預設開
    expect(goodReuseExactTeam({ ...DEFAULT_AGENT_TUNING, goodReuseNoMatchPoint: false }, r5, pipe)).toEqual({ type: 'team_select', teamIds: ['P2', 'P3', 'P6', 'P8', 'P9'] });
    expect(goodReuseExactTeam({ ...DEFAULT_AGENT_TUNING, goodReuseNoMatchPoint: true }, r5, pipe)).toBe(pipe);
  });
  it('below two red fails the re-proposal is unchanged', () => {
    const r3 = asObs({
      ...r5, currentRound: 3, questResults: ['fail', 'success'],
      questHistory: [
        { round: 1, team: ['P4', 'P5', 'P7'], result: 'fail', failCount: 1 },
        { round: 2, team: ['P2', 'P3', 'P6', 'P8'], result: 'success', failCount: 0 },
      ],
    });
    const p3: AgentAction = { type: 'team_select', teamIds: ['P1', 'P2', 'P3', 'P6'] };
    const on = goodReuseExactTeam({ ...DEFAULT_AGENT_TUNING, goodReuseNoMatchPoint: true }, r3, p3);
    expect(on).toEqual(goodReuseExactTeam(DEFAULT_AGENT_TUNING, r3, p3));
    expect(on).toEqual({ type: 'team_select', teamIds: ['P2', 'P3', 'P6', 'P8'] });
  });
});

describe('goodLakeEntropy (round 30, blue lake holder; Edward 2026-11-05)', () => {
  // After R2: R1 P1 P2 P3 failed with one fail card, R2 P5 P6 P7 P8 succeeded. The lake holder is P10 (clean) or P1 (on the failed team).
  const lake = (holder: string) => asObs({
    myPlayerId: holder, myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'lady_of_the_lake',
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
  });
  const on: AgentTuning = { ...DEFAULT_AGENT_TUNING, beliefStrongTables: false, goodLakeEntropy: 1 };
  const cands = ['P2', 'P3', 'P4', 'P5', 'P6', 'P9'];
  it('a truthful-or-mixed declaration never loses information on average (expected entropy drop ≥ 0); the pick is the argmax', () => {
    const gains = cands.map((c) => publicLakeGain(on, lake('P10'), c));
    for (const g of gains) expect(g).toBeGreaterThanOrEqual(-1e-9);
    const best = cands[gains.indexOf(Math.max(...gains))];
    expect(pickGoodLakeTargetEntropy(on, lake('P10'), cands)).toBe(best);
    expect(pickGoodLakeTargetEntropy(DEFAULT_AGENT_TUNING, lake('P10'), cands)).toBeNull();
    expect(pickGoodLakeTargetEntropy(on, asObs({ ...lake('P10'), myTeam: 'evil', myRole: 'assassin' }), cands)).toBeNull();
  });
  it('the holder\'s own trustworthiness counts: a holder the table suspects (on the failed R1 team) adds less public information', () => {
    const others = ['P4', 'P5', 'P6', 'P9'];
    const clean = Math.max(...others.map((c) => publicLakeGain(on, lake('P10'), c)));
    const suspect = Math.max(...others.map((c) => publicLakeGain(on, lake('P1'), c)));
    expect(suspect).toBeLessThan(clean);
  });
});
