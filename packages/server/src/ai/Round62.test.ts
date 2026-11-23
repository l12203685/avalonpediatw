/**
 * 第 62 回合：2-5（第 1 局失敗之後的強制局）的整體公開讀法（`tailRead62`；Round62.ts）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { goodCleanLeadTeam } from './GoodRound5';
import { FEATURES_62, W62, overlay62, setTailRead62Weights, tailRead62Applies, tailRead62Features } from './Round62';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const votes = (yes: string[]) => Object.fromEntries(IDS.map((id) => [id, yes.includes(id)]));

// 第 1 局：1-1 P1 [P1 P2 P3]、1-2 P2 [P2 P3 P4]、1-3 P3 [P3 P4 P6]、1-4 P4 [P4 P6 P7] 都被否決，1-5 P5 派 [P5 P3 P8]（P8 沒被別人提過）任務一張失敗。
// 第 2 局：2-1 P6 [P6 P5 P3 P9]、2-2 P7 [P7 P9 P1 P2]、2-3 P8 [P8 P5 P3 P1]、2-4 P9 [P9 P1 P2 P6] 都被否決；P10 派 2-5。
const vh = [
  { round: 1, attempt: 1, leader: 'P1', team: ['P1', 'P2', 'P3'], approved: false, votes: votes(['P1', 'P2', 'P3']) },
  { round: 1, attempt: 2, leader: 'P2', team: ['P2', 'P3', 'P4'], approved: false, votes: votes(['P2', 'P3', 'P4', 'P9']) },
  { round: 1, attempt: 3, leader: 'P3', team: ['P3', 'P4', 'P6'], approved: false, votes: votes(['P3', 'P4', 'P6']) },
  { round: 1, attempt: 4, leader: 'P4', team: ['P4', 'P6', 'P7'], approved: false, votes: votes(['P4', 'P6', 'P7']) },
  { round: 1, attempt: 5, leader: 'P5', team: ['P5', 'P3', 'P8'], approved: true, votes: votes(IDS) },
  { round: 2, attempt: 1, leader: 'P6', team: ['P6', 'P5', 'P3', 'P9'], approved: false, votes: votes(['P6', 'P5', 'P3', 'P9']) },
  { round: 2, attempt: 2, leader: 'P7', team: ['P7', 'P9', 'P1', 'P2'], approved: false, votes: votes(['P7', 'P9', 'P1', 'P2']) },
  { round: 2, attempt: 3, leader: 'P8', team: ['P8', 'P5', 'P3', 'P1'], approved: false, votes: votes(['P8', 'P5', 'P3', 'P1', 'P2']) },
  { round: 2, attempt: 4, leader: 'P9', team: ['P9', 'P1', 'P2', 'P6'], approved: false, votes: votes(['P9', 'P1', 'P2', 'P6']) },
];
const obs25 = (extra: object = {}) => asObs({
  myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 2, currentLeader: 'P10', failCount: 4, questResults: ['fail'], gamePhase: 'team_select',
  questHistory: [{ round: 1, team: ['P5', 'P3', 'P8'], result: 'fail', failCount: 1 }],
  voteHistory: vh, proposedTeam: [], lakeHistory: [], myLakeResults: [], ...extra,
});

describe('round 62 tuning field', () => {
  it('off by default and in the legacy table; the flag parses and describes', () => {
    expect(DEFAULT_AGENT_TUNING.tailRead62).toBe(0);
    expect(LEGACY_AGENT_TUNING.tailRead62).toBe(0);
    expect(parseTuningFlag('tailRead62')).toEqual({ tailRead62: 1 });
    expect(parseTuningFlag('tailRead62=0.5')).toEqual({ tailRead62: 0.5 });
    expect(() => parseTuningFlag('tailRead62=5')).toThrow();
    expect(describeAgentTuning({ ...DEFAULT_AGENT_TUNING, tailRead62: 1 })).toContain('tailRead62=1');
  });
});

describe('tailRead62Applies: only the 2-5 after a failed R1, a loyal / Percival leader', () => {
  it('applies at the fixture', () => expect(tailRead62Applies(obs25())).toBe(true));
  it('not after a successful R1, not before the forced proposal, not for Merlin or red', () => {
    expect(tailRead62Applies(obs25({ questHistory: [{ round: 1, team: ['P5', 'P3', 'P8'], result: 'success', failCount: 0 }], questResults: ['success'] }))).toBe(false);
    expect(tailRead62Applies(obs25({ failCount: 3 }))).toBe(false);
    expect(tailRead62Applies(obs25({ myRole: 'merlin' }))).toBe(false);
    expect(tailRead62Applies(obs25({ myRole: 'assassin', myTeam: 'evil' }))).toBe(false);
    expect(tailRead62Applies(obs25({ myRole: 'percival' }))).toBe(true);
  });
});

describe('tailRead62Features: the failed team, the 1-5 team\'s reasonableness, everyone\'s proposals and votes', () => {
  const f = tailRead62Features(obs25());
  it('the failed team and its leader; P8 was the leader\'s own pick (never proposed by anyone else)', () => {
    expect(f.has('P10')).toBe(false);
    expect(f.get('P5')).toMatchObject({ inR1: 1, r1Lead: 1, r1LeadUnr: 1, r1Pick: 0 });
    expect(f.get('P8')).toMatchObject({ inR1: 1, r1Lead: 0, r1Pick: 1 });
    expect(f.get('P3')).toMatchObject({ inR1: 1, r1Pick: 0, nPropR1: 2 });
    expect(f.get('P1')).toMatchObject({ inR1: 0, r1Lead: 0, r1Pick: 0 });
  });
  it('proposals: who brought the failed seats up, how often each seat was proposed by others', () => {
    expect(f.get('P1')?.consSeed).toBe(1); // 1-1 put P3 on
    expect(f.get('P2')?.consSeed).toBe(1);
    expect(f.get('P4')?.consSeed).toBe(0);
    expect(f.get('P1')?.nPropR2).toBe(3);
  });
  it('votes: outer approval of R1 teams with two failed seats; R2 approval of such teams; R2 proposals with failed seats', () => {
    // No 1-1…1-4 team holds two of P5 P3 P8, so the R1 rate is neutral.
    expect(f.get('P9')?.apprR1out).toBe(0);
    // 2-1 and 2-3 hold two failed seats: P1 approved 2-3 only, P5 both.
    expect(f.get('P1')?.apprR2fail).toBeCloseTo(0);
    expect(f.get('P5')?.apprR2fail).toBeCloseTo(0.5);
    expect(f.get('P6')?.r2PropFail).toBe(1);
    expect(f.get('P8')?.r2PropFail).toBe(1);
    expect(f.get('P7')?.r2PropFail).toBe(0);
  });
  it('every feature is present', () => {
    for (const x of f.values()) expect(Object.keys(x).sort()).toEqual([...FEATURES_62].sort());
  });
});

describe('overlay62 and the cleanest-team pick', () => {
  it('empty when off or not applicable; scaled weights when on', () => {
    expect(overlay62(DEFAULT_AGENT_TUNING, obs25()).size).toBe(0);
    expect(overlay62({ ...DEFAULT_AGENT_TUNING, tailRead62: 1 }, obs25({ myRole: 'merlin' })).size).toBe(0);
    const on = overlay62({ ...DEFAULT_AGENT_TUNING, tailRead62: 1 }, obs25());
    const f = tailRead62Features(obs25()).get('P8')!;
    const want = FEATURES_62.reduce((s, k) => s + W62[k] * f[k], 0);
    expect(on.get('P8')).toBeCloseTo(want);
    expect(overlay62({ ...DEFAULT_AGENT_TUNING, tailRead62: 2 }, obs25()).get('P8')).toBeCloseTo(2 * want);
  });
  it('research weights override and reset', () => {
    const zero = Object.fromEntries(FEATURES_62.map((k) => [k, 0])) as typeof W62;
    setTailRead62Weights(zero);
    expect(overlay62({ ...DEFAULT_AGENT_TUNING, tailRead62: 1 }, obs25()).size).toBe(0);
    setTailRead62Weights(null);
    expect(overlay62({ ...DEFAULT_AGENT_TUNING, tailRead62: 1 }, obs25()).size).toBeGreaterThan(0);
  });
  it('switch off: the cleanest team is the same object path as before; switch on still returns a legal team with the leader on it', () => {
    const action = { type: 'team_select' as const, teamIds: ['P10', 'P1', 'P2', 'P4'] };
    const off = goodCleanLeadTeam(DEFAULT_AGENT_TUNING, obs25(), action);
    const on = goodCleanLeadTeam({ ...DEFAULT_AGENT_TUNING, tailRead62: 1 }, obs25(), action);
    expect(off.type).toBe('team_select');
    expect(on.type).toBe('team_select');
    if (on.type === 'team_select') {
      expect(on.teamIds).toHaveLength(4);
      expect(on.teamIds).toContain('P10');
    }
  });
});
