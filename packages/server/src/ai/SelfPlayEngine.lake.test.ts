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
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING } from './AgentTuning';
import type { PlayerObservation, VoteRecord, QuestRecord } from './types';

// 2026-10-12: the production default (`DEFAULT_AGENT_TUNING`) flips the good
// holder to "most suspicious" and the evil claim to "always good". The tests
// below pin the pre-2026-10-12 policy, so they pass the legacy tuning
// explicitly; `SelfPlayEngine.tuning.test.ts` / `LakePolicy.tuning.test.ts`
// cover the switches. The two assertions on the new default pass
// `DEFAULT_AGENT_TUNING` explicitly too: the engine's default argument is
// `getDefaultAgentTuning()`, which re-reads `AVALON_TUNING_*` from the
// environment on every call, and strength_benchmark.md tells developers to
// export those variables as a temporary switch.
//
// 2026-10-13: `evilLakeHumanStrategy` (Edward's ruling: a red holder keeps
// the lake on a visible teammate and declares them good) is an opt-in
// switch — measured weaker as red in self-play, so not in the production
// default. The evil-holder tests below pin the older evil branch with
// `LEGACY` explicitly and add the opt-in behaviour (`HUMAN_STRATEGY`) next
// to it. `LakePolicy.tuning.test.ts` covers the strategy itself.
const LEGACY = { ...LEGACY_AGENT_TUNING };
const PRODUCTION = { ...DEFAULT_AGENT_TUNING };
const HUMAN_STRATEGY = { ...DEFAULT_AGENT_TUNING, evilLakeHumanStrategy: true };

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

  it('good holder prefers the LOWEST-suspicion (highest-blue) unknown-camp player — Edward 2026-04-29 fundamental fix #2', () => {
    // Edward 2026-04-29 13:35: lake target should prioritise low red
    // (high blue) to build a trust chain (硬規則 4: 首湖藍 → 持續湖到
    // 藍). P2 / P5 / P6 appeared on failed quests → high red. P4 was
    // on R1 fail but cleaned up by R3 success. P7 only on a success
    // quest → lowest red (cleanest blue). New behaviour: pick P7.
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
    const target = engine.pickLadyTarget('good', obs, validTargets, LEGACY);
    expect(target).toBe('P7'); // lowest suspicion (only-on-success), unknown-camp
    // 2026-10-12 default (`goodLakeTargetMostSuspicious`): the most
    // suspicious unknown-camp seat instead — P2 (two failed quests).
    expect(engine.pickLadyTarget('good', obs, validTargets, PRODUCTION)).toBe('P2');
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

  // ── Edward 2026-04-29 fundamental fix #2 — trust-chain regression cases ──

  it('good loyal lakes the cleanest blue when no known-evil — Edward 2026-04-29 self-play case', () => {
    // Mirrors Edward 13:35 self-play: R1 任務 130 oox (1 fail) →
    // 1家 紅嫌 ≥ 0.7. R2 通過 2370 oooo → 0 家拿湖. 0 家(忠臣) 該湖
    // LOW 紅嫌 (e.g. seat 2/3/7 — clean R2 success) 不該湖 high 紅嫌
    // (seat 1 — appeared on R1 fail).
    const ids = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'];
    const questHistory: QuestRecord[] = [
      // R1 failed: P1, P3, P0 on team → P1/P3 push red signal (P0 is holder).
      { round: 1, team: ['P0', 'P1', 'P3'], result: 'fail',    failCount: 1 },
      // R2 succeeded: P2, P3, P7, P0 on team — P3 also on R2 → mixed,
      // but P2 / P7 only-on-success → clean blue.
      { round: 2, team: ['P0', 'P2', 'P3', 'P7'], result: 'success', failCount: 0 },
    ];
    const obs = makeObs({
      myPlayerId:   'P0',
      myRole:       'loyal',
      myTeam:       'good',
      allPlayerIds: ids,
      knownEvils:   [],
      questHistory,
    });
    // P0 is the holder. validTargets exclude self.
    const validTargets = ids.filter(id => id !== 'P0');
    const target = engine.pickLadyTarget('good', obs, validTargets, LEGACY);
    // Must NOT lake the highest-red (P1 — pure R1-fail with no recovery).
    expect(target).not.toBe('P1');
    // Should lake either P2 or P7 (only on success — cleanest blue).
    // Tiebreak by allPlayerIds index → P2 first.
    expect(['P2', 'P7']).toContain(target);
  });

  it('good holder ascending preference is deterministic by tiebreak when scores tie', () => {
    // Empty history → all candidates score 0. Ascending sort →
    // first by allPlayerIds order. validTargets = [P2..P5].
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5'];
    const obs = makeObs({
      myPlayerId:   'P1',
      myRole:       'merlin',
      myTeam:       'good',
      allPlayerIds: ids,
      knownEvils:   [],
      questHistory: [],
    });
    const validTargets = ['P2', 'P3', 'P4', 'P5'];
    const target = engine.pickLadyTarget('good', obs, validTargets);
    // All scores tie at 0 → tiebreak by allPlayerIds index → P2.
    expect(target).toBe('P2');
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
    const target = engine.pickLadyTarget('evil', obs, validTargets, LEGACY);
    expect(target).toBe('P3'); // pressured ally washed, not filtered out
    // Declaration hook → publicly claim ally is "good".
    expect(engine.decideLakeAnnouncement('evil', 'P3', obs, 'evil', LEGACY)).toBe('good');
    // Same wash under the production default and under the opt-in human
    // strategy (the pressured ally is also the one P1 never left off a team).
    expect(engine.pickLadyTarget('evil', obs, validTargets, PRODUCTION)).toBe('P3');
    expect(engine.pickLadyTarget('evil', obs, validTargets, HUMAN_STRATEGY)).toBe('P3');
    expect(engine.decideLakeAnnouncement('evil', 'P3', obs, 'evil', HUMAN_STRATEGY)).toBe('good');
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
    const target = engine.pickLadyTarget('evil', obs, validTargets, LEGACY);
    expect(target).toBe('P4');
    // Declare "good" on the Merlin-like opponent to disguise assassination intel.
    expect(engine.decideLakeAnnouncement('evil', 'P4', obs, 'good', LEGACY)).toBe('good');
    // Opt-in human strategy (盡量湖隊友): a visible teammate is legal and
    // another lake follows → lake the teammate, declare "good".
    const human = engine.pickLadyTarget('evil', obs, validTargets, HUMAN_STRATEGY);
    expect(['P3', 'P5']).toContain(human);
    expect(engine.decideLakeAnnouncement('evil', human, obs, 'evil', HUMAN_STRATEGY)).toBe('good');
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
    expect(engine.decideLakeAnnouncement('evil', 'P2', obs, 'good', LEGACY)).toBe('evil');
    // `evilLakeClaimAlwaysGood` is NOT in the production default (更像真人但紅方 −0.5pp，
    // docs/ai/strength_benchmark.md), so the default still muddies; switched on it says "good".
    expect(engine.decideLakeAnnouncement('evil', 'P2', obs, 'good', PRODUCTION)).toBe('evil');
    expect(engine.decideLakeAnnouncement('evil', 'P2', obs, 'good', { ...PRODUCTION, evilLakeClaimAlwaysGood: true })).toBe('good');
    // Opt-in human strategy (2026-10-13, not in the default): a blue with no
    // shared failed mission (red not listening) gets the truthful "good".
    expect(engine.decideLakeAnnouncement('evil', 'P2', obs, 'good', HUMAN_STRATEGY)).toBe('good');
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
    const target = engine.pickLadyTarget('evil', obs, validTargets, LEGACY);
    expect(['P2', 'P4', 'P5']).toContain(target);
    expect(target).not.toBe('P3'); // no pressure on ally → no wash
    // Opt-in human strategy: the teammate is laked even without pressure (盡量湖隊友).
    expect(engine.pickLadyTarget('evil', obs, validTargets, HUMAN_STRATEGY)).toBe('P3');
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
    const target = engine.pickLadyTarget('evil', obs, validTargets, LEGACY);
    expect(target).not.toBe('P3');
    expect(target).not.toBe('P5');
    expect(['P2', 'P4', 'P6', 'P7']).toContain(target);
    // `evilLakeHumanStrategy` (opt-in, 2026-10-13) supersedes this regression flag.
    expect(['P3', 'P5']).toContain(engine.pickLadyTarget('evil', obs, validTargets, HUMAN_STRATEGY));
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
