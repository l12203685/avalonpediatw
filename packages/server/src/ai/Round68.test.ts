import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning, type AgentTuning } from './AgentTuning';
import { MISSION_SCORE_68, lakeChain68Pick, lakeTrustRegime68, missionProbScore68, missionScoreApplies68, taintedSeats68 } from './Round68';
import { OPPONENT_TYPES, PROFILE_OVERRIDES, tuningForOpponent } from './humanProfile';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const T = (over: Partial<AgentTuning> = {}): AgentTuning => resolveAgentTuning(over);

/** 第 2 局後的第一湖（1-1）：第 1 局 P1 P2 P3 成功、第 2 局 P6 P7 P8 P9 一張失敗；持湖者 P10。 */
function lakeObs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 2, currentLeader: 'P3', gamePhase: 'lady_of_the_lake', failCount: 0, questResults: ['success', 'fail'],
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 },
      { round: 2, team: ['P6', 'P7', 'P8', 'P9'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [], lakeHistory: [], myLakeResults: [], proposedTeam: [],
    ...over,
  } as unknown as PlayerObservation;
}

// P7 (tainted) has the best information, P4 (untainted, likely blue) is next.
const an = (_o: PlayerObservation, c: readonly string[]) => ({
  candidates: c.map((id) => ({ id, infoGain: id === 'P7' ? 1.0 : id === 'P4' ? 0.8 : 0.5, score: id === 'P7' ? 1.0 : id === 'P4' ? 0.8 : 0.5, pEvil: id === 'P7' ? 0.5 : id === 'P4' ? 0.2 : 0.4 })),
});

describe('round 68 switches', () => {
  it('off in the default and the legacy tables; lakeChain68 = 0.25 on the human tables; flags parse', () => {
    for (const k of ['lakeChain68', 'lakeChain68Good', 'lakeChain68Scope', 'lakeChain68Roles', 'lakeChain68Mix', 'missionScore68'] as const) {
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      for (const o of OPPONENT_TYPES) if (k !== 'lakeChain68') expect(PROFILE_OVERRIDES[o][k]).toBeUndefined();
    }
    // Round 68: the three human tables carry lakeChain68 = 0.25 (default scope / roles); the bot-only baseline stays off.
    expect(PROFILE_OVERRIDES.ai.lakeChain68).toBeUndefined();
    for (const o of ['weakHuman', 'avgHuman', 'strongHuman'] as const) {
      expect(PROFILE_OVERRIDES[o].lakeChain68).toBe(0.25);
      expect(tuningForOpponent(o).lakeChain68).toBe(0.25);
    }
    expect(parseTuningFlag('lakeChain68')).toEqual({ lakeChain68: 0.5 });
    expect(parseTuningFlag('lakeChain68Good=1')).toEqual({ lakeChain68Good: 1 });
    expect(parseTuningFlag('lakeChain68Scope=3')).toEqual({ lakeChain68Scope: 3 });
    expect(parseTuningFlag('lakeChain68Roles')).toEqual({ lakeChain68Roles: 3 });
    expect(parseTuningFlag('missionScore68')).toEqual({ missionScore68: 1 });
    expect(parseTuningFlag('lakeChain68Mix')).toEqual({ lakeChain68Mix: 0.5 });
    expect(() => parseTuningFlag('lakeChain68Mix=2')).toThrow();
    expect(() => parseTuningFlag('lakeChain68=-1')).toThrow();
    expect(() => parseTuningFlag('lakeChain68Scope=4')).toThrow();
    expect(() => parseTuningFlag('lakeChain68Roles=8')).toThrow();
    expect(() => parseTuningFlag('missionScore68=4')).toThrow();
  });
});

describe('lakeChain68Pick', () => {
  it('off: null; on: a tainted best candidate is docked w × best info', () => {
    expect(taintedSeats68(lakeObs())).toEqual(new Set(['P6', 'P7', 'P8', 'P9']));
    expect(lakeChain68Pick(T(), lakeObs(), ['P7', 'P4', 'P5'], an)).toBeNull();
    expect(lakeChain68Pick(T({ lakeChain68: 0.1 }), lakeObs(), ['P7', 'P4', 'P5'], an)).toBe('P7'); // 1.0 − 0.1 > 0.8
    expect(lakeChain68Pick(T({ lakeChain68: 0.5 }), lakeObs(), ['P7', 'P4', 'P5'], an)).toBe('P4'); // 1.0 − 0.5 < 0.8
  });

  it('the extra trust weight favours the likely-blue candidate', () => {
    // P7: 1.0 + g·0·1 = 1.0; P4: 0.8 + g·0.6·1 → P4 once g > 1/3.
    expect(lakeChain68Pick(T({ lakeChain68Good: 0.2 }), lakeObs(), ['P7', 'P4'], an)).toBe('P7');
    expect(lakeChain68Pick(T({ lakeChain68Good: 0.5 }), lakeObs(), ['P7', 'P4'], an)).toBe('P4');
  });

  it('scope: only the trust-chain state unless bit 2 (red has two wins / the last lake: owner ruling, measured only)', () => {
    const on = T({ lakeChain68: 0.5 });
    expect(lakeTrustRegime68(lakeObs())).toBe(true);
    const redTwo = lakeObs({ currentRound: 3, questResults: ['fail', 'fail', 'success'] } as Partial<PlayerObservation>);
    const last = lakeObs({ currentRound: 4, questResults: ['success', 'fail', 'success', 'fail'] } as Partial<PlayerObservation>);
    expect(lakeTrustRegime68(redTwo)).toBe(false);
    expect(lakeTrustRegime68(last)).toBe(false);
    expect(lakeChain68Pick(on, redTwo, ['P7', 'P4'], an)).toBeNull();
    expect(lakeChain68Pick(on, last, ['P7', 'P4'], an)).toBeNull();
    expect(lakeChain68Pick(T({ lakeChain68: 0.5, lakeChain68Scope: 2 }), redTwo, ['P7', 'P4'], an)).toBe('P4');
    expect(lakeChain68Pick(T({ lakeChain68: 0.5, lakeChain68Scope: 2 }), lakeObs(), ['P7', 'P4'], an)).toBeNull();
    expect(lakeChain68Pick(T({ lakeChain68: 0.5, lakeChain68Scope: 3 }), last, ['P7', 'P4'], an)).toBe('P4');
  });

  it('roles: loyal and Percival by default, Merlin with bit 4, never a red holder', () => {
    const on = T({ lakeChain68: 0.5 });
    expect(lakeChain68Pick(on, lakeObs({ myRole: 'percival' }), ['P7', 'P4'], an)).toBe('P4');
    expect(lakeChain68Pick(on, lakeObs({ myRole: 'merlin' }), ['P7', 'P4'], an)).toBeNull();
    expect(lakeChain68Pick(T({ lakeChain68: 0.5, lakeChain68Roles: 4 }), lakeObs({ myRole: 'merlin' }), ['P7', 'P4'], an)).toBe('P4');
    expect(lakeChain68Pick(T({ lakeChain68: 0.5, lakeChain68Roles: 7 }), lakeObs({ myRole: 'assassin', myTeam: 'evil' } as Partial<PlayerObservation>), ['P7', 'P4'], an)).toBeNull();
    expect(lakeChain68Pick(on, lakeObs(), [], an)).toBeNull();
  });

  it('50% mix: a position hash decides, the same position always the same way', () => {
    const seen = new Set<string | null>();
    let used = 0;
    for (let i = 1; i <= 10; i++) {
      const o = lakeObs({ myPlayerId: `P${i}` });
      const pick = lakeChain68Pick(T({ lakeChain68: 0.5, lakeChain68Mix: 0.5 }), o, ['P7', 'P4'].filter((x) => x !== `P${i}`).concat(i === 4 || i === 7 ? ['P5'] : []), an);
      expect(lakeChain68Pick(T({ lakeChain68: 0.5, lakeChain68Mix: 0.5 }), o, ['P7', 'P4'].filter((x) => x !== `P${i}`).concat(i === 4 || i === 7 ? ['P5'] : []), an)).toBe(pick);
      seen.add(pick === null ? null : 'x');
      if (pick !== null) used++;
    }
    expect(seen.size).toBe(2);
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(10);
  });
});

describe('missionScore68', () => {
  const base = (k: number) => (f: number): number => (f <= k ? 1 / (k + 1) : 0);

  it('the human table: a lone red on R4 hides at 2-1, fails at 1-2', () => {
    const [hide, fail] = MISSION_SCORE_68['4|1|1'];
    expect(hide / (hide + fail)).toBeGreaterThan(0.85);
    const [hide0, fail0] = MISSION_SCORE_68['4|0|1'];
    expect(hide0 / (hide0 + fail0)).toBeLessThan(0.25);
  });

  it('a normalised likelihood over 0..reds, moved toward the score cell; no cell → the base', () => {
    for (const at of [true, false]) {
      let s = 0;
      for (let f = 0; f <= 2; f++) s += missionProbScore68(4, at, 2, f, base(2));
      expect(s).toBeCloseTo(1, 9);
    }
    expect(missionProbScore68(4, true, 1, 0, base(1))).toBeGreaterThan(0.5);
    expect(missionProbScore68(4, false, 1, 0, base(1))).toBeLessThan(0.5);
    expect(missionProbScore68(4, true, 1, 2, base(1))).toBe(0);
    expect(missionProbScore68(2, true, 1, 0, base(1))).toBe(0.5);
    expect(missionProbScore68(4, true, 0, 0, () => 1)).toBe(1);
    expect(missionScoreApplies68(1, 4)).toBe(true);
    expect(missionScoreApplies68(1, 3)).toBe(false);
    expect(missionScoreApplies68(2, 3)).toBe(true);
    expect(missionScoreApplies68(3, 5)).toBe(false);
  });

  /** 第 5 局（2-2）：第 1、2 局失敗、第 3 局成功（2-1），第 4 局 P1–P5 零張失敗成功。藍方忠臣 P10 看 P1–P5 這隊。 */
  function r5(over: Partial<PlayerObservation> = {}): PlayerObservation {
    const q = (round: number, team: string[], fails: number) => ({ round, team, result: fails >= (round === 4 ? 2 : 1) ? 'fail' : 'success', failCount: fails });
    return {
      myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
      currentRound: 5, currentLeader: 'P10', gamePhase: 'team_select', failCount: 0, questResults: ['fail', 'fail', 'success', 'success'],
      questHistory: [q(1, ['P6', 'P7', 'P8'], 1), q(2, ['P6', 'P8', 'P9', 'P10'], 1), q(3, ['P1', 'P2', 'P4', 'P10'], 0), q(4, ['P1', 'P2', 'P3', 'P4', 'P5'], 0)],
      voteHistory: [], lakeHistory: [], myLakeResults: [], proposedTeam: [],
      ...over,
    } as unknown as PlayerObservation;
  }

  it('a zero-fail R4 team at 2-1 reads less clean for a blue seat; red seats unchanged', () => {
    const team = ['P1', 'P2', 'P3', 'P4', 'P5'];
    const off = bayesTeamClean(r5(), team, bayesOptionsOf(T()));
    const on = bayesTeamClean(r5(), team, bayesOptionsOf(T({ missionScore68: 1 })));
    const r3only = bayesTeamClean(r5(), team, bayesOptionsOf(T({ missionScore68: 2 })));
    expect(off).not.toBeNull();
    expect(on as number).toBeLessThan(off as number);
    // R3 at 2-0 with zero fails: the A1 convention (red certainly fails after two fails) already makes P1 P2 P4 certain blues, so bit 2 changes nothing here.
    expect(r3only as number).toBeCloseTo(off as number, 12);
    // A red seat is not affected (blue seats only).
    const red = r5({ myPlayerId: 'P6', myRole: 'morgana', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P7', 'P8'] } as Partial<PlayerObservation>);
    expect(bayesTeamClean(red, team, bayesOptionsOf(T({ missionScore68: 1 })))).toBe(bayesTeamClean(red, team, bayesOptionsOf(T())));
  });
});
