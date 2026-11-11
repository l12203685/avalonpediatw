/**
 * 優化迴圈第 38 回合・藍方：挑隊帶自己的先驗（`ownView`）、派西只帶分得出來的拇指（`beliefThumbNoStain`、`percivalThumbRead`）、
 * 異常票照局面（`goodOnTeamState`、`goodReuseWhite`、`goodFourthWhite`、`goodR5NoWhite`、`merlinOnTeamOwn`、`merlinOwnWhite`、`percivalMerlinWhite`）、
 * 梅林順著場上都在派的紅（`merlinFlowFollow`）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean, ownViewOffsets, ownViewStrength } from './belief/BayesBelief';
import { bayesVoteCriteria, r1InfoCtx } from './BlueRound33';
import { earlyOwnTeamWhite, fourthWhiteNow, ownViewOn, fullReuseOfLastSuccess, goodLakeHumanPool, leadsLaterThisRound, merlinOnTeamOwnApprove, onTeamStateApprove, ownViewFirstPickTeam, percivalMerlinWhiteNow, percivalThumbReadTeam, r3TeamKeptAtR4, reuseWhiteNow } from './BlueRound38';
import { tailWhiteCore } from './GoodVoteAlt';
import { merlinFlowRed, merlinLoyalStyleTeam, merlinReusePublicNow } from './MerlinLoyalStyle';
import { ForwardAgent } from './forward/ForwardAgent';
import { HeuristicAgent } from './HeuristicAgent';
import { redCleanLookTeam } from './RedRound4';
import { r1InflCtx } from './BlueRound34';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const R1 = [
  vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3']), vote(1, 2, 'P2', ['P2', 'P4', 'P6'], ['P2', 'P4', 'P6']),
  vote(1, 3, 'P3', ['P3', 'P5', 'P9'], ['P3', 'P5', 'P9']), vote(1, 4, 'P4', ['P4', 'P7', 'P10'], ['P4', 'P7', 'P10']),
  vote(1, 5, 'P5', ['P5', 'P1', 'P10'], IDS),
];
const base = {
  myPlayerId: 'P7', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [], evilCount: 4,
  lakeHistory: [], myLakeResults: [], proposedTeam: [],
};
// R2 after the R1 fail, P6 has proposed; P7 leads the second R2 proposal.
const r2 = asObs({
  ...base, currentRound: 2, currentLeader: 'P7', failCount: 1, questResults: ['fail'], gamePhase: 'team_select',
  questHistory: [{ round: 1, team: ['P5', 'P1', 'P10'], result: 'fail', failCount: 1 }],
  voteHistory: [...R1, vote(2, 1, 'P6', ['P6', 'P2', 'P3', 'P4'], ['P6', 'P2', 'P3', 'P4'])],
});
// The round-38 cases are written on the round-37 default: the round-38 and round-39 adoptions are switched off here.
const OFF = { ...DEFAULT_AGENT_TUNING, ownView: 0, merlinOnTeamOwn: 0, goodBayesR4Kept: 0, loyalTailWhiteLastTau: 0, goodReuseWhite: 0,
  percivalRead39: 0, percivalCarry39: 0, merlinFlowFollow: 0, beliefPendingProposal: false, goodBayesBad: 0.8, goodBayesBadKey: 0.7, goodBayesGood: 0.7, loyalTailWhite: 0.7 };
const T = (over: object) => ({ ...OFF, ...over });

describe('round 38 tuning fields', () => {
  it('off in the legacy table and the default; flags parse', () => {
    for (const k of ['ownView', 'ownViewScope', 'ownViewKeep', 'percivalThumbRead', 'goodOnTeamState', 'goodReuseWhite', 'goodFourthWhite', 'merlinOwnWhite', 'percivalMerlinWhite', 'merlinFlowFollow', 'merlinOnTeamOwn', 'loyalTailWhiteLastTau', 'goodBayesR4Kept', 'goodBayesFsReuse', 'merlinPublicPipeline', 'goodR4White', 'goodEarlyVote', 'goodLakeHuman'] as const) {
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
    }
    // adopted in round 38 (default on): ownView 0.3, merlinOnTeamOwn 1, goodBayesR4Kept 1, loyalTailWhiteLastTau 0.5, goodReuseWhite 1
    expect([DEFAULT_AGENT_TUNING.ownView, DEFAULT_AGENT_TUNING.merlinOnTeamOwn, DEFAULT_AGENT_TUNING.goodBayesR4Kept, DEFAULT_AGENT_TUNING.loyalTailWhiteLastTau, DEFAULT_AGENT_TUNING.goodReuseWhite]).toEqual([0.3, 1, 1, 0.5, 1]);
    for (const k of ['ownViewScope', 'ownViewKeep', 'ownViewRounds', 'percivalThumbRead', 'goodOnTeamState', 'goodFourthWhite', 'merlinOwnWhite', 'percivalMerlinWhite', 'goodBayesFsReuse', 'merlinPublicPipeline', 'goodR4White', 'goodEarlyVote', 'goodLakeHuman'] as const) expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
    // round 39 adopted `merlinFlowFollow=3`; `beliefPendingProposal` was tried and reverted after review (gate 1)
    expect(DEFAULT_AGENT_TUNING.merlinFlowFollow).toBe(3);
    expect(DEFAULT_AGENT_TUNING.beliefPendingProposal).toBe(false);
    for (const k of ['beliefThumbNoStain', 'goodR5NoWhite', 'merlinPublicTieBreak', 'beliefPendingProposal', 'percivalLakeNoMorgana'] as const) expect(LEGACY_AGENT_TUNING[k]).toBe(false);
    expect(parseTuningFlag('ownView')).toEqual({ ownView: 0.3 });
    expect(parseTuningFlag('ownView=0.6')).toEqual({ ownView: 0.6 });
    expect(parseTuningFlag('ownViewScope=3')).toEqual({ ownViewScope: 3 });
    expect(() => parseTuningFlag('ownViewScope=4')).toThrow();
    expect(parseTuningFlag('percivalThumbRead')).toEqual({ percivalThumbRead: 0.6 });
    expect(parseTuningFlag('goodOnTeamState=2')).toEqual({ goodOnTeamState: 2 });
    expect(parseTuningFlag('goodReuseWhite')).toEqual({ goodReuseWhite: 1 });
    expect(() => parseTuningFlag('goodReuseWhite=3')).toThrow();
    expect(parseTuningFlag('merlinFlowFollow')).toEqual({ merlinFlowFollow: 3 });
    expect(() => parseTuningFlag('merlinFlowFollow=1')).toThrow();
    expect(parseTuningFlag('merlinOwnWhite')).toEqual({ merlinOwnWhite: 0.5 });
    expect(parseTuningFlag('beliefThumbNoStain')).toEqual({ beliefThumbNoStain: true });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, ownView: 0.3, ownViewScope: 2, goodReuseWhite: 1, merlinOnTeamOwn: 2 })).toBe('ownView=0.3,ownViewScope=2,merlinOnTeamOwn=2,goodReuseWhite=1');
    expect(parseTuningFlag('merlinOnTeamOwn')).toEqual({ merlinOnTeamOwn: 4 });
  });
});

describe('ownView (round 38: the leader picks from his own prior; the record still updates it)', () => {
  const cfg = { sigma: 0.3, keep: 0, scope: 1 };
  it('applies to a loyal non-forced pick only; weaker the likelier the proposal goes on a mission; never to a public-view (red) seat', () => {
    expect(ownViewStrength(r2, 1)).toBeGreaterThan(0.9);
    expect(ownViewStrength(asObs({ ...(r2 as object), failCount: 4 }), 1)).toBe(0);
    expect(ownViewStrength(asObs({ ...(r2 as object), gamePhase: 'team_vote' }), 1)).toBe(0);
    expect(ownViewStrength(asObs({ ...(r2 as object), publicLoyalView: true }), 1)).toBe(0);
    expect(ownViewStrength(asObs({ ...(r2 as object), myRole: 'percival' }), 1)).toBe(0);
    expect(ownViewStrength(asObs({ ...(r2 as object), myRole: 'percival' }), 2)).toBeGreaterThan(0);
    // R4 first proposal goes on a mission 55% of the time: no own prior there
    expect(ownViewStrength(asObs({ ...(r2 as object), currentRound: 4, failCount: 0 }), 1)).toBe(0);
    expect(ownViewStrength(asObs({ ...(r2 as object), currentRound: 3, failCount: 1 }), 1)).toBeCloseTo(0.8, 5);
  });
  it('from the game\'s first proposal on the offsets are fixed for the seat (the first proposal itself is a separate random draw), differ between seats, and count the leader\'s own earlier picks less suspicious', () => {
    const a = ownViewOffsets(r2, cfg)!;
    const again = ownViewOffsets(asObs({ ...(r2 as object) }), cfg)!;
    expect([...a]).toEqual([...again]);
    expect(a.has('P7')).toBe(false);
    const other = ownViewOffsets(asObs({ ...(r2 as object), myPlayerId: 'P8', currentLeader: 'P8' }), cfg)!;
    expect(IDS.filter((id) => id !== 'P7' && id !== 'P8').some((id) => Math.abs(a.get(id)! - other.get(id)!) > 1e-6)).toBe(true);
    // P4 led R1-4 with P7 and P10: as P4 at a later pick, those two are `keep` less suspicious than without it
    const p4 = asObs({ ...(r2 as object), myPlayerId: 'P4', currentLeader: 'P4', currentRound: 3, failCount: 1, questResults: ['fail', 'fail'] });
    const plain = ownViewOffsets(p4, cfg)!;
    const kept = ownViewOffsets(p4, { ...cfg, keep: 0.5 })!;
    const f = ownViewStrength(p4, 1);
    expect(plain.get('P7')! - kept.get('P7')!).toBeCloseTo(0.5 * f, 6);
    expect(plain.get('P2')! - kept.get('P2')!).toBeCloseTo(0, 6);
  });
  it('tilts the pick posterior only: votes read the same posterior as before', () => {
    const t = T({ ownView: 0.3 });
    const team = ['P7', 'P2', 'P8', 'P9'];
    const pick = bayesTeamClean(r2, team, bayesOptionsOf(t))!;
    const plain = bayesTeamClean(r2, team, bayesOptionsOf(OFF))!;
    expect(Math.abs(pick - plain)).toBeGreaterThan(1e-6);
    const asVote = asObs({ ...(r2 as object), gamePhase: 'team_vote', proposedTeam: team });
    expect(bayesTeamClean(asVote, team, bayesOptionsOf(t))).toBeCloseTo(bayesTeamClean(asVote, team, bayesOptionsOf(OFF))!, 12);
    // certain facts stay certain: the whole failed R1 team can never be clean in any view
    expect(bayesTeamClean(asObs({ ...(r2 as object), myPlayerId: 'P5', currentLeader: 'P5' }), ['P5', 'P1', 'P10', 'P2'], bayesOptionsOf(t))).toBe(0);
  });
  it('the first proposal of the game is the cleanest team of the own prior (two leaders with different draws differ); off: untouched', () => {
    const first = asObs({ ...base, myPlayerId: 'P1', currentRound: 1, currentLeader: 'P1', failCount: 0, questResults: [], gamePhase: 'team_select', questHistory: [], voteHistory: [] });
    const fixed = { type: 'team_select' as const, teamIds: ['P1', 'P6', 'P9'] };
    expect(ownViewFirstPickTeam(OFF, first, fixed)).toBe(fixed);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const a = ownViewFirstPickTeam(T({ ownView: 0.3 }), asObs({ ...(first as object) }), fixed);
      if (a.type !== 'team_select') throw new Error(a.type);
      expect(a.teamIds).toContain('P1');
      expect(a.teamIds.length).toBe(3);
      seen.add([...a.teamIds].sort().join(','));
    }
    expect(seen.size).toBeGreaterThan(3);
    // not once a proposal is on the record (the posterior-based pick handles those)
    expect(ownViewFirstPickTeam(T({ ownView: 0.3 }), r2, { type: 'team_select', teamIds: ['P7', 'P2', 'P3', 'P4'] }).teamIds).toEqual(['P7', 'P2', 'P3', 'P4']);
  });
  it('Merlin (scope 3): still never a red he sees', () => {
    const merlin = asObs({ ...(r2 as object), myRole: 'merlin', knownEvils: ['P2', 'P8', 'P9'] });
    for (const t of [T({ ownView: 0.6, ownViewScope: 3 }), OFF]) {
      const a = merlinLoyalStyleTeam(t, merlin, { type: 'team_select', teamIds: ['P7', 'P2', 'P3', 'P4'] });
      if (a.type !== 'team_select') throw new Error(a.type);
      expect(a.teamIds.some((id) => ['P2', 'P8', 'P9'].includes(id))).toBe(false);
    }
  });
});

describe('Percival thumbs (round 38)', () => {
  // P7 = Percival, thumbs P1 (on the failed R1 team) and P2 (not).
  const perc = asObs({ ...(r2 as object), myRole: 'percival', knownWizards: ['P1', 'P2'] });
  it('beliefThumbNoStain: the failed R1 mission with one thumb on it no longer tells the thumbs apart', () => {
    const stained = bayesRedShare(perc, bayesOptionsOf(OFF));
    const fixed = bayesRedShare(perc, bayesOptionsOf(T({ beliefThumbNoStain: true })));
    expect(stained.get('P1')! + stained.get('P2')!).toBeCloseTo(1, 6);
    expect(fixed.get('P1')! + fixed.get('P2')!).toBeCloseTo(1, 6);
    expect(stained.get('P1')!).toBeGreaterThan(fixed.get('P1')!);
    // the other evidence (proposals, votes) still counts: not forced to one half exactly, but nearer to it
    expect(Math.abs(fixed.get('P1')! - 0.5)).toBeLessThan(Math.abs(stained.get('P1')! - 0.5));
    // a loyal's posterior is untouched
    expect(bayesRedShare(r2, bayesOptionsOf(T({ beliefThumbNoStain: true }))).get('P1')).toBeCloseTo(bayesRedShare(r2, bayesOptionsOf(OFF)).get('P1')!, 12);
  });
  it('percivalThumbRead: a thumb he cannot read as Merlin leaves the team; one he can stays; a team without a barred thumb is untouched', () => {
    const t = T({ beliefThumbNoStain: true, percivalThumbRead: 0.95 });
    const both = { type: 'team_select' as const, teamIds: ['P7', 'P1', 'P8', 'P9'] };
    const a = percivalThumbReadTeam(t, perc, both);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P7');
    expect(a.teamIds.some((id) => id === 'P1' || id === 'P2')).toBe(false);
    const clean = { type: 'team_select' as const, teamIds: ['P7', 'P3', 'P8', 'P9'] };
    expect(percivalThumbReadTeam(t, perc, clean)).toBe(clean);
    expect(percivalThumbReadTeam(OFF, perc, both)).toBe(both);
    expect(percivalThumbReadTeam(t, asObs({ ...(perc as object), currentRound: 1 }), both)).toBe(both);
    // a low bar keeps the thumb he reads as the likelier Merlin and still drops the other
    const share = bayesRedShare(perc, bayesOptionsOf(t));
    const likelier = (share.get('P1') ?? 1) < (share.get('P2') ?? 1) ? 'P1' : 'P2';
    const other = likelier === 'P1' ? 'P2' : 'P1';
    const b = percivalThumbReadTeam(T({ beliefThumbNoStain: true, percivalThumbRead: 0.5 }), perc, { type: 'team_select', teamIds: ['P7', likelier, 'P8', 'P9'] });
    expect(b.type === 'team_select' && b.teamIds.includes(likelier)).toBe(true);
    const c = percivalThumbReadTeam(T({ beliefThumbNoStain: true, percivalThumbRead: 0.5 }), perc, { type: 'team_select', teamIds: ['P7', other, 'P8', 'P9'] });
    expect(c.type === 'team_select' && c.teamIds.includes(other)).toBe(false);
  });
  it('percivalMerlinWhite: off the team, the thumb he reads as Merlin leads and the other thumb is off it', () => {
    const v = asObs({ ...(perc as object), gamePhase: 'team_vote', currentRound: 3, failCount: 0, currentLeader: 'P2', proposedTeam: ['P2', 'P3', 'P8', 'P9'], questResults: ['fail', 'success'],
      questHistory: [{ round: 1, team: ['P5', 'P1', 'P10'], result: 'fail', failCount: 1 }, { round: 2, team: ['P2', 'P3', 'P4', 'P6'], result: 'success', failCount: 0 }] });
    expect(percivalMerlinWhiteNow(T({ percivalMerlinWhite: 0.01 }), v)).toBe(true);
    expect(percivalMerlinWhiteNow(T({ percivalMerlinWhite: 1 }), v)).toBe(false);
    expect(percivalMerlinWhiteNow(OFF, v)).toBe(false);
    expect(percivalMerlinWhiteNow(T({ percivalMerlinWhite: 0.01 }), asObs({ ...(v as object), proposedTeam: ['P2', 'P1', 'P8', 'P9'] }))).toBe(false);
    expect(percivalMerlinWhiteNow(T({ percivalMerlinWhite: 0.01 }), asObs({ ...(v as object), proposedTeam: ['P2', 'P7', 'P8', 'P9'] }))).toBe(false);
    expect(percivalMerlinWhiteNow(T({ percivalMerlinWhite: 0.01 }), asObs({ ...(v as object), currentLeader: 'P3' }))).toBe(false);
  });
});

describe('situational abnormal votes (round 38)', () => {
  const quests = (results: ('success' | 'fail')[]) => results.map((r, i) => ({ round: i + 1, team: [['P5', 'P1', 'P10'], ['P2', 'P3', 'P4', 'P6'], ['P2', 'P3', 'P4', 'P8']][i], result: r, failCount: r === 'fail' ? 1 : 0 }));
  const at = (round: number, results: ('success' | 'fail')[], over: object = {}) => asObs({
    ...base, currentRound: round, currentLeader: 'P1', failCount: 0, questResults: results, gamePhase: 'team_vote', questHistory: quests(results),
    voteHistory: R1, proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P6'], ...over,
  });
  it('helpers: whole re-proposal of the latest successful team; leading later this round', () => {
    const o = at(4, ['fail', 'success', 'success'], { proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P8'] });
    expect(fullReuseOfLastSuccess(o, ['P1', 'P2', 'P3', 'P4', 'P8'])).toBe(true);
    expect(fullReuseOfLastSuccess(o, ['P1', 'P2', 'P3', 'P4', 'P6'])).toBe(false); // the R2 team, not the latest success
    expect(leadsLaterThisRound(asObs({ ...(o as object), currentLeader: 'P5', failCount: 0 }))).toBe(true); // P7 is two seats later
    expect(leadsLaterThisRound(asObs({ ...(o as object), currentLeader: 'P5', failCount: 3 }))).toBe(false);
    expect(leadsLaterThisRound(asObs({ ...(o as object), currentLeader: 'P8' }))).toBe(false);
  });
  it('goodReuseWhite: first proposal, the leader re-proposes the whole latest successful team — R4 at 2:1, R3 at 1:1; mode 2 adds R4 at 1:2', () => {
    const r4 = at(4, ['fail', 'success', 'success'], { proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P8'] });
    expect(reuseWhiteNow(T({ goodReuseWhite: 1 }), r4)).toBe(true);
    expect(reuseWhiteNow(OFF, r4)).toBe(false);
    expect(reuseWhiteNow(T({ goodReuseWhite: 1 }), asObs({ ...(r4 as object), failCount: 1 }))).toBe(false);
    expect(reuseWhiteNow(T({ goodReuseWhite: 1 }), asObs({ ...(r4 as object), proposedTeam: ['P1', 'P2', 'P3', 'P9', 'P8'] }))).toBe(false);
    expect(reuseWhiteNow(T({ goodReuseWhite: 1 }), asObs({ ...(r4 as object), proposedTeam: ['P7', 'P2', 'P3', 'P4', 'P8'] }))).toBe(false); // on the team: not an outer white
    const r3 = at(3, ['fail', 'success'], { proposedTeam: ['P2', 'P3', 'P4', 'P6'] });
    expect(reuseWhiteNow(T({ goodReuseWhite: 1 }), r3)).toBe(true);
    // R1 success then R2 fail: the R1 team has been on a failed mission since — not approved
    expect(reuseWhiteNow(T({ goodReuseWhite: 1 }), at(3, ['success', 'fail'], { proposedTeam: ['P5', 'P1', 'P10', 'P2'] }))).toBe(false);
    expect(bayesVoteCriteria(T({ goodReuseWhite: 1 }), r3)).toEqual({ vote: true, reason: 'reuse' });
    expect(bayesVoteCriteria(OFF, r3)?.reason).not.toBe('reuse');
    const r3ff = at(3, ['fail', 'fail'], { proposedTeam: ['P2', 'P3', 'P4', 'P6'] });
    expect(reuseWhiteNow(T({ goodReuseWhite: 2 }), r3ff)).toBe(false);
    const r4key = at(4, ['fail', 'fail', 'success'], { proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P8'] });
    expect(reuseWhiteNow(T({ goodReuseWhite: 1 }), r4key)).toBe(false);
    expect(reuseWhiteNow(T({ goodReuseWhite: 2 }), r4key)).toBe(true);
  });
  it('goodFourthWhite: R3 fourth proposal at 1:1, the forced leader is off the team and sat on a failed mission', () => {
    // leader P4 on the fourth proposal -> forced fifth = P5 (on the failed R1 team)
    const o = at(3, ['fail', 'success'], { currentLeader: 'P4', failCount: 3, proposedTeam: ['P4', 'P2', 'P3', 'P6'] });
    expect(fourthWhiteNow(T({ goodFourthWhite: 1 }), o)).toBe(true);
    expect(fourthWhiteNow(OFF, o)).toBe(false);
    expect(fourthWhiteNow(T({ goodFourthWhite: 1 }), asObs({ ...(o as object), proposedTeam: ['P4', 'P5', 'P3', 'P6'] }))).toBe(false); // tail on the team
    expect(fourthWhiteNow(T({ goodFourthWhite: 1 }), asObs({ ...(o as object), failCount: 2 }))).toBe(false);
    expect(fourthWhiteNow(T({ goodFourthWhite: 1 }), asObs({ ...(o as object), questResults: ['fail', 'fail'] }))).toBe(false); // 0:2 is not copied
    expect(fourthWhiteNow(T({ goodFourthWhite: 1 }), asObs({ ...(o as object), myPlayerId: 'P5' }))).toBe(false); // the tail keeps his own proposal
    // forced leader P7's seat never sat on a failed mission -> no
    expect(fourthWhiteNow(T({ goodFourthWhite: 1 }), asObs({ ...(o as object), myPlayerId: 'P9', currentLeader: 'P6', proposedTeam: ['P6', 'P2', 'P3', 'P4'] }))).toBe(false);
  });
  it('goodOnTeamState: before red has two wins only a near-certain fail is inner-blacked; key round (mode 2) needs a further reason; R5 untouched', () => {
    const on = at(3, ['fail', 'success'], { proposedTeam: ['P7', 'P5', 'P1', 'P9'] });
    expect(onTeamStateApprove(T({ goodOnTeamState: 1 }), on, 0.9, false)).toBe(true);
    expect(onTeamStateApprove(T({ goodOnTeamState: 1 }), on, 0.995, false)).toBe(false);
    expect(onTeamStateApprove(OFF, on, 0.9, false)).toBe(false);
    expect(onTeamStateApprove(T({ goodOnTeamState: 1 }), asObs({ ...(on as object), currentRound: 5 }), 0.9, false)).toBe(false);
    const key = at(3, ['fail', 'fail'], { currentLeader: 'P8', proposedTeam: ['P7', 'P8', 'P2', 'P9'] });
    expect(onTeamStateApprove(T({ goodOnTeamState: 1 }), key, 0.75, true)).toBe(false);
    expect(onTeamStateApprove(T({ goodOnTeamState: 2 }), key, 0.75, true)).toBe(true); // P7 does not lead again this round, nobody declared red
    expect(onTeamStateApprove(T({ goodOnTeamState: 2 }), key, 0.92, true)).toBe(false);
    expect(onTeamStateApprove(T({ goodOnTeamState: 2 }), asObs({ ...(key as object), currentLeader: 'P5' }), 0.75, true)).toBe(false); // P7 still leads this round
    expect(onTeamStateApprove(T({ goodOnTeamState: 2 }), asObs({ ...(key as object), lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P2', declaredClaim: 'evil' }] }), 0.75, true)).toBe(false);
  });
  it('goodR5NoWhite: no threshold outer white at R5', () => {
    const r5 = at(5, ['fail', 'success', 'fail', 'success'], { proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P8'], questHistory: [...quests(['fail', 'success', 'fail']), { round: 4, team: ['P1', 'P2', 'P3', 'P4', 'P8'], result: 'success', failCount: 0 }] });
    const v = bayesVoteCriteria(T({ goodR5NoWhite: true }), r5);
    if (v && v.reason !== 'provRed' && v.reason !== 'lakeRed') expect(v).toEqual({ vote: false, reason: 'offDefault' });
  });
});

describe('merlinFlowFollow (round 38: Merlin carries a red he sees only when the round\'s proposals all carry him)', () => {
  const votes = [...R1.slice(0, 0),
    vote(1, 1, 'P1', ['P1', 'P8', 'P3'], ['P1', 'P8', 'P3']), vote(1, 2, 'P2', ['P2', 'P8', 'P6'], ['P2', 'P8', 'P6']), vote(1, 3, 'P3', ['P3', 'P8', 'P9'], ['P3', 'P8', 'P9'])];
  const merlin = asObs({ ...base, myPlayerId: 'P4', myRole: 'merlin', knownEvils: ['P8', 'P9', 'P10'], currentRound: 1, currentLeader: 'P4', failCount: 3, questResults: [], gamePhase: 'team_select', questHistory: [], voteHistory: votes });
  it('the carried red, only at R1–R2 non-forced proposals with enough earlier proposals; off by default', () => {
    expect(merlinFlowRed(T({ merlinFlowFollow: 3 }), merlin)).toBe('P8');
    expect(merlinFlowRed(T({ merlinFlowFollow: 2 }), merlin)).toBe('P8');
    expect(merlinFlowRed(OFF, merlin)).toBe(null);
    expect(merlinFlowRed(T({ merlinFlowFollow: 4 }), merlin)).toBe(null);
    expect(merlinFlowRed(T({ merlinFlowFollow: 3 }), asObs({ ...(merlin as object), failCount: 4 }))).toBe(null);
    expect(merlinFlowRed(T({ merlinFlowFollow: 3 }), asObs({ ...(merlin as object), currentRound: 3 }))).toBe(null);
    expect(merlinFlowRed(T({ merlinFlowFollow: 3 }), asObs({ ...(merlin as object), knownEvils: ['P9', 'P10', 'P5'] }))).toBe(null);
    expect(merlinFlowRed(T({ merlinFlowFollow: 3 }), asObs({ ...(merlin as object), myRole: 'loyal' }))).toBe(null);
  });
  it('the team carries that red and no other red he sees; without the flow his team has none', () => {
    const a = merlinLoyalStyleTeam(T({ merlinFlowFollow: 3 }), merlin, { type: 'team_select', teamIds: ['P4', 'P1', 'P2'] });
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P8');
    expect(a.teamIds).toContain('P4');
    expect(a.teamIds.filter((id) => ['P8', 'P9', 'P10'].includes(id))).toEqual(['P8']);
    const b = merlinLoyalStyleTeam(OFF, merlin, { type: 'team_select', teamIds: ['P4', 'P1', 'P2'] });
    expect(b.type === 'team_select' && b.teamIds.some((id) => ['P8', 'P9', 'P10'].includes(id))).toBe(false);
  });
});

describe('checklist rules built in round 38 (bundles A–D, BL-01)', () => {
  const q = (round: number, team: string[], result: 'success' | 'fail') => ({ round, team, result, failCount: result === 'fail' ? 1 : 0 });
  const r4 = asObs({ ...base, currentRound: 4, currentLeader: 'P1', failCount: 0, gamePhase: 'team_vote', voteHistory: R1,
    questResults: ['fail', 'fail', 'success'], questHistory: [q(1, ['P5', 'P1', 'P10'], 'fail'), q(2, ['P2', 'P3', 'P4', 'P6'], 'fail'), q(3, ['P1', 'P8', 'P9', 'P3'], 'success')],
    proposedTeam: ['P1', 'P8', 'P9', 'P3', 'P7'] });
  it('r3TeamKeptAtR4: R4 first proposal, R3 succeeded, the whole R3 team is on it', () => {
    expect(r3TeamKeptAtR4(r4, ['P1', 'P8', 'P9', 'P3', 'P7'])).toBe(true);
    expect(r3TeamKeptAtR4(r4, ['P1', 'P8', 'P9', 'P2', 'P7'])).toBe(false);
    expect(r3TeamKeptAtR4(asObs({ ...(r4 as object), failCount: 1 }), ['P1', 'P8', 'P9', 'P3', 'P7'])).toBe(false);
    expect(r3TeamKeptAtR4(asObs({ ...(r4 as object), questResults: ['fail', 'success', 'fail'] }), ['P1', 'P8', 'P9', 'P3', 'P7'])).toBe(false);
  });
  it('goodBayesR4Kept: on the kept R3 team the on-team vote is an approve (value 1); a lake-declared red on it keeps the old path', () => {
    const v = bayesVoteCriteria(T({ goodBayesR4Kept: 1 }), r4);
    expect(v).toEqual({ vote: true, reason: 'onDefault' });
    const declared = asObs({ ...(r4 as object), lakeHistory: [{ round: 3, holderId: 'P10', targetId: 'P8', declaredClaim: 'evil' }] });
    const d0 = bayesVoteCriteria(OFF, declared);
    expect(bayesVoteCriteria(T({ goodBayesR4Kept: 1 }), declared)).toEqual(d0);
    // value 2 is the off-team part only: the on-team vote is the default one
    expect(bayesVoteCriteria(T({ goodBayesR4Kept: 2 }), r4)).toEqual(bayesVoteCriteria(OFF, r4));
  });
  it('merlinOnTeamOwnApprove: R4 without a seen red always; one seen red only with a low own P(Mordred on the team); 0:2 only in mode 3; never R5 (modes 1–3)', () => {
    expect(merlinOnTeamOwnApprove(1, r4, 0, 0.5, 0.5)).toBe(true);
    expect(merlinOnTeamOwnApprove(1, r4, 1, null, 0.2)).toBe(true);
    expect(merlinOnTeamOwnApprove(1, r4, 1, null, 0.4)).toBe(false); // red has two wins: bar 0.3
    expect(merlinOnTeamOwnApprove(1, r4, 2, null, 0.1)).toBe(false);
    const r3even = asObs({ ...(r4 as object), currentRound: 3, questResults: ['fail', 'success'] });
    expect(merlinOnTeamOwnApprove(1, r3even, 0, 0.6, 0.4)).toBe(false);
    expect(merlinOnTeamOwnApprove(2, r3even, 0, 0.6, 0.4)).toBe(true);
    expect(merlinOnTeamOwnApprove(2, r3even, 0, 0.1, 0.9)).toBe(false);
    const r3key = asObs({ ...(r4 as object), currentRound: 3, questResults: ['fail', 'fail'] });
    expect(merlinOnTeamOwnApprove(2, r3key, 0, 0.8, 0.2)).toBe(false);
    expect(merlinOnTeamOwnApprove(3, r3key, 0, 0.8, 0.2)).toBe(true);
    expect(merlinOnTeamOwnApprove(3, r3key, 0, 0.6, 0.4)).toBe(false);
    const r5 = asObs({ ...(r4 as object), currentRound: 5 });
    expect(merlinOnTeamOwnApprove(3, r5, 0, 0.9, 0.1)).toBe(false);
    expect(merlinOnTeamOwnApprove(4, r5, 0, null, null)).toBe(true);
    expect(merlinOnTeamOwnApprove(0, r4, 0, 0.9, 0.1)).toBe(false);
  });
  it('loyalTailWhiteLastTau: a lower bar can only add tail whites, and only on the fourth proposal of rounds 3–5', () => {
    const fourth = asObs({ ...(r4 as object), currentRound: 3, failCount: 3, currentLeader: 'P4', questResults: ['fail', 'success'], questHistory: [q(1, ['P5', 'P1', 'P10'], 'fail'), q(2, ['P2', 'P3', 'P4', 'P6'], 'success')], proposedTeam: ['P4', 'P2', 'P3', 'P6'] });
    const def = tailWhiteCore(OFF, fourth);
    const low = tailWhiteCore(T({ loyalTailWhiteLastTau: 0.01 }), fourth);
    expect(!def || low).toBe(true);
    const third = asObs({ ...(fourth as object), failCount: 2, currentLeader: 'P3' });
    expect(tailWhiteCore(T({ loyalTailWhiteLastTau: 0.01 }), third)).toBe(tailWhiteCore(OFF, third));
  });
  it('beliefPendingProposal: only the vote-time posterior of a non-leader changes; a pick is untouched', () => {
    const vt = asObs({ ...(r2 as object), gamePhase: 'team_vote', currentLeader: 'P8', proposedTeam: ['P8', 'P2', 'P3', 'P9'] });
    const a = bayesTeamClean(vt, ['P8', 'P2', 'P3', 'P9'], bayesOptionsOf(OFF))!;
    const b = bayesTeamClean(vt, ['P8', 'P2', 'P3', 'P9'], bayesOptionsOf(T({ beliefPendingProposal: true })))!;
    expect(Math.abs(a - b)).toBeGreaterThan(1e-9);
    expect(bayesTeamClean(r2, ['P7', 'P2', 'P3', 'P9'], bayesOptionsOf(T({ beliefPendingProposal: true })))).toBeCloseTo(bayesTeamClean(r2, ['P7', 'P2', 'P3', 'P9'], bayesOptionsOf(OFF))!, 12);
    const own = asObs({ ...(vt as object), currentLeader: 'P7', proposedTeam: ['P7', 'P2', 'P3', 'P9'] });
    expect(bayesTeamClean(own, ['P7', 'P2', 'P3', 'P9'], bayesOptionsOf(T({ beliefPendingProposal: true })))).toBeCloseTo(bayesTeamClean(own, ['P7', 'P2', 'P3', 'P9'], bayesOptionsOf(OFF))!, 12);
  });
  it('merlinPublicPipeline / merlinPublicTieBreak: still a team without a red he sees', () => {
    const merlin = asObs({ ...(r2 as object), myRole: 'merlin', knownEvils: ['P2', 'P8', 'P9'] });
    const a = merlinLoyalStyleTeam(T({ merlinPublicPipeline: 1, merlinPublicTieBreak: true }), merlin, { type: 'team_select', teamIds: ['P7', 'P2', 'P3', 'P4'] });
    expect(a.type === 'team_select' && a.teamIds.includes('P7') && !a.teamIds.some((id) => ['P2', 'P8', 'P9'].includes(id))).toBe(true);
  });
  it('earlyOwnTeamWhite: R1–R2, off the team, the proposal keeps every player of my own proposal of the round', () => {
    // P2 led R1-2 with P4 and P6; now P3 proposes P3 + P4 + P6
    const o = asObs({ ...base, myPlayerId: 'P2', currentRound: 1, currentLeader: 'P3', failCount: 2, gamePhase: 'team_vote', questResults: [], questHistory: [], voteHistory: R1.slice(0, 2), proposedTeam: ['P3', 'P4', 'P6'] });
    expect(earlyOwnTeamWhite(T({ goodEarlyVote: 1 }), o)).toBe(true);
    expect(earlyOwnTeamWhite(OFF, o)).toBe(false);
    expect(earlyOwnTeamWhite(T({ goodEarlyVote: 1 }), asObs({ ...(o as object), proposedTeam: ['P3', 'P4', 'P9'] }))).toBe(false);
    expect(earlyOwnTeamWhite(T({ goodEarlyVote: 1 }), asObs({ ...(o as object), myPlayerId: 'P8' }))).toBe(false); // never led this round
    expect(earlyOwnTeamWhite(T({ goodEarlyVote: 1 }), asObs({ ...(o as object), currentRound: 3 }))).toBe(false);
  });
  it('goodLakeHumanPool: after a successful mission only its members who never sat on a failed one; otherwise the list as it was', () => {
    const o = asObs({ ...base, currentRound: 3, questResults: ['fail', 'success'], questHistory: [q(1, ['P5', 'P1', 'P10'], 'fail'), q(2, ['P2', 'P3', 'P1', 'P6'], 'success')], voteHistory: R1 });
    const cands = ['P1', 'P2', 'P3', 'P4', 'P8'];
    expect(goodLakeHumanPool(T({ goodLakeHuman: 1 }), o, cands)).toEqual(['P2', 'P3']);
    expect(goodLakeHumanPool(OFF, o, cands)).toBe(cands);
    const failedLast = asObs({ ...(o as object), questResults: ['success', 'fail'], questHistory: [q(1, ['P5', 'P1', 'P10'], 'success'), q(2, ['P2', 'P3', 'P1', 'P6'], 'fail')] });
    expect(goodLakeHumanPool(T({ goodLakeHuman: 1 }), failedLast, cands)).toBe(cands);
  });
});

describe('ownView: the first proposal of the game keeps the fixed seat-combination ban (round 38 review)', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  // a seeded stand-in for the decision's random numbers, so the draws are the same on every run
  const seeded = (seed: number) => { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x + 0.5) / 4294967296; }; };
  const seats = (t: readonly string[], ids: readonly string[]) => t.map((id) => ids.indexOf(id) + 1).sort((a, b) => a - b).map((n) => (n === 10 ? '0' : String(n))).join('');
  for (const [n, banned, runs] of [[5, ['12', '34', '45', '15'], 30], [10, ['123', '150', '234', '678'], 60]] as const) {
    it(`${n} players: the loyal first leader's own-prior pick is never a banned combination`, () => {
      vi.spyOn(Math, 'random').mockImplementation(seeded(38000 + n));
      const ids = IDS.slice(0, n);
      const picks = new Set<string>();
      for (let k = 0; k < runs; k++) {
        const o = asObs({ myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: n, allPlayerIds: ids, knownEvils: [], currentRound: 1, currentLeader: 'P1', failCount: 0, questResults: [], gamePhase: 'team_select', voteHistory: [], questHistory: [], proposedTeam: [], lakeHistory: [] });
        const agent = new ForwardAgent('P1', new HeuristicAgent('P1', undefined, undefined, { ...DEFAULT_AGENT_TUNING }));
        agent.onGameStart(o);
        const d = agent.decide(o);
        if (d.action.type !== 'team_select') throw new Error(d.action.type);
        const s = seats(d.action.teamIds, ids);
        expect(d.action.teamIds).toContain('P1');
        expect((banned as readonly string[]).includes(s)).toBe(false);
        picks.add(s);
      }
      // still the leader's own pick: not one fixed team
      expect(picks.size).toBeGreaterThan(1);
    });
  }
});

describe('public views carry no leader\'s own prior (round 38 review)', () => {
  const big = { ownView: 3 };
  it('RedRound4.redCleanLookTeam with redCleanLookBot reads the blue seats the same with ownView 0 and on (red unchanged)', () => {
    const red = asObs({
      myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P3'], evilCount: 4,
      currentRound: 3, currentLeader: 'P1', failCount: 1, questResults: ['fail', 'success'], gamePhase: 'team_select', lakeHistory: [], proposedTeam: [],
      questHistory: [{ round: 1, team: ['P5', 'P6', 'P7'], result: 'fail', failCount: 1 }, { round: 2, team: ['P4', 'P8', 'P9', 'P10'], result: 'success', failCount: 0 }],
      voteHistory: [vote(3, 1, 'P10', ['P10', 'P4', 'P8', 'P9'], ['P10', 'P4', 'P8', 'P9'])],
    });
    const act = { type: 'team_select' as const, teamIds: ['P1', 'P2', 'P5', 'P6'] };
    for (const extra of [{}, { redStackRatio: 0.01 }]) {
      const off = redCleanLookTeam({ ...DEFAULT_AGENT_TUNING, redCleanLook: true, redCleanLookBot: true, ownView: 0, ...extra }, red, act);
      for (const ov of [0.3, 3]) {
        expect(redCleanLookTeam({ ...DEFAULT_AGENT_TUNING, redCleanLook: true, redCleanLookBot: true, ownView: ov, ...extra }, red, act)).toEqual(off);
      }
    }
  });
  it('Merlin\'s public re-proposal check and the R1 information-value contexts read the same record with ownView 0 and on', () => {
    const merlin = asObs({ ...(r2 as object), myRole: 'merlin', knownEvils: ['P2', 'P8', 'P9'], currentRound: 3, failCount: 0, questResults: ['fail', 'success'],
      questHistory: [{ round: 1, team: ['P5', 'P1', 'P10'], result: 'fail', failCount: 1 }, { round: 2, team: ['P6', 'P3', 'P4', 'P7'], result: 'success', failCount: 0 }] });
    for (const size of [3, 4]) {
      expect(merlinReusePublicNow(T({ merlinReusePublic: true, ...big }), merlin, size)).toBe(merlinReusePublicNow(T({ merlinReusePublic: true }), merlin, size));
    }
    const lead = asObs({ ...base, myPlayerId: 'P3', currentRound: 1, currentLeader: 'P3', failCount: 2, questResults: [], gamePhase: 'team_select', questHistory: [], voteHistory: R1.slice(0, 2) });
    expect(ownViewOn(T(big), lead)).toBe(true);
    expect([...r1InfoCtx(T(big), lead).wts]).toEqual([...r1InfoCtx(OFF, lead).wts]);
    expect([...r1InflCtx(T(big), lead).wts]).toEqual([...r1InflCtx(OFF, lead).wts]);
  });
});

describe('round 38 knobs without an earlier behaviour test (review)', () => {
  const quests = (results: ('success' | 'fail')[]) => results.map((r, i) => ({ round: i + 1, team: [['P5', 'P1', 'P10'], ['P2', 'P3', 'P4', 'P6'], ['P2', 'P3', 'P4', 'P8']][i], result: r, failCount: r === 'fail' ? 1 : 0 }));
  const at = (round: number, results: ('success' | 'fail')[], over: object = {}) => asObs({
    ...base, currentRound: round, currentLeader: 'P1', failCount: 0, questResults: results, gamePhase: 'team_vote', questHistory: quests(results),
    voteHistory: R1, proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P6'], ...over,
  });
  it('goodBayesFsReuse: R3 first proposal after fail-then-success, the R2 team as it was, off the team — the bar decides; other orders and teams untouched', () => {
    const fs = at(3, ['fail', 'success'], { currentLeader: 'P2', proposedTeam: ['P2', 'P3', 'P4', 'P6'] });
    expect(bayesVoteCriteria(T({ goodBayesFsReuse: 0.01 }), fs)).toEqual({ vote: true, reason: 'reuse' });
    expect(bayesVoteCriteria(T({ goodBayesFsReuse: 1 }), fs)?.reason).not.toBe('reuse');
    expect(bayesVoteCriteria(OFF, fs)?.reason).not.toBe('reuse');
    // a grown team is not the R2 team as it was; a later proposal of the round is not the first
    expect(bayesVoteCriteria(T({ goodBayesFsReuse: 0.01 }), asObs({ ...(fs as object), proposedTeam: ['P2', 'P3', 'P4', 'P9'] }))?.reason).not.toBe('reuse');
    expect(bayesVoteCriteria(T({ goodBayesFsReuse: 0.01 }), asObs({ ...(fs as object), failCount: 1 }))?.reason).not.toBe('reuse');
  });
  it('goodR4White: off the team in a round that needs two fails, P(fewer than two reds) over the bar → approve; never in a one-fail round', () => {
    const r4 = at(4, ['fail', 'success', 'success'], { currentLeader: 'P9', proposedTeam: ['P9', 'P2', 'P3', 'P5', 'P10'] });
    expect(bayesVoteCriteria(T({ goodR4White: 0.01 }), r4)).toEqual({ vote: true, reason: 'r4' });
    expect(bayesVoteCriteria(T({ goodR4White: 1.01 }), r4)?.reason).not.toBe('r4');
    expect(bayesVoteCriteria(OFF, r4)?.reason).not.toBe('r4');
    const r3 = at(3, ['fail', 'success'], { currentLeader: 'P9', proposedTeam: ['P9', 'P2', 'P5', 'P10'] });
    expect(bayesVoteCriteria(T({ goodR4White: 0.01 }), r3)?.reason).not.toBe('r4');
  });
  it('percivalLakeNoMorgana: Percival leaves out the thumb his posterior reads as Morgana; a loyal holder\'s list is untouched', () => {
    const perc = asObs({ ...(r2 as object), myRole: 'percival', knownWizards: ['P1', 'P2'], gamePhase: 'lake' });
    const share = bayesRedShare(perc, bayesOptionsOf(OFF));
    const morgana = (share.get('P1') ?? 0) > (share.get('P2') ?? 0) ? 'P1' : 'P2';
    const cands = ['P1', 'P2', 'P3', 'P8'];
    const pool = goodLakeHumanPool(T({ percivalLakeNoMorgana: true }), perc, cands);
    expect(pool).not.toContain(morgana);
    expect(pool).toContain(morgana === 'P1' ? 'P2' : 'P1');
    expect(goodLakeHumanPool(OFF, perc, cands)).toBe(cands);
    expect(goodLakeHumanPool(T({ percivalLakeNoMorgana: true }), asObs({ ...(r2 as object), gamePhase: 'lake' }), cands)).toBe(cands);
  });
  it('ownViewRounds: the own prior only up to that round', () => {
    expect(ownViewStrength(r2, 1, 1)).toBe(0);
    expect(ownViewStrength(r2, 1, 2)).toBeGreaterThan(0);
    expect(ownViewOn(T({ ownView: 0.3, ownViewRounds: 1 }), r2)).toBe(false);
    expect(ownViewOn(T({ ownView: 0.3, ownViewRounds: 2 }), r2)).toBe(true);
  });
});
