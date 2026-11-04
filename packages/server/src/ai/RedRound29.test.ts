/**
 * 優化迴圈第 29 回合・紅方：紅方已兩紅時隊上的相認紅都出失敗（`redMatchPointFail`）、相認紅同隊照真人比例一起藏（`redStackHide`）、
 * 莫德雷德在沒有隊友的隊上投白（`mordredSoloApprove`）、紅方照忠臣投票時自己的外白門檻（`redTailVote`）、紅方挑湖的強者模型（`redLakeHuman`）、
 * 刺客照派讀法第 2 局的係數重新擬合（`assassinReuseRead=12`）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { withSeededRandom } from './benchmark/agreement';
import {
  MORDRED_SOLO_FLIP, RED_LAKE_WEIGHTS, STACK_HIDE_RATE, mordredSoloApproveVote, redLakeArgmax, redLakeHumanTarget, redLakeSample,
  redLakeScore, redMatchPointFailCard, redStackHideCard, redTailVoteTau,
} from './RedRound29';
import { goodTailVote } from './GoodCleanVote';
import { REUSE_MODE_FACTORS, reuseLeadLogRatio } from './assassin/VisibleRedProposals';
import { pickLakeTargetForTeam } from './LakePolicy';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const agentOf = (id: string, t: AgentTuning): ForwardAgent => new ForwardAgent(id, new HeuristicAgent(id, undefined, undefined, t));

// Mordred P8 (teammates P1 assassin, P2 Morgana; Oberon P9 unseen). R3 team of four, one fail needed.
function r3(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P8', myRole: 'mordred', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2'],
    currentRound: 3, currentLeader: 'P5', gamePhase: 'quest_vote', failCount: 0,
    questResults: ['fail', 'fail'],
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P5'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P2', 'P4', 'P6', 'P7'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [], proposedTeam: ['P1', 'P8', 'P4', 'P5'], lakeHistory: [], myLakeResults: [],
    ...over,
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('round 29 knobs exist and are off in the legacy table', () => {
    for (const k of ['redMatchPointFail', 'redStackHide'] as const) expect(LEGACY_AGENT_TUNING[k]).toBe(false);
    for (const k of ['mordredSoloApprove', 'redTailVote', 'redLakeHuman'] as const) expect(LEGACY_AGENT_TUNING[k]).toBe(0);
    expect(DEFAULT_AGENT_TUNING.redMatchPointFail).toBe(true); // round 29 hard constraint (G1)
    expect(DEFAULT_AGENT_TUNING.assassinReuseRead).toBe(12); // round 29 R2 refit
    expect(DEFAULT_AGENT_TUNING.redStackHide).toBe(false);
    expect(DEFAULT_AGENT_TUNING.mordredSoloApprove).toBe(1); // round 29 consistency fix (L7)
    expect(DEFAULT_AGENT_TUNING.redTailVote).toBe(0);
    expect(DEFAULT_AGENT_TUNING.redLakeHuman).toBe(0);
  });
  it('parse the ranges', () => {
    expect(parseTuningFlag('redMatchPointFail')).toEqual({ redMatchPointFail: true });
    expect(parseTuningFlag('redStackHide')).toEqual({ redStackHide: true });
    expect(parseTuningFlag('mordredSoloApprove=2')).toEqual({ mordredSoloApprove: 2 });
    expect(() => parseTuningFlag('mordredSoloApprove=4')).toThrow();
    expect(parseTuningFlag('redTailVote')).toEqual({ redTailVote: 0.85 });
    expect(parseTuningFlag('redTailVote=0.8')).toEqual({ redTailVote: 0.8 });
    expect(() => parseTuningFlag('redTailVote=2')).toThrow();
    expect(parseTuningFlag('redLakeHuman=3')).toEqual({ redLakeHuman: 3 });
    expect(() => parseTuningFlag('redLakeHuman=4')).toThrow();
    expect(parseTuningFlag('assassinReuseRead=12')).toEqual({ assassinReuseRead: 12 });
    expect(() => parseTuningFlag('assassinReuseRead=13')).toThrow();
  });
});

describe('redMatchPointFail', () => {
  it('red has two fails and the known reds on the team suffice: fail (the rank order would hide Mordred next to the assassin)', () => {
    expect(redMatchPointFailCard(T({ redMatchPointFail: true }), r3())).toBe('fail');
    expect(redMatchPointFailCard(T({ redMatchPointFail: false }), r3())).toBeNull();
    const on = agentOf('P8', T({ redMatchPointFail: true }));
    expect(withSeededRandom('x', () => on.decide(r3())).action).toEqual({ type: 'quest_vote', vote: 'fail' });
    const off = agentOf('P8', T({ redMatchPointFail: false }));
    expect(withSeededRandom('x', () => off.decide(r3())).action).toEqual({ type: 'quest_vote', vote: 'success' });
  });
  it('not before red has two fails, not when the known reds cannot fail a two-fail mission (redHideR4Solo keeps its place)', () => {
    const t = T({ redMatchPointFail: true });
    expect(redMatchPointFailCard(t, r3({ questResults: ['fail', 'success'] }))).toBeNull();
    const r4 = r3({ currentRound: 4, questResults: ['fail', 'success', 'fail'], proposedTeam: ['P8', 'P3', 'P4', 'P5', 'P6'] });
    expect(redMatchPointFailCard(t, r4)).toBeNull();
    expect(redMatchPointFailCard(t, { ...r4, proposedTeam: ['P8', 'P1', 'P4', 'P5', 'P6'] })).toBe('fail');
  });
});

describe('redStackHide', () => {
  it('two recognised reds on an R3 mission below match point: every one draws the same (mission hash) at the human rate', () => {
    const t = T({ redStackHide: true });
    let hid = 0;
    for (let k = 0; k < 400; k++) {
      const team = ['P1', 'P8', `P${3 + (k % 5)}`, `extra${k}`];
      const me = r3({ questResults: ['fail', 'success'], proposedTeam: team });
      const mate = { ...me, myPlayerId: 'P1', myRole: 'assassin', knownEvils: ['P2', 'P8'] } as PlayerObservation;
      const a = redStackHideCard(t, me);
      expect(redStackHideCard(t, mate)).toBe(a);
      if (a === 'success') hid++;
    }
    expect(hid / 400).toBeGreaterThan(STACK_HIDE_RATE[3] - 0.07);
    expect(hid / 400).toBeLessThan(STACK_HIDE_RATE[3] + 0.07);
  });
  it('not alone, not at either match point, not for Oberon, not on R4', () => {
    const t = T({ redStackHide: true });
    expect(redStackHideCard(t, r3({ questResults: ['fail', 'success'], proposedTeam: ['P8', 'P3', 'P4', 'P5'] }))).toBeNull();
    expect(redStackHideCard(t, r3())).toBeNull();
    expect(redStackHideCard(t, r3({ questResults: ['success', 'success'] }))).toBeNull();
    expect(redStackHideCard(t, r3({ questResults: ['fail', 'success'], myRole: 'oberon', knownEvils: [] }))).toBeNull();
    expect(redStackHideCard(t, r3({ currentRound: 4, questResults: ['fail', 'success', 'success'] }))).toBeNull();
  });
});

describe('mordredSoloApprove', () => {
  const vote = (over: Partial<PlayerObservation> = {}): PlayerObservation => r3({ gamePhase: 'team_vote', proposedTeam: ['P8', 'P3', 'P4', 'P5'], questResults: ['fail', 'success'], ...over });
  it('mode 1: approve when his own card fails the mission (one fail needed); not on R4, not as leader, not with a teammate on it', () => {
    const t = T({ mordredSoloApprove: 1 });
    expect(mordredSoloApproveVote(t, vote())).toBe(true);
    expect(mordredSoloApproveVote(t, vote({ currentRound: 4, proposedTeam: ['P8', 'P3', 'P4', 'P5', 'P6'] }))).toBeNull();
    expect(mordredSoloApproveVote(t, vote({ currentLeader: 'P8' }))).toBeNull();
    expect(mordredSoloApproveVote(t, vote({ proposedTeam: ['P8', 'P1', 'P4', 'P5'] }))).toBeNull();
    expect(mordredSoloApproveVote(t, vote({ myRole: 'assassin' }))).toBeNull();
    expect(mordredSoloApproveVote(t, vote({ failCount: 4 }))).toBeNull();
    expect(mordredSoloApproveVote(T({ mordredSoloApprove: 0 }), vote())).toBeNull();
  });
  it('mode 2: the strong-Mordred flip rate of the cell (R4 too)', () => {
    const t = T({ mordredSoloApprove: 2 });
    let yes = 0;
    for (let k = 0; k < 400; k++) if (mordredSoloApproveVote(t, vote({ proposedTeam: ['P8', 'P3', `P${4 + (k % 3)}`, `x${k}`] }))) yes++;
    expect(yes / 400).toBeGreaterThan(MORDRED_SOLO_FLIP['R3|其他'] - 0.07);
    expect(yes / 400).toBeLessThan(MORDRED_SOLO_FLIP['R3|其他'] + 0.07);
  });
  it('the forward agent takes it ahead of the scorer', () => {
    const on = agentOf('P8', T({ mordredSoloApprove: 1 }));
    expect(withSeededRandom('y', () => on.decide(vote())).action).toEqual({ type: 'team_vote', vote: true });
  });
});

describe('redTailVote', () => {
  it('only the red loyal view takes the red threshold', () => {
    const t = T({ redTailVote: 0.85 });
    const view = { ...r3({ gamePhase: 'team_vote' }), myRole: 'loyal', myTeam: 'good', knownEvils: [], publicLoyalView: true } as PlayerObservation;
    expect(redTailVoteTau(t, view)).toBeNull();
    expect(redTailVoteTau(t, { ...view, redLoyalView: true })).toBe(0.85);
    expect(redTailVoteTau(T({ redTailVote: 0 }), { ...view, redLoyalView: true })).toBeNull();
  });
  it('a stricter threshold never adds an outer white', () => {
    const base = { ...r3({ gamePhase: 'team_vote', questResults: ['fail', 'success'], proposedTeam: ['P3', 'P4', 'P5', 'P6'], currentLeader: 'P5' }), myRole: 'loyal', myTeam: 'good', knownEvils: [], publicLoyalView: true, redLoyalView: true } as PlayerObservation;
    const loose = goodTailVote(T({ redTailVote: 0 }), base);
    const strict = goodTailVote(T({ redTailVote: 0.99 }), base);
    if (loose === false) expect(strict).toBe(false);
    expect(strict === true && loose !== true).toBe(false);
  });
});

describe('redLakeHuman', () => {
  // Assassin P1 holds the lake after R2 (teammates P2, P8). R1 P1 P4 P5 failed; R2 P3 P6 P7 P9 passed.
  const lake = (over: Partial<PlayerObservation> = {}): PlayerObservation => ({
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P8'],
    currentRound: 2, currentLeader: 'P3', gamePhase: 'lady_of_the_lake', failCount: 0, questResults: ['fail', 'success'],
    questHistory: [
      { round: 1, team: ['P1', 'P4', 'P5'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P3', 'P6', 'P7', 'P9'], result: 'success', failCount: 0 },
    ],
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P1', team: ['P1', 'P4', 'P5'], approved: true, votes: {} },
      { round: 2, attempt: 1, leader: 'P2', team: ['P3', 'P6', 'P7', 'P9'], approved: true, votes: {} },
    ],
    proposedTeam: [], lakeHistory: [], myLakeResults: [],
    ...over,
  } as unknown as PlayerObservation);
  const valid = ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'];
  it('the score follows the fitted weights (a blue on the failed mission it led, co-failed with the holder)', () => {
    const w = RED_LAKE_WEIGHTS;
    expect(redLakeScore(lake(), 'P4')).toBeCloseTo(w.blueFail + w.coFail + w.holderShare + w.picked * 0, 6);
    expect(redLakeScore(lake(), 'P8')).toBeCloseTo(w.ally + w.allyNever, 6);
  });
  it('argmax and sample stay inside the valid targets; mode 3 keeps a teammate the 10/13 rule picked', () => {
    const t1 = T({ redLakeHuman: 1 });
    expect(valid).toContain(redLakeArgmax(lake(), valid));
    expect(valid).toContain(redLakeSample(lake(), valid));
    expect(redLakeHumanTarget(t1, lake(), valid, 'P2')).toBe(redLakeArgmax(lake(), valid));
    const t3 = T({ redLakeHuman: 3 });
    expect(redLakeHumanTarget(t3, lake(), valid, 'P2')).toBeNull();
    const blue = redLakeHumanTarget(t3, lake(), valid, 'P3');
    expect(blue).not.toBeNull();
    expect(['P2', 'P8']).not.toContain(blue);
    expect(redLakeHumanTarget(T({ redLakeHuman: 0 }), lake(), valid, 'P3')).toBeNull();
  });
  it('the lake policy applies it after the 10/13 rule', () => {
    const t = T({ redLakeHuman: 1 });
    expect(pickLakeTargetForTeam('evil', lake(), valid, t)).toBe(redLakeArgmax(lake(), valid));
  });
});

describe('assassinReuseRead=12', () => {
  it('keeps the R3+ factors of 11 and refits R2 (re-proposing the R1 team with a seen red is loyal-ish)', () => {
    expect(REUSE_MODE_FACTORS[12].miss[1]).toBe(REUSE_MODE_FACTORS[11].miss[1]);
    expect(REUSE_MODE_FACTORS[12].reuse[1]).toBe(REUSE_MODE_FACTORS[11].reuse[1]);
    expect(REUSE_MODE_FACTORS[12].clean[1]).toBe(REUSE_MODE_FACTORS[11].clean[1]);
    expect(REUSE_MODE_FACTORS[12].reuse[0]).toBeLessThan(0.1);
    expect(REUSE_MODE_FACTORS[12].miss[0]).toBeGreaterThan(REUSE_MODE_FACTORS[11].miss[0]);
  });
  it('a captain who re-proposed the R1 team holding a red Merlin sees scores lower than under 11', () => {
    // Assassin P1 (sees P2, P8; Merlin sees P1, P2, P9). R1 P1 P4 P5 passed; R2 captain P6 re-proposed it with himself.
    const obs = {
      myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P8'], allEvilIds: ['P1', 'P2', 'P8', 'P9'],
      currentRound: 3, currentLeader: 'P7', gamePhase: 'assassination', failCount: 0, questResults: ['success', 'success', 'success'],
      questHistory: [
        { round: 1, team: ['P1', 'P4', 'P5'], result: 'success', failCount: 0 },
        { round: 2, team: ['P1', 'P4', 'P5', 'P6'], result: 'success', failCount: 0 },
        { round: 3, team: ['P3', 'P4', 'P5', 'P6'], result: 'success', failCount: 0 },
      ],
      voteHistory: [
        { round: 1, attempt: 1, leader: 'P5', team: ['P1', 'P4', 'P5'], approved: true, votes: {} },
        { round: 2, attempt: 1, leader: 'P6', team: ['P1', 'P4', 'P5', 'P6'], approved: true, votes: {} },
        { round: 3, attempt: 1, leader: 'P7', team: ['P3', 'P4', 'P5', 'P6'], approved: true, votes: {} },
      ],
      proposedTeam: [], lakeHistory: [], myLakeResults: [],
    } as unknown as PlayerObservation;
    expect(reuseLeadLogRatio(obs, 'P6', 12)).toBeLessThan(reuseLeadLogRatio(obs, 'P6', 11));
  });
});
