/**
 * 第 56 回合：任務結果合起來看（`missionJoint56`）、第 1–4 次提議照強制局派（`goLike56`）、任務牌分有沒有奧伯倫（`missionRole56`），都預設關。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean, MISSION_OBERON_56 } from './belief/BayesBelief';
import { buildReplayObservation } from './benchmark/replayObservation';
import { withSeededRandom } from './benchmark/agreement';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';
import type { PlayerObservation } from './types';
import { HeuristicAgent } from './HeuristicAgent';
import { goLike56Applies, goLike56Bit, goLike56Obs, missionJoint56Team, missionJointScores56, missionOnlyObs } from './Round56';
import { Q2 } from '../../scripts/acceptRound53';

const T = (x: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...x });

/** 第 55 回合的那一局（第 1 局 457 成功、第 2 局 4570 一張失敗）。 */
function game55(): ReplayGame {
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
    id: 'R56', playerCount: 10, names: Array(10).fill(''), proposals,
    seatRoles: ['loyal', 'merlin', 'assassin', 'loyal', 'morgana', 'loyal', 'mordred', 'oberon', 'loyal', 'percival'],
    quests: [{ round: 1, teamSeats: [4, 5, 7], successCount: 3, failCount: 0, failed: false }, { round: 2, teamSeats: [4, 5, 7, 10], successCount: 3, failCount: 1, failed: true }],
    lakes: [{ round: 2, holderSeat: 10, targetSeat: 4, claim: 'good' }], lakeChainValid: true, winner: 'evil',
  } as unknown as ReplayGame;
}
const at = (seat: number, proposal: number): PlayerObservation => {
  const o = buildReplayObservation(game55(), seat, { kind: 'team_select', proposal });
  return { ...o, seatTeam: o.myTeam };
};

describe('round 56: flags', () => {
  it('exist, default off, parse', () => {
    for (const k of ['missionJoint56', 'goLike56', 'missionRole56'] as const) { expect(LEGACY_AGENT_TUNING[k]).toBe(0); expect(DEFAULT_AGENT_TUNING[k]).toBe(0); }
    expect(parseTuningFlag('missionJoint56=0.8')).toEqual({ missionJoint56: 0.8 });
    expect(parseTuningFlag('goLike56=3')).toEqual({ goLike56: 3 });
    expect(parseTuningFlag('missionRole56')).toEqual({ missionRole56: 1 });
    expect(() => parseTuningFlag('goLike56=32')).toThrow();
    expect(parseTuningFlag('goLike56=31')).toEqual({ goLike56: 31 });
    expect(() => parseTuningFlag('missionJoint56=2')).toThrow();
  });
});

describe('round 56: missionJoint56', () => {
  it('the missions-only observation drops every proposal and vote', () => {
    const o = missionOnlyObs(at(1, 10));
    expect(o.voteHistory).toEqual([]);
    expect(o.questHistory.length).toBe(2);
  });
  it('a team already within κ of the best missions-only P(clean) is kept; κ = 1 moves a worse team to the best M', () => {
    const obs = at(1, 10);
    const sc = missionJointScores56(T(), obs, 4)!;
    const bestM = Math.max(...sc.map((s) => s.m));
    const best = sc.find((s) => s.m >= bestM - 1e-9)!;
    expect(missionJoint56Team(T({ missionJoint56: 0.5 }), obs, best.team, () => true)).toBeNull();
    const worst = [...sc].sort((a, b) => a.m - b.m)[0];
    const moved = withSeededRandom('t', () => missionJoint56Team(T({ missionJoint56: 1 }), obs, worst.team, () => true))!;
    expect(moved).not.toBeNull();
    const m = sc.find((s) => [...s.team].sort().join() === [...moved].sort().join())!.m;
    expect(m).toBeGreaterThanOrEqual(bestM - 1e-9);
  });
  it('off, before any mission, for Merlin and red seats it does nothing', () => {
    const obs = at(1, 10);
    expect(missionJoint56Team(T(), obs, ['P1', 'P2', 'P3', 'P6'], () => true)).toBeNull();
    expect(missionJoint56Team(T({ missionJoint56: 1 }), at(4, 3), ['P4', 'P2', 'P3'], () => true)).toBeNull();
    expect(missionJoint56Team(T({ missionJoint56: 1 }), at(2, 10), ['P2', 'P1', 'P3', 'P6'], () => true)).toBeNull();
    expect(missionJoint56Team(T({ missionJoint56: 1 }), at(3, 10), ['P3', 'P1', 'P2', 'P6'], () => true)).toBeNull();
  });
  it('Q2 (round 53): the missions-only posterior is the exact joint over red sets — 0 sits on both failed missions but is not the likeliest red', () => {
    const m = bayesRedShare(missionOnlyObs(Q2()), bayesOptionsOf(T()));
    expect(m.get('P10')!).toBeLessThan(m.get('P2')!);
    expect(m.get('P1')! + m.get('P8')!).toBeCloseTo(1, 6);
  });
});

describe('round 56: goLike56', () => {
  it('applies to a loyal / Percival leader at R1–R2 proposals 1–4 only, per bit', () => {
    expect(goLike56Bit(at(4, 3))).toBe(1); // loyal 4, 1-4
    expect(goLike56Bit(at(5, 4))).toBe(0); // forced
    expect(goLike56Bit(at(6, 5))).toBe(2); // loyal 6, 2-1
    expect(goLike56Bit(at(10, 9))).toBe(0); // Percival 0, 2-5 forced
    expect(goLike56Bit(at(2, 1))).toBe(0); // Merlin
    expect(goLike56Applies(T({ goLike56: 2 }), at(4, 3))).toBe(false);
    expect(goLike56Applies(T({ goLike56: 1 }), at(4, 3))).toBe(true);
    expect(goLike56Obs(at(4, 3)).failCount).toBe(4);
    expect(goLike56Obs(at(4, 3), true).goLikeOwnViewFc).toBe(3);
  });
  it('the pick is the forced-proposal pick on the same record (or the usual one when its own gates refuse it)', () => {
    const obs = at(4, 3);
    const act = (t: AgentTuning, o: PlayerObservation): string[] => {
      const a = new HeuristicAgent(o.myPlayerId, undefined, undefined, t);
      a.onGameStart(o);
      const r = withSeededRandom('go56', () => a.act(o));
      return r.type === 'team_select' ? [...r.teamIds].sort() : [];
    };
    const on = act(T({ goLike56: 1 }), obs);
    const forced = act(T(), goLike56Obs(obs));
    const usual = act(T(), obs);
    expect([forced.join(), usual.join()]).toContain(on.join());
  });
});

describe('round 56: missionRole56', () => {
  it('the table holds the 53b split: two reds with Oberon fail double far more often in R2', () => {
    const share = (k: string, f: number): number => MISSION_OBERON_56[k][f] / MISSION_OBERON_56[k].reduce((a, b) => a + b, 0);
    expect(share('2|2|1', 2)).toBeGreaterThan(share('2|2|0', 2) + 0.3);
  });
  it('changes a blue seat\'s posterior where the missions interact, and leaves red seats as they were', () => {
    const blue = at(1, 10);
    const d = bayesRedShare(blue, bayesOptionsOf(T()));
    const r = bayesRedShare(blue, bayesOptionsOf(T({ missionRole56: 1 })));
    const diff = Math.max(...blue.allPlayerIds.map((id) => Math.abs((d.get(id) ?? 0) - (r.get(id) ?? 0))));
    expect(diff).toBeGreaterThan(0.001); // second-order: one mission alone keeps the table's marginal
    const red = at(3, 10);
    expect(bayesTeamClean(red, ['P4', 'P5', 'P7'], bayesOptionsOf(T({ missionRole56: 1 })))).toBe(bayesTeamClean(red, ['P4', 'P5', 'P7'], bayesOptionsOf(T())));
  });
});
