import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { DM89_FIT, dm89Applies, dm89Cfg, dm89RedLakeEvil } from './Round89';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { tuningForOpponent } from './humanProfile';
import { Q1, Q2, q1Pass, q2Pass } from '../../scripts/acceptRound53';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.filter((id) => id !== 'P1').map((id) => [id, yes.includes(id)]));
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });

/** A loyal P1 at R2: P2 led R1 with P2 P3 P4 (rejected), P5 led with P5 P6 P7 (rejected). No mission yet. */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: ids, knownEvils: [],
    currentRound: 1, currentLeader: 'P8', failCount: 2, questResults: [], gamePhase: 'team_vote',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P4'], approved: false, votes: votes(['P2', 'P3']) },
      { round: 1, attempt: 2, leader: 'P5', team: ['P5', 'P6', 'P7'], approved: false, votes: votes(['P5', 'P6']) },
    ],
    questHistory: [], proposedTeam: ['P8', 'P9', 'P10'], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

describe('round 89 worldDM89 (roadmap Phase B: the joint (W, D, M) layer)', () => {
  it('switches exist, are off by default and in the legacy table, and parse with their ranges', () => {
    expect(DEFAULT_AGENT_TUNING.worldDM89).toBe(0);
    expect(DEFAULT_AGENT_TUNING.worldDM89Scope).toBe(0);
    expect(LEGACY_AGENT_TUNING.worldDM89).toBe(0);
    expect(LEGACY_AGENT_TUNING.worldDM89Scope).toBe(0);
    expect(parseTuningFlag('worldDM89')).toEqual({ worldDM89: 1 });
    expect(parseTuningFlag('worldDM89=1.25')).toEqual({ worldDM89: 1.25 });
    expect(parseTuningFlag('worldDM89Scope=127')).toEqual({ worldDM89Scope: 127 });
    expect(() => parseTuningFlag('worldDM89=2')).toThrow();
    expect(() => parseTuningFlag('worldDM89Scope=128')).toThrow();
    // Human tables do not set it either.
    for (const type of ['weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(type, DEFAULT_AGENT_TUNING).worldDM89).toBe(0);
  });

  it('off = the belief options carry nothing and every posterior is the same numbers', () => {
    expect(dm89Cfg(T())).toBeNull();
    expect(bayesOptionsOf(T()).worldDM89).toBeUndefined();
    expect(bayesOptionsOf(T({ worldDM89Scope: 127 })).worldDM89).toBeUndefined();
    const a = bayesRedShare(obs(), bayesOptionsOf(T()));
    const b = bayesRedShare(obs(), bayesOptionsOf(T({ worldDM89: 0, worldDM89Scope: 9 })));
    for (const id of ids) expect(b.get(id)).toBe(a.get(id));
  });

  it('the fitted mixing weights are (Merlin − generic blue) / (1 − generic blue) from the time-split fit', () => {
    // 86.6% vs 39.5% (R1–R2 non-forced), 88.0% vs 53.6% (R3+), 92.1% vs 48.0% (forced): scripts/worldDM89Rates.ts.
    expect(DM89_FIT.a12).toBeCloseTo((0.866 - 0.395) / (1 - 0.395), 2);
    expect(DM89_FIT.a3).toBeCloseTo((0.88 - 0.536) / (1 - 0.536), 2);
    expect(DM89_FIT.aForced).toBeCloseTo((0.921 - 0.48) / (1 - 0.48), 2);
    expect(dm89RedLakeEvil(true, false)).toBe(0.236);
    expect(dm89RedLakeEvil(false, true)).toBe(0.231);
  });

  it('applies to blue seats only: the loyal seat, Percival with bit 1, public loyal views with bit 64; red seats never', () => {
    const on = dm89Cfg(T({ worldDM89: 1 }));
    const perc = dm89Cfg(T({ worldDM89: 1, worldDM89Scope: 1 }));
    const pub = dm89Cfg(T({ worldDM89: 1, worldDM89Scope: 64 }));
    expect(dm89Applies(on, obs())).toBe('loyal');
    expect(dm89Applies(on, obs({ seatTeam: 'evil' }))).toBeNull();
    expect(dm89Applies(on, obs({ redLoyalView: true }))).toBeNull();
    expect(dm89Applies(on, obs({ publicLoyalView: true }))).toBeNull();
    expect(dm89Applies(pub, obs({ publicLoyalView: true }))).toBe('loyal');
    const p = obs({ myRole: 'percival', knownWizards: ['P2', 'P5'] });
    expect(dm89Applies(on, p)).toBeNull();
    expect(dm89Applies(perc, p)).toBe('percival');
  });

  it('every world is re-weighed: a possible Merlin\'s team reads its members a bit bluer; the soft layer moves less than the strict mixture', () => {
    // P2's team P2 P3 P4: in worlds where P2 is Merlin, P3 / P4 can only be Mordred or blue, so P3 red loses a little weight. Every world is
    // scored by the same mixture over (D, M) — no one-sided discount (round 63 G2) — and the shares still sum to the four reds.
    const off = bayesRedShare(obs(), bayesOptionsOf(T({ loyalMerlinRead: 0 })));
    const soft = bayesRedShare(obs(), bayesOptionsOf(T({ loyalMerlinRead: 0, worldDM89: 1 })));
    const strict = bayesRedShare(obs(), bayesOptionsOf(T()));
    expect(soft.get('P3')!).toBeLessThan(off.get('P3')!);
    expect(strict.get('P3')!).toBeLessThan(soft.get('P3')!);
    const total = (m: Map<string, number>): number => ids.filter((id) => id !== 'P1').reduce((s, id) => s + m.get(id)!, 0);
    expect(total(soft)).toBeCloseTo(4, 6);
    expect(total(off)).toBeCloseTo(4, 6);
  });

  it('acceptance Q1 / Q2 (round 53): recorded — Q1 still fails; Percival with the layer moves the thumbs toward 1 = Merlin, untempered it flips 8 above 1', () => {
    const base = bayesOptionsOf(T());
    expect(q1Pass(bayesRedShare(Q1(), bayesOptionsOf(T({ worldDM89: 1, worldDM89Scope: 1 }))))).toBe(false);
    const m0 = bayesRedShare(Q2(), base);
    const m1 = bayesRedShare(Q2(), bayesOptionsOf(T({ worldDM89: 1, worldDM89Scope: 1 })));
    const mu = bayesRedShare(Q2(), bayesOptionsOf(T({ worldDM89: 1, worldDM89Scope: 17 })));
    const gap = (m: Map<string, number>): number => m.get('P8')! - m.get('P1')!;
    expect(gap(m1)).toBeGreaterThan(gap(m0));
    expect(gap(mu)).toBeGreaterThan(0);
    expect(q2Pass(mu)).toBe(false);
  });
});
