/**
 * 優化迴圈第 43 回合・藍方：忠臣／派西第 1、2 局的提議去相關（`loyalFresh43`，百科 B27／B19／B7）。
 */
import { describe, expect, it } from 'vitest';
import { withSeededRandom } from './benchmark/agreement';
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
  it('off in the legacy table; V5 (1285) in the default; flags parse', () => {
    expect(LEGACY_AGENT_TUNING.loyalFresh43).toBe(0);
    expect(DEFAULT_AGENT_TUNING.loyalFresh43).toBe(1285); // round 43b V5 adopted (site owner 2026-11-18)
    expect(LEGACY_AGENT_TUNING.loyalFresh43Tau).toBe(0);
    expect(DEFAULT_AGENT_TUNING.loyalFresh43Tau).toBe(0);
    expect(parseTuningFlag('loyalFresh43')).toEqual({ loyalFresh43: 15 });
    expect(parseTuningFlag('loyalFresh43=31')).toEqual({ loyalFresh43: 31 });
    expect(parseTuningFlag('loyalFresh43=1157')).toEqual({ loyalFresh43: 1157 });
    expect(() => parseTuningFlag('loyalFresh43=2048')).toThrow();
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

  // PR #60 review：換出的人同分、換完一樣乾淨時，不能永遠換掉隊伍名單上第一個（座位序）。
  it('ties: every equally scored (out, in) swap can be picked — not the team-list order; the same seed gives the same team', () => {
    // 一個被否決的提議 P1 帶 P2、P3，只有這三人贊成：P2 與 P3 對稱，P4、P6–P10 也對稱。
    const sym = asObs({ ...base, failCount: 1, voteHistory: [vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3'])] });
    const team = { type: 'team_select' as const, teamIds: ['P5', 'P2', 'P3'] };
    const share = bayesRedShare(sym, bayesOptionsOf(on(15)));
    expect(Math.abs(share.get('P2')! - share.get('P3')!)).toBeLessThan(1e-12);
    const outs = new Set<string>();
    const ins = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const got = withSeededRandom(`r43-tie-${i}`, () => loyalFresh43Team(on(15), sym, team));
      if (got.type !== 'team_select') throw new Error('team');
      expect(got.teamIds[0]).toBe('P5');
      const kept = got.teamIds.filter((id) => id === 'P2' || id === 'P3');
      expect(kept.length).toBe(1);
      outs.add(kept[0] === 'P2' ? 'P3' : 'P2');
      for (const id of got.teamIds) if (!['P5', 'P2', 'P3'].includes(id)) ins.add(id);
      const again = withSeededRandom(`r43-tie-${i}`, () => loyalFresh43Team(on(15), sym, team));
      expect(again).toEqual(got);
    }
    expect([...outs].sort()).toEqual(['P2', 'P3']);
    expect(ins.size).toBeGreaterThan(1);
  });

  it('the gates bind: no allowed swap → the pipeline team', () => {
    expect(loyalFresh43Team(on(15), r1, stacked, () => false)).toBe(stacked);
  });
});

// 第 43b 回合：第 1 局的開局排法（站長 11/17：「從第 3 家之後才開始考慮」；百科 1AB／2CD、1AB／2BC、12A、13A 與 3 家的尊重）。
describe('loyalFresh43 round-43b R1 opening variants (bits 128 / 256 / 512 / 1024)', () => {
  const first = [vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3'])];
  const r1b = asObs({ ...base, failCount: 1, voteHistory: first }); // the 2nd proposal of R1
  const team = (ids: string[]) => ({ type: 'team_select' as const, teamIds: ids });
  const ids = (a: ReturnType<typeof loyalFresh43Team>): string[] => { if (a.type !== 'team_select') throw new Error('team'); return a.teamIds; };
  const mates = (a: ReturnType<typeof loyalFresh43Team>) => ids(a).filter((id) => id !== 'P5');
  const firstMates = ['P2', 'P3'];
  const seen1 = ['P1', 'P2', 'P3'];

  it('128 (V1): the 2nd proposal is left alone (it may reuse the 1st), from the 3rd on it is the round-43 rule', () => {
    const reuse = team(['P5', 'P1', 'P2']);
    expect(loyalFresh43Team(on(133), r1b, reuse)).toBe(reuse);
    expect(loyalFresh43Team(on(5), r1b, reuse)).not.toBe(reuse);
    const a = withSeededRandom('v1', () => loyalFresh43Team(on(133), r1, stacked));
    const b = withSeededRandom('v1', () => loyalFresh43Team(on(5), r1, stacked));
    expect(a).toEqual(b);
    expect(a).not.toBe(stacked);
  });

  it('256 (V2, extend): the 2nd proposal keeps one of the 1st proposal\'s members (not its leader) and holds one fresh player', () => {
    const ext = team(['P5', 'P2', 'P7']);
    expect(loyalFresh43Team(on(261), r1b, ext)).toBe(ext);
    for (const start of [['P5', 'P6', 'P7'], ['P5', 'P2', 'P3'], ['P5', 'P1', 'P2']]) {
      const got = mates(loyalFresh43Team(on(261), r1b, team(start)));
      expect(got.filter((id) => firstMates.includes(id)).length).toBeGreaterThanOrEqual(1);
      expect(got.filter((id) => !seen1.includes(id)).length).toBeGreaterThanOrEqual(1);
      // the fewest swaps: one member changes
      expect(got.filter((id) => start.includes(id)).length).toBe(1);
    }
  });

  it('512 (V3, no overlap): the 2nd proposal holds nobody from the 1st proposal; two members can change', () => {
    const got = mates(loyalFresh43Team(on(517), r1b, team(['P5', 'P1', 'P2'])));
    expect(got.every((id) => !seen1.includes(id))).toBe(true);
    const disjoint = team(['P5', 'P6', 'P7']);
    expect(loyalFresh43Team(on(517), r1b, disjoint)).toBe(disjoint);
  });

  it('1024 (V4, respect from the 3rd on): at most one member of each earlier proposal and of the not-yet-proposed; the 2nd proposal untouched with 128', () => {
    const got = mates(loyalFresh43Team(on(1157), r1, stacked));
    expect(got.length).toBe(2);
    for (const v of R1) expect(got.filter((id) => v.team.includes(id)).length).toBeLessThanOrEqual(1);
    expect(got.filter((id) => !seen.includes(id)).length).toBeLessThanOrEqual(1);
    const twoFresh = team(['P5', 'P6', 'P7']);
    expect(loyalFresh43Team(on(1157), r1, twoFresh)).not.toBe(twoFresh);
    const okTeam = team(['P5', 'P1', 'P7']);
    expect(loyalFresh43Team(on(1157), r1, okTeam)).toBe(okTeam);
    const reuse = team(['P5', 'P1', 'P2']);
    expect(loyalFresh43Team(on(1157), r1b, reuse)).toBe(reuse);
  });

  it('same seed → same team; R2, Merlin and the gates are as before', () => {
    for (const m of [133, 261, 517, 1157, 1285]) {
      const x = withSeededRandom(`s${m}`, () => loyalFresh43Team(on(m), r1b, team(['P5', 'P1', 'P2'])));
      const y = withSeededRandom(`s${m}`, () => loyalFresh43Team(on(m), r1b, team(['P5', 'P1', 'P2'])));
      expect(x).toEqual(y);
      expect(loyalFresh43Team(on(m), r1b, team(['P5', 'P1', 'P2']), () => false)).toEqual(team(['P5', 'P1', 'P2']));
      expect(loyalFresh43Applies(on(m), asObs({ ...base, myRole: 'merlin' }))).toBe(false);
      expect(loyalFresh43Applies(on(m), asObs({ ...base, currentRound: 2 }))).toBe(false);
    }
  });
});
