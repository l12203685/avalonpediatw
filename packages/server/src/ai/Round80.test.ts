/**
 * 第 80 回合（藍方・梅林）：`merlinLoyalFree80`／`merlinLoyalFreeScope80`（預設關）——站長 11/25「梅林學忠臣的意思是 在忠臣資訊視角內
 * 可以派出的全沒拇指組合 但如果只用忠臣資訊一定會派到拇指 那當然還是用能力避開」。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { AGENT_TUNING_KEYS, DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { loyalFree80Applies, loyalFree80Set, loyalFree80Team, round80Stats } from './Round80';
import { tuningForOpponent } from './humanProfile';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { withSeededRandom } from './benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';

const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const obsAt = (round: number, failCount: number, extra: Partial<PlayerObservation> = {}): PlayerObservation =>
  ({ myRole: 'merlin', myPlayerId: 'p1', gamePhase: 'team_select', currentRound: round, failCount, knownEvils: ['p2', 'p3', 'p4'], voteHistory: [], ...extra } as unknown as PlayerObservation);

describe('round 80 flags', () => {
  it('exist, default off on the baseline, 0.5 on the three human tables, parse', () => {
    expect(AGENT_TUNING_KEYS).toContain('merlinLoyalFree80');
    expect(AGENT_TUNING_KEYS).toContain('merlinLoyalFreeScope80');
    for (const t of [LEGACY_AGENT_TUNING, DEFAULT_AGENT_TUNING]) {
      expect(t.merlinLoyalFree80).toBe(0);
      expect(t.merlinLoyalFreeScope80).toBe(0);
    }
    // the human tables (round 80, real-game replay): 0.5, every round attempts 1–4
    for (const type of ['weakHuman', 'avgHuman', 'strongHuman'] as const) {
      const t = tuningForOpponent(type, DEFAULT_AGENT_TUNING);
      expect(t.merlinLoyalFree80).toBe(0.5);
      expect(t.merlinLoyalFreeScope80).toBe(0);
    }
    expect(parseTuningFlag('merlinLoyalFree80')).toEqual({ merlinLoyalFree80: 0.5 });
    expect(parseTuningFlag('merlinLoyalFree80=0.3')).toEqual({ merlinLoyalFree80: 0.3 });
    expect(parseTuningFlag('merlinLoyalFreeScope80=5')).toEqual({ merlinLoyalFreeScope80: 5 });
    expect(() => parseTuningFlag('merlinLoyalFree80=1.5')).toThrow();
    expect(() => parseTuningFlag('merlinLoyalFreeScope80=32')).toThrow();
    expect(describeAgentTuning(T({ merlinLoyalFree80: 0.5, merlinLoyalFreeScope80: 1 }))).toContain('merlinLoyalFree80=0.5');
    expect(describeAgentTuning(T({ merlinLoyalFree80: 0.5, merlinLoyalFreeScope80: 1 }))).toContain('merlinLoyalFreeScope80=1');
    expect(describeAgentTuning(T())).not.toContain('merlinLoyalFree80');
  });

  it('scope: Merlin only, team selection only; 0 = every round attempts 1–4; bit 1 = R1–R2 non-forced; bit 2 = the forced fifth too', () => {
    const on = T({ merlinLoyalFree80: 0.5 });
    expect(loyalFree80Applies(T(), obsAt(1, 0))).toBe(false);
    for (const round of [1, 2, 3, 4, 5]) {
      for (const fc of [0, 1, 2, 3]) expect(loyalFree80Applies(on, obsAt(round, fc))).toBe(true);
      expect(loyalFree80Applies(on, obsAt(round, 4))).toBe(false);
      expect(loyalFree80Applies(T({ merlinLoyalFree80: 0.5, merlinLoyalFreeScope80: 2 }), obsAt(round, 4))).toBe(true);
    }
    const early = T({ merlinLoyalFree80: 0.5, merlinLoyalFreeScope80: 1 });
    expect(loyalFree80Applies(early, obsAt(1, 0))).toBe(true);
    expect(loyalFree80Applies(early, obsAt(2, 3))).toBe(true);
    expect(loyalFree80Applies(early, obsAt(2, 4))).toBe(false);
    for (const round of [3, 4, 5]) expect(loyalFree80Applies(early, obsAt(round, 0))).toBe(false);
    expect(loyalFree80Applies(on, obsAt(1, 0, { myRole: 'loyal' } as Partial<PlayerObservation>))).toBe(false);
    expect(loyalFree80Applies(on, obsAt(1, 0, { myRole: 'percival' } as Partial<PlayerObservation>))).toBe(false);
    expect(loyalFree80Applies(on, obsAt(1, 0, { gamePhase: 'team_vote' } as Partial<PlayerObservation>))).toBe(false);
  });
});

/**
 * 虛構的十人局（座位 1..10）：前面的提議都被否決（正常票：只有隊員贊成）。
 */
function game(seatRoles: string[], teams: number[][]): ReplayGame {
  const proposals: ReplayProposal[] = teams.map((t, g) => {
    const votes = Array.from({ length: 10 }, (_, k) => t.includes(k + 1));
    return { round: Math.floor(g / 5) + 1, attempt: (g % 5) + 1, globalIndex: g, leaderSeat: (g % 10) + 1, teamSeats: t, plusSeats: [], minusSeats: [], votes,
      approveCount: votes.filter(Boolean).length, forced: g % 5 === 4, wentOnMission: g % 5 === 4, votesReliable: g % 5 !== 4 };
  });
  return { id: 'r80', playerCount: 10, names: Array(10).fill(''), proposals, seatRoles, quests: [], lakes: [], lakeChainValid: true, winner: 'good' } as unknown as ReplayGame;
}

/** 梅林在第 `index` 次提議（0 起算）派的隊（座位，排序）。 */
function merlinTeamAt(tuning: AgentTuning, g: ReplayGame, index: number): number[] {
  const seat = (index % 10) + 1;
  const agent = new ForwardAgent(seatId(seat), new HeuristicAgent(seatId(seat), undefined, undefined, tuning));
  agent.onGameStart(buildReplayObservation(g, seat, { kind: 'team_select', proposal: 0 }));
  for (let i = 0; i < index; i++) {
    if (!g.proposals[i].forced) withSeededRandom(`r80|${seat}|vote-${i}`, () => agent.act(buildReplayObservation(g, seat, { kind: 'team_vote', proposal: i })));
  }
  const a = withSeededRandom(`r80|${seat}|team-${index}`, () => agent.act(buildReplayObservation(g, seat, { kind: 'team_select', proposal: index })));
  return a.type === 'team_select' ? a.teamIds.map(seatOfId).sort((x, y) => x - y) : [];
}

describe('round 80: the plausible set and the pick', () => {
  const roles = ['loyal', 'loyal', 'percival', 'merlin', 'morgana', 'assassin', 'oberon', 'mordred', 'loyal', 'loyal'];
  // 1-1 … 1-3 都帶了 5 家（莫甘娜，梅林看得到）：現行預設（`merlinFlowFollow=3`）梅林 1-4 順著帶 5 家。
  const g = game(roles, [[1, 5, 9], [2, 5, 10], [3, 5, 9], [4, 1, 2]]);
  const seen = [5, 6, 7];
  const obs = (): PlayerObservation => buildReplayObservation(g, 4, { kind: 'team_select', proposal: 3 });

  it('the set holds every team with Merlin, marks the publicly plausible ones (p ≥ r × best), r = 1 keeps only the best', () => {
    const tuning = T({ merlinLoyalFree80: 0.5 });
    const set = loyalFree80Set(tuning, obs(), 3, 0.5, () => true, []);
    expect(set).not.toBeNull();
    expect(set!.teams).toHaveLength(36);
    expect(set!.teams.every((t) => t.team.includes(seatId(4)))).toBe(true);
    for (const t of set!.teams) expect(t.plausible).toBe(t.p >= 0.5 * set!.top - 1e-12);
    const tight = loyalFree80Set(tuning, obs(), 3, 1, () => true, []);
    expect(tight!.teams.filter((t) => t.plausible).every((t) => Math.abs(t.p - tight!.top) < 1e-9)).toBe(true);
    // barred seats leave the pool
    const barred = loyalFree80Set(tuning, obs(), 3, 0.5, () => true, [seatId(5)]);
    expect(barred!.teams).toHaveLength(28);
    expect(barred!.teams.some((t) => t.team.includes(seatId(5)))).toBe(false);
  });

  it('off: the flow team (carries 5); on: a red-free team out of the plausible set, the best by the current score', () => {
    const off = merlinTeamAt(T(), g, 3);
    expect(off).toContain(4);
    expect(off).toContain(5);
    const before = { ...round80Stats };
    const on = merlinTeamAt(T({ merlinLoyalFree80: 0.5 }), g, 3);
    expect(round80Stats.applies).toBe(before.applies + 1);
    expect(on).toHaveLength(3);
    expect(on).toContain(4);
    expect(on.some((s) => seen.includes(s))).toBe(false);
    expect(round80Stats.fromThumb).toBe(before.fromThumb + 1);
    // the pick is the highest-scoring clean plausible team
    const set = loyalFree80Set(T({ merlinLoyalFree80: 0.5 }), obs(), 3, 0.5, () => true, []);
    const best = set!.teams.filter((t) => t.plausible && t.thumbs === 0).sort((x, y) => y.score - x.score)[0];
    expect(on).toEqual(best.team.map(seatOfId).sort((x, y) => x - y));
    // R3+-only would not apply here: bit 1 keeps R1–R2 (applies), forced bit irrelevant
    expect(merlinTeamAt(T({ merlinLoyalFree80: 0.5, merlinLoyalFreeScope80: 1 }), g, 3)).toEqual(on);
    // bit 16: going with the flow (owner 11/10) stays as it is
    expect(merlinTeamAt(T({ merlinLoyalFree80: 0.5, merlinLoyalFreeScope80: 16 }), g, 3)).toEqual(off);
  }, 120000);

  it('a clean current pick inside the plausible set is kept (the switch changes nothing)', () => {
    const o = obs();
    const set = loyalFree80Set(T({ merlinLoyalFree80: 0.5 }), o, 3, 0.5, () => true, []);
    const cleanPlausible = set!.teams.find((t) => t.plausible && t.thumbs === 0)!;
    const before = round80Stats.kept;
    const out = loyalFree80Team(T({ merlinLoyalFree80: 0.5 }), o, cleanPlausible.team, () => true, () => true, []);
    expect(out).toBe(cleanPlausible.team);
    expect(round80Stats.kept).toBe(before + 1);
  });

  it('every plausible team holds a red he sees: his sight keeps them off (bit 4 = keep the current team instead)', () => {
    const o = obs();
    const thumbOnly = (team: readonly string[]): boolean => team.includes(seatId(5));
    const cur = [seatId(4), seatId(5), seatId(9)];
    const before = { ...round80Stats };
    const out = loyalFree80Team(T({ merlinLoyalFree80: 0.5 }), o, cur, () => true, thumbOnly, []);
    expect(out).not.toBe(cur);
    expect(out.some((id) => seen.map(seatId).includes(id))).toBe(false);
    expect(out).toContain(seatId(4));
    expect(round80Stats.fallback).toBe(before.fallback + 1);
    expect(round80Stats.fallbackClean).toBe(before.fallbackClean + 1);
    // the knowledge pick respects his own gate
    const noSix = (team: readonly string[]): boolean => !team.includes(seatId(9));
    const out2 = loyalFree80Team(T({ merlinLoyalFree80: 0.5 }), o, cur, noSix, thumbOnly, []);
    expect(out2.includes(seatId(9))).toBe(false);
    // bit 4: the current team stays
    expect(loyalFree80Team(T({ merlinLoyalFree80: 0.5, merlinLoyalFreeScope80: 4 }), o, cur, () => true, thumbOnly, [])).toBe(cur);
    // a clean current team outside the set stays too (his sight already kept the reds off)
    const clean = [seatId(4), seatId(1), seatId(2)];
    expect(loyalFree80Team(T({ merlinLoyalFree80: 0.5 }), o, clean, () => true, thumbOnly, [])).toBe(clean);
  });

  it('bit 8: among the clean plausible teams, Merlin\'s own P(clean) first', () => {
    const o = obs();
    const cur = [seatId(4), seatId(5), seatId(9)];
    const a = loyalFree80Team(T({ merlinLoyalFree80: 0.5, merlinLoyalFreeScope80: 8 }), o, cur, () => true, () => true, []);
    expect(a.some((id) => seen.map(seatId).includes(id))).toBe(false);
    expect(a).toContain(seatId(4));
  });
});
