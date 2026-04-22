/**
 * SelfPlayEngine — Lady of the Lake targeting logic tests.
 *
 * Covers SSoT §4.3 / §6.9 / §8.3 + Edward 2026-04-22 12:39 +08 correction
 * ("紅方湖中女神當然可以湖隊友並宣告隊友是好人 / 不用刻意避開"):
 *   - Good holder MUST NOT lake known evils (no new info).
 *   - Evil holder MAY lake allies — a pressured ally is a valid wash target.
 *   - Evil holder picks the most Merlin-like opponent only when ally pressure
 *     isn't higher than the opponent's Merlin signal.
 *   - Evil holder's announcement hook washes allies as "good" and calls
 *     suspected Merlin opponents "good" to disguise assassination intel.
 *   - Legacy behaviour preserved behind `AVALON_USE_SMART_LAKE=0` feature flag.
 *   - Fix #2 regression behaviour preserved behind
 *     `AVALON_EVIL_LAKE_BRING_FRIEND=0`.
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

  // ── Evil holder (Edward 2026-04-22 12:39 +08 — allies allowed) ─────────

  it('evil holder lakes a visibly pressured ally to wash them with a "good" claim', () => {
    // Edward: 「紅方湖中女神當然可以湖隊友並宣告隊友是好人」
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
    // P1 assassin, knownEvils = [P3, P5].
    // P3 appeared on a failed quest (publicly suspected) → wash candidate.
    // Opponents (P2/P4/P6/P7) show no strong Merlin signal.
    const questHistory: QuestRecord[] = [
      { round: 1, team: ['P3', 'P4', 'P7'], result: 'fail',    failCount: 1 },
      { round: 2, team: ['P2', 'P6', 'P7'], result: 'success', failCount: 0 },
    ];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      allPlayerIds: ids,
      knownEvils:   ['P3', 'P5'],
      questHistory,
    });
    const validTargets = ids.filter(id => id !== 'P1');
    const target = engine.pickLadyTarget('evil', obs, validTargets);
    expect(target).toBe('P3'); // pressured ally washed, not filtered out
    // Declaration hook → publicly claim ally is "good".
    expect(engine.decideLakeAnnouncement('evil', 'P3', obs, 'evil')).toBe('good');
  });

  it('evil holder lakes the most Merlin-like opponent when no ally is under pressure', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
    // P1 assassin, knownEvils = [P3 Mordred, P5 Morgana]. Allies clean → no wash needed.
    // P4 rejected both teams containing knownEvils → strongest Merlin signal.
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
    expect(target).toBe('P4');
    // Declare "good" on the Merlin-like opponent to disguise assassination intel.
    expect(engine.decideLakeAnnouncement('evil', 'P4', obs, 'good')).toBe('good');
  });

  it('evil holder declares "evil" on a clean non-Merlin-like opponent to muddy narrative', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5'];
    // P1 assassin, knownEvils = [P3]. Allies clean, opponents clean.
    // P2 has zero Merlin signal → declaring "evil" (a lie) injects confusion.
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      allPlayerIds: ids,
      knownEvils:   ['P3'],
    });
    expect(engine.decideLakeAnnouncement('evil', 'P2', obs, 'good')).toBe('evil');
  });

  it('evil holder with no pressured ally and no distinct opponent picks deterministically', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5'];
    // P1 assassin, knownEvils = [P3]. No vote / quest history → every opponent tied at 0.
    // Ally pressure = 0 ≤ opponent score 0, but ally pressure must be > 0 to trigger wash,
    // so holder falls through to opponent branch, picking the first by allPlayerIds tiebreak.
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      allPlayerIds: ids,
      knownEvils:   ['P3'],
    });
    const validTargets = ['P2', 'P3', 'P4', 'P5'];
    const target = engine.pickLadyTarget('evil', obs, validTargets);
    expect(['P2', 'P4', 'P5']).toContain(target);
    expect(target).not.toBe('P3'); // no pressure on ally → no wash
  });
});

describe('SelfPlayEngine — evil lake (Fix #2 filter-out-allies regression flag)', () => {
  let engine: SelfPlayEngine;

  beforeEach(() => {
    delete process.env.AVALON_USE_SMART_LAKE;
    process.env.AVALON_EVIL_LAKE_BRING_FRIEND = '0';
    engine = new SelfPlayEngine();
  });

  afterEach(() => {
    delete process.env.AVALON_EVIL_LAKE_BRING_FRIEND;
  });

  it('with bring-friend flag off, evil holder restores Fix #2 filter-out-allies behaviour', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
    // Same setup as the "pressured ally" case above — but flag forces old behaviour.
    const questHistory: QuestRecord[] = [
      { round: 1, team: ['P3', 'P4', 'P7'], result: 'fail', failCount: 1 },
    ];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      allPlayerIds: ids,
      knownEvils:   ['P3', 'P5'],
      questHistory,
    });
    const validTargets = ids.filter(id => id !== 'P1');
    const target = engine.pickLadyTarget('evil', obs, validTargets);
    expect(target).not.toBe('P3');
    expect(target).not.toBe('P5');
    expect(['P2', 'P4', 'P6', 'P7']).toContain(target);
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
