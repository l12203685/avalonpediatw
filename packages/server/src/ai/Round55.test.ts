/**
 * 第 55 回合（站長 2026-11-19「第二局的任務結果資訊 跟第一局任務結果資訊要合起來看」）：照派最近一次乾淨成功任務隊的提議以權重 1 − d 讀
 * （`copyDiscount55`，預設關）。驗收案例：網站回報的那一局（第 54 回合），忠臣 1 家在 3-1。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from './belief/BayesBelief';
import { buildReplayObservation } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';
import type { PlayerObservation } from './types';

function reportedGame(): ReplayGame {
  const rounds = [
    [[1, 2, 3], [2, 6, 8], [3, 9, 10], [4, 1, 6], [4, 5, 7]],
    [[4, 5, 6, 7], [4, 5, 7, 1], [4, 5, 7, 8], [4, 5, 7, 9], [4, 5, 7, 10]],
    [[4, 5, 7, 1]],
  ];
  const went = new Set([4, 9]);
  const proposals: ReplayProposal[] = [];
  let g = 0;
  rounds.forEach((rp, ri) => rp.forEach((t, ai) => {
    const votes = Array.from({ length: 10 }, (_, k) => t.includes(k + 1));
    proposals.push({ round: ri + 1, attempt: ai + 1, globalIndex: g, leaderSeat: (g % 10) + 1, teamSeats: t, plusSeats: [], minusSeats: [], votes,
      approveCount: votes.filter(Boolean).length, forced: ai === 4, wentOnMission: went.has(g), votesReliable: ai < 4 });
    g++;
  }));
  return {
    id: 'R55', playerCount: 10, names: Array(10).fill(''), proposals,
    seatRoles: ['loyal', 'merlin', 'assassin', 'loyal', 'morgana', 'loyal', 'mordred', 'oberon', 'loyal', 'percival'],
    quests: [{ round: 1, teamSeats: [4, 5, 7], successCount: 3, failCount: 0, failed: false }, { round: 2, teamSeats: [4, 5, 7, 10], successCount: 3, failCount: 1, failed: true }],
    lakes: [{ round: 2, holderSeat: 10, targetSeat: 4, claim: 'good' }], lakeChainValid: true, winner: 'evil',
  } as unknown as ReplayGame;
}

const loyal1 = (): PlayerObservation => {
  const o = buildReplayObservation(reportedGame(), 1, { kind: 'team_select', proposal: 10 });
  return { ...o, seatTeam: o.myTeam };
};
const pCoreRed = (d: number): number => 1 - (bayesTeamClean(loyal1(), ['P4', 'P5', 'P7'], bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, copyDiscount55: d })) ?? 0);

describe('copyDiscount55', () => {
  it('exists, off in both tables, parses', () => {
    expect(LEGACY_AGENT_TUNING.copyDiscount55).toBe(0);
    expect(DEFAULT_AGENT_TUNING.copyDiscount55).toBe(0);
    expect(parseTuningFlag('copyDiscount55')).toEqual({ copyDiscount55: 0.5 });
    expect(parseTuningFlag('copyDiscount55=1')).toEqual({ copyDiscount55: 1 });
    expect(() => parseTuningFlag('copyDiscount55=1.5')).toThrow();
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING }).copyWeight55).toBeUndefined();
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, copyDiscount55: 0.75 }).copyWeight55).toBe(0.25);
  });
  it('the reported game: the four R2 copies of 457 no longer count as four independent endorsements', () => {
    const off = pCoreRed(0);
    const half = pCoreRed(0.5);
    const all = pCoreRed(1);
    expect(off).toBeLessThan(0.35); // the default reads 457 as clean (round 55: 26%)
    expect(half).toBeGreaterThan(off);
    expect(all).toBeGreaterThan(half);
    expect(all).toBeGreaterThan(0.4); // missions + lake alone say about 0.6
  });
  it('a red seat is unchanged (blue seats only)', () => {
    const o = buildReplayObservation(reportedGame(), 3, { kind: 'team_select', proposal: 10 });
    const red = { ...o, seatTeam: o.myTeam } as PlayerObservation;
    const a = bayesRedShare(red, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING }));
    const b = bayesRedShare(red, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, copyDiscount55: 1 }));
    expect([...b.entries()]).toEqual([...a.entries()]);
  });
});

const pCoreRedOpts = (o: Partial<typeof DEFAULT_AGENT_TUNING>): number => 1 - (bayesTeamClean(loyal1(), ['P4', 'P5', 'P7'], bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, ...o })) ?? 0);

describe('round 55b: copyRepeat55b / copyFreq55b', () => {
  it('exist, off in both tables, parse', () => {
    for (const k of ['copyRepeat55b', 'copyFreq55b'] as const) { expect(LEGACY_AGENT_TUNING[k]).toBe(0); expect(DEFAULT_AGENT_TUNING[k]).toBe(0); }
    expect(parseTuningFlag('copyRepeat55b')).toEqual({ copyRepeat55b: 1 });
    expect(parseTuningFlag('copyFreq55b')).toEqual({ copyFreq55b: 1 });
    expect(() => parseTuningFlag('copyFreq55b=2')).toThrow();
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING }).copyRepeatWeight55b).toBeUndefined();
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, copyRepeat55b: 1 }).copyRepeatWeight55b).toBe(0);
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, copyFreq55b: 1 }).copyFreq55b).toBe(true);
  });
  it('the reported game: counting the copy once lies between reading every copy and reading none', () => {
    const off = pCoreRedOpts({});
    const once = pCoreRedOpts({ copyRepeat55b: 1 });
    const none = pCoreRedOpts({ copyDiscount55: 1 });
    expect(once).toBeGreaterThan(off);
    expect(once).toBeLessThanOrEqual(none + 1e-9);
  });
  it('the reported game: the copy-frequency read makes 457 less clean than the generic team model', () => {
    expect(pCoreRedOpts({ copyFreq55b: 1 })).toBeGreaterThan(pCoreRedOpts({}));
  });
});
