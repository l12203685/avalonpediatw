/**
 * 優化迴圈第 50 回合：公開視角忠臣評分的四個開關（預設關）。
 *   藍方：`loyalRationality50`（忠臣難以說明的動作 → 紅）、`lakePickSuspicion50`（湖的混合概似）；
 *   紅方：`assassinDerivability50`（公開推不出來的全好隊 → 梅林）、`redLakeDisguise50`（紅方持湖以比例照忠臣挑）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { pickLakeTarget } from './LakePolicy';
import {
  D_CAP, clearRound50Cache, derivabilityLogRatio50, lakePickTerms50, lakeReads50, proposalReads50, rationalityAdj50, rationalityFeatures50, redLakeDisguiseNow,
} from './Round50';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const KEYS = ['loyalRationality50', 'lakePickSuspicion50', 'assassinDerivability50', 'redLakeDisguise50'] as const;

// A loyal P3 at the R3 vote. R1: P1's team 1-2-3 rejected, P2's 2-4-5 rejected, …, the forced P5 team 5-6-7 failed (one fail card).
// R2: forced P10 team 10-8-9-2 succeeded. P10 held the first lake on P5 and declared P5 blue.
function r3(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P1', gamePhase: 'team_vote', failCount: 0, questResults: ['fail', 'success'],
    questHistory: [
      { round: 1, team: ['P5', 'P6', 'P7'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P10', 'P8', 'P9', 'P2'], result: 'success', failCount: 0 },
    ],
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P1', team: ['P1', 'P2', 'P3'], approved: false, votes: { P1: true, P2: true, P3: true, P4: false, P5: false, P6: false, P7: false, P8: false, P9: false, P10: false } },
      { round: 1, attempt: 5, leader: 'P5', team: ['P5', 'P6', 'P7'], approved: true, votes: {} },
      { round: 2, attempt: 1, leader: 'P6', team: ['P6', 'P5', 'P7', 'P1'], approved: false, votes: { P1: true, P2: false, P3: false, P4: false, P5: true, P6: true, P7: true, P8: false, P9: false, P10: false } },
      { round: 2, attempt: 5, leader: 'P10', team: ['P10', 'P8', 'P9', 'P2'], approved: true, votes: {} },
    ],
    lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P5', declaredClaim: 'good' }],
    myLakeResults: [], proposedTeam: ['P1', 'P3', 'P4', 'P6'],
    ...over,
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('exist, are off in the legacy and default tables, and parse their ranges', () => {
    for (const k of KEYS) {
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
    }
    expect(parseTuningFlag('loyalRationality50')).toEqual({ loyalRationality50: 1 });
    expect(parseTuningFlag('loyalRationality50=2')).toEqual({ loyalRationality50: 2 });
    expect(parseTuningFlag('assassinDerivability50=2')).toEqual({ assassinDerivability50: 2 });
    expect(parseTuningFlag('lakePickSuspicion50=0.4')).toEqual({ lakePickSuspicion50: 0.4 });
    expect(parseTuningFlag('redLakeDisguise50=1')).toEqual({ redLakeDisguise50: 1 });
    expect(() => parseTuningFlag('loyalRationality50=5')).toThrow();
    expect(bayesOptionsOf(T({ loyalRationality50: 4 })).rationality50).toEqual({ scale: 1, noVote: true, weights: 'all' });
    expect(() => parseTuningFlag('lakePickSuspicion50=1')).toThrow();
    expect(describeAgentTuning(T({ lakePickSuspicion50: 0.4 }))).toContain('lakePickSuspicion50=0.4');
  });

  it('off: the posterior options are the default ones', () => {
    const o = bayesOptionsOf(T());
    expect(o.rationality50).toBeUndefined();
    expect(o.lakeSusp50).toBeUndefined();
    expect(bayesOptionsOf(T({ loyalRationality50: 2 })).rationality50).toEqual({ scale: 1, noVote: true });
  });
});

describe('public-loyal reads', () => {
  it('the 1-1 proposal is fully justifiable (every team equally clean); later ones are scored from the leader seat', () => {
    clearRound50Cache();
    const reads = proposalReads50(r3());
    expect(reads[0]!.d).toBeCloseTo(0, 9);
    for (const r of reads) {
      expect(r!.d).toBeGreaterThanOrEqual(0);
      expect(r!.d).toBeLessThanOrEqual(D_CAP);
    }
    // P6 (on the failed R1 team) puts both other R1 members back on his R2 team: not what a public-view loyal in his seat would pick.
    expect(reads[2]!.d).toBeGreaterThan(0.1);
    expect(reads[1]!.forced).toBe(true);
  });

  it('features add up per seat; the viewer gets no offset', () => {
    const obs = r3();
    const f = rationalityFeatures50(obs);
    const reads = proposalReads50(obs);
    expect(f.get('P6')!.prop).toBeCloseTo(reads[2]!.d, 9);
    expect(f.get('P5')!.tail).toBeCloseTo(reads[1]!.d, 9);
    const adj = rationalityAdj50(obs, 1, { prop: 1, tail: 1, lake: 1 });
    expect(adj.has('P3')).toBe(false);
    expect(adj.get('P6')).toBeCloseTo(f.get('P6')!.prop + f.get('P6')!.lake + f.get('P6')!.tail, 9);
    expect(rationalityAdj50(obs, 0).size).toBe(0);
  });

  it('the lake read scores the holder against the loyal lake scorer', () => {
    const reads = lakeReads50(r3());
    expect(reads).toHaveLength(1);
    expect(reads[0]!.holder).toBe('P10');
    expect(reads[0]!.scores.has('P10')).toBe(false);
    expect(reads[0]!.d).toBeGreaterThanOrEqual(0);
    const terms = lakePickTerms50(r3(), (id) => 1 << IDS.indexOf(id));
    expect(terms).toHaveLength(1);
    expect(terms[0].pL).toBeGreaterThanOrEqual(0.02);
    // The viewer's own lake is not read.
    expect(lakePickTerms50(r3({ myPlayerId: 'P10' }), (id) => 1 << IDS.indexOf(id))).toHaveLength(0);
  });

  it('switched on, the blue posterior moves; red seats are untouched', () => {
    const base = bayesRedShare(r3(), bayesOptionsOf(T()));
    const on = bayesRedShare(r3(), bayesOptionsOf(T({ lakePickSuspicion50: 0.5 })));
    expect([...on.values()].some((p, i) => Math.abs(p - [...base.values()][i]) > 1e-6)).toBe(true);
    const red = r3({ myPlayerId: 'P5', myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P6'] });
    const rb = bayesRedShare(red, bayesOptionsOf(T()));
    const ro = bayesRedShare(red, bayesOptionsOf(T({ lakePickSuspicion50: 0.5, loyalRationality50: 1 })));
    expect([...ro.values()]).toEqual([...rb.values()]);
  });
});

describe('assassinDerivability50', () => {
  const end = (): PlayerObservation => r3({ myPlayerId: 'P5', myRole: 'assassin', myTeam: 'evil', gamePhase: 'assassination', allEvilIds: ['P5', 'P6', 'P7', 'P1'], allEvilRoles: { P5: 'assassin', P6: 'morgana', P7: 'mordred', P1: 'oberon' } } as Partial<PlayerObservation>);
  it('a seen red on the team reads as not-Merlin; mode 2 reads only forced proposals; 0 = off', () => {
    const obs = end();
    const reds = obs.allEvilIds!;
    // P10's forced R2 team (10-8-9-2) is all good: a positive Merlin read.
    expect(derivabilityLogRatio50(obs, 'P10', reds, 2)).toBeGreaterThan(0);
    expect(derivabilityLogRatio50(obs, 'P10', reds, 0)).toBe(0);
    // P2 led nothing forced.
    expect(derivabilityLogRatio50(obs, 'P2', reds, 2)).toBe(0);
    // Mode 1: P1 is red, but take P2 as a leader of a team with a seen red: a fake record where P2 led 1-2-3 (P1 red, seen).
    const fake = r3({ ...end(), voteHistory: [{ ...r3().voteHistory[0], leader: 'P2' }, ...r3().voteHistory.slice(1)] } as Partial<PlayerObservation>);
    expect(derivabilityLogRatio50(fake, 'P2', reds, 1)).toBeLessThan(0);
  });
});

describe('redLakeDisguise50', () => {
  it('0 never, 1 always (red holders only); the loyal-style pick is a valid target', () => {
    const red = r3({ myPlayerId: 'P5', myRole: 'assassin', myTeam: 'evil', knownEvils: ['P6'] });
    expect(redLakeDisguiseNow(T(), red)).toBe(false);
    expect(redLakeDisguiseNow(T({ redLakeDisguise50: 1 }), red)).toBe(true);
    expect(redLakeDisguiseNow(T({ redLakeDisguise50: 1 }), r3())).toBe(false);
    const valid = ['P1', 'P2', 'P3', 'P4', 'P6', 'P7', 'P8', 'P9'];
    const pick = pickLakeTarget(red, valid, T({ redLakeDisguise50: 1 }));
    expect(valid).toContain(pick);
    expect(pick).toBe(pickLakeTarget(red, valid, T({ redLakeLoyal: true })));
  });
});
