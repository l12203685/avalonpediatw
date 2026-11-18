/**
 * 第 49 回合（藍方）：第 1 局成功隊的沿用比例、`goodCleanLead` 第 4 局兩張失敗的修正的修正、第 2 局的尾家外白門檻（`BlueRound49.ts`，預設關）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { AgentAction, PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean, bayesTeamRedsBelow } from './belief/BayesBelief';
import { goodCleanLeadTeam } from './GoodRound5';
import { earlyWhiteTuning49, r1ReuseThinTeam49, r1SuccessTeam } from './BlueRound49';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });

function r2(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P6', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 2, currentLeader: 'P6', gamePhase: 'team_select', failCount: 0, questResults: ['success'],
    questHistory: [{ round: 1, team: ['P5', 'P6', 'P7'], result: 'success', failCount: 0 }],
    voteHistory: [{ round: 1, attempt: 5, leader: 'P5', team: ['P5', 'P6', 'P7'], approved: true, votes: {} }],
    lakeHistory: [], myLakeResults: [], proposedTeam: [],
    ...over,
  } as unknown as PlayerObservation;
}
const share = new Map([['P5', 0.3], ['P7', 0.4], ['P1', 0.2], ['P2', 0.5], ['P3', 0.35], ['P4', 0.45], ['P8', 0.5], ['P9', 0.5], ['P10', 0.5]]);
const outs = (): string[] => ['P1', 'P3', 'P4', 'P2', 'P8', 'P9', 'P10'];

describe('flags', () => {
  it('exist, off by default, parse', () => {
    for (const k of ['r1ReuseRate49', 'goodCleanLeadR4Fix49', 'earlyWhite49'] as const) { expect(LEGACY_AGENT_TUNING[k]).toBe(0); expect(DEFAULT_AGENT_TUNING[k]).toBe(0); }
    expect(parseTuningFlag('r1ReuseRate49')).toEqual({ r1ReuseRate49: 0.79 });
    expect(parseTuningFlag('goodCleanLeadR4Fix49')).toEqual({ goodCleanLeadR4Fix49: 0.02 });
    expect(parseTuningFlag('earlyWhite49=0.4')).toEqual({ earlyWhite49: 0.4 });
    expect(() => parseTuningFlag('r1ReuseRate49=1')).toThrow();
  });
});

describe('r1ReuseRate49', () => {
  it('the R1 success team', () => {
    expect(r1SuccessTeam(r2())).toEqual(['P5', 'P6', 'P7']);
    expect(r1SuccessTeam(r2({ questHistory: [{ round: 1, team: ['P5', 'P6', 'P7'], result: 'fail', failCount: 1 }] } as Partial<PlayerObservation>))).toBeNull();
  });
  it('rate ~0 keeps nothing of the whole R1 team: the reddest R1 member (not self) goes for the cleanest outsider', () => {
    const t = r1ReuseThinTeam49(T({ r1ReuseRate49: 0.0001 }), r2(), ['P6', 'P5', 'P7', 'P1'], share, outs, () => true);
    expect(t).toEqual(['P6', 'P5', 'P3', 'P1']);
  });
  it('off, a non-R2 round, a team without the whole R1 team, a red seat or its loyal view: unchanged', () => {
    const on = T({ r1ReuseRate49: 0.0001 });
    expect(r1ReuseThinTeam49(T(), r2(), ['P6', 'P5', 'P7', 'P1'], share, outs, () => true)).toBeNull();
    expect(r1ReuseThinTeam49(on, r2({ currentRound: 3 }), ['P6', 'P5', 'P7', 'P1'], share, outs, () => true)).toBeNull();
    expect(r1ReuseThinTeam49(on, r2(), ['P6', 'P5', 'P1', 'P2'], share, outs, () => true)).toBeNull();
    expect(r1ReuseThinTeam49(on, r2({ publicLoyalView: true } as Partial<PlayerObservation>), ['P6', 'P5', 'P7', 'P1'], share, outs, () => true)).toBeNull();
    expect(r1ReuseThinTeam49(on, r2({ myRole: 'merlin' }), ['P6', 'P5', 'P7', 'P1'], share, outs, () => true)).toBeNull();
  });
  it('the leader\'s own gate binds the swapped team', () => {
    const t = r1ReuseThinTeam49(T({ r1ReuseRate49: 0.0001 }), r2(), ['P6', 'P5', 'P7', 'P1'], share, outs, (team) => !team.includes('P3'));
    expect(t).toEqual(['P6', 'P5', 'P4', 'P1']);
  });
});

describe('earlyWhite49', () => {
  it('R2 only: the tail-white threshold becomes τ', () => {
    expect(earlyWhiteTuning49(T({ earlyWhite49: 0.4 }), r2()).loyalTailWhite).toBe(0.4);
    expect(earlyWhiteTuning49(T({ earlyWhite49: 0.4 }), r2({ currentRound: 3 })).loyalTailWhite).toBe(DEFAULT_AGENT_TUNING.loyalTailWhite);
    expect(earlyWhiteTuning49(T(), r2()).loyalTailWhite).toBe(DEFAULT_AGENT_TUNING.loyalTailWhite);
  });
  it('mix (§1C 50%): about half of the R2 states keep the default threshold, the same state always the same way', () => {
    const t = T({ earlyWhite49: 0.4, earlyWhite49Mix: 1 });
    let on = 0;
    for (let i = 0; i < 200; i++) {
      const o = r2({ myPlayerId: `P${(i % 10) + 1}`, failCount: i % 4, proposedTeam: [`P${(i % 9) + 1}`, `P${((i + 3) % 9) + 1}`, 'P10', `X${i}`] } as Partial<PlayerObservation>);
      const a = earlyWhiteTuning49(t, o).loyalTailWhite;
      expect(earlyWhiteTuning49(t, o).loyalTailWhite).toBe(a);
      if (a === 0.4) on++;
    }
    expect(on).toBeGreaterThan(70);
    expect(on).toBeLessThan(130);
    expect(parseTuningFlag('earlyWhite49Mix')).toEqual({ earlyWhite49Mix: 1 });
  });
});

describe('goodCleanLeadR4Fix49', () => {
  it('R4: the cleanest team among those whose P(fewer than two reds) is within ε of the best', () => {
    const o = r2({
      currentRound: 4, myPlayerId: 'P3', questResults: ['success', 'fail', 'success'],
      questHistory: [
        { round: 1, team: ['P5', 'P6', 'P7'], result: 'success', failCount: 0 },
        { round: 2, team: ['P10', 'P8', 'P9', 'P2'], result: 'fail', failCount: 1 },
        { round: 3, team: ['P3', 'P1', 'P4', 'P6'], result: 'success', failCount: 0 },
      ],
      voteHistory: [
        { round: 1, attempt: 5, leader: 'P5', team: ['P5', 'P6', 'P7'], approved: true, votes: {} },
        { round: 2, attempt: 5, leader: 'P10', team: ['P10', 'P8', 'P9', 'P2'], approved: true, votes: {} },
        { round: 3, attempt: 5, leader: 'P5', team: ['P3', 'P1', 'P4', 'P6'], approved: true, votes: {} },
      ],
    } as Partial<PlayerObservation>);
    const opts = bayesOptionsOf(T());
    const start: AgentAction = { type: 'team_select', teamIds: ['P3', 'P1', 'P4', 'P6', 'P7'] };
    const off = goodCleanLeadTeam(T(), o, start);
    const on = goodCleanLeadTeam(T({ goodCleanLeadR4Fix49: 0.02 }), o, start);
    const r47 = goodCleanLeadTeam(T({ goodCleanLeadR4Fix47: 1 }), o, start);
    if (off.type !== 'team_select' || on.type !== 'team_select' || r47.type !== 'team_select') throw new Error('team');
    const below = (t: string[]): number => bayesTeamRedsBelow(o, t, 2, opts)!;
    expect(below(on.teamIds)).toBeGreaterThanOrEqual(below(r47.teamIds) - 0.02 - 1e-9);
    expect(bayesTeamClean(o, on.teamIds, opts)!).toBeGreaterThanOrEqual(bayesTeamClean(o, r47.teamIds, opts)! - 1e-9);
    // R3 (one fail needed): no change
    const r3 = r2({ currentRound: 3 });
    const a: AgentAction = { type: 'team_select', teamIds: ['P6', 'P1', 'P3', 'P4'] };
    expect(goodCleanLeadTeam(T({ goodCleanLeadR4Fix49: 0.02 }), r3, a)).toEqual(goodCleanLeadTeam(T(), r3, a));
  });
});
