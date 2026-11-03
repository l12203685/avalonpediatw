/**
 * 優化迴圈第 25 回合・紅方：奧伯倫藍方兩藍時不外白（硬約束 `oberonMatchPoint`）、紅方持湖者言行一致（硬約束 `redVouchConsistent`）、
 * 被鐵咬的奧伯倫不認壞（`oberonBiteReject`）、紅方隊長不照派自己內黑過的隊（`redLeadConsistent`）、紅方隊長照派成功的隊（`redReuseExact`）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation, VoteRecord } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { withSeededRandom } from './benchmark/agreement';
import {
  bitingQuests, keepsRedVouch, oberonBiteRejectNow, oberonMatchPointReject, redReuseExactTeam,
  redVouchKeptTeam, redVouchOnTeamReject,
} from './RedRound25';
import { leadConsistentSkip, leaderSelfApproveReason } from './GoodLeadConsistent';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const vote = (round: number, attempt: number, leader: string, team: string[], approved = false, votes: Record<string, boolean> = {}): VoteRecord =>
  ({ round, attempt, leader, team, approved, votes }) as unknown as VoteRecord;
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });

// Oberon P9. R1 P1 P4 P5 success; R2 P3 P6 P9 P10 one fail; R3: P5 leads P3 P5 P6 P10 — keeps three of the failed four, bites P9.
function oberonBitten(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P9', myRole: 'oberon', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P5', gamePhase: 'team_vote', failCount: 0,
    questResults: ['success', 'fail'],
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P5'], result: 'success', failCount: 0 },
      { round: 2, team: ['P3', 'P6', 'P9', 'P10'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [vote(1, 1, 'P1', ['P1', 'P4', 'P5'], true), vote(2, 1, 'P2', ['P3', 'P6', 'P9', 'P10'], true)],
    proposedTeam: ['P3', 'P5', 'P6', 'P10'], lakeHistory: [], myLakeResults: [],
    ...over,
  } as unknown as PlayerObservation;
}

// Blue match point: R1 success, R2 fail, R3 success; R4 team of five, Oberon P9 off the team.
function matchPoint(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P9', myRole: 'oberon', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 4, currentLeader: 'P5', gamePhase: 'team_vote', failCount: 0,
    questResults: ['success', 'fail', 'success'],
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P5'], result: 'success', failCount: 0 },
      { round: 2, team: ['P2', 'P3', 'P6', 'P9'], result: 'fail', failCount: 1 },
      { round: 3, team: ['P3', 'P4', 'P5', 'P6'], result: 'success', failCount: 0 },
    ],
    voteHistory: [],
    proposedTeam: ['P3', 'P4', 'P5', 'P6', 'P7'], lakeHistory: [], myLakeResults: [],
    ...over,
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('the two hard constraints are on by default, off in the legacy table; the knobs default off', () => {
    expect(DEFAULT_AGENT_TUNING.oberonMatchPoint).toBe(true);
    expect(DEFAULT_AGENT_TUNING.redVouchConsistent).toBe(true);
    expect(LEGACY_AGENT_TUNING.oberonMatchPoint).toBe(false);
    expect(LEGACY_AGENT_TUNING.redVouchConsistent).toBe(false);
    expect(DEFAULT_AGENT_TUNING.oberonBiteReject).toBe(0);
    expect(DEFAULT_AGENT_TUNING.redLeadConsistent).toBe(0);
    expect(DEFAULT_AGENT_TUNING.redReuseExact).toBe(0);
  });
  it('parse the knob ranges', () => {
    expect(parseTuningFlag('oberonBiteReject')).toEqual({ oberonBiteReject: 1 });
    expect(parseTuningFlag('oberonBiteReject=3')).toEqual({ oberonBiteReject: 3 });
    expect(() => parseTuningFlag('oberonBiteReject=4')).toThrow();
    expect(parseTuningFlag('redLeadConsistent')).toEqual({ redLeadConsistent: 1 });
    expect(parseTuningFlag('redReuseExact=2')).toEqual({ redReuseExact: 2 });
    expect(() => parseTuningFlag('redReuseExact=3')).toThrow();
    expect(parseTuningFlag('oberonMatchPoint=0')).toEqual({ oberonMatchPoint: false });
  });
});

describe('bite (鐵咬)', () => {
  it('a team keeping |failed team| − fail cards of its members bites the dropped one', () => {
    const obs = oberonBitten();
    expect(bitingQuests(obs, obs.proposedTeam, 'P9').map((q) => q.round)).toEqual([2]);
    expect(bitingQuests(obs, ['P3', 'P5', 'P6', 'P9'], 'P9')).toEqual([]); // he is on it
    expect(bitingQuests(obs, ['P3', 'P5', 'P6', 'P7'], 'P9')).toEqual([]); // keeps only two of the four
  });
  it('oberonBiteReject: 1 every bite, 2 the next round only, 0 off', () => {
    const obs = oberonBitten();
    expect(oberonBiteRejectNow(T(), obs)).toBe(false);
    expect(oberonBiteRejectNow(T({ oberonBiteReject: 1 }), obs)).toBe(true);
    expect(oberonBiteRejectNow(T({ oberonBiteReject: 2 }), obs)).toBe(true);
    const later = oberonBitten({ currentRound: 4, questResults: ['success', 'fail', 'success'],
      questHistory: [...oberonBitten().questHistory, { round: 3, team: ['P1', 'P2', 'P4', 'P5'], result: 'success', failCount: 0 }],
      proposedTeam: ['P3', 'P5', 'P6', 'P10', 'P1'] });
    // R4 team of five keeps P3 P6 P10 (three of four) — still a bite of the R2 team, two rounds on.
    expect(oberonBiteRejectNow(T({ oberonBiteReject: 1 }), later)).toBe(true);
    expect(oberonBiteRejectNow(T({ oberonBiteReject: 2 }), later)).toBe(false);
  });
  it('not for the leader, the forced proposal, or another role', () => {
    expect(oberonBiteRejectNow(T({ oberonBiteReject: 1 }), oberonBitten({ currentLeader: 'P9' }))).toBe(false);
    expect(oberonBiteRejectNow(T({ oberonBiteReject: 1 }), oberonBitten({ failCount: 4 }))).toBe(false);
    expect(oberonBiteRejectNow(T({ oberonBiteReject: 1 }), oberonBitten({ myRole: 'mordred' as never }))).toBe(false);
  });
  it('the 50% version (3) is a fixed half by state hash', () => {
    let on = 0;
    const others = ['P1', 'P2', 'P4', 'P5', 'P7', 'P8'];
    for (let i = 0; i < 24; i++) {
      const obs = oberonBitten({ failCount: i % 4, proposedTeam: ['P3', 'P6', 'P10', others[i % 6]] });
      if (oberonBiteRejectNow(T({ oberonBiteReject: 3 }), obs)) on++;
      expect(oberonBiteRejectNow(T({ oberonBiteReject: 3 }), obs)).toBe(oberonBiteRejectNow(T({ oberonBiteReject: 3 }), obs));
    }
    expect(on).toBeGreaterThan(4);
    expect(on).toBeLessThan(20);
  });
  it('the agent rejects the biting team with the knob on', () => {
    const agent = (t: AgentTuning) => new ForwardAgent('P9', new HeuristicAgent('P9', undefined, undefined, t));
    expect(withSeededRandom('r25-bite', () => agent(T({ oberonBiteReject: 1 })).act(oberonBitten()))).toEqual({ type: 'team_vote', vote: false });
    // Without the knob the post-fail approve bias (`biasForOberon` +1.5) whites it — the 鐵咬 admission.
    expect(withSeededRandom('r25-bite', () => agent(T()).act(oberonBitten()))).toEqual({ type: 'team_vote', vote: true });
  });
});

describe('oberonMatchPoint (hard constraint)', () => {
  it('blue two wins, off the team, no certain red on it → reject', () => {
    expect(oberonMatchPointReject(T(), matchPoint())).toBe(true);
    expect(oberonMatchPointReject(T({ oberonMatchPoint: false }), matchPoint())).toBe(false);
  });
  it('not on the team, not the leader, not the forced proposal, not before blue has two', () => {
    expect(oberonMatchPointReject(T(), matchPoint({ proposedTeam: ['P3', 'P4', 'P5', 'P6', 'P9'] }))).toBe(false);
    expect(oberonMatchPointReject(T(), matchPoint({ currentLeader: 'P9' }))).toBe(false);
    expect(oberonMatchPointReject(T(), matchPoint({ failCount: 4 }))).toBe(false);
    expect(oberonMatchPointReject(T(), matchPoint({ questResults: ['success', 'fail', 'fail'] }))).toBe(false);
  });
  it('his own view puts enough reds on it → no constraint (R5 needs one: a seat he laked red)', () => {
    const r5 = matchPoint({ currentRound: 5, questResults: ['success', 'fail', 'success', 'fail'], myLakeResults: [{ round: 2, targetId: 'P7', result: 'evil' }] });
    expect(oberonMatchPointReject(T(), r5)).toBe(false);
    // R4 needs two fail cards: one laked red is not enough.
    expect(oberonMatchPointReject(T(), matchPoint({ myLakeResults: [{ round: 2, targetId: 'P7', result: 'evil' }] }))).toBe(true);
  });
  it('the agent rejects (the old post-fail approve bias would white it)', () => {
    const agent = (t: AgentTuning) => new ForwardAgent('P9', new HeuristicAgent('P9', undefined, undefined, t));
    expect(withSeededRandom('r25-mp', () => agent(T()).act(matchPoint()))).toEqual({ type: 'team_vote', vote: false });
    expect(withSeededRandom('r25-mp', () => agent(T({ oberonMatchPoint: false })).act(matchPoint()))).toEqual({ type: 'team_vote', vote: true });
  });
});

describe('redVouchConsistent (hard constraint)', () => {
  // Morgana P2 held the lake after R2: declared P5 red, P7 blue.
  const lake = [{ round: 2, holderId: 'P2', targetId: 'P5', declaredClaim: 'evil' }, { round: 3, holderId: 'P2', targetId: 'P7', declaredClaim: 'good' }];
  const holder = (over: Partial<PlayerObservation> = {}): PlayerObservation => ({
    myPlayerId: 'P2', myRole: 'morgana', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P8'],
    currentRound: 4, currentLeader: 'P6', gamePhase: 'team_vote', failCount: 0, questResults: ['success', 'fail', 'success'],
    questHistory: [], voteHistory: [], proposedTeam: ['P2', 'P5', 'P6', 'P7', 'P10'], lakeHistory: lake, myLakeResults: [],
    ...over,
  }) as unknown as PlayerObservation;
  it('on the team with a seat it declared red → reject', () => {
    expect(redVouchOnTeamReject(T(), holder())).toBe(true);
    expect(redVouchOnTeamReject(T({ redVouchConsistent: false }), holder())).toBe(false);
  });
  it('not at red match point, not as leader, not off the team, not forced', () => {
    expect(redVouchOnTeamReject(T(), holder({ questResults: ['fail', 'fail', 'success'] }))).toBe(false);
    expect(redVouchOnTeamReject(T(), holder({ currentLeader: 'P2' }))).toBe(false);
    expect(redVouchOnTeamReject(T(), holder({ proposedTeam: ['P3', 'P5', 'P6', 'P7', 'P10'] }))).toBe(false);
    expect(redVouchOnTeamReject(T(), holder({ failCount: 4 }))).toBe(false);
  });
  it('the leader keeps its word through the clean-look swap', () => {
    const lead = holder({ gamePhase: 'team_select', currentLeader: 'P2', proposedTeam: [] });
    const kept = { type: 'team_select', teamIds: ['P2', 'P7', 'P3', 'P4', 'P1'] } as const;
    const broken = { type: 'team_select', teamIds: ['P2', 'P3', 'P4', 'P6', 'P1'] } as const;
    expect(keepsRedVouch(T(), lead, kept.teamIds)).toBe(true);
    expect(keepsRedVouch(T(), lead, broken.teamIds)).toBe(false);
    expect(keepsRedVouch(T(), lead, ['P2', 'P7', 'P5', 'P4', 'P1'])).toBe(false);
    expect(redVouchKeptTeam(T(), lead, kept, broken)).toBe(kept);
    expect(redVouchKeptTeam(T({ redVouchConsistent: false }), lead, kept, broken)).toBe(broken);
    expect(redVouchKeptTeam(T(), lead, broken, kept)).toBe(kept);
  });
});

describe('redLeadConsistent', () => {
  it('red leaders skip their own inner-black references only with the knob', () => {
    const obs = { myTeam: 'evil', myRole: 'oberon' } as unknown as PlayerObservation;
    expect(leadConsistentSkip(T(), obs)).toBe(false);
    expect(leadConsistentSkip(T({ redLeadConsistent: 1 }), obs)).toBe(true);
    expect(leadConsistentSkip(T({ redLeadConsistent: 1 }), { myTeam: 'good', myRole: 'loyal' } as unknown as PlayerObservation)).toBe(false);
  });
});

describe('redReuseExact', () => {
  // Assassin P1 leads R3 (team of four) after R2 P3 P4 P5 P6 succeeded with no fail card.
  const lead = (over: Partial<PlayerObservation> = {}): PlayerObservation => ({
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P8'],
    currentRound: 3, currentLeader: 'P1', gamePhase: 'team_select', failCount: 0, questResults: ['fail', 'success'],
    questHistory: [
      { round: 1, team: ['P2', 'P4', 'P5'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P3', 'P4', 'P5', 'P6'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
    ...over,
  }) as unknown as PlayerObservation;
  const pick = { type: 'team_select', teamIds: ['P1', 'P2', 'P4', 'P5'] } as const;
  it('1: same size → the successful team as it was; 2: only when it grows by the leader', () => {
    expect(redReuseExactTeam(T({ redReuseExact: 1 }), lead(), pick)).toEqual({ type: 'team_select', teamIds: ['P3', 'P4', 'P5', 'P6'] });
    expect(redReuseExactTeam(T({ redReuseExact: 2 }), lead(), pick)).toBe(pick);
    const r4 = lead({ currentRound: 4, questResults: ['fail', 'success', 'success'], questHistory: [...lead().questHistory, { round: 3, team: ['P3', 'P4', 'P6', 'P7'], result: 'success', failCount: 0 }] });
    const pick5 = { type: 'team_select', teamIds: ['P1', 'P2', 'P4', 'P5', 'P8'] } as const;
    // blue already has two wins → no clean re-proposal from a red leader.
    expect(redReuseExactTeam(T({ redReuseExact: 2 }), r4, pick5)).toBe(pick5);
    const r4b = lead({ currentRound: 4, questResults: ['fail', 'success', 'fail'], questHistory: [...lead().questHistory, { round: 3, team: ['P3', 'P4', 'P6', 'P7'], result: 'success', failCount: 0 }] });
    expect(redReuseExactTeam(T({ redReuseExact: 2 }), r4b, pick5)).toBe(pick5); // R3 failed: no successful last team
  });
  it('not when the leader was on it, the team was already proposed this round, or the lake word forbids it', () => {
    expect(redReuseExactTeam(T({ redReuseExact: 1 }), lead({ myPlayerId: 'P3', currentLeader: 'P3' }), pick)).toBe(pick);
    expect(redReuseExactTeam(T({ redReuseExact: 1 }), lead({ voteHistory: [vote(3, 1, 'P7', ['P3', 'P4', 'P5', 'P6'])] }), pick)).toBe(pick);
    const lakeObs = lead({ lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P6', declaredClaim: 'evil' }] as never });
    expect(redReuseExactTeam(T({ redReuseExact: 1 }), lakeObs, pick)).toBe(pick);
  });
  it('the leader whites its own exact re-proposal it is not on (hard constraint `leaderSelfApproveOffTeam`)', () => {
    const v = lead({ gamePhase: 'team_vote', proposedTeam: ['P3', 'P4', 'P5', 'P6'] });
    expect(leaderSelfApproveReason(T(), v)).toBe('leader approves its own team (not on it)');
    expect(leaderSelfApproveReason(T({ leaderSelfApproveOffTeam: false }), v)).toBeNull();
    expect(leaderSelfApproveReason(T(), { ...v, currentLeader: 'P7' } as PlayerObservation)).toBeNull();
  });
});

describe('assassinReuseRead=11 (refit on the round-24 default)', () => {
  it('parses and carries the refitted factors', async () => {
    const { REUSE_MODE_FACTORS } = await import('./assassin/VisibleRedProposals');
    expect(parseTuningFlag('assassinReuseRead=11')).toEqual({ assassinReuseRead: 11 });
    expect(REUSE_MODE_FACTORS[11].clean[1]).toBeGreaterThan(1); // passing over a clean norm team R3+ now reads Merlin-ish
    expect(REUSE_MODE_FACTORS[11].reuse[0]).toBeLessThan(REUSE_MODE_FACTORS[9].reuse[0]);
  });
});
