/**
 * 優化迴圈第 22 回合・藍方・梅林：`merlinDoomedPublic`（第 1、2 局注定被否決的提議照公開視角的忠臣派，看得到的紅也可以在隊上）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentAction, PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { merlinDoomedPublicTeam, merlinLoyalStyleTeam } from './MerlinLoyalStyle';
import { bayesOptionsOf } from './belief/BayesBelief';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const SEEN = ['P3', 'P7', 'P9'];
const base = {
  myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: SEEN,
  currentRound: 1, currentLeader: 'P1', failCount: 1, questResults: [], gamePhase: 'team_select',
  questHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
} as unknown as PlayerObservation;
// 1-1: P10 proposed P10 P2 P3 (rejected); Merlin P1 leads 1-2 (size 3).
const r1 = {
  ...base,
  voteHistory: [{ round: 1, attempt: 1, leader: 'P10', team: ['P10', 'P2', 'P3'], votes: Object.fromEntries(IDS.map((id) => [id, ['P10', 'P2', 'P3'].includes(id)])), approved: false }],
} as unknown as PlayerObservation;
const pipeline: AgentAction = { type: 'team_select', teamIds: ['P1', 'P2', 'P4'] };
const on = (m: number) => ({ ...DEFAULT_AGENT_TUNING, merlinDoomedPublic: m });

describe('merlinDoomedPublic (round 22, Merlin)', () => {
  it('off by default and in the legacy table', () => {
    expect(DEFAULT_AGENT_TUNING.merlinDoomedPublic).toBe(0);
    expect(LEGACY_AGENT_TUNING.merlinDoomedPublic).toBe(0);
    expect(merlinDoomedPublicTeam(DEFAULT_AGENT_TUNING, r1, 3)).toBeNull();
  });
  it('off: the loyal-style doomed proposal never holds a seen red', () => {
    const t = merlinLoyalStyleTeam(DEFAULT_AGENT_TUNING, r1, pipeline);
    expect(t.type === 'team_select' && t.teamIds.some((id) => SEEN.includes(id))).toBe(false);
  });
  it('on: the doomed proposal is the public view of the seat — it extends the earlier proposal, seen red and all', () => {
    const t = merlinDoomedPublicTeam(on(1), r1, 3);
    expect(t).not.toBeNull();
    expect(t![0]).toBe('P1');
    expect(t).toHaveLength(3);
    // The public view does not know P3 is red: extending 1-1 takes two of P10 P2 P3.
    expect(t!.filter((id) => ['P10', 'P2', 'P3'].includes(id))).toHaveLength(2);
    const styled = merlinLoyalStyleTeam(on(1), r1, pipeline);
    expect(styled.type === 'team_select' && styled.teamIds).toEqual(t);
  });
  it('the pick ignores what Merlin sees (same team for any sight)', () => {
    const other = { ...r1, knownEvils: ['P4', 'P5', 'P6'] } as unknown as PlayerObservation;
    expect(merlinDoomedPublicTeam(on(1), other, 3)).toEqual(merlinDoomedPublicTeam(on(1), r1, 3));
  });
  it('only doomed proposals: not the forced fifth, not R3+, not other roles', () => {
    expect(merlinDoomedPublicTeam(on(1), { ...r1, failCount: 4 } as unknown as PlayerObservation, 3)).toBeNull();
    expect(merlinDoomedPublicTeam(on(1), { ...r1, currentRound: 3 } as unknown as PlayerObservation, 4)).toBeNull();
    expect(merlinDoomedPublicTeam(on(1), { ...r1, myRole: 'loyal' } as unknown as PlayerObservation, 3)).toBeNull();
  });
  it('deterministic, and 1-1 (nothing to read) spreads over the table by the position hash', () => {
    const seen = new Set<string>();
    for (const me of IDS) {
      const o = { ...base, myPlayerId: me, failCount: 0, voteHistory: [] } as unknown as PlayerObservation;
      const t = merlinDoomedPublicTeam(on(1), o, 3)!;
      expect(merlinDoomedPublicTeam(on(1), o, 3)).toEqual(t);
      expect(t[0]).toBe(me);
      for (const id of t.slice(1)) seen.add(id);
    }
    expect(seen.size).toBeGreaterThan(4);
  });
  it('mode 2 also stops the blues reading the Merlin candidate\'s R1–R2 proposals strictly', () => {
    expect(bayesOptionsOf(DEFAULT_AGENT_TUNING).merlinEarlyStrict).toBe(true);
    expect(bayesOptionsOf(on(1)).merlinEarlyStrict).toBe(true);
    expect(bayesOptionsOf(on(2)).merlinEarlyStrict).toBe(false);
  });
  it('the flag takes 0–2', () => {
    expect(parseTuningFlag('merlinDoomedPublic').merlinDoomedPublic).toBe(1);
    expect(parseTuningFlag('merlinDoomedPublic=2').merlinDoomedPublic).toBe(2);
    expect(() => parseTuningFlag('merlinDoomedPublic=3')).toThrow();
  });
});
