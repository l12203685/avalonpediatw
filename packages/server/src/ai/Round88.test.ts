/**
 * 第 88 回合（藍方・梅林；路線圖 Phase A 第 2 項）：`merlinEvAssassin88`——梅林派隊照 log P(三藍) + λ log(1 − P(被刺)) 挑。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { AGENT_TUNING_KEYS, DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import {
  CAL_HUMAN, assassinatedProb88, ev88Applies, ev88InScope, ev88Team, merlinExposure88, mordredDist88, p3b88, p3bParts88, round88Stats, succ88,
  type Ev88Cand,
} from './Round88';
import { worldLines75, worldLines75LeaderProbe } from './assassin/WorldLines75';
import { tuningForOpponent } from './humanProfile';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { merlinPublicScoring } from './MerlinLoyalStyle';
import { buildReplayObservation, seatId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';

const KEYS = ['merlinEvAssassin88', 'merlinEvScope88', 'merlinEvTemp88'] as const;
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const obsAt = (round: number, failCount: number, extra: Partial<PlayerObservation> = {}): PlayerObservation =>
  ({ myRole: 'merlin', myPlayerId: 'p1', gamePhase: 'team_select', currentRound: round, failCount, knownEvils: ['p2', 'p3', 'p4'], voteHistory: [], questResults: [], playerCount: 10, ...extra } as unknown as PlayerObservation);

describe('round 88 flags', () => {
  it('exist, default off everywhere, parse and describe', () => {
    for (const k of KEYS) {
      expect(AGENT_TUNING_KEYS).toContain(k);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
      for (const type of ['ai', 'weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(type, DEFAULT_AGENT_TUNING)[k]).toBe(0);
    }
    expect(parseTuningFlag('merlinEvAssassin88')).toEqual({ merlinEvAssassin88: 1 });
    expect(parseTuningFlag('merlinEvAssassin88=0.5')).toEqual({ merlinEvAssassin88: 0.5 });
    expect(parseTuningFlag('merlinEvScope88=11')).toEqual({ merlinEvScope88: 11 });
    expect(parseTuningFlag('merlinEvTemp88=0.2')).toEqual({ merlinEvTemp88: 0.2 });
    expect(() => parseTuningFlag('merlinEvAssassin88=11')).toThrow();
    expect(() => parseTuningFlag('merlinEvScope88=128')).toThrow();
    expect(describeAgentTuning(T({ merlinEvAssassin88: 1, merlinEvScope88: 3 }))).toContain('merlinEvAssassin88=1');
    expect(describeAgentTuning(T())).not.toContain('merlinEvAssassin88');
  });

  it('scope: Merlin leading a 10-player game; default R3–R4 non-forced; bits 1 / 4 / 8 widen it', () => {
    const on = T({ merlinEvAssassin88: 1 });
    expect(ev88Applies(T(), obsAt(3, 0))).toBe(false);
    for (const round of [3, 4]) for (const fc of [0, 1, 2, 3]) expect(ev88Applies(on, obsAt(round, fc))).toBe(true);
    for (const round of [1, 2, 5]) expect(ev88Applies(on, obsAt(round, 0))).toBe(false);
    expect(ev88Applies(on, obsAt(3, 4))).toBe(false);
    expect(ev88InScope(T({ merlinEvScope88: 1 }), obsAt(1, 2))).toBe(true);
    expect(ev88InScope(T({ merlinEvScope88: 8 }), obsAt(2, 0))).toBe(true);
    expect(ev88InScope(T({ merlinEvScope88: 1 }), obsAt(3, 0))).toBe(false);
    expect(ev88InScope(T({ merlinEvScope88: 4 }), obsAt(2, 4))).toBe(true);
    expect(ev88InScope(T({ merlinEvScope88: 4 }), obsAt(5, 4))).toBe(true);
    expect(ev88InScope(T({ merlinEvScope88: 3 }), obsAt(5, 0))).toBe(false);
    expect(ev88Applies(on, obsAt(3, 0, { myRole: 'loyal' } as Partial<PlayerObservation>))).toBe(false);
    expect(ev88Applies(on, obsAt(3, 0, { gamePhase: 'team_vote' } as Partial<PlayerObservation>))).toBe(false);
    expect(ev88Applies(on, obsAt(3, 0, { playerCount: 8 } as Partial<PlayerObservation>))).toBe(false);
    expect(ev88Applies(on, obsAt(3, 0, { publicLoyalView: true } as Partial<PlayerObservation>))).toBe(false);
    expect(ev88Applies(on, obsAt(4, 0, { questResults: ['success', 'success', 'success'] } as Partial<PlayerObservation>))).toBe(false);
  });

  it('calibration is increasing in E; succ88 / p3b88 behave', () => {
    expect(assassinatedProb88(0.05, false)).toBeLessThan(assassinatedProb88(0.3, false));
    expect(assassinatedProb88(0.3, false)).toBeCloseTo(1 / (1 + Math.exp(-(CAL_HUMAN.a + CAL_HUMAN.b * Math.log(0.3 / 0.7)))));
    const seen = new Set(['r1', 'r2', 'r3']);
    const mord = new Map([['a', 0.5], ['b', 0.5]]);
    expect(succ88(['me', 'r1', 'x'], 1, seen, mord, 'me')).toBe(0);
    expect(succ88(['me', 'a', 'x'], 1, seen, mord, 'me')).toBeCloseTo(0.5);
    expect(succ88(['me', 'x', 'y'], 1, seen, mord, 'me')).toBe(1);
    expect(succ88(['me', 'r1', 'a', 'x'], 2, seen, mord, 'me')).toBeCloseTo(0.5);
    expect(succ88(['me', 'a', 'b', 'x'], 2, seen, mord, 'me')).toBe(1);
    const parts = { rho: 0.25, vSucc: 0.8, vFail: 0.3, vNone: 0.5 };
    expect(p3b88(parts, 1)).toBeCloseTo(0.25 * 0.8 + 0.75 * 0.5);
    expect(p3b88(parts, 0)).toBeCloseTo(0.25 * 0.3 + 0.75 * 0.5);
  });
});

/** 虛構的十人局（同第 83 回合的測試）：第 1、2 局成功，第 3 局第 1 次提議被否決；第 3 局第 2 次提議的隊長是 4 家（梅林）。 */
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
  return { id: 'r88', playerCount: 10, names: Array(10).fill(''), proposals, seatRoles: roles, quests, lakes, lakeChainValid: true, winner: 'good' } as unknown as ReplayGame;
}

describe('merlinExposure88 / worldLines75LeaderProbe / ev88Team', () => {
  const obs = buildReplayObservation(game(), 4, { kind: 'team_select', proposal: 3 });
  const me = seatId(4);
  const cur = [me, seatId(1), seatId(2), seatId(10)];
  const seen = new Set([seatId(5), seatId(6), seatId(8)]);
  const thumbTeam = [me, seatId(1), seatId(2), seatId(5)];
  const own = bayesRedShare(obs, bayesOptionsOf(T()));
  const obsL = { ...obs, lakeHistory: [{ round: 2, holderId: seatId(10), targetId: seatId(1), declaredClaim: 'good' as const }] };
  const OPEN = { merlinGatedThumbA83: 0.001, merlinGatedThumbB83: 0.001, merlinGatedThumbLake83: 1 };

  it('the leader probe matches a full world-line run with the proposal appended (votes not cast)', () => {
    const roles = { [seatId(5)]: 'assassin', [seatId(6)]: 'morgana', [seatId(8)]: 'oberon', [seatId(7)]: 'mordred' };
    const hyp = { ...obs, allEvilRoles: roles } as PlayerObservation;
    const pr = worldLines75LeaderProbe(hyp, me, [cur, thumbTeam])!;
    const full = worldLines75(hyp)!;
    expect(pr.base).toBeCloseTo(full.merlin.get(me)!, 9);
    for (const [i, team] of [cur, thumbTeam].entries()) {
      const ext = { ...hyp, voteHistory: [...hyp.voteHistory, { round: 3, attempt: 3, leader: me, team, approved: false, votes: {} }] } as PlayerObservation;
      expect(pr.after[i]).toBeCloseTo(worldLines75(ext)!.merlin.get(me)!, 9);
    }
    expect(worldLines75LeaderProbe(hyp, seatId(5), [cur])).toBeNull();
  });

  it('exposure: probabilities; Mordred spread sums to 1 over the seats Merlin cannot see; non-Merlin → null', () => {
    const d = mordredDist88(obs, own);
    expect([...d.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(d.has(me) || [...seen].some((id) => d.has(id))).toBe(false);
    const ex = merlinExposure88(obs, [cur, thumbTeam], own)!;
    for (const v of [ex.base, ...ex.after]) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1); }
    expect(merlinExposure88({ ...obs, myRole: 'loyal' }, [cur], own)).toBeNull();
    expect(merlinExposure88({ ...obs, knownEvils: [seatId(5)] }, [cur], own)).toBeNull();
  });

  it('P(three blue) parts are probabilities; a forced or like-forced proposal always goes', () => {
    const pubOpts = merlinPublicScoring(T(), obs).pubOpts;
    const parts = p3bParts88(T(), obs, own, pubOpts, false)!;
    for (const v of [parts.rho, parts.vSucc, parts.vFail, parts.vNone]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(parts.vSucc).toBeGreaterThanOrEqual(parts.vFail);
    expect(p3bParts88(T(), obs, own, pubOpts, true)!.rho).toBe(1);
    expect(p3bParts88(T(), { ...obs, failCount: 4 }, own, pubOpts, false)!.rho).toBe(1);
  });

  it('off / out of scope → the same object; on: a candidate team of the right size with Merlin, scored, best picked', () => {
    expect(ev88Team(T(), obs, cur, () => true, () => true, [])).toBe(cur);
    expect(ev88Team(T({ merlinEvAssassin88: 1, merlinEvScope88: 1 }), obs, cur, () => true, () => true, [])).toBe(cur);
    const trace: Ev88Cand[] = [];
    const before = round88Stats.applies;
    const t = ev88Team(T({ merlinEvAssassin88: 1 }), obs, cur, () => true, () => true, [], trace);
    expect(round88Stats.applies).toBe(before + 1);
    expect(t).toHaveLength(4);
    expect(t).toContain(me);
    expect(trace[0].cur).toBe(true);
    const best = Math.max(...trace.map((c) => c.score));
    const picked = trace.find((c) => [...c.team].sort().join() === [...t].sort().join())!;
    expect(picked.score).toBeCloseTo(best);
    for (const c of trace) { expect(c.p3b).toBeGreaterThan(0); expect(c.pa).toBeGreaterThan(0); expect(c.pa).toBeLessThan(1); }
  });

  it('thumbs: only through the round-83 gate (or bit 16); bit 32 keeps every candidate clean; λ = 0 is off', () => {
    const traceClosed: Ev88Cand[] = [];
    ev88Team(T({ merlinEvAssassin88: 1, merlinGatedThumbA83: 1, merlinGatedThumbB83: 1 }), obsL, cur, () => true, () => true, [], traceClosed);
    expect(traceClosed.some((c) => c.thumbs > 0)).toBe(false);
    const traceOpen: Ev88Cand[] = [];
    const t = ev88Team(T({ merlinEvAssassin88: 1, ...OPEN }), obsL, cur, () => true, () => true, [], traceOpen);
    expect(traceOpen.some((c) => c.thumbs === 1)).toBe(true);
    // a gated thumb is far less Merlin-like; with λ = 1 and a proposal that rarely goes the thumb wins
    expect(t.filter((id) => seen.has(id)).length).toBeLessThanOrEqual(1);
    const traceNo: Ev88Cand[] = [];
    ev88Team(T({ merlinEvAssassin88: 1, merlinEvScope88: 2 | 32, ...OPEN }), obsL, cur, () => true, () => true, [], traceNo);
    expect(traceNo.some((c) => c.thumbs > 0)).toBe(false);
    const traceUngated: Ev88Cand[] = [];
    ev88Team(T({ merlinEvAssassin88: 1, merlinEvScope88: 2 | 16, merlinGatedThumbA83: 1, merlinGatedThumbB83: 1 }), obsL, cur, () => true, () => true, [], traceUngated);
    expect(traceUngated.some((c) => c.thumbs === 1)).toBe(true);
    expect(ev88Team(T({ merlinEvAssassin88: 0, ...OPEN }), obsL, cur, () => true, () => true, [])).toBe(cur);
    // τ > 0: a sampled candidate (deterministic for the same observation), always one of the scored teams
    const traceT: Ev88Cand[] = [];
    const tt = ev88Team(T({ merlinEvAssassin88: 1, merlinEvTemp88: 1, ...OPEN }), obsL, cur, () => true, () => true, [], traceT);
    expect(traceT.some((c) => [...c.team].sort().join() === [...tt].sort().join())).toBe(true);
    expect(ev88Team(T({ merlinEvAssassin88: 1, merlinEvTemp88: 1, ...OPEN }), obsL, cur, () => true, () => true, [])).toEqual(tt);
    // the barred seats and Merlin's own gates bind the clean candidates
    const traceBar: Ev88Cand[] = [];
    ev88Team(T({ merlinEvAssassin88: 1 }), obs, cur, (team) => !team.includes(seatId(3)), () => true, [seatId(9)], traceBar);
    expect(traceBar.filter((c) => !c.cur).some((c) => c.team.includes(seatId(3)) || c.team.includes(seatId(9)))).toBe(false);
  });
});
