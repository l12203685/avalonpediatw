/**
 * 第 82 回合（藍方・梅林）：`merlinTierCover82`／`merlinTierCoverScope82`／`merlinLakeMix82`（預設關，只量）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { AGENT_TUNING_KEYS, DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { merlinLakeMix82Now, tierCover82Applies, tierCover82Team } from './Round82';
import { tuningForOpponent } from './humanProfile';
import { buildReplayObservation, seatId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';

const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const obsAt = (round: number, failCount: number, extra: Partial<PlayerObservation> = {}): PlayerObservation =>
  ({ myRole: 'merlin', myPlayerId: 'p1', gamePhase: 'team_select', currentRound: round, failCount, knownEvils: ['p2', 'p3', 'p4'], voteHistory: [], questResults: [], playerCount: 10, ...extra } as unknown as PlayerObservation);

describe('round 82 flags', () => {
  it('exist, default off everywhere, parse and describe', () => {
    for (const k of ['merlinTierCover82', 'merlinTierCoverScope82', 'merlinLakeMix82'] as const) {
      expect(AGENT_TUNING_KEYS).toContain(k);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
      for (const type of ['ai', 'weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(type, DEFAULT_AGENT_TUNING)[k]).toBe(0);
    }
    expect(parseTuningFlag('merlinTierCover82')).toEqual({ merlinTierCover82: 0.5 });
    expect(parseTuningFlag('merlinLakeMix82=0.3')).toEqual({ merlinLakeMix82: 0.3 });
    expect(parseTuningFlag('merlinTierCoverScope82=9')).toEqual({ merlinTierCoverScope82: 9 });
    expect(() => parseTuningFlag('merlinTierCover82=1.5')).toThrow();
    expect(() => parseTuningFlag('merlinTierCoverScope82=16')).toThrow();
    expect(describeAgentTuning(T({ merlinTierCover82: 0.5, merlinLakeMix82: 0.5 }))).toContain('merlinTierCover82=0.5');
    expect(describeAgentTuning(T())).not.toContain('merlinTierCover82');
  });

  it('tier cover scope: Merlin, team selection, R3–R4 attempts 1–3, red short of two fails, never after a counted seen-red lead', () => {
    const on = T({ merlinTierCover82: 0.5 });
    expect(tierCover82Applies(T(), obsAt(3, 0))).toBe(false);
    for (const round of [1, 2, 5]) expect(tierCover82Applies(on, obsAt(round, 0))).toBe(false);
    for (const round of [3, 4]) {
      for (const fc of [0, 1, 2]) expect(tierCover82Applies(on, obsAt(round, fc))).toBe(true);
      expect(tierCover82Applies(on, obsAt(round, 3))).toBe(false);
      expect(tierCover82Applies(on, obsAt(round, 4))).toBe(false);
    }
    expect(tierCover82Applies(on, obsAt(3, 0, { questResults: ['fail', 'fail'] } as Partial<PlayerObservation>))).toBe(false);
    expect(tierCover82Applies(on, obsAt(3, 0, { myRole: 'loyal' } as Partial<PlayerObservation>))).toBe(false);
    expect(tierCover82Applies(on, obsAt(3, 0, { gamePhase: 'team_vote' } as Partial<PlayerObservation>))).toBe(false);
    // bit 1 = R3 only; bit 4 = attempts 2–3 only
    expect(tierCover82Applies(T({ merlinTierCover82: 0.5, merlinTierCoverScope82: 1 }), obsAt(4, 0))).toBe(false);
    expect(tierCover82Applies(T({ merlinTierCover82: 0.5, merlinTierCoverScope82: 4 }), obsAt(3, 0))).toBe(false);
    expect(tierCover82Applies(T({ merlinTierCover82: 0.5, merlinTierCoverScope82: 4 }), obsAt(3, 1))).toBe(true);
    // already led a seen red from R3 on (or on a forced proposal): the tier has him already
    const led = [{ round: 3, attempt: 1, leader: 'p1', team: ['p1', 'p2', 'p5', 'p6'], approvals: [] }];
    expect(tierCover82Applies(on, obsAt(4, 0, { voteHistory: led } as unknown as Partial<PlayerObservation>))).toBe(false);
    const r1 = [{ round: 1, attempt: 1, leader: 'p1', team: ['p1', 'p2', 'p5'], approvals: [] }];
    expect(tierCover82Applies(on, obsAt(3, 0, { voteHistory: r1 } as unknown as Partial<PlayerObservation>))).toBe(true);
  });

  it('lake mix: Merlin only, rate by seat and lake number (deterministic)', () => {
    const lakeObs = (id: string, lakes: number): PlayerObservation =>
      ({ myRole: 'merlin', myPlayerId: id, lakeHistory: Array(lakes).fill({}) } as unknown as PlayerObservation);
    expect(merlinLakeMix82Now(T(), lakeObs('p1', 0))).toBe(false);
    expect(merlinLakeMix82Now(T({ merlinLakeMix82: 1 }), lakeObs('p1', 0))).toBe(true);
    expect(merlinLakeMix82Now(T({ merlinLakeMix82: 1 }), { ...lakeObs('p1', 0), myRole: 'loyal' } as PlayerObservation)).toBe(false);
    let on = 0;
    for (let s = 1; s <= 10; s++) for (let l = 0; l < 3; l++) {
      const a = merlinLakeMix82Now(T({ merlinLakeMix82: 0.5 }), lakeObs(`p${s}`, l));
      expect(merlinLakeMix82Now(T({ merlinLakeMix82: 0.5 }), lakeObs(`p${s}`, l))).toBe(a);
      on += a ? 1 : 0;
    }
    expect(on).toBeGreaterThan(5);
    expect(on).toBeLessThan(25);
  });
});

/** 虛構的十人局：第 1、2 局成功（紅方藏牌，看得到的紅在成功的隊上），第 3 局第 1 次提議被否決；第 3 局第 2 次提議的隊長是 4 家（梅林）。 */
function game(): ReplayGame {
  const roles = ['loyal', 'loyal', 'loyal', 'merlin', 'assassin', 'morgana', 'mordred', 'oberon', 'percival', 'loyal'];
  const mk = (g: number, round: number, attempt: number, team: number[], went: boolean): ReplayProposal => {
    const votes = Array.from({ length: 10 }, (_, k) => (went ? true : team.includes(k + 1)));
    return { round, attempt, globalIndex: g, leaderSeat: g + 1, teamSeats: team, plusSeats: [], minusSeats: [], votes,
      approveCount: votes.filter(Boolean).length, forced: false, wentOnMission: went, votesReliable: true };
  };
  const proposals = [mk(0, 1, 1, [1, 5, 9], true), mk(1, 2, 1, [2, 6, 8, 10], true), mk(2, 3, 1, [1, 2, 3, 10], false), mk(3, 3, 2, [4, 1, 2, 10], false)];
  const quests = [
    { round: 1, teamSeats: [1, 5, 9], successCount: 3, failCount: 0, failed: false },
    { round: 2, teamSeats: [2, 6, 8, 10], successCount: 4, failCount: 0, failed: false },
  ];
  return { id: 'r82', playerCount: 10, names: Array(10).fill(''), proposals, seatRoles: roles, quests, lakes: [], lakeChainValid: true, winner: 'good' } as unknown as ReplayGame;
}

describe('tierCover82Team', () => {
  const obs = buildReplayObservation(game(), 4, { kind: 'team_select', proposal: 3 });
  const cur = [seatId(4), seatId(1), seatId(2), seatId(10)];
  const seen = new Set([seatId(5), seatId(6), seatId(8)]);

  it('q = 1: a loyal-plausible team holding exactly one red he sees, Merlin on it', () => {
    expect(obs.currentRound).toBe(3);
    expect(obs.failCount).toBe(1);
    const t = tierCover82Team(T({ merlinTierCover82: 1 }), obs, cur, () => true, []);
    expect(t).not.toBe(cur);
    expect(t).toHaveLength(4);
    expect(t).toContain(seatId(4));
    expect(t.filter((id) => seen.has(id))).toHaveLength(1);
  });

  it('off, q = 0, a barred seen red, or a current team already holding a seen red → unchanged', () => {
    expect(tierCover82Team(T(), obs, cur, () => true, [])).toBe(cur);
    expect(tierCover82Team(T({ merlinTierCover82: 1e-9 }), obs, cur, () => true, [])).toBe(cur);
    const withRed = [seatId(4), seatId(1), seatId(2), seatId(5)];
    expect(tierCover82Team(T({ merlinTierCover82: 1 }), obs, withRed, () => true, [])).toBe(withRed);
    const t = tierCover82Team(T({ merlinTierCover82: 1 }), obs, cur, () => true, [seatId(5), seatId(6), seatId(8)]);
    expect(t).toBe(cur);
  });

  it('the public gate binds: no team passing it → unchanged', () => {
    expect(tierCover82Team(T({ merlinTierCover82: 1 }), obs, cur, () => false, [])).toBe(cur);
  });
});
