/**
 * 第 87 回合（藍方・梅林）：Gemini 交接 v2 第 1 項 `merlinInnerBlackShield87`（預設關）——梅林在隊上本來要反對時，公開視角夠乾淨就照公開視角贊成。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { AGENT_TUNING_KEYS, DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { shield87Applies, shield87Config, shield87Decide, shield87MatesApprove, shield87PublicClean } from './Round87';
import { tuningForOpponent } from './humanProfile';
import { buildReplayObservation, seatId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';
import { ForwardAgent } from './forward/ForwardAgent';
import { HeuristicAgent } from './HeuristicAgent';

const KEYS = ['merlinInnerBlackShield87', 'merlinInnerBlackShieldTemp87', 'merlinInnerBlackShieldRate87', 'merlinInnerBlackShieldScope87'] as const;
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });

/**
 * 虛構的十人局：第 1、2 局成功（1、5、9家；2、6、8、0家），第 3 局第 1 次提議 1、2、3、0家被否決，第 2 次提議的隊長 2家、隊伍 2、4、1、0家（梅林 4家在隊上）。
 * 梅林看得到 5、6、8家（刺客、莫甘娜、奧伯倫），看不到 7家（莫德雷德）。`fails` 把前兩局改成失敗。
 */
function game(team: number[] = [2, 4, 1, 10], fails = 0): ReplayGame {
  const roles = ['loyal', 'loyal', 'loyal', 'merlin', 'assassin', 'morgana', 'mordred', 'oberon', 'percival', 'loyal'];
  const mk = (g: number, round: number, attempt: number, t: number[], went: boolean, leader = g + 1): ReplayProposal => {
    const votes = Array.from({ length: 10 }, (_, k) => (went ? true : t.includes(k + 1)));
    return { round, attempt, globalIndex: g, leaderSeat: leader, teamSeats: t, plusSeats: [], minusSeats: [], votes,
      approveCount: votes.filter(Boolean).length, forced: false, wentOnMission: went, votesReliable: true };
  };
  const proposals = [mk(0, 1, 1, [1, 5, 9], true), mk(1, 2, 1, [2, 6, 8, 10], true), mk(2, 3, 1, [1, 2, 3, 10], false), mk(3, 3, 2, team, false, 2)];
  const quests = [
    { round: 1, teamSeats: [1, 5, 9], successCount: fails >= 1 ? 2 : 3, failCount: fails >= 1 ? 1 : 0, failed: fails >= 1 },
    { round: 2, teamSeats: [2, 6, 8, 10], successCount: fails >= 2 ? 3 : 4, failCount: fails >= 2 ? 1 : 0, failed: fails >= 2 },
  ];
  return { id: 'r87', playerCount: 10, names: Array(10).fill(''), proposals, seatRoles: roles, quests, lakes: [], lakeChainValid: true, winner: 'good' } as unknown as ReplayGame;
}

const voteObs = (team?: number[], fails = 0, seat = 4): PlayerObservation => buildReplayObservation(game(team, fails), seat, { kind: 'team_vote', proposal: 3 });

describe('round 87 flags', () => {
  it('exist, default off everywhere (bot and human tables), parse and describe', () => {
    for (const k of KEYS) {
      expect(AGENT_TUNING_KEYS).toContain(k);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
      for (const type of ['ai', 'weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(type, DEFAULT_AGENT_TUNING)[k]).toBe(0);
    }
    expect(parseTuningFlag('merlinInnerBlackShield87')).toEqual({ merlinInnerBlackShield87: 0.5 });
    expect(parseTuningFlag('merlinInnerBlackShield87=0.7')).toEqual({ merlinInnerBlackShield87: 0.7 });
    expect(parseTuningFlag('merlinInnerBlackShieldTemp87=0.05')).toEqual({ merlinInnerBlackShieldTemp87: 0.05 });
    expect(parseTuningFlag('merlinInnerBlackShieldRate87=0.5')).toEqual({ merlinInnerBlackShieldRate87: 0.5 });
    expect(parseTuningFlag('merlinInnerBlackShieldScope87=18')).toEqual({ merlinInnerBlackShieldScope87: 18 });
    expect(() => parseTuningFlag('merlinInnerBlackShield87=2')).toThrow();
    expect(parseTuningFlag('merlinInnerBlackShieldScope87=32')).toEqual({ merlinInnerBlackShieldScope87: 32 });
    expect(() => parseTuningFlag('merlinInnerBlackShieldScope87=64')).toThrow();
    expect(describeAgentTuning(T({ merlinInnerBlackShield87: 0.6 }))).toContain('merlinInnerBlackShield87=0.6');
    expect(describeAgentTuning(T())).not.toContain('merlinInnerBlackShield87');
    expect(shield87Config(T())).toEqual({ tau: 0, temp: 0, rate: 1, scope: 0 });
    expect(shield87Config(T({ merlinInnerBlackShield87: 0.6, merlinInnerBlackShieldRate87: 0.5 }))).toEqual({ tau: 0.6, temp: 0, rate: 0.5, scope: 0 });
  });
});

describe('shield87Applies', () => {
  const on = T({ merlinInnerBlackShield87: 0.5 });
  it('Merlin on the team, not the leader, non-forced, R3+, a reject — off / approve / other roles / off the team never', () => {
    const obs = voteObs();
    expect(obs.myRole).toBe('merlin');
    expect(obs.gamePhase).toBe('team_vote');
    expect(obs.currentLeader).toBe(seatId(2));
    expect(shield87Applies(on, obs, false)).toBe(true);
    expect(shield87Applies(T(), obs, false)).toBe(false);
    expect(shield87Applies(on, obs, true)).toBe(false);
    expect(shield87Applies(on, { ...obs, myRole: 'loyal' }, false)).toBe(false);
    expect(shield87Applies(on, { ...obs, myRole: 'percival' }, false)).toBe(false);
    expect(shield87Applies(on, voteObs([1, 2, 3, 10]), false)).toBe(false);
    expect(shield87Applies(on, { ...obs, currentLeader: obs.myPlayerId }, false)).toBe(false);
    expect(shield87Applies(on, { ...obs, failCount: 4 }, false)).toBe(false);
    expect(shield87Applies(on, { ...obs, currentRound: 2 }, false)).toBe(false);
    expect(shield87Applies(T({ merlinInnerBlackShield87: 0.5, merlinInnerBlackShieldScope87: 1 }), { ...obs, currentRound: 2 }, false)).toBe(true);
    expect(shield87Applies(T({ merlinInnerBlackShield87: 0.5, merlinInnerBlackShieldScope87: 16 }), { ...obs, currentRound: 4 }, false)).toBe(false);
  });

  it('never when passing can lose on the spot (red at two wins with a red he sees, R4 two seen reds) or his own lake showed a red on it', () => {
    const seenOn = voteObs([2, 4, 5, 10]);
    expect(shield87Applies(on, seenOn, false)).toBe(true);
    expect(shield87Applies(T({ merlinInnerBlackShield87: 0.5, merlinInnerBlackShieldScope87: 4 }), seenOn, false)).toBe(false);
    expect(shield87Applies(T({ merlinInnerBlackShield87: 0.5, merlinInnerBlackShieldScope87: 8 }), voteObs(), false)).toBe(false);
    const fatal = voteObs([2, 4, 5, 10], 2);
    expect(fatal.questResults.filter((r) => r === 'fail')).toHaveLength(2);
    expect(shield87Applies(on, fatal, false)).toBe(false);
    // red at two wins, no red he sees: allowed unless bit 2
    const mp = voteObs(undefined, 2);
    expect(shield87Applies(on, mp, false)).toBe(true);
    expect(shield87Applies(T({ merlinInnerBlackShield87: 0.5, merlinInnerBlackShieldScope87: 2 }), mp, false)).toBe(false);
    // R4 (two fails at 10p): one seen red is allowed, two are not
    const r4one = { ...seenOn, currentRound: 4 };
    expect(shield87Applies(on, r4one, false)).toBe(true);
    expect(shield87Applies(on, { ...r4one, proposedTeam: [seatId(2), seatId(4), seatId(5), seatId(6), seatId(10)] }, false)).toBe(false);
    expect(shield87Applies(on, { ...seenOn, myLakeResults: [{ round: 2, targetId: seatId(5), result: 'evil' }] } as PlayerObservation, false)).toBe(false);
  });
});

describe('shield87Decide', () => {
  it('the public P(clean) is a probability that ignores Merlin\'s sight; hard threshold, temperature, rate, gates', () => {
    const obs = voteObs([2, 4, 5, 10]);
    const p = shield87PublicClean(T(), obs)!;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    // Merlin's sight does not move it
    expect(shield87PublicClean(T(), { ...obs, knownEvils: [] })).toBeCloseTo(p, 12);
    expect(shield87Decide(T({ merlinInnerBlackShield87: Math.max(0.001, p - 0.01) }), obs, false, () => true)).toEqual({ approve: true, p });
    expect(shield87Decide(T({ merlinInnerBlackShield87: Math.min(1, p + 0.01) }), obs, false, () => true)).toEqual({ approve: false, p });
    expect(shield87Decide(T({ merlinInnerBlackShield87: 0.001 }), obs, false, () => false)).toBeNull();
    expect(shield87Decide(T(), obs, false, () => true)).toBeNull();
    expect(shield87Decide(T({ merlinInnerBlackShield87: 0.001, merlinInnerBlackShieldRate87: 1e-6 }), obs, false, () => true)).toBeNull();
    // temperature: a draw between, deterministic for the same decision
    const warm = T({ merlinInnerBlackShield87: p, merlinInnerBlackShieldTemp87: 0.5 });
    const a = shield87Decide(warm, obs, false, () => true);
    expect(a).not.toBeNull();
    expect(shield87Decide(warm, obs, false, () => true)).toEqual(a);
    // bit 32: the share of the other members (not seen red) whose public loyal on-team rule approves
    const m = shield87MatesApprove(T(), obs)!;
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThanOrEqual(1);
    expect(shield87Decide(T({ merlinInnerBlackShield87: 1, merlinInnerBlackShieldScope87: 32 }), obs, false, () => true)).toEqual({ approve: m >= 1, p: m });
    expect(shield87MatesApprove(T(), { ...obs, proposedTeam: [obs.myPlayerId, seatId(5)] })).toBeNull();
  });

  it('in the agent: off → the usual vote; on with a low bar, a Merlin reject on a team without a fatal seen red becomes an approve; loyal votes unchanged', () => {
    const obs = voteObs([2, 4, 5, 10]);
    const vote = (tuning: AgentTuning, o: PlayerObservation): boolean => {
      const fa = new ForwardAgent(o.myPlayerId, new HeuristicAgent(o.myPlayerId, undefined, undefined, tuning));
      const a = fa.act(o);
      return a.type === 'team_vote' ? a.vote : (() => { throw new Error(a.type); })();
    };
    const base = vote(T(), obs);
    const on = vote(T({ merlinInnerBlackShield87: 0.001 }), obs);
    if (!base) expect(on).toBe(true); else expect(on).toBe(base);
    // a loyal on the same team votes the same with or without the switch
    const loyal = voteObs([2, 4, 5, 10], 0, 10);
    expect(vote(T({ merlinInnerBlackShield87: 0.001 }), loyal)).toBe(vote(T(), loyal));
    // red at two wins with the seen red on it: the reject stays
    const fatal = voteObs([2, 4, 5, 10], 2);
    expect(vote(T({ merlinInnerBlackShield87: 0.001 }), fatal)).toBe(vote(T(), fatal));
  });
});
