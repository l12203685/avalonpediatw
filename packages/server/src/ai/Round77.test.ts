/**
 * 第 77 回合（藍方・梅林）：`merlinCover77`／`merlinCoverScope77`（預設關）——梅林在幾乎不會出任務的提議（第 1、2 局非強制）
 * 照「坐在他位置、只看公開紀錄的忠臣」的流程派，讓世界線刺客（第 75 回合）在這幾格分不出梅林和忠臣。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { AGENT_TUNING_KEYS, DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { merlinCover77Now, merlinCover77TeamOk, merlinCoverMix77, round77Stats } from './Round77';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { tuningForOpponent } from './humanProfile';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { withSeededRandom } from './benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';

const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const obsAt = (round: number, failCount: number, extra: Partial<PlayerObservation> = {}): PlayerObservation =>
  ({ myRole: 'merlin', myPlayerId: 'p1', gamePhase: 'team_select', currentRound: round, failCount, knownEvils: ['p2', 'p3', 'p4'], voteHistory: [], ...extra } as unknown as PlayerObservation);

describe('round 77 flags', () => {
  it('exist, default off everywhere (legacy, baseline, every human-table profile), parse', () => {
    expect(AGENT_TUNING_KEYS).toContain('merlinCover77');
    expect(AGENT_TUNING_KEYS).toContain('merlinCoverScope77');
    for (const t of [LEGACY_AGENT_TUNING, DEFAULT_AGENT_TUNING, tuningForOpponent('weakHuman', DEFAULT_AGENT_TUNING), tuningForOpponent('avgHuman', DEFAULT_AGENT_TUNING), tuningForOpponent('strongHuman', DEFAULT_AGENT_TUNING)]) {
      expect(t.merlinCover77).toBe(0);
      expect(t.merlinCoverScope77).toBe(0);
    }
    expect(parseTuningFlag('merlinCover77')).toEqual({ merlinCover77: 1 });
    expect(parseTuningFlag('merlinCover77=0.5')).toEqual({ merlinCover77: 0.5 });
    expect(parseTuningFlag('merlinCoverScope77=2')).toEqual({ merlinCoverScope77: 2 });
    expect(() => parseTuningFlag('merlinCover77=1.5')).toThrow();
    expect(() => parseTuningFlag('merlinCoverScope77=16')).toThrow();
    expect(describeAgentTuning(T({ merlinCover77: 0.5, merlinCoverScope77: 6 }))).toContain('merlinCover77=0.5');
    expect(describeAgentTuning(T({ merlinCover77: 0.5, merlinCoverScope77: 6 }))).toContain('merlinCoverScope77=6');
    expect(describeAgentTuning(T())).not.toContain('merlinCover77');
  });

  it('scope: Merlin only, team selection only, R1–R2 non-forced (the proposals that all but never become a mission)', () => {
    const on = T({ merlinCover77: 1 });
    expect(merlinCover77Now(T(), obsAt(1, 0))).toBe(false); // off
    expect(merlinCover77Now(on, obsAt(1, 0))).toBe(true);
    expect(merlinCover77Now(on, obsAt(1, 3))).toBe(true);
    expect(merlinCover77Now(on, obsAt(2, 3))).toBe(true);
    expect(merlinCover77Now(on, obsAt(1, 4))).toBe(false); // forced: it is a mission
    expect(merlinCover77Now(on, obsAt(2, 4))).toBe(false);
    for (const round of [3, 4, 5]) for (const fc of [0, 1, 2, 3, 4]) expect(merlinCover77Now(on, obsAt(round, fc))).toBe(false);
    expect(merlinCover77Now(on, obsAt(1, 0, { myRole: 'loyal' } as Partial<PlayerObservation>))).toBe(false);
    expect(merlinCover77Now(on, obsAt(1, 0, { myRole: 'percival' } as Partial<PlayerObservation>))).toBe(false);
    expect(merlinCover77Now(on, obsAt(1, 0, { gamePhase: 'team_vote' } as Partial<PlayerObservation>))).toBe(false);
  });

  it('round bits: 1 = R1, 2 = R2 (0 = both)', () => {
    expect(merlinCover77Now(T({ merlinCover77: 1, merlinCoverScope77: 1 }), obsAt(1, 0))).toBe(true);
    expect(merlinCover77Now(T({ merlinCover77: 1, merlinCoverScope77: 1 }), obsAt(2, 0))).toBe(false);
    expect(merlinCover77Now(T({ merlinCover77: 1, merlinCoverScope77: 2 }), obsAt(1, 0))).toBe(false);
    expect(merlinCover77Now(T({ merlinCover77: 1, merlinCoverScope77: 2 }), obsAt(2, 0))).toBe(true);
    expect(merlinCover77Now(T({ merlinCover77: 1, merlinCoverScope77: 4 }), obsAt(1, 0))).toBe(true); // no round bit = both
    expect(merlinCover77Now(T({ merlinCover77: 1, merlinCoverScope77: 4 }), obsAt(2, 0))).toBe(true);
  });

  it('bit 8: at most one lead with a red he sees per game (his earlier non-forced leads count, the forced one and the others\' leads do not)', () => {
    const on = T({ merlinCover77: 1, merlinCoverScope77: 8 });
    const lead = (leader: string, attempt: number, team: string[]) => ({ round: 1, attempt, leader, team, approved: false, votes: {} });
    expect(merlinCover77Now(on, obsAt(2, 0, { voteHistory: [lead('p1', 1, ['p1', 'p5', 'p6'])] } as unknown as Partial<PlayerObservation>))).toBe(true);
    expect(merlinCover77Now(on, obsAt(2, 0, { voteHistory: [lead('p1', 1, ['p1', 'p2', 'p6'])] } as unknown as Partial<PlayerObservation>))).toBe(false);
    expect(merlinCover77Now(on, obsAt(2, 0, { voteHistory: [lead('p7', 1, ['p7', 'p2', 'p6'])] } as unknown as Partial<PlayerObservation>))).toBe(true);
    expect(merlinCover77Now(on, obsAt(2, 0, { voteHistory: [lead('p1', 5, ['p1', 'p2', 'p6'])] } as unknown as Partial<PlayerObservation>))).toBe(true);
    // without the bit the earlier lead does not matter
    expect(merlinCover77Now(T({ merlinCover77: 1 }), obsAt(2, 0, { voteHistory: [lead('p1', 1, ['p1', 'p2', 'p6'])] } as unknown as Partial<PlayerObservation>))).toBe(true);
  });

  it('rate: a hash of seat, round and attempt — the same situation always decides the same way, and about q of the situations are covered', () => {
    const half = T({ merlinCover77: 0.5 });
    let n = 0;
    let k = 0;
    for (let seat = 1; seat <= 10; seat++) {
      for (const round of [1, 2]) {
        for (let fc = 0; fc < 4; fc++) {
          const obs = obsAt(round, fc, { myPlayerId: `p${seat}` } as Partial<PlayerObservation>);
          const a = merlinCover77Now(half, obs);
          expect(merlinCover77Now(half, obs)).toBe(a);
          n++;
          if (a) k++;
        }
      }
    }
    expect(k / n).toBeGreaterThan(0.3);
    expect(k / n).toBeLessThan(0.7);
  });

  it('team check: no barred seat; bit 4 = not with two or more reds he sees', () => {
    const obs = obsAt(1, 0);
    expect(merlinCover77TeamOk(T({ merlinCover77: 1 }), obs, ['p1', 'p2', 'p6'], [])).toBe(true);
    expect(merlinCover77TeamOk(T({ merlinCover77: 1 }), obs, ['p1', 'p2', 'p3'], [])).toBe(true);
    expect(merlinCover77TeamOk(T({ merlinCover77: 1 }), obs, ['p1', 'p2', 'p6'], ['p2'])).toBe(false);
    expect(merlinCover77TeamOk(T({ merlinCover77: 1 }), obs, ['p1', 'p5', 'p6'], ['p6'])).toBe(false);
    expect(merlinCover77TeamOk(T({ merlinCover77: 1, merlinCoverScope77: 4 }), obs, ['p1', 'p2', 'p3'], [])).toBe(false);
    expect(merlinCover77TeamOk(T({ merlinCover77: 1, merlinCoverScope77: 4 }), obs, ['p1', 'p2', 'p6'], [])).toBe(true);
  });

  it('the blues read the Merlin candidate\'s R1–R2 non-forced proposals as 1 − q strict, q as a loyal leader\'s; off = the reading is untouched', () => {
    expect(merlinCoverMix77(T())).toBeNull();
    expect(merlinCoverMix77(T({ merlinCover77: 1 }))).toEqual({ mix: 0, round: 0 });
    expect(merlinCoverMix77(T({ merlinCover77: 0.25, merlinCoverScope77: 1 }))).toEqual({ mix: 0.75, round: 1 });
    expect(merlinCoverMix77(T({ merlinCover77: 0.5, merlinCoverScope77: 2 }))).toEqual({ mix: 0.5, round: 2 });
    expect(merlinCoverMix77(T({ merlinCover77: 0.5, merlinCoverScope77: 12 }))).toEqual({ mix: 0.5, round: 0 });
    const off = bayesOptionsOf(T());
    expect(off.merlinEarlyStrict).toBe(true);
    expect(off.merlinEarlyMix).toBe(1);
    const on = bayesOptionsOf(T({ merlinCover77: 0.5, merlinCoverScope77: 2 }));
    expect(on.merlinEarlyStrict).toBe(true);
    expect(on.merlinEarlyMix).toBe(0.5);
    expect(on.merlinEarlyMixRound).toBe(2);
    expect(on.merlinEarlyGood).toBe(true);
    expect(off.merlinEarlyGood).toBeUndefined();
    // the leader-viewpoint reader (round 53; the one the current defaults read proposals with) carries the covered share and rounds
    expect(off.viewpoint53?.cover).toBeUndefined();
    expect(on.viewpoint53?.cover).toEqual({ share: 0.5, rounds: 2 });
    expect(bayesOptionsOf(T({ merlinCover77: 1 })).viewpoint53?.cover).toEqual({ share: 1, rounds: 3 });
    // every other belief option is the same as with the switch off (the level-0 reader of the recursive read carries the same three)
    const strip = (o: unknown): unknown => (o && typeof o === 'object' && !Array.isArray(o)
      ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => !k.startsWith('merlinEarly') && k !== 'cover').map(([k, v]) => [k, strip(v)]))
      : o);
    expect(strip(on)).toEqual(strip(off));
  });
});

describe('round 77: Percival reads a covered proposal of his Merlin thumb', () => {
  // 派西 3 家看得到 4 家（梅林）與 5 家（莫甘娜）。1-4 由 4 家派 4·5·9——真梅林照忠臣的流程派，帶到另一根拇指。
  const roles = ['loyal', 'loyal', 'percival', 'merlin', 'morgana', 'assassin', 'oberon', 'mordred', 'loyal', 'loyal'];
  const g = (): ReplayGame => game(roles, [[1, 2, 9], [2, 8, 10], [3, 1, 9], [4, 5, 9], [5, 1, 2]]);
  const pMerlin = (tuning: AgentTuning): number => {
    const obs = buildReplayObservation(g(), 3, { kind: 'team_vote', proposal: 4 });
    return bayesTeamClean(obs, [seatId(3), seatId(4)], bayesOptionsOf(tuning)) ?? -1;
  };

  it('off: sending the other thumb counts against him being Merlin (Merlin\'s q); on: that talk proposal reads as a loyal leader\'s', () => {
    const off = pMerlin(T());
    const on = pMerlin(T({ merlinCover77: 1 }));
    expect(off).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(off + 0.03);
    expect(on).toBeLessThan(0.6);
    // half the proposals covered: in between
    const half = pMerlin(T({ merlinCover77: 0.5 }));
    expect(half).toBeGreaterThan(off);
    expect(half).toBeLessThan(on);
    // R2-only scope: the R1 proposal still reads as before
    expect(pMerlin(T({ merlinCover77: 1, merlinCoverScope77: 2 }))).toBeCloseTo(off, 9);
    expect(pMerlin(T({ merlinCover77: 1, merlinCoverScope77: 1 }))).toBeCloseTo(on, 9);
  });
});

/**
 * 虛構的十人局（座位 1..10）：梅林在 `merlinSeat`，他看得到的紅 = 刺客、莫甘娜、奧伯倫。前面的提議都被否決（正常票：只有隊員贊成）。
 */
function game(seatRoles: string[], teams: number[][]): ReplayGame {
  const proposals: ReplayProposal[] = teams.map((t, g) => {
    const votes = Array.from({ length: 10 }, (_, k) => t.includes(k + 1));
    return { round: Math.floor(g / 5) + 1, attempt: (g % 5) + 1, globalIndex: g, leaderSeat: (g % 10) + 1, teamSeats: t, plusSeats: [], minusSeats: [], votes,
      approveCount: votes.filter(Boolean).length, forced: g % 5 === 4, wentOnMission: g % 5 === 4, votesReliable: g % 5 !== 4 };
  });
  return { id: 'r77', playerCount: 10, names: Array(10).fill(''), proposals, seatRoles, quests: [], lakes: [], lakeChainValid: true, winner: 'good' } as unknown as ReplayGame;
}

/** 梅林在第 `index` 次提議（0 起算）派的隊（座位，排序）。 */
function merlinTeamAt(tuning: AgentTuning, g: ReplayGame, index: number): number[] {
  const seat = (index % 10) + 1;
  const agent = new ForwardAgent(seatId(seat), new HeuristicAgent(seatId(seat), undefined, undefined, tuning));
  agent.onGameStart(buildReplayObservation(g, seat, { kind: 'team_select', proposal: 0 }));
  for (let i = 0; i < index; i++) {
    if (!g.proposals[i].forced) withSeededRandom(`r77|${seat}|vote-${i}`, () => agent.act(buildReplayObservation(g, seat, { kind: 'team_vote', proposal: i })));
  }
  const a = withSeededRandom(`r77|${seat}|team-${index}`, () => agent.act(buildReplayObservation(g, seat, { kind: 'team_select', proposal: index })));
  return a.type === 'team_select' ? a.teamIds.map(seatOfId).sort((x, y) => x - y) : [];
}

describe('round 77: Merlin leads a talk proposal as the loyal of his seat would', () => {
  // 1-1 … 1-3 都帶了 5 家（莫甘娜）；梅林 4 家當 1-4 的隊長。坐在 4 家、只看公開紀錄的忠臣怎麼派由公開局勢決定。
  const roles = ['loyal', 'loyal', 'percival', 'merlin', 'morgana', 'assassin', 'oberon', 'mordred', 'loyal', 'loyal'];
  const earlier = [[1, 5, 9], [2, 5, 10], [3, 5, 9]];
  const seen = [5, 6, 7];

  it('off: the current pick; on: exactly the team a loyal in his seat sends on the same record (same seat, same public history)', () => {
    const g = game(roles, [...earlier, [4, 1, 2]]);
    const off = merlinTeamAt(T(), g, 3);
    expect(off).toHaveLength(3);
    expect(off).toContain(4);
    // the loyal of the same seat: the same game with seat 4 dealt a loyal (he sees nobody), under the same switches
    const loyalRoles = roles.map((r, i) => (i === 3 ? 'loyal' : r));
    const loyalTeam = merlinTeamAt(T({ merlinCover77: 1 }), game(loyalRoles, [...earlier, [4, 1, 2]]), 3);
    const before = { ...round77Stats };
    const on = merlinTeamAt(T({ merlinCover77: 1 }), g, 3);
    expect(round77Stats.applies).toBe(before.applies + 1);
    expect(on).toHaveLength(3);
    expect(on).toContain(4);
    expect(round77Stats.sent).toBe(before.sent + 1);
    expect(on).toEqual(loyalTeam);
    expect(on).not.toEqual(off);
    // R1 only / R2 only bits: this is round 1
    expect(merlinTeamAt(T({ merlinCover77: 1, merlinCoverScope77: 2 }), g, 3)).toEqual(off);
    expect(merlinTeamAt(T({ merlinCover77: 1, merlinCoverScope77: 1 }), g, 3)).toEqual(merlinTeamAt(T({ merlinCover77: 1, merlinCoverScope77: 1 }), game(loyalRoles, [...earlier, [4, 1, 2]]), 3));
  }, 120000);

  it('the forced fifth proposal is a mission: untouched, and it holds no red he sees', () => {
    // 梅林 5 家當 1-5 的隊長（強制局）
    const roles5 = ['loyal', 'loyal', 'percival', 'morgana', 'merlin', 'assassin', 'oberon', 'mordred', 'loyal', 'loyal'];
    const g = game(roles5, [[1, 4, 9], [2, 4, 10], [3, 4, 9], [4, 9, 10], [5, 1, 2]]);
    const off = merlinTeamAt(T(), g, 4);
    const before = round77Stats.applies;
    const on = merlinTeamAt(T({ merlinCover77: 1 }), g, 4);
    expect(round77Stats.applies).toBe(before);
    expect(on).toEqual(off);
    expect(on.some((s) => [4, 6, 7].includes(s))).toBe(false);
  }, 120000);

  it('over many seatings: whenever the cover is sent it is the loyal\'s team of the same seat; reds he sees ride along as the public record has it', () => {
    let sent = 0;
    const base = ['loyal', 'loyal', 'percival', 'morgana', 'assassin', 'oberon', 'mordred', 'loyal', 'loyal'];
    const stats0 = { ...round77Stats };
    for (let k = 0; k < 9; k++) {
      // 梅林固定 4 家（1-4 的隊長）；其餘角色照座位輪轉，前三個提議跟著換
      const rest = [...base.slice(k), ...base.slice(0, k)];
      const r = [...rest.slice(0, 3), 'merlin', ...rest.slice(3)];
      const pick = (leader: number, a: number, b: number): number[] => [leader, ((leader + a - 1) % 10) + 1, ((leader + b - 1) % 10) + 1];
      const teams = [pick(1, 4 + (k % 3), 7), pick(2, 3 + (k % 3), 7), pick(3, 2 + (k % 2), 5), [4, 1, 2]];
      // the loyal of the same seat under the same switches (the blues' reading of talk proposals moves with the switch)
      const loyalTeam = merlinTeamAt(T({ merlinCover77: 1 }), game(r.map((role) => (role === 'merlin' ? 'loyal' : role)), teams), 3);
      const off = merlinTeamAt(T(), game(r, teams), 3);
      const before = round77Stats.sent;
      const on = merlinTeamAt(T({ merlinCover77: 1 }), game(r, teams), 3);
      expect(on).toContain(4);
      expect(on).toHaveLength(3);
      if (round77Stats.sent > before) { sent++; expect(on).toEqual(loyalTeam); } else expect(on).toEqual(off);
    }
    expect(round77Stats.applies - stats0.applies).toBe(9);
    expect(sent).toBeGreaterThan(0);
    expect(round77Stats.sent - stats0.sent + round77Stats.barred - stats0.barred).toBe(9);
    expect(round77Stats.thumb - stats0.thumb).toBeLessThanOrEqual(sent);
    expect(seen).toHaveLength(3);
  }, 300000);
});
