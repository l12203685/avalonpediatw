/**
 * SelfPlayEngine — Lady of the Lake targeting logic tests.
 *
 * Covers SSoT §4.3 / §6.9 / §8.3 / §8.4:
 *   - Good holder MUST NOT lake known evils (no new info).
 *   - Evil holder MUST NOT lake known evil teammates (wastes the lake).
 *   - Smart path uses history-derived suspicion / Merlin-likeness to pick targets.
 *   - Legacy behaviour preserved behind `AVALON_USE_SMART_LAKE=0` feature flag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SelfPlayEngine } from './SelfPlayEngine';
import { RandomAgent } from './RandomAgent';
import type { PlayerObservation, VoteRecord, QuestRecord } from './types';

function makeObs(partial: Partial<PlayerObservation> & {
  allPlayerIds: string[];
  knownEvils:   string[];
}): PlayerObservation {
  return {
    myPlayerId:    partial.myPlayerId ?? partial.allPlayerIds[0],
    myRole:        partial.myRole ?? 'loyal',
    myTeam:        partial.myTeam ?? 'good',
    playerCount:   partial.allPlayerIds.length,
    allPlayerIds:  partial.allPlayerIds,
    knownEvils:    partial.knownEvils,
    currentRound:  partial.currentRound ?? 3,
    currentLeader: partial.currentLeader ?? partial.allPlayerIds[0],
    failCount:     partial.failCount ?? 0,
    questResults:  partial.questResults ?? [],
    gamePhase:     partial.gamePhase ?? 'team_select',
    voteHistory:   partial.voteHistory ?? [],
    questHistory:  partial.questHistory ?? [],
    proposedTeam:  partial.proposedTeam ?? [],
  };
}

describe('SelfPlayEngine — pickLadyTarget (smart path)', () => {
  let engine: SelfPlayEngine;

  beforeEach(() => {
    delete process.env.AVALON_USE_SMART_LAKE; // default → smart on
    engine = new SelfPlayEngine();
  });

  // ── Good holder ──────────────────────────────────────────────

  it('good holder never picks a known evil (§8.3)', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'merlin',
      myTeam:       'good',
      allPlayerIds: ids,
      knownEvils:   ['P3', 'P5'],
    });
    const validTargets = ids.filter(id => id !== 'P1'); // holder excluded
    for (let i = 0; i < 20; i++) {
      const target = engine.pickLadyTarget('good', obs, validTargets);
      expect(['P3', 'P5']).not.toContain(target);
      expect(target).not.toBe('P1');
      expect(validTargets).toContain(target);
    }
  });

  it('good holder prefers the highest-suspicion unknown-camp player', () => {
    // P2 appeared on two failed quests → high suspicion.
    // P4 / P6 / P7 clean. P3 is a known evil (excluded).
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
    const questHistory: QuestRecord[] = [
      { round: 1, team: ['P1', 'P2', 'P4'], result: 'fail',    failCount: 1 },
      { round: 2, team: ['P2', 'P5', 'P6'], result: 'fail',    failCount: 1 },
      { round: 3, team: ['P1', 'P4', 'P7'], result: 'success', failCount: 0 },
    ];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'merlin',
      myTeam:       'good',
      allPlayerIds: ids,
      knownEvils:   ['P3'],
      questHistory,
    });
    const validTargets = ids.filter(id => id !== 'P1');
    const target = engine.pickLadyTarget('good', obs, validTargets);
    expect(target).toBe('P2'); // highest suspicion, unknown-camp
  });

  it('good holder falls back to any valid target when all remaining are known evil', () => {
    const ids = ['P1', 'P2', 'P3'];
    // All other players are known evil → fallback to first valid deterministically.
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'merlin',
      myTeam:       'good',
      allPlayerIds: ids,
      knownEvils:   ['P2', 'P3'],
    });
    const validTargets = ['P2', 'P3'];
    const target = engine.pickLadyTarget('good', obs, validTargets);
    expect(validTargets).toContain(target);
  });

  // ── Evil holder ──────────────────────────────────────────────

  it('evil holder never picks a known evil teammate (§8.4)', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
    // P1 = assassin, knownEvils = {P3=Mordred, P5=Morgana}
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      allPlayerIds: ids,
      knownEvils:   ['P3', 'P5'],
    });
    const validTargets = ids.filter(id => id !== 'P1');
    for (let i = 0; i < 20; i++) {
      const target = engine.pickLadyTarget('evil', obs, validTargets);
      expect(['P3', 'P5']).not.toContain(target);
      expect(target).not.toBe('P1');
      expect(validTargets).toContain(target);
    }
  });

  it('evil holder prefers the most Merlin-like opponent (rejected teams containing knownEvils)', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
    // P1 assassin, knownEvils = [P3 Mordred, P5 Morgana].
    // Build vote history: a team containing P3 was proposed — P4 rejected (Merlin signal), P6 approved.
    // P2 never acted distinctively.
    const voteHistory: VoteRecord[] = [
      {
        round: 1, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P7'], approved: false,
        votes: { P1: true, P2: true, P3: true, P4: false, P5: true, P6: true, P7: false },
      },
      {
        round: 1, attempt: 2, leader: 'P4', team: ['P4', 'P6', 'P7'], approved: true,
        votes: { P1: false, P2: true, P3: false, P4: true, P5: false, P6: true, P7: true },
      },
      {
        round: 2, attempt: 1, leader: 'P5', team: ['P5', 'P3', 'P6'], approved: false,
        votes: { P1: true, P2: false, P3: true, P4: false, P5: true, P6: true, P7: true },
      },
    ];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      allPlayerIds: ids,
      knownEvils:   ['P3', 'P5'],
      voteHistory,
    });
    const validTargets = ids.filter(id => id !== 'P1');
    const target = engine.pickLadyTarget('evil', obs, validTargets);
    // P4 rejected both teams containing knownEvils → strongest Merlin signal.
    expect(target).toBe('P4');
  });

  it('evil holder penalises players seen on failed quests (likely fellow evil, not Merlin)', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
    // P1 evil, knownEvils = [P3].
    // P2 and P6 both rejected a team with P3 (equal Merlin signal).
    // But P2 also appeared on a failed quest → penalty → P6 preferred.
    const voteHistory: VoteRecord[] = [
      {
        round: 2, attempt: 1, leader: 'P4', team: ['P3', 'P4', 'P7'], approved: false,
        votes: { P1: true, P2: false, P3: true, P4: true, P5: true, P6: false, P7: false },
      },
    ];
    const questHistory: QuestRecord[] = [
      { round: 1, team: ['P1', 'P2', 'P5'], result: 'fail', failCount: 1 },
    ];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      allPlayerIds: ids,
      knownEvils:   ['P3'],
      voteHistory,
      questHistory,
    });
    const validTargets = ids.filter(id => id !== 'P1');
    const target = engine.pickLadyTarget('evil', obs, validTargets);
    expect(target).toBe('P6');
  });
});

describe('SelfPlayEngine — pickLadyTarget (legacy path via feature flag)', () => {
  let engine: SelfPlayEngine;

  beforeEach(() => {
    process.env.AVALON_USE_SMART_LAKE = '0';
    engine = new SelfPlayEngine();
  });

  afterEach(() => {
    delete process.env.AVALON_USE_SMART_LAKE;
  });

  it('legacy good holder picks knownEvils[0] when present (regression guard)', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5'];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'merlin',
      myTeam:       'good',
      allPlayerIds: ids,
      knownEvils:   ['P3', 'P4'],
    });
    const validTargets = ['P2', 'P3', 'P4', 'P5'];
    const target = engine.pickLadyTarget('good', obs, validTargets);
    // Legacy: picks first knownEvil in valid targets (= P3, the waste-the-lake bug).
    expect(target).toBe('P3');
  });

  it('legacy evil holder picks randomly without filtering known evils (bug preserved)', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5'];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      allPlayerIds: ids,
      knownEvils:   ['P3'],
    });
    const validTargets = ['P2', 'P3', 'P4', 'P5'];
    // Pick many times; legacy may land on P3 (a teammate). Smart path never does.
    const results = new Set<string>();
    for (let i = 0; i < 200; i++) {
      results.add(engine.pickLadyTarget('evil', obs, validTargets));
    }
    // Legacy random produces a superset including every valid target.
    expect(results.size).toBeGreaterThan(1);
  });
});

describe('SelfPlayEngine — lake regression (full self-play integration)', () => {
  it('runs a 7-player heuristic game with smart lake enabled', async () => {
    delete process.env.AVALON_USE_SMART_LAKE;
    const engine = new SelfPlayEngine();
    const agents = Array.from({ length: 7 }, (_, i) => new RandomAgent(`R-${i + 1}`));
    const result = await engine.runGame(agents, false);

    expect(result.playerCount).toBe(7);
    expect(['good', 'evil']).toContain(result.winner);
    expect(result.rounds).toBeGreaterThan(0);
  }, 15_000);
});
