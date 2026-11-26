/**
 * 第 83 回合（藍方・梅林）：站長 11/26 的「有條件的拇指」`merlinGatedThumb83`（基準線預設 1、真人桌 0）與兩個條件 (a)、(b)。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { AGENT_TUNING_KEYS, DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import {
  GATE_A_DEFAULT, GATE_B_DEFAULT, gatedThumb83Applies, gatedThumb83Config, gatedThumb83Eval, gatedThumb83Exempt, gatedThumb83InScope,
  gatedThumb83InvariantExempt, gatedThumb83Passes, gatedThumb83Team, reachProb, setGatedThumb83InvariantTuning,
} from './Round83';
import { tuningForOpponent } from './humanProfile';
import { buildReplayObservation, seatId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';

const KEYS = ['merlinGatedThumb83', 'merlinGatedThumbA83', 'merlinGatedThumbB83', 'merlinGatedThumbLake83', 'merlinGatedThumbScope83'] as const;
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const obsAt = (round: number, failCount: number, extra: Partial<PlayerObservation> = {}): PlayerObservation =>
  ({ myRole: 'merlin', myPlayerId: 'p1', gamePhase: 'team_select', currentRound: round, failCount, knownEvils: ['p2', 'p3', 'p4'], voteHistory: [], questResults: [], playerCount: 10, ...extra } as unknown as PlayerObservation);

describe('round 83 flags', () => {
  it('exist, default off everywhere, parse and describe', () => {
    for (const k of KEYS) {
      expect(AGENT_TUNING_KEYS).toContain(k);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      // round 83: the gated thumb is a bot-table default (rate 1, default thresholds); every human table turns it off
      expect(DEFAULT_AGENT_TUNING[k]).toBe(k === 'merlinGatedThumb83' ? 1 : 0);
      expect(tuningForOpponent('ai', DEFAULT_AGENT_TUNING)[k]).toBe(k === 'merlinGatedThumb83' ? 1 : 0);
      for (const type of ['weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(type, DEFAULT_AGENT_TUNING)[k]).toBe(0);
    }
    expect(parseTuningFlag('merlinGatedThumb83')).toEqual({ merlinGatedThumb83: 0.5 });
    expect(parseTuningFlag('merlinGatedThumbA83=0.4')).toEqual({ merlinGatedThumbA83: 0.4 });
    expect(parseTuningFlag('merlinGatedThumbScope83=12')).toEqual({ merlinGatedThumbScope83: 12 });
    expect(() => parseTuningFlag('merlinGatedThumb83=2')).toThrow();
    expect(() => parseTuningFlag('merlinGatedThumbScope83=16')).toThrow();
    expect(describeAgentTuning(T({ merlinGatedThumb83: 0.5 }))).toContain('merlinGatedThumb83=0.5');
    expect(describeAgentTuning(T({ merlinGatedThumb83: 0 }))).not.toContain('merlinGatedThumb83');
    expect(gatedThumb83Config(T())).toEqual({ a: GATE_A_DEFAULT, b: GATE_B_DEFAULT, lake: 0.5 });
    expect(gatedThumb83Config(T({ merlinGatedThumbA83: 0.3, merlinGatedThumbB83: 0.7, merlinGatedThumbLake83: 0.2 }))).toEqual({ a: 0.3, b: 0.7, lake: 0.2 });
  });

  it('scope: Merlin, team selection, R3–R4 non-forced by default; bits widen or narrow it; red at two wins never', () => {
    const on = T({ merlinGatedThumb83: 0.5 });
    expect(gatedThumb83Applies(T({ merlinGatedThumb83: 0 }), obsAt(3, 0))).toBe(false);
    for (const round of [1, 2, 5]) expect(gatedThumb83Applies(on, obsAt(round, 0))).toBe(false);
    for (const round of [3, 4]) {
      for (const fc of [0, 1, 2, 3]) expect(gatedThumb83Applies(on, obsAt(round, fc))).toBe(true);
      expect(gatedThumb83Applies(on, obsAt(round, 4))).toBe(false);
    }
    expect(gatedThumb83Applies(on, obsAt(3, 0, { questResults: ['fail', 'fail'] } as Partial<PlayerObservation>))).toBe(false);
    expect(gatedThumb83Applies(on, obsAt(3, 0, { myRole: 'loyal' } as Partial<PlayerObservation>))).toBe(false);
    expect(gatedThumb83Applies(on, obsAt(3, 0, { gamePhase: 'team_vote' } as Partial<PlayerObservation>))).toBe(false);
    expect(gatedThumb83Applies(T({ merlinGatedThumb83: 0.5, merlinGatedThumbScope83: 1 }), obsAt(2, 0))).toBe(true);
    expect(gatedThumb83Applies(T({ merlinGatedThumb83: 0.5, merlinGatedThumbScope83: 2 }), obsAt(3, 4))).toBe(true);
    expect(gatedThumb83Applies(T({ merlinGatedThumb83: 0.5, merlinGatedThumbScope83: 4 }), obsAt(3, 3))).toBe(false);
    const led = [{ round: 3, attempt: 1, leader: 'p1', team: ['p1', 'p2', 'p5', 'p6'], approved: false, votes: {} }];
    expect(gatedThumb83Applies(T({ merlinGatedThumb83: 0.5, merlinGatedThumbScope83: 8 }), obsAt(4, 0, { voteHistory: led } as unknown as Partial<PlayerObservation>))).toBe(false);
    expect(gatedThumb83Applies(on, obsAt(4, 0, { voteHistory: led } as unknown as Partial<PlayerObservation>))).toBe(true);
    // the scope alone (the invariant uses it) does not need the rate
    expect(gatedThumb83InScope(T(), obsAt(3, 0))).toBe(true);
  });

  it('reachProb: needs n successes before slack+1 more fails', () => {
    expect(reachProb([1, 1], 1, 0)).toBe(1);
    expect(reachProb([0, 0], 1, 1)).toBe(0);
    expect(reachProb([0.5, 0.5], 1, 0)).toBeCloseTo(0.5);
    expect(reachProb([0.5, 0.5], 1, 1)).toBeCloseTo(0.75);
    expect(reachProb([0.5, 0.5], 2, 0)).toBeCloseTo(0.25);
    expect(reachProb([], 1, 1)).toBe(0);
    expect(reachProb([0.9], 0, 0)).toBe(1);
  });
});

/** 虛構的十人局（同第 82 回合的測試）：第 1、2 局成功，第 3 局第 1 次提議被否決；第 3 局第 2 次提議的隊長是 4 家（梅林）。 */
function game(lakes: unknown[] = []): ReplayGame {
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
  return { id: 'r83', playerCount: 10, names: Array(10).fill(''), proposals, seatRoles: roles, quests, lakes, lakeChainValid: true, winner: 'good' } as unknown as ReplayGame;
}

describe('gatedThumb83Eval / gatedThumb83Team', () => {
  const obs = buildReplayObservation(game(), 4, { kind: 'team_select', proposal: 3 });
  const cur = [seatId(4), seatId(1), seatId(2), seatId(10)];
  const seen = new Set([seatId(5), seatId(6), seatId(8)]);
  const thumbTeam = [seatId(4), seatId(1), seatId(2), seatId(5)];
  // A lake after R2 (10家 → 1家「好人」): the lake is on, two lakes still to come; with λ = 1 a lake always fixes the team.
  const obsL = { ...obs, lakeHistory: [{ round: 2, holderId: seatId(10), targetId: seatId(1), declaredClaim: 'good' as const }] };
  const OPEN = { merlinGatedThumbA83: 0.001, merlinGatedThumbB83: 0.001, merlinGatedThumbLake83: 1 };

  it('(a) and (b) are probabilities from Merlin\'s view; more lake weight never lowers (a); red at two wins → null', () => {
    const ev = gatedThumb83Eval(T(), obs, thumbTeam);
    expect(ev).not.toBeNull();
    for (const x of [ev!.pathProb, ev!.trustAfter, ev!.trustNow]) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    expect(ev!.lakeCert).toBe(false);
    const hiLake = gatedThumb83Eval(T({ merlinGatedThumbLake83: 0.9 }), obs, thumbTeam)!;
    const loLake = gatedThumb83Eval(T({ merlinGatedThumbLake83: 0.01 }), obs, thumbTeam)!;
    expect(hiLake.pathProb).toBeGreaterThanOrEqual(loLake.pathProb - 1e-12);
    // on the failed team Merlin looks no better than before
    expect(ev!.trustAfter).toBeLessThanOrEqual(ev!.trustNow + 1e-9);
    expect(gatedThumb83Eval(T(), { ...obs, questResults: ['fail', 'fail'] }, thumbTeam)).toBeNull();
    expect(gatedThumb83Eval(T(), { ...obs, myRole: 'loyal' }, thumbTeam)).toBeNull();
  });

  it('q = 1 with open thresholds: a loyal-plausible team holding exactly one red he sees, Merlin on it', () => {
    expect(gatedThumb83Eval(T(OPEN), obsL, thumbTeam)!.pathProb).toBeCloseTo(1);
    // no lake left in this game (R3 without any lake record = lake off) and the public's best five hold seen reds → (a) is 0
    expect(gatedThumb83Eval(T(OPEN), obs, thumbTeam)!.pathProb).toBe(0);
    const t = gatedThumb83Team(T({ merlinGatedThumb83: 1, ...OPEN }), obsL, cur, () => true, []);
    expect(t).not.toBe(cur);
    expect(t).toHaveLength(4);
    expect(t).toContain(seatId(4));
    expect(t.filter((id) => seen.has(id))).toHaveLength(1);
  });

  it('closed gate, off, q = 0, barred reds, a seen red already on the team, or the public gate → unchanged', () => {
    expect(gatedThumb83Team(T({ merlinGatedThumb83: 1, merlinGatedThumbA83: 1, merlinGatedThumbB83: 1 }), obs, cur, () => true, [])).toBe(cur);
    expect(gatedThumb83Team(T({ merlinGatedThumb83: 0 }), obs, cur, () => true, [])).toBe(cur);
    expect(gatedThumb83Team(T({ merlinGatedThumb83: 1e-9, ...OPEN }), obsL, cur, () => true, [])).toBe(cur);
    const open = T({ merlinGatedThumb83: 1, ...OPEN });
    expect(gatedThumb83Team(open, obs, cur, () => true, [])).toBe(cur);
    expect(gatedThumb83Team(open, obsL, cur, () => true, [seatId(5), seatId(6), seatId(8)])).toBe(cur);
    expect(gatedThumb83Team(open, obsL, thumbTeam, () => true, [])).toBe(thumbTeam);
    expect(gatedThumb83Team(open, obsL, cur, () => false, [])).toBe(cur);
  });

  it('invariant exemption: only with the switch on, exactly one seen red, inside the gate', () => {
    const open = T({ merlinGatedThumb83: 0.5, ...OPEN });
    expect(gatedThumb83Exempt(open, obsL, thumbTeam)).toBe(true);
    expect(gatedThumb83Exempt(open, obs, thumbTeam)).toBe(false);
    expect(gatedThumb83Exempt(T({ merlinGatedThumb83: 0 }), obsL, thumbTeam)).toBe(false);
    expect(gatedThumb83Exempt(open, obsL, [seatId(4), seatId(1), seatId(5), seatId(6)])).toBe(false);
    expect(gatedThumb83Exempt(T({ merlinGatedThumb83: 0.5, merlinGatedThumbA83: 1, merlinGatedThumbB83: 1, merlinGatedThumbLake83: 1 }), obsL, thumbTeam)).toBe(false);
    const ev = gatedThumb83Eval(open, obsL, thumbTeam)!;
    expect(gatedThumb83Passes(ev, gatedThumb83Config(open))).toBe(true);
    setGatedThumb83InvariantTuning(null);
    expect(gatedThumb83InvariantExempt(obsL, thumbTeam)).toBe(false);
    setGatedThumb83InvariantTuning(open);
    expect(gatedThumb83InvariantExempt(obsL, thumbTeam)).toBe(true);
    setGatedThumb83InvariantTuning(null);
  });

  it('a good lake declaration on Merlin by a holder he does not see as red counts as (b)', () => {
    const lakeObs = { ...obs, lakeHistory: [{ round: 2, holderId: seatId(1), targetId: seatId(4), declaredClaim: 'good' as const }] };
    expect(gatedThumb83Eval(T(), lakeObs, thumbTeam)!.lakeCert).toBe(true);
    const redHolder = { ...obs, lakeHistory: [{ round: 2, holderId: seatId(5), targetId: seatId(4), declaredClaim: 'good' as const }] };
    expect(gatedThumb83Eval(T(), redHolder, thumbTeam)!.lakeCert).toBe(false);
  });
});
