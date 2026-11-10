/**
 * 優化迴圈第 37 回合・藍方：第 1 局失敗之後第 2 局的提議帶自己的視角（`loyalR2View`）、派西只放分得出來的拇指（`percivalThumbSure`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from './belief/BayesBelief';
import { pickGoodLakeTargetInfoMax } from './GoodLakeInfo';
import { loyalR2ViewTeam, loyalReasonableSet, loyalSetPickTeam, percivalThumbSureTeam, PROPOSAL_GO_RATE, r2AfterR1Fail, r2ViewCandidates } from './BlueRound37';

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
// R2 after the R1 fail (P5 P1 P10, one fail card); R2-1 by P6 (P6 P2 P3 P4, rejected); P7 leads R2-2.
const r2 = asObs({
  myPlayerId: 'P7', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 2, currentLeader: 'P7', failCount: 1, questResults: ['fail'], gamePhase: 'team_select', evilCount: 4,
  questHistory: [{ round: 1, team: ['P5', 'P1', 'P10'], result: 'fail', failCount: 1 }], lakeHistory: [], myLakeResults: [], proposedTeam: [],
  voteHistory: [...R1, vote(2, 1, 'P6', ['P6', 'P2', 'P3', 'P4'], ['P6', 'P2', 'P3', 'P4'])],
});
const copy = { type: 'team_select' as const, teamIds: ['P7', 'P2', 'P3', 'P4'] };
const on = (mode: number) => ({ ...DEFAULT_AGENT_TUNING, loyalR2View: mode });
const kept = (team: readonly string[]) => team.filter((id) => ['P6', 'P2', 'P3', 'P4'].includes(id)).length;

describe('round 37 tuning fields', () => {
  it('off in the legacy table and the default; flags parse', () => {
    expect(LEGACY_AGENT_TUNING.loyalR2View).toBe(0);
    expect(DEFAULT_AGENT_TUNING.loyalR2View).toBe(6); // adopted in round 37
    expect(LEGACY_AGENT_TUNING.percivalThumbSure).toBe(0);
    expect(DEFAULT_AGENT_TUNING.percivalThumbSure).toBe(0);
    expect(parseTuningFlag('loyalR2View')).toEqual({ loyalR2View: 1 });
    expect(parseTuningFlag('loyalR2View=4')).toEqual({ loyalR2View: 4 });
    expect(parseTuningFlag('loyalR2View=6')).toEqual({ loyalR2View: 6 });
    expect(() => parseTuningFlag('loyalR2View=7')).toThrow();
    expect(parseTuningFlag('percivalThumbSure')).toEqual({ percivalThumbSure: 0.7 });
    expect(parseTuningFlag('percivalThumbSure=0.6')).toEqual({ percivalThumbSure: 0.6 });
    expect(() => parseTuningFlag('percivalThumbSure=2')).toThrow();
    expect(LEGACY_AGENT_TUNING.loyalR2ViewKeep).toBe(0);
    expect(DEFAULT_AGENT_TUNING.loyalR2ViewKeep).toBe(0);
    expect(parseTuningFlag('loyalR2ViewKeep')).toEqual({ loyalR2ViewKeep: 0.9 });
    expect(parseTuningFlag('loyalR2ViewKeep=0.85')).toEqual({ loyalR2ViewKeep: 0.85 });
    expect(() => parseTuningFlag('loyalR2ViewKeep=1.5')).toThrow();
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, loyalR2View: 3, loyalR2ViewKeep: 0.9, percivalThumbSure: 0.7 })).toBe('loyalR2View=3,loyalR2ViewKeep=0.9,percivalThumbSure=0.7');
  });
});

describe('loyalR2View (round 37: R2 after an R1 fail, the proposal answers the previous one with the leader\'s own view)', () => {
  it('off: the pipeline team; on: no near-copy of the previous R2 team, never the same team, the leader on it', () => {
    expect(r2AfterR1Fail(r2)).toBe(true);
    expect(loyalR2ViewTeam(on(0), r2, copy)).toBe(copy);
    const share = bayesRedShare(r2, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    const correct = (share.get('P6') ?? 0) >= 0.5;
    for (const mode of [1, 3]) {
      const a = loyalR2ViewTeam(on(mode), r2, copy);
      if (a.type !== 'team_select') throw new Error(a.type);
      expect(a.teamIds).toContain('P7');
      expect(a.teamIds.length).toBe(4);
      expect(kept(a.teamIds)).toBeLessThanOrEqual(correct ? 0 : mode === 1 ? 1 : 2);
      // the cleanest team (own posterior) among the allowed answers
      const p = bayesTeamClean(r2, a.teamIds, bayesOptionsOf(on(mode)))!;
      const alt = ['P7', 'P8', 'P9', 'P2'];
      if (!correct) expect(p).toBeGreaterThanOrEqual(bayesTeamClean(r2, alt, bayesOptionsOf(on(mode)))! - 1e-9);
    }
  });
  it('only R2 after an R1 fail, non-forced, with an earlier R2 proposal; loyal only unless mode 2 / 4; the logic gate binds', () => {
    const t = on(1);
    expect(loyalR2ViewTeam(t, asObs({ ...(r2 as object), failCount: 4 }), copy)).toBe(copy);
    expect(loyalR2ViewTeam(t, asObs({ ...(r2 as object), questResults: ['success'], questHistory: [{ round: 1, team: ['P5', 'P1', 'P10'], result: 'success', failCount: 0 }] }), copy)).toBe(copy);
    expect(loyalR2ViewTeam(t, asObs({ ...(r2 as object), currentRound: 3, questResults: ['fail', 'success'] }), copy)).toBe(copy);
    expect(loyalR2ViewTeam(t, asObs({ ...(r2 as object), voteHistory: R1, failCount: 0 }), copy)).toBe(copy);
    expect(loyalR2ViewTeam(t, asObs({ ...(r2 as object), myRole: 'merlin', knownEvils: ['P1', 'P8', 'P9'] }), copy)).toBe(copy);
    expect(loyalR2ViewTeam(t, asObs({ ...(r2 as object), myRole: 'assassin', myTeam: 'evil' }), copy)).toBe(copy);
    const perc = asObs({ ...(r2 as object), myRole: 'percival', knownWizards: ['P2', 'P8'] });
    expect(loyalR2ViewTeam(on(1), perc, copy)).toBe(copy);
    expect(loyalR2ViewTeam(on(3), perc, copy)).toBe(copy);
    const pa = loyalR2ViewTeam(on(2), perc, copy);
    if (pa.type !== 'team_select') throw new Error(pa.type);
    expect(pa).not.toBe(copy);
    expect(loyalR2ViewTeam(on(1), r2, copy, () => false)).toBe(copy);
    // modes 5 / 6: the second and third proposals only (the fourth is likelier to go on mission)
    expect(loyalR2ViewTeam(on(5), r2, copy)).toEqual(loyalR2ViewTeam(on(1), r2, copy));
    expect(loyalR2ViewTeam(on(6), perc, copy)).toEqual(loyalR2ViewTeam(on(2), perc, copy));
    expect(loyalR2ViewTeam(on(5), asObs({ ...(r2 as object), failCount: 3 }), copy)).toBe(copy);
    expect(loyalR2ViewTeam(on(1), asObs({ ...(r2 as object), failCount: 3 }), copy)).not.toBe(copy);
  });
});

describe('loyalR2ViewKeep (round 37: the soft answer — every kept member of the previous team costs a factor γ of the own-view clean probability)', () => {
  it('picks the candidate with the highest p × γ^kept; γ near 0 keeps nobody, γ = 1 is the cleanest team that is not a re-proposal', () => {
    const got = r2ViewCandidates(DEFAULT_AGENT_TUNING, r2, 4)!;
    expect(got.prevLeader).toBe('P6');
    expect(got.cands.length).toBe(84);
    for (const gamma of [0.9, 0.5]) {
      const a = loyalR2ViewTeam({ ...on(1), loyalR2ViewKeep: gamma }, r2, copy);
      if (a.type !== 'team_select') throw new Error(a.type);
      const key = [...a.teamIds].sort().join(',');
      const open = got.cands.filter((c) => !c.barred);
      const best = Math.max(...open.map((c) => c.p * Math.pow(gamma, c.kept)));
      const mine = open.find((c) => [...c.team].sort().join(',') === key)!;
      expect(mine.p * Math.pow(gamma, mine.kept)).toBeCloseTo(best, 9);
    }
    const none = loyalR2ViewTeam({ ...on(1), loyalR2ViewKeep: 0.01 }, r2, copy);
    if (none.type !== 'team_select') throw new Error(none.type);
    expect(kept(none.teamIds)).toBe(1); // keeping nobody of the only earlier R2 team would be the fully reversed team (barred)
    // without loyalR2View the soft knob alone does nothing
    expect(loyalR2ViewTeam({ ...on(0), loyalR2ViewKeep: 0.9 }, r2, copy)).toBe(copy);
  });
});

describe('percivalThumbSure (round 37: Percival sends a thumb only when his posterior tells it is Merlin)', () => {
  const perc = asObs({ ...(r2 as object), myRole: 'percival', knownWizards: ['P2', 'P8'] });
  const withThumb = { type: 'team_select' as const, teamIds: ['P7', 'P2', 'P3', 'P4'] };
  const t = { ...DEFAULT_AGENT_TUNING, percivalThumbSure: 0.999 };
  it('off by default; on: a thumb he cannot tell apart leaves the team (the cleanest team without it)', () => {
    expect(percivalThumbSureTeam(DEFAULT_AGENT_TUNING, perc, withThumb)).toBe(withThumb);
    const a = percivalThumbSureTeam(t, perc, withThumb);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P7');
    expect(a.teamIds.length).toBe(4);
    expect(a.teamIds).not.toContain('P2');
    expect(a.teamIds).not.toContain('P8');
  });
  it('a thumb he is sure of stays; no thumb on the team, R1, a non-Percival and a re-proposed successful team are untouched', () => {
    const share = bayesRedShare(perc, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    const pMerlin = 1 - (share.get('P2') ?? 0.5);
    expect(percivalThumbSureTeam({ ...DEFAULT_AGENT_TUNING, percivalThumbSure: Math.max(0.01, pMerlin - 0.01) }, perc, withThumb)).toBe(withThumb);
    const none = { type: 'team_select' as const, teamIds: ['P7', 'P3', 'P4', 'P6'] };
    expect(percivalThumbSureTeam(t, perc, none)).toBe(none);
    expect(percivalThumbSureTeam(t, asObs({ ...(perc as object), currentRound: 1, questResults: [], questHistory: [] }), withThumb)).toBe(withThumb);
    expect(percivalThumbSureTeam(t, r2, withThumb)).toBe(withThumb);
    const r3 = asObs({ ...(perc as object), currentRound: 3, questResults: ['fail', 'success'],
      questHistory: [{ round: 1, team: ['P5', 'P1', 'P10'], result: 'fail', failCount: 1 }, { round: 2, team: ['P7', 'P2', 'P3', 'P4'], result: 'success', failCount: 0 }] });
    expect(percivalThumbSureTeam(t, r3, withThumb)).toBe(withThumb);
    expect(percivalThumbSureTeam(t, perc, withThumb, () => false)).toBe(withThumb);
  });
});

describe('loyalSetPick (round 37, Edward 11/10: pick among the reasonable teams of the own view, not the single best one)', () => {
  const t = (lambda: number) => ({ ...DEFAULT_AGENT_TUNING, loyalR2View: 0, loyalSetPick: lambda });
  const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);
  it('off in the legacy table and the default; the flag parses', () => {
    expect(LEGACY_AGENT_TUNING.loyalSetPick).toBe(0);
    expect(DEFAULT_AGENT_TUNING.loyalSetPick).toBe(0);
    expect(parseTuningFlag('loyalSetPick')).toEqual({ loyalSetPick: 0.7 });
    expect(parseTuningFlag('loyalSetPick=0.9')).toEqual({ loyalSetPick: 0.9 });
    expect(() => parseTuningFlag('loyalSetPick=2')).toThrow();
    expect(loyalSetPickTeam(DEFAULT_AGENT_TUNING, r2, copy)).toBe(copy);
    expect(loyalReasonableSet(DEFAULT_AGENT_TUNING, r2, copy)).toBeNull();
    expect(loyalSetPickTeam({ ...DEFAULT_AGENT_TUNING, loyalSetPick: 0.5 }, r2, copy)).toBe(copy); // the default loyalR2View answers this point
  });
  it('the set: the leader on every team, the pipeline team in it, no re-proposal of the round, every member near the cleanest; tighter with λ', () => {
    const wide = loyalReasonableSet(t(0.5), r2, copy)!;
    const tight = loyalReasonableSet(t(0.95), r2, copy)!;
    expect(tight.length).toBeGreaterThanOrEqual(1);
    expect(wide.length).toBeGreaterThanOrEqual(tight.length);
    const key = (x: readonly string[]) => [...x].sort().join(',');
    expect(wide.some((x) => key(x) === key(copy.teamIds))).toBe(true);
    expect(wide.every((x) => x.includes('P7') && x.length === 4)).toBe(true);
    expect(wide.some((x) => key(x) === key(['P6', 'P2', 'P3', 'P4']))).toBe(false);
    const ps = wide.filter((x) => key(x) !== key(copy.teamIds)).map((x) => bayesTeamClean(r2, x, opts)!);
    const thr = 0.5 + 0.5 * PROPOSAL_GO_RATE[2][1];
    const all = r2ViewCandidates(DEFAULT_AGENT_TUNING, r2, 4)!.cands.filter((c) => !c.barred).map((c) => c.p);
    expect(Math.min(...ps)).toBeGreaterThanOrEqual(thr * Math.max(...all) - 1e-9);
  });
  it('picks a member of the set with the given random number; not on the forced fifth, not for Merlin / red, not a re-proposed successful team, and not where loyalR2View answers', () => {
    const set = loyalReasonableSet(t(0.5), r2, copy)!;
    const key = (x: readonly string[]) => [...x].sort().join(',');
    for (const u of [0, 0.37, 0.999]) {
      const a = loyalSetPickTeam(t(0.5), r2, copy, () => true, () => u);
      if (a.type !== 'team_select') throw new Error(a.type);
      expect(key(a.teamIds)).toBe(key(set[Math.min(set.length - 1, Math.floor(u * set.length))]));
    }
    expect(loyalSetPickTeam(t(0.5), asObs({ ...(r2 as object), failCount: 4 }), copy)).toBe(copy);
    expect(loyalSetPickTeam(t(0.5), asObs({ ...(r2 as object), myRole: 'merlin', knownEvils: ['P1', 'P8', 'P9'] }), copy)).toBe(copy);
    expect(loyalSetPickTeam(t(0.5), asObs({ ...(r2 as object), myRole: 'assassin', myTeam: 'evil' }), copy)).toBe(copy);
    expect(loyalSetPickTeam({ ...t(0.5), loyalR2View: 1 }, r2, copy)).toBe(copy);
    const r3 = asObs({ ...(r2 as object), currentRound: 3, failCount: 0, questResults: ['fail', 'success'],
      questHistory: [{ round: 1, team: ['P5', 'P1', 'P10'], result: 'fail', failCount: 1 }, { round: 2, team: ['P7', 'P2', 'P3', 'P4'], result: 'success', failCount: 0 }] });
    expect(loyalSetPickTeam(t(0.5), r3, copy)).toBe(copy);
    // the logic gate / own vote filter binds on every other member
    const only = loyalReasonableSet(t(0.5), r2, copy, () => false)!;
    expect(only.length).toBe(1);
  });
});

describe('goodLakeTieSpread (round 37, Edward 11/10: the lake target does not depend on seat adjacency)', () => {
  it('off by default; with a random number the tied best candidates are all reachable, without it the lowest seat', () => {
    expect(LEGACY_AGENT_TUNING.goodLakeTieSpread).toBe(false);
    expect(DEFAULT_AGENT_TUNING.goodLakeTieSpread).toBe(false);
    expect(parseTuningFlag('goodLakeTieSpread')).toEqual({ goodLakeTieSpread: true });
    // First lake after R2 with nobody but the R1 / R2 teams on record: the never-on-mission seats tie.
    const lake = asObs({ ...(r2 as object), myPlayerId: 'P10', myRole: 'loyal', currentRound: 2, gamePhase: 'lake', questResults: ['fail', 'success'],
      questHistory: [{ round: 1, team: ['P5', 'P1', 'P10'], result: 'fail', failCount: 1 }, { round: 2, team: ['P10', 'P2', 'P3', 'P4'], result: 'success', failCount: 0 }] });
    const cands = ['P6', 'P7', 'P8', 'P9'];
    const first = pickGoodLakeTargetInfoMax(lake, cands);
    expect(first).toBe('P6');
    const picks = new Set([0, 0.26, 0.51, 0.76, 0.999].map((u) => pickGoodLakeTargetInfoMax(lake, cands, undefined, () => u)));
    expect(picks.size).toBeGreaterThan(1);
    for (const id of picks) expect(cands).toContain(id);
  });
});
