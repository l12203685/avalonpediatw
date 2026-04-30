/**
 * Wave E PR1 unit tests — InterpretationModule + ToMReverseEngine.
 *
 * Coverage targets (from spec):
 *   - extractFacts: public-only Facts shape (failedMission, outer-white,
 *     lake violators, lake chain, knownEvils / knownWizards mirroring)
 *   - reverseEngineerMind: ToM symmetric assumption — projecting the
 *     same public history through the target's seat yields a pyramid
 *     score map; predicted role distribution sums to 1; pinned zeros
 *     are honoured for privately-known evils.
 *   - normalizeRoleDist: invariants (sums to 1, pinned zeros respected,
 *     epsilon floor for unpinned roles).
 *   - projectObsFromSeat: target's POV strips own private fields.
 *   - InterpretationModule.interpret: full pipeline determinism + skips
 *     self in mindBy.
 *   - Determinism (Q2=A): same obs twice → identical output.
 */

import { describe, it, expect } from 'vitest';
import type { PlayerObservation } from '../types';
import {
  interpret,
  extractFacts,
  InterpretationModule,
  reverseEngineerMind,
  normalizeRoleDist,
  projectObsFromSeat,
  predictRoleDist,
  ALL_ROLES,
  ROLE_PRIOR_EPSILON,
} from './index';
import type { Role } from '@avalon/shared';

// Helper: shorten boilerplate for an observation.
function makeObs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P0',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 5,
    allPlayerIds: ['P0', 'P1', 'P2', 'P3', 'P4'],
    knownEvils: [],
    currentRound: 1,
    currentLeader: 'P0',
    failCount: 0,
    questResults: [],
    gamePhase: 'team_select',
    voteHistory: [],
    questHistory: [],
    proposedTeam: [],
    ...partial,
  };
}

describe('extractFacts', () => {
  it('returns empty fact sets for a fresh game', () => {
    const obs = makeObs({});
    const facts = extractFacts(obs);
    expect(facts.failedMissionMembers.size).toBe(0);
    expect(facts.outerWhiteApprovers.size).toBe(0);
    expect(facts.lakeViolators.size).toBe(0);
    expect(facts.lakeChain.length).toBe(0);
    expect(facts.knownEvils.size).toBe(0);
    expect(facts.knownWizards.size).toBe(0);
    expect(facts.allPlayerIds.length).toBe(5);
    expect(facts.currentRound).toBe(1);
  });

  it('mirrors knownEvils and knownWizards from the observation', () => {
    const obs = makeObs({
      myRole: 'percival',
      knownEvils: ['P3'],
      knownWizards: ['P1', 'P2'],
    });
    const facts = extractFacts(obs);
    expect(facts.knownEvils.has('P3')).toBe(true);
    expect(facts.knownWizards.has('P1')).toBe(true);
    expect(facts.knownWizards.has('P2')).toBe(true);
  });

  it('captures failed-mission members from quest history', () => {
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 },
        { round: 2, team: ['P3', 'P4'], result: 'success', failCount: 0 },
      ],
    });
    const facts = extractFacts(obs);
    expect(facts.failedMissionMembers.has('P1')).toBe(true);
    expect(facts.failedMissionMembers.has('P2')).toBe(true);
    expect(facts.failedMissionMembers.has('P3')).toBe(false);
  });

  it('captures outer-white approvers from vote history (excluding self)', () => {
    const obs = makeObs({
      voteHistory: [
        {
          round: 1,
          attempt: 1,
          leader: 'P0',
          team: ['P1', 'P2'],
          votes: { P0: true, P1: true, P2: true, P3: true, P4: false },
          approved: true,
        },
      ],
    });
    const facts = extractFacts(obs);
    expect(facts.outerWhiteApprovers.has('P0')).toBe(false); // self filtered
    expect(facts.outerWhiteApprovers.has('P3')).toBe(true);
  });

  it('captures lake-chain violators from the public lake history', () => {
    const obs = makeObs({
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 3, holderId: 'P2', targetId: 'P1', declaredClaim: 'evil' },
      ],
    });
    const facts = extractFacts(obs);
    expect(facts.lakeViolators.has('P1')).toBe(true);
    expect(facts.lakeViolators.has('P2')).toBe(true);
    expect(facts.lakeChain.length).toBe(2);
  });
});

describe('normalizeRoleDist', () => {
  it('sums to 1 for an empty raw distribution (uniform fallback)', () => {
    const dist = normalizeRoleDist(new Map());
    const total = ALL_ROLES.reduce((acc, r) => acc + (dist[r] ?? 0), 0);
    expect(total).toBeCloseTo(1, 5);
    // Each role should be roughly 1/7.
    for (const r of ALL_ROLES) {
      expect(dist[r]).toBeGreaterThan(0);
    }
  });

  it('honours pinned zeros and renormalises remaining mass', () => {
    const raw = new Map<Role, number>([
      ['merlin', 1],
      ['percival', 1],
      ['loyal', 1],
      ['assassin', 1],
      ['morgana', 1],
      ['oberon', 1],
      ['mordred', 1],
    ]);
    const pinned = new Set<Role>(['merlin', 'percival']);
    const dist = normalizeRoleDist(raw, pinned);
    expect(dist.merlin).toBe(0);
    expect(dist.percival).toBe(0);
    const total = ALL_ROLES.reduce((acc, r) => acc + (dist[r] ?? 0), 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('floors unpinned roles at epsilon', () => {
    const raw = new Map<Role, number>([['merlin', 0]]);
    const dist = normalizeRoleDist(raw);
    // merlin had 0 but unpinned → epsilon floor → still > 0 after normalise.
    expect(dist.merlin).toBeGreaterThan(0);
    expect(dist.merlin).toBeLessThan(1);
    // Total is still 1.
    const total = ALL_ROLES.reduce((acc, r) => acc + (dist[r] ?? 0), 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('handles fully-pinned input by spreading uniformly on unpinned', () => {
    const pinned = new Set<Role>([
      'merlin',
      'percival',
      'loyal',
      'assassin',
      'morgana',
    ]);
    // All values pinned to 0 except oberon + mordred.
    const dist = normalizeRoleDist(new Map(), pinned);
    expect(dist.merlin).toBe(0);
    expect(dist.assassin).toBe(0);
    expect(dist.oberon).toBeGreaterThan(0);
    expect(dist.mordred).toBeGreaterThan(0);
    const total = ALL_ROLES.reduce((acc, r) => acc + (dist[r] ?? 0), 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('keeps every role at >= epsilon when no pin specified', () => {
    const dist = normalizeRoleDist(new Map());
    for (const r of ALL_ROLES) {
      expect(dist[r]).toBeGreaterThanOrEqual(ROLE_PRIOR_EPSILON / 100);
    }
  });
});

describe('projectObsFromSeat (symmetric assumption)', () => {
  it("strips the agent's private fields when projecting to target POV", () => {
    const obs = makeObs({
      myPlayerId: 'P0',
      myRole: 'merlin',
      knownEvils: ['P3', 'P4'],
      knownWizards: ['P1', 'P2'],
    });
    const targetObs = projectObsFromSeat(obs, 'P3');
    expect(targetObs.myPlayerId).toBe('P3');
    expect(targetObs.myRole).toBe('loyal'); // placeholder
    expect(targetObs.myTeam).toBe('good'); // placeholder
    expect(targetObs.knownEvils).toEqual([]); // stripped
    expect(targetObs.knownWizards).toBeUndefined(); // stripped
    expect(targetObs.allEvilIds).toBeUndefined(); // stripped
  });

  it('preserves all PUBLIC history fields across the projection', () => {
    const voteHistory = [
      {
        round: 1,
        attempt: 1,
        leader: 'P0',
        team: ['P1', 'P2'],
        votes: { P0: true, P1: true, P2: true, P3: true, P4: false },
        approved: true,
      },
    ];
    const questHistory = [
      { round: 1, team: ['P1', 'P2'], result: 'fail' as const, failCount: 1 },
    ];
    const lakeHistory = [
      { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' as const },
    ];
    const obs = makeObs({ voteHistory, questHistory, lakeHistory });
    const targetObs = projectObsFromSeat(obs, 'P2');
    expect(targetObs.voteHistory).toBe(voteHistory);
    expect(targetObs.questHistory).toBe(questHistory);
    expect(targetObs.lakeHistory).toBe(lakeHistory);
    expect(targetObs.allPlayerIds).toBe(obs.allPlayerIds);
  });

  it('symmetric assumption: projecting twice for two seats yields different POVs', () => {
    const obs = makeObs({});
    const a = projectObsFromSeat(obs, 'P1');
    const b = projectObsFromSeat(obs, 'P2');
    expect(a.myPlayerId).not.toBe(b.myPlayerId);
    // But shared history pointers are identical (no copy needed).
    expect(a.voteHistory).toBe(b.voteHistory);
    expect(a.questHistory).toBe(b.questHistory);
  });
});

describe('predictRoleDist', () => {
  it('produces a valid distribution for every player', () => {
    const obs = makeObs({});
    for (const pid of obs.allPlayerIds) {
      const dist = predictRoleDist(obs, pid);
      const total = ALL_ROLES.reduce((acc, r) => acc + (dist[r] ?? 0), 0);
      expect(total).toBeCloseTo(1, 5);
    }
  });

  it('pins good roles to zero for privately-known evils', () => {
    const obs = makeObs({
      myRole: 'merlin',
      knownEvils: ['P3'],
    });
    const dist = predictRoleDist(obs, 'P3');
    expect(dist.merlin).toBe(0);
    expect(dist.percival).toBe(0);
    expect(dist.loyal).toBe(0);
    expect(dist.assassin + dist.morgana + dist.mordred + dist.oberon).toBeCloseTo(1, 5);
  });

  it('pins all but merlin/morgana for known wizard candidates (Percival POV)', () => {
    const obs = makeObs({
      myRole: 'percival',
      knownWizards: ['P1', 'P2'],
    });
    const dist = predictRoleDist(obs, 'P1');
    expect(dist.percival).toBe(0);
    expect(dist.loyal).toBe(0);
    expect(dist.assassin).toBe(0);
    expect(dist.oberon).toBe(0);
    expect(dist.mordred).toBe(0);
    expect(dist.merlin + dist.morgana).toBeCloseTo(1, 5);
  });
});

describe('reverseEngineerMind', () => {
  it('builds an interpretation map with one entry per visible player', () => {
    const obs = makeObs({});
    const facts = extractFacts(obs);
    const mind = reverseEngineerMind(obs, facts, 'P1');
    // The target's pyramid covers everyone in allPlayerIds.
    for (const pid of obs.allPlayerIds) {
      expect(mind.interpretation.has(pid)).toBe(true);
    }
  });

  it('predicted role distribution sums to 1', () => {
    const obs = makeObs({});
    const facts = extractFacts(obs);
    const mind = reverseEngineerMind(obs, facts, 'P1');
    const total = ALL_ROLES.reduce(
      (acc, r) => acc + (mind.predictedRoleProb[r] ?? 0),
      0,
    );
    expect(total).toBeCloseTo(1, 5);
  });

  it('predictedLogic mentions failed-mission membership when applicable', () => {
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 },
      ],
    });
    const facts = extractFacts(obs);
    const mind = reverseEngineerMind(obs, facts, 'P1');
    expect(mind.predictedLogic).toMatch(/failed mission/);
  });

  it('predictedPurpose reflects the highest-probability role', () => {
    const obs = makeObs({
      myRole: 'merlin',
      knownEvils: ['P3'],
    });
    const facts = extractFacts(obs);
    const mind = reverseEngineerMind(obs, facts, 'P3');
    // P3 known evil → top role is one of the evil roles.
    expect(mind.predictedPurpose).toMatch(/assassin|morgana|mordred|oberon/);
  });

  it('symmetric: projecting target POV uses the same public substrate', () => {
    // If two players have identical public history available to them
    // (which they always do — public history IS shared), their POV
    // pyramids on a third party agree on that third party's score.
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P3', 'P4'], result: 'fail', failCount: 1 },
      ],
    });
    const facts = extractFacts(obs);
    const mindFromP1 = reverseEngineerMind(obs, facts, 'P1');
    const mindFromP2 = reverseEngineerMind(obs, facts, 'P2');
    // Both seats see the same failed-mission roster → both think P3/P4 are
    // suspect. Score on P3 should be identical from both POVs (public-only
    // baseline assumption).
    const p1OnP3 = mindFromP1.interpretation.get('P3') ?? 0;
    const p2OnP3 = mindFromP2.interpretation.get('P3') ?? 0;
    expect(p1OnP3).toBeCloseTo(p2OnP3, 5);
    expect(p1OnP3).toBeGreaterThan(0.5);
  });
});

describe('InterpretationModule (full Step 1 pipeline)', () => {
  it('skips self in the mindBy map', () => {
    const obs = makeObs({});
    const result = interpret(obs);
    expect(result.mindBy.has(obs.myPlayerId)).toBe(false);
    expect(result.mindBy.size).toBe(obs.allPlayerIds.length - 1);
  });

  it('class wrapper produces the same result as the free function', () => {
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 },
      ],
    });
    const r1 = interpret(obs);
    const r2 = new InterpretationModule().interpret(obs);
    // Compare facts.
    expect([...r2.facts.failedMissionMembers]).toEqual(
      [...r1.facts.failedMissionMembers],
    );
    // Compare mind keys.
    expect([...r2.mindBy.keys()].sort()).toEqual(
      [...r1.mindBy.keys()].sort(),
    );
  });

  it('determinism (Q2=A): same obs twice yields identical results', () => {
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 },
      ],
      voteHistory: [
        {
          round: 1,
          attempt: 1,
          leader: 'P0',
          team: ['P1', 'P2'],
          votes: { P0: true, P1: true, P2: true, P3: true, P4: false },
          approved: true,
        },
      ],
      lakeHistory: [
        { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
        { round: 3, holderId: 'P2', targetId: 'P1', declaredClaim: 'evil' },
      ],
    });
    const r1 = interpret(obs);
    const r2 = interpret(obs);

    // Facts equality
    expect([...r2.facts.failedMissionMembers].sort()).toEqual(
      [...r1.facts.failedMissionMembers].sort(),
    );
    expect([...r2.facts.outerWhiteApprovers].sort()).toEqual(
      [...r1.facts.outerWhiteApprovers].sort(),
    );
    expect([...r2.facts.lakeViolators].sort()).toEqual(
      [...r1.facts.lakeViolators].sort(),
    );

    // Mind equality (per player)
    for (const pid of r1.mindBy.keys()) {
      const m1 = r1.mindBy.get(pid)!;
      const m2 = r2.mindBy.get(pid)!;
      expect(m2.predictedLogic).toBe(m1.predictedLogic);
      expect(m2.predictedPurpose).toBe(m1.predictedPurpose);
      for (const r of ALL_ROLES) {
        expect(m2.predictedRoleProb[r]).toBeCloseTo(
          m1.predictedRoleProb[r],
          10,
        );
      }
    }
  });

  it('integrates Facts + ToM into a single result object', () => {
    const obs = makeObs({
      questHistory: [
        { round: 1, team: ['P1', 'P2'], result: 'fail', failCount: 1 },
      ],
    });
    const result = interpret(obs);
    // P1/P2 should be marked as failed-mission members.
    expect(result.facts.failedMissionMembers.has('P1')).toBe(true);
    // The mind reverse-engineered for P3 should reflect that public anomaly.
    const mindOnP3 = result.mindBy.get('P3');
    expect(mindOnP3).toBeDefined();
    // P3's POV pyramid sees P1/P2 as suspects too (public-only agreement).
    expect((mindOnP3!.interpretation.get('P1') ?? 0)).toBeGreaterThan(0.5);
  });
});
