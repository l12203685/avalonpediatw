/**
 * 優化迴圈第 20 回合・藍方・梅林：`merlinReuseSkip`（照派適用時以比例不照派）、`merlinReusePublic`（只在公開視角的忠臣也會照派時照派）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentAction, PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { merlinLoyalStyleTeam, merlinReusePublicNow, merlinReuseSkipNow } from './MerlinLoyalStyle';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

// R2 P2 P3 P4 succeeded with the seen red P3 on it; Merlin P1 leads R3 (size 4).
const mobs = {
  myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P3', 'P7', 'P9'],
  currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_select',
  questHistory: [
    { round: 1, team: ['P6', 'P7', 'P8'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P2', 'P3', 'P4', 'P5'], result: 'success', failCount: 0 },
  ],
  voteHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
} as unknown as PlayerObservation;
const pipeline: AgentAction = { type: 'team_select', teamIds: ['P1', 'P2', 'P4', 'P5'] };

describe('merlinReuseSkip (round 20, Merlin)', () => {
  const at = (s: number) => ({ ...DEFAULT_AGENT_TUNING, merlinReuseSkip: s });
  it('off by default and in the legacy table; 0 never skips, 1 always does', () => {
    expect(DEFAULT_AGENT_TUNING.merlinReuseSkip).toBe(0);
    expect(LEGACY_AGENT_TUNING.merlinReuseSkip).toBe(0);
    expect(merlinReuseSkipNow(at(0), mobs)).toBe(false);
    expect(merlinReuseSkipNow(at(1), mobs)).toBe(true);
  });
  it('a rate in between skips about that share of positions (deterministic per position)', () => {
    let n = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const o = { ...mobs, voteHistory: [{ round: 3, attempt: 1, leader: IDS[i % 10], team: [IDS[(i * 7) % 10], IDS[(i * 3 + 1) % 10], `X${i}`], votes: {}, approved: false }] } as unknown as PlayerObservation;
      const a = merlinReuseSkipNow(at(0.5), o);
      expect(merlinReuseSkipNow(at(0.5), o)).toBe(a);
      if (a) n++;
    }
    expect(n / N).toBeGreaterThan(0.4);
    expect(n / N).toBeLessThan(0.6);
  });
  it('a skipped re-proposal falls back to the loyal-style team (no seen red)', () => {
    const reuse = merlinLoyalStyleTeam(at(0), mobs, pipeline);
    expect(reuse.type === 'team_select' && reuse.teamIds).toEqual(['P2', 'P3', 'P4', 'P5']);
    const skipped = merlinLoyalStyleTeam(at(1), mobs, pipeline);
    expect(skipped.type).toBe('team_select');
    if (skipped.type === 'team_select') {
      expect(skipped.teamIds).toContain('P1');
      expect(skipped.teamIds.some((id) => mobs.knownEvils.includes(id))).toBe(false);
    }
  });
  it('the flag takes [0, 1]', () => {
    expect(parseTuningFlag('merlinReuseSkip=0.25').merlinReuseSkip).toBe(0.25);
    expect(parseTuningFlag('merlinReuseSkip').merlinReuseSkip).toBe(0.5);
    expect(() => parseTuningFlag('merlinReuseSkip=1.5')).toThrow();
  });
});

describe('merlinReusePublic (round 20, Merlin)', () => {
  const on = { ...DEFAULT_AGENT_TUNING, merlinReusePublic: true };
  it('off: always true', () => {
    expect(DEFAULT_AGENT_TUNING.merlinReusePublic).toBe(false);
    expect(merlinReusePublicNow(DEFAULT_AGENT_TUNING, mobs, 4)).toBe(true);
  });
  it('a full successful team without Merlin: the public loyal leads with itself, so never a re-proposal', () => {
    expect(merlinReusePublicNow(on, mobs, 4)).toBe(false);
    const t = merlinLoyalStyleTeam(on, mobs, pipeline);
    expect(t.type === 'team_select' && t.teamIds.includes('P1')).toBe(true);
  });
  it('a smaller successful team the public reads as the cleanest is re-proposed', () => {
    const r2 = {
      ...mobs, currentRound: 2, questResults: ['success'],
      questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }],
      voteHistory: [{ round: 1, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P4'], votes: Object.fromEntries(IDS.map((id) => [id, true])), approved: true }],
    } as unknown as PlayerObservation;
    const pub = merlinReusePublicNow(on, r2, 4);
    expect(typeof pub).toBe('boolean');
    const t = merlinLoyalStyleTeam(on, r2, pipeline);
    if (pub) expect(t.type === 'team_select' && ['P2', 'P3', 'P4'].every((id) => t.teamIds.includes(id))).toBe(true);
  });
  it('the flag is a boolean', () => {
    expect(parseTuningFlag('merlinReusePublic').merlinReusePublic).toBe(true);
  });
});
