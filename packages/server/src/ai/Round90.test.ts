import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { assassinModel90, beliefModel90, ml90Applies, ml90Cfg, mlAssassinMode90, mlAssassinNoTier90, mlAssassinScores90, tiltWorlds90 } from './Round90';
import { bayesOptionsOf, bayesRedShare, bayesWorlds } from './belief/BayesBelief';
import { tuningForOpponent } from './humanProfile';
import { MlModel90, type ModelJson } from './ml/mlModel90';
import { BELIEF_FEATURES_90, beliefFeatures90 } from './ml/beliefFeatures90';
import { ASSASSIN_FEATURES_90 } from './ml/assassinFeatures90';
import { HeuristicAgent } from './HeuristicAgent';
import PARITY from './ml/parity90.fixture.json';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });

/** A loyal P1 at the R3 first vote: R1 P2 P3 P4 succeeded, R2 P5 P6 P7 P8 failed with one card; one lake (P10 said P6 is good). */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: ids, knownEvils: [],
    currentRound: 3, currentLeader: 'P9', failCount: 0, questResults: ['success', 'fail'], gamePhase: 'team_vote',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P4'], approved: true, votes: votes(['P1', 'P2', 'P3', 'P4', 'P6', 'P9']) },
      { round: 2, attempt: 1, leader: 'P5', team: ['P5', 'P6', 'P7', 'P8'], approved: true, votes: votes(['P5', 'P6', 'P7', 'P8', 'P10', 'P3']) },
    ],
    questHistory: [
      { round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 },
      { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'fail', failCount: 1 },
    ],
    proposedTeam: ['P9', 'P1', 'P2', 'P3'], myLakeResults: [],
    lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P6', declaredClaim: 'good' }],
    ...over,
  } as PlayerObservation;
}

describe('round 90 (roadmap Phase C): trained world-posterior and assassination models', () => {
  it('switches exist, are off by default and in the legacy table, parse with their ranges, and no human table sets them', () => {
    for (const k of ['mlBelief90', 'mlBelief90Scope', 'mlAssassin90'] as const) {
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      for (const type of ['weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(type, DEFAULT_AGENT_TUNING)[k]).toBe(0);
    }
    expect(parseTuningFlag('mlBelief90')).toEqual({ mlBelief90: 1 });
    expect(parseTuningFlag('mlBelief90=2')).toEqual({ mlBelief90: 2 });
    expect(parseTuningFlag('mlBelief90Scope=15')).toEqual({ mlBelief90Scope: 15 });
    expect(parseTuningFlag('mlAssassin90=4')).toEqual({ mlAssassin90: 4 });
    expect(() => parseTuningFlag('mlBelief90=3')).toThrow();
    expect(() => parseTuningFlag('mlBelief90Scope=16')).toThrow();
    expect(() => parseTuningFlag('mlAssassin90=5')).toThrow();
  });

  it('the JSON weights load against the code feature lists, and the TypeScript scores equal the numpy trainer to 1e-9', () => {
    expect(beliefModel90(1).json.features).toEqual([...BELIEF_FEATURES_90]);
    expect(beliefModel90(2).json.features).toEqual([...BELIEF_FEATURES_90]);
    expect(assassinModel90().json.features).toEqual([...ASSASSIN_FEATURES_90]);
    expect(assassinModel90(true).json.features).toEqual([...ASSASSIN_FEATURES_90]);
    // Stack model starts at the current belief's logit (offset feature 0); the pure model has none.
    expect(beliefModel90(1).json.offset).toBe(0);
    expect(beliefModel90(2).json.offset).toBe(-1);
    for (const r of PARITY.belief90) expect(beliefModel90(1).score(r.x)).toBeCloseTo(r.z, 9);
    for (const r of PARITY.belief90Pure) expect(beliefModel90(2).score(r.x)).toBeCloseTo(r.z, 9);
    for (const s of PARITY.assassin90) s.x.forEach((x, i) => expect(assassinModel90().score(x)).toBeCloseTo(s.z[i], 9));
    expect(() => new MlModel90({ ...(beliefModel90(1).json as ModelJson), features: ['x'] }, BELIEF_FEATURES_90)).toThrow();
  });

  it('off = the belief options carry nothing and every posterior is the same numbers', () => {
    expect(ml90Cfg(T())).toBeUndefined();
    expect(bayesOptionsOf(T()).ml90).toBeUndefined();
    expect(bayesOptionsOf(T({ mlBelief90Scope: 15 })).ml90).toBeUndefined();
    const a = bayesRedShare(obs(), bayesOptionsOf(T()));
    const b = bayesRedShare(obs(), bayesOptionsOf(T({ mlBelief90: 0, mlBelief90Scope: 9 })));
    for (const id of ids) expect(b.get(id)).toBe(a.get(id));
    expect(mlAssassinMode90(T())).toBe(0);
    const s = new Map([['P1', 1], ['P2', 2]]);
    expect(mlAssassinScores90(T(), obs(), s, new Set())).toBe(s);
  });

  it('applies to blue seats only: loyal; Percival with bit 1; public loyal views with bit 4; not at picks with bit 2; red seats never', () => {
    const c = ml90Cfg(T({ mlBelief90: 1 }));
    expect(ml90Applies(c, obs())).toBe(true);
    expect(ml90Applies(c, obs({ myRole: 'percival', knownWizards: ['P4', 'P7'] }))).toBe(false);
    expect(ml90Applies(ml90Cfg(T({ mlBelief90: 1, mlBelief90Scope: 1 })), obs({ myRole: 'percival', knownWizards: ['P4', 'P7'] }))).toBe(true);
    expect(ml90Applies(c, obs({ myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil' }))).toBe(false);
    expect(ml90Applies(c, obs({ seatTeam: 'evil' }))).toBe(false);
    expect(ml90Applies(c, obs({ redLoyalView: true }))).toBe(false);
    expect(ml90Applies(c, obs({ publicLoyalView: true }))).toBe(false);
    expect(ml90Applies(ml90Cfg(T({ mlBelief90: 1, mlBelief90Scope: 4 })), obs({ publicLoyalView: true }))).toBe(true);
    expect(ml90Applies(ml90Cfg(T({ mlBelief90: 1, mlBelief90Scope: 2 })), obs({ gamePhase: 'team_select' }))).toBe(false);
  });

  it('the world tilt hits consistent targets, keeps certain seats and sums to 1', () => {
    // 4 seats (bits 1, 2, 4, 8), worlds = every pair; seat bit 8 is certain good (no world holds it).
    const worlds = [3, 5, 6];
    const w0 = [1 / 3, 1 / 3, 1 / 3];
    const w = tiltWorlds90(worlds, w0, [[1, 0.9], [2, 0.6], [4, 0.5], [8, 0.7]]);
    const m = (b: number): number => worlds.reduce((s, x, k) => s + ((x & b) ? w[k] : 0), 0);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(m(8)).toBe(0);
    // Targets shifted to sum to 2 reds, then matched.
    expect(m(1) + m(2) + m(4)).toBeCloseTo(2, 9);
    expect(m(1)).toBeGreaterThan(m(2));
    expect(m(2)).toBeGreaterThan(m(4));
  });

  it('on: the loyal posterior moves toward the model, stays a probability, keeps the rule-certain seats, and the worlds still sum to 1', () => {
    const o = obs();
    const base = bayesRedShare(o, bayesOptionsOf(T()));
    const on = bayesRedShare(o, bayesOptionsOf(T({ mlBelief90: 1 })));
    let moved = 0;
    for (const id of ids) {
      const a = base.get(id) as number;
      const b = on.get(id) as number;
      if (a <= 1e-9 || a >= 1 - 1e-9) expect(b).toBeCloseTo(a, 9);
      else { expect(b).toBeGreaterThan(0); expect(b).toBeLessThan(1); }
      if (Math.abs(a - b) > 1e-6) moved++;
    }
    expect(moved).toBeGreaterThan(0);
    expect(on.get('P1')).toBe(0);
    const reds = ids.reduce((s, id) => s + (on.get(id) as number), 0);
    expect(reds).toBeCloseTo(4, 6);
    const wts = bayesWorlds(o, bayesOptionsOf(T({ mlBelief90: 1 }))).wts;
    expect(wts.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // The features are one row per other seat, in seat order.
    const fx = beliefFeatures90(o, base, base);
    expect(fx.ids).toEqual(ids.slice(1));
    expect(fx.rows[0].length).toBe(BELIEF_FEATURES_90.length);
    // Red seats never read with the model (red frozen).
    const red = obs({ myRole: 'morgana', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P1', 'P5', 'P9'] });
    const r0 = bayesRedShare(red, bayesOptionsOf(T()));
    const r1 = bayesRedShare(red, bayesOptionsOf(T({ mlBelief90: 1, mlBelief90Scope: 15 })));
    for (const id of ids) expect(r1.get(id)).toBe(r0.get(id));
  });

  it('assassin: off picks as before; on (no tiers) picks the model\'s top seat among every blue candidate', () => {
    const roles: Record<string, 'assassin' | 'morgana' | 'mordred' | 'oberon'> = { P5: 'assassin', P6: 'morgana', P9: 'mordred', P3: 'oberon' };
    const a = obs({
      myPlayerId: 'P5', myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P6', 'P9'], gamePhase: 'assassination',
      allEvilIds: Object.keys(roles), allEvilRoles: roles, questResults: ['success', 'fail', 'success', 'success'],
      questHistory: [
        { round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 },
        { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'fail', failCount: 1 },
        { round: 3, team: ['P9', 'P1', 'P2', 'P10'], result: 'success', failCount: 0 },
        { round: 4, team: ['P10', 'P1', 'P2', 'P4', 'P7'], result: 'success', failCount: 0 },
      ],
      voteHistory: [
        ...obs().voteHistory,
        { round: 3, attempt: 1, leader: 'P9', team: ['P9', 'P1', 'P2', 'P10'], approved: true, votes: votes(['P9', 'P1', 'P2', 'P10', 'P5', 'P6', 'P3']) },
        { round: 4, attempt: 1, leader: 'P10', team: ['P10', 'P1', 'P2', 'P4', 'P7'], approved: true, votes: votes(['P10', 'P1', 'P2', 'P4', 'P7', 'P8']) },
      ],
    } as Partial<PlayerObservation>);
    const off = new HeuristicAgent('P5', undefined, undefined, T()).act(a);
    const off2 = new HeuristicAgent('P5', undefined, undefined, T({ mlAssassin90: 0 })).act(a);
    expect(off2).toEqual(off);
    expect(mlAssassinNoTier90(T({ mlAssassin90: 2 }))).toBe(true);
    expect(mlAssassinNoTier90(T({ mlAssassin90: 1 }))).toBe(false);
    const front = new HeuristicAgent('P5', undefined, undefined, T()).assassinationReadout(a)?.front ?? [];
    expect(front.length).toBeGreaterThan(0);
    const scores = mlAssassinScores90(T({ mlAssassin90: 2 }), a, new Map(['P1', 'P2', 'P4', 'P7', 'P8', 'P10'].map((id) => [id, 0])), new Set(front));
    const top = [...scores].sort((x, y) => y[1] - x[1])[0][0];
    const on = new HeuristicAgent('P5', undefined, undefined, T({ mlAssassin90: 2 })).act(a);
    expect(on.type).toBe('assassinate');
    if (on.type === 'assassinate') expect(on.targetId).toBe(top);
    // Log-probabilities over the six candidates sum (exp) to 1.
    expect([...scores.values()].reduce((s, v) => s + Math.exp(v), 0)).toBeCloseTo(1, 9);
  });
});
