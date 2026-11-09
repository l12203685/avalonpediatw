/**
 * 優化迴圈第 28 回合・藍方（第 2 階段）：
 * - 梅林／派西 `mpTailWhite`（D3 第二階段，Edward 2026-11-04「忠臣做得到 梅林跟派西維爾才能做」）：同一座位、只看公開紀錄的忠臣會開尾家外白時才開；
 *   梅林另外不開有他看得到的紅的隊，派西另外要自己的後驗也過同一條規則；
 * - 忠臣 `loyalTailWhiteEarly`：第 1–3 次提議也開，比較的對象是之後每一任隊長（到尾家為止）能派的最乾淨的隊。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { bestCleanWith, leaderAhead, loyalTailWhiteNow, mpTailWhiteNow, tailWhiteCore } from './GoodVoteAlt';
import { loyalViewOf } from './RedR1Teammate';
import { merlinLoyalStyleTeam, merlinReuseNormTeam } from './MerlinLoyalStyle';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votesFor = (team: string[], yes: string[] = team) => Object.fromEntries(IDS.map((id) => [id, yes.includes(id)]));
const asObs = (o: object) => o as unknown as PlayerObservation;

// R2, attempt 1, leader P6 → the tail is P10. R1: P10 P2 P3 failed with three fail cards (all three red); the fourth red is among P4…P9.
const r2 = asObs({
  myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 2, currentLeader: 'P6', failCount: 0, questResults: ['fail'], gamePhase: 'team_vote',
  questHistory: [{ round: 1, team: ['P10', 'P2', 'P3'], result: 'fail', failCount: 3 }],
  voteHistory: [{ round: 1, attempt: 1, leader: 'P10', team: ['P10', 'P2', 'P3'], votes: votesFor(IDS), approved: true }],
  proposedTeam: ['P6', 'P5', 'P1', 'P7'], lakeHistory: [], myLakeResults: [],
});
const fourth = asObs({ ...r2, failCount: 3, currentLeader: 'P9' }); // the fourth proposal: the tail P10 leads the forced fifth

describe('round 28 tuning fields', () => {
  it('off in the legacy table; the round-28 default (stage 2 package); flags parse and describe', () => {
    expect(LEGACY_AGENT_TUNING.mpTailWhite).toBe(0);
    expect(LEGACY_AGENT_TUNING.loyalTailWhiteEarly).toBe(false);
    expect(LEGACY_AGENT_TUNING.merlinReuseNoEarly).toBe(false);
    // Round 28 adoption (stage 2, three sets of 6000 seeds): the package below.
    expect(DEFAULT_AGENT_TUNING.mpTailWhite).toBe(1);
    expect(DEFAULT_AGENT_TUNING.loyalTailWhiteEarly).toBe(true);
    expect(DEFAULT_AGENT_TUNING.merlinReuseNoEarly).toBe(false); // round 33: off (Edward 2026-11-09 ruling 1: 本來就可以照派成功隊)
    expect(DEFAULT_AGENT_TUNING.goodTailVote).toBe(0.7);
    expect(DEFAULT_AGENT_TUNING.beliefLeadTemper).toBe(0);
    expect(DEFAULT_AGENT_TUNING.beliefLeadStrong).toBe(true); // round 30 adoption (Edward 2026-11-05)
    expect(parseTuningFlag('mpTailWhite=2')).toEqual({ mpTailWhite: 2 });
    expect(parseTuningFlag('loyalTailWhiteEarly')).toEqual({ loyalTailWhiteEarly: true });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, mpTailWhite: 1 })).toBe('mpTailWhite=1');
  });
});

describe('tailWhiteCore (round 28 refactor of loyalTailWhite)', () => {
  it('a true loyal reads exactly as before with loyalTailWhiteEarly off: the fourth proposal only', () => {
    const r26: AgentTuning = { ...DEFAULT_AGENT_TUNING, loyalTailWhiteEarly: false };
    expect(loyalTailWhiteNow(r26, r2)).toBe(false);
    expect(loyalTailWhiteNow(r26, fourth)).toBe(true);
    expect(tailWhiteCore(r26, fourth)).toBe(true);
  });
  it('loyalTailWhiteEarly: attempts 1–3 compare with the cleanest team any later captain up to the tail could send', () => {
    const early: AgentTuning = DEFAULT_AGENT_TUNING;
    const opts = bayesOptionsOf(early);
    const p = bayesTeamClean(r2, r2.proposedTeam, opts)!;
    let alt = 0;
    for (let o = 1; o <= 4; o++) alt = Math.max(alt, bestCleanWith(r2, leaderAhead(r2, o)!, 4, opts) ?? 0);
    expect(tailWhiteCore(early, r2)).toBe(p >= alt && p > 0);
    // Stricter than the tail-only comparison (more alternatives can only raise the bar).
    const tailOnly: AgentTuning = { ...DEFAULT_AGENT_TUNING, loyalTailWhiteLast: false };
    if (tailWhiteCore(early, r2)) expect(tailWhiteCore(tailOnly, r2)).toBe(true);
    // The fourth proposal is unchanged.
    expect(tailWhiteCore(early, fourth)).toBe(tailWhiteCore({ ...DEFAULT_AGENT_TUNING, loyalTailWhiteEarly: false }, fourth));
    // A certain-red team never passes.
    expect(tailWhiteCore(early, asObs({ ...r2, proposedTeam: ['P6', 'P2', 'P1', 'P7'] }))).toBe(false);
  });
});

describe('mpTailWhite (round 28, Merlin / Percival; D3 stage 2)', () => {
  const merlin = asObs({ ...fourth, myRole: 'merlin', knownEvils: ['P10', 'P2', 'P3', 'P9'] });
  const percival = asObs({ ...fourth, myRole: 'percival', knownWizards: ['P4', 'P5'] });
  it('Merlin casts the tail white the public loyal view of his seat casts (default 1; 0 = off)', () => {
    expect(mpTailWhiteNow({ ...DEFAULT_AGENT_TUNING, mpTailWhite: 0 }, merlin)).toBe(false);
    expect(mpTailWhiteNow(DEFAULT_AGENT_TUNING, merlin)).toBe(true);
    expect(mpTailWhiteNow({ ...DEFAULT_AGENT_TUNING, mpTailWhite: 1 }, merlin)).toBe(true);
    expect(mpTailWhiteNow({ ...DEFAULT_AGENT_TUNING, mpTailWhite: 2 }, merlin)).toBe(true);
    expect(mpTailWhiteNow({ ...DEFAULT_AGENT_TUNING, mpTailWhite: 3 }, merlin)).toBe(false);
    // Not where the public loyal view would not (the first proposal under the round-26 fourth-only rule).
    expect(mpTailWhiteNow({ ...DEFAULT_AGENT_TUNING, mpTailWhite: 1, loyalTailWhiteEarly: false }, asObs({ ...merlin, failCount: 0, currentLeader: 'P6' }))).toBe(false);
  });
  it('Merlin never on a team holding a red he sees, even when the public view would white it', () => {
    const on: AgentTuning = { ...DEFAULT_AGENT_TUNING, mpTailWhite: 1 };
    const withSeen = asObs({ ...merlin, proposedTeam: ['P9', 'P5', 'P1', 'P7'] });
    const publicView = asObs({ ...loyalViewOf(withSeen), publicLoyalView: false });
    // Whatever the public view says, the seen red blocks it.
    expect(typeof tailWhiteCore(on, publicView)).toBe('boolean');
    expect(mpTailWhiteNow(on, withSeen)).toBe(false);
  });
  it('Percival: the public view and his own posterior must agree; loyals and the public-loyal view itself are not touched', () => {
    const on: AgentTuning = { ...DEFAULT_AGENT_TUNING, mpTailWhite: 1 };
    const publicView = asObs({ ...loyalViewOf(percival), publicLoyalView: false });
    expect(mpTailWhiteNow(on, percival)).toBe(tailWhiteCore(on, publicView) && tailWhiteCore(on, percival));
    expect(mpTailWhiteNow({ ...on, mpTailWhite: 2 }, percival)).toBe(false);
    expect(mpTailWhiteNow(on, fourth)).toBe(false); // a loyal goes through loyalTailWhite
    expect(mpTailWhiteNow(on, loyalViewOf(merlin))).toBe(false);
  });
});

describe('beliefLeadTemper (round 28, team picks)', () => {
  // R3, P1 picks a team: two R2 proposals were rejected with split votes (the votes and proposals carry information).
  const r3 = asObs({
    ...r2, currentRound: 3, currentLeader: 'P1', gamePhase: 'team_select', questResults: ['fail', 'success'], failCount: 0,
    questHistory: [...(r2 as unknown as { questHistory: unknown[] }).questHistory, { round: 2, team: ['P4', 'P5', 'P6', 'P7'], result: 'success', failCount: 0 }],
    voteHistory: [
      ...r2.voteHistory,
      { round: 2, attempt: 1, leader: 'P4', team: ['P4', 'P5', 'P8', 'P9'], votes: votesFor(IDS, ['P4', 'P5', 'P8', 'P9', 'P2']), approved: false },
      { round: 2, attempt: 2, leader: 'P5', team: ['P4', 'P5', 'P6', 'P7'], votes: votesFor(IDS, ['P4', 'P5', 'P6', 'P7', 'P1', 'P9']), approved: true },
    ],
    proposedTeam: [],
  });
  it('off by default; on, a team pick reads with its own powers and a vote point does not change', () => {
    expect(DEFAULT_AGENT_TUNING.beliefLeadTemper).toBe(0);
    expect(parseTuningFlag('beliefLeadTemper=70')).toEqual({ beliefLeadTemper: 70 });
    const team = ['P1', 'P4', 'P6', 'P7', 'P9'];
    const base = bayesTeamClean(r3, team, bayesOptionsOf(DEFAULT_AGENT_TUNING))!;
    const lead = bayesTeamClean(r3, team, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefLeadTemper: 1 }))!;
    const untempered = bayesTeamClean(r3, team, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefTemper: 0 }))!;
    expect(lead).not.toBeCloseTo(base, 6);
    expect(lead).toBeCloseTo(untempered, 9);
    const vote = asObs({ ...r3, gamePhase: 'team_vote', proposedTeam: team });
    expect(bayesTeamClean(vote, team, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefLeadTemper: 1 }))).toBeCloseTo(bayesTeamClean(vote, team, bayesOptionsOf(DEFAULT_AGENT_TUNING))!, 12);
  });
  it('beliefLeadStrong: a team pick reads with the strong tables, a vote point does not', () => {
    expect(DEFAULT_AGENT_TUNING.beliefLeadStrong).toBe(true); // default since round 30
    const team = ['P1', 'P4', 'P6', 'P7', 'P9'];
    const on = bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefLeadStrong: true });
    const strong = bayesTeamClean(r3, team, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefStrongTables: true }))!;
    expect(bayesTeamClean(r3, team, on)).toBeCloseTo(strong, 12);
    const vote = asObs({ ...r3, gamePhase: 'team_vote', proposedTeam: team });
    expect(bayesTeamClean(vote, team, on)).toBeCloseTo(bayesTeamClean(vote, team, bayesOptionsOf(DEFAULT_AGENT_TUNING))!, 12);
  });
});

describe('merlinReuseNoEarly (round 28; Edward 11/04 ruling 5 — off by default since round 33, Edward 11/09 ruling 1)', () => {
  // R1 P2 P3 P4 succeeded with P3 (a red Merlin sees) hiding; Merlin P1 leads R2.
  const mobs = asObs({
    myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P3', 'P7', 'P9'],
    currentRound: 2, currentLeader: 'P1', failCount: 1, questResults: ['success'], gamePhase: 'team_select',
    questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }],
    voteHistory: [], proposedTeam: [], lakeHistory: [],
  });
  it('R2: no re-proposal of the successful R1 team holding a seen red; the loyal-style team has no seen red', () => {
    const ON = { ...DEFAULT_AGENT_TUNING, merlinReuseNoEarly: true };
    expect(merlinReuseNormTeam(ON, mobs, 4)).toBeNull();
    const a = merlinLoyalStyleTeam(ON, mobs, { type: 'team_select', teamIds: ['P1', 'P2', 'P3', 'P4'] });
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds.some((id) => ['P3', 'P7', 'P9'].includes(id))).toBe(false);
  });
  it('R3+: the re-proposal norm is unchanged (Edward 11/01: 照派成功的隊算順應局勢)', () => {
    const r3 = asObs({ ...mobs, currentRound: 3, questResults: ['success', 'success'],
      questHistory: [{ round: 1, team: ['P5', 'P6', 'P8'], result: 'success', failCount: 0 }, { round: 2, team: ['P2', 'P3', 'P4', 'P5'], result: 'success', failCount: 0 }] });
    const t = merlinReuseNormTeam(DEFAULT_AGENT_TUNING, r3, 4);
    expect(t === null || ['P2', 'P3', 'P4', 'P5'].every((id) => t.includes(id))).toBe(true);
  });
});
