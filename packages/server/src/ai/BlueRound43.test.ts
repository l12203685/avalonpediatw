/**
 * 優化迴圈第 43 回合・藍方：忠臣／派西第 1、2 局的提議去相關（`loyalFresh43`，百科 B27／B19／B7）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { loyalFresh43Applies, loyalFresh43Team, proposedBefore } from './BlueRound43';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
// R1: three rejected proposals that keep piling on P1–P4; P5 leads R1-4.
const R1 = [
  vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3']),
  vote(1, 2, 'P2', ['P2', 'P1', 'P4'], ['P1', 'P2', 'P4']),
  vote(1, 3, 'P3', ['P3', 'P1', 'P2'], ['P1', 'P2', 'P3']),
];
const base = {
  myPlayerId: 'P5', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 1, currentLeader: 'P5', failCount: 3, questResults: [], gamePhase: 'team_select', evilCount: 4,
  questHistory: [], lakeHistory: [], myLakeResults: [], proposedTeam: [], voteHistory: R1,
};
const r1 = asObs(base);
const stacked = { type: 'team_select' as const, teamIds: ['P5', 'P1', 'P2'] };
const on = (mode: number, extra: object = {}) => ({ ...DEFAULT_AGENT_TUNING, ownView: 0, loyalFresh43: mode, ...extra });
const seen = ['P1', 'P2', 'P3', 'P4'];

describe('round 43 tuning fields', () => {
  it('off in the legacy table and the default; flags parse', () => {
    expect(LEGACY_AGENT_TUNING.loyalFresh43).toBe(0);
    expect(DEFAULT_AGENT_TUNING.loyalFresh43).toBe(0);
    expect(LEGACY_AGENT_TUNING.loyalFresh43Tau).toBe(0);
    expect(DEFAULT_AGENT_TUNING.loyalFresh43Tau).toBe(0);
    expect(parseTuningFlag('loyalFresh43')).toEqual({ loyalFresh43: 15 });
    expect(parseTuningFlag('loyalFresh43=31')).toEqual({ loyalFresh43: 31 });
    expect(() => parseTuningFlag('loyalFresh43=128')).toThrow();
    expect(parseTuningFlag('loyalFresh43Tau=0.4')).toEqual({ loyalFresh43Tau: 0.4 });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, loyalFresh43: 15 })).toBe('loyalFresh43=15');
  });
});

describe('loyalFresh43 (round 43: R1–R2 talk proposals of a loyal / Percival hold a player no earlier proposal held)', () => {
  it('off: the pipeline team, the same object', () => {
    expect(loyalFresh43Team(on(0), r1, stacked)).toBe(stacked);
  });

  it('on: the reddest mate is swapped for the cleanest not-yet-proposed player; the leader stays', () => {
    const got = loyalFresh43Team(on(15), r1, stacked);
    expect(got).not.toBe(stacked);
    if (got.type !== 'team_select') throw new Error('team');
    expect(got.teamIds).toContain('P5');
    expect(got.teamIds.length).toBe(3);
    const fresh = got.teamIds.filter((id) => id !== 'P5' && !seen.includes(id));
    expect(fresh.length).toBe(1);
    const share = bayesRedShare(r1, bayesOptionsOf(on(15)));
    expect(share.get(fresh[0])!).toBeLessThan(0.5);
    // one of the two stacked mates is kept (a swap, not a new team)
    expect(got.teamIds.filter((id) => id === 'P1' || id === 'P2').length).toBe(1);
  });

  it('a team that already holds a fresh player is kept as it is', () => {
    const ok = { type: 'team_select' as const, teamIds: ['P5', 'P1', 'P7'] };
    expect(loyalFresh43Team(on(15), r1, ok)).toBe(ok);
  });

  it('scope: Merlin never; Percival only with bit 2; R2 only with bit 8; red seats and the public loyal view never; forced fifth never', () => {
    expect(loyalFresh43Applies(on(15), asObs({ ...base, myRole: 'merlin' }))).toBe(false);
    expect(loyalFresh43Applies(on(13), asObs({ ...base, myRole: 'percival' }))).toBe(false);
    expect(loyalFresh43Applies(on(15), asObs({ ...base, myRole: 'percival' }))).toBe(true);
    expect(loyalFresh43Applies(on(5), asObs({ ...base, currentRound: 2 }))).toBe(false);
    expect(loyalFresh43Applies(on(13), asObs({ ...base, currentRound: 2 }))).toBe(true);
    expect(loyalFresh43Applies(on(15), asObs({ ...base, myTeam: 'evil', seatTeam: 'evil' }))).toBe(false);
    expect(loyalFresh43Applies(on(15), asObs({ ...base, publicLoyalView: true }))).toBe(false);
    expect(loyalFresh43Applies(on(15), asObs({ ...base, failCount: 4 }))).toBe(false);
    expect(loyalFresh43Applies(on(15), asObs({ ...base, currentRound: 3 }))).toBe(false);
  });

  it('bit 64: R2 only after an R1 fail; the successful R1 team re-proposed stays', () => {
    const r2s = asObs({ ...base, currentRound: 2, failCount: 0, questResults: ['success'], questHistory: [{ round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 }] });
    expect(loyalFresh43Applies(on(15 | 64), r2s)).toBe(false);
    const reuse = { type: 'team_select' as const, teamIds: ['P5', 'P1', 'P2', 'P3'] };
    expect(loyalFresh43Team(on(15 | 16), r2s, reuse)).toBe(reuse);
  });

  it('bit 16: "not yet proposed" counts the whole game, otherwise this round only', () => {
    const r2 = asObs({ ...base, currentRound: 2, failCount: 0, questResults: ['fail'] });
    expect([...proposedBefore(r2, true)].sort()).toEqual(seen);
    expect(proposedBefore(r2, false).size).toBe(0);
    // R2's first proposal: nothing earlier this round → not applied without bit 16
    const t = { type: 'team_select' as const, teamIds: ['P5', 'P1', 'P2', 'P3'] };
    expect(loyalFresh43Team(on(15), r2, t)).toBe(t);
    expect(loyalFresh43Team(on(31), r2, t)).not.toBe(t);
  });

  it('the gates bind: no allowed swap → the pipeline team', () => {
    expect(loyalFresh43Team(on(15), r1, stacked, () => false)).toBe(stacked);
  });
});
