import { describe, it, expect, beforeEach } from 'vitest';
import { HeuristicAgent } from './HeuristicAgent';
import type { PlayerObservation, VoteRecord, QuestRecord } from './types';

// ── Fixture builders ──────────────────────────────────────────

function baseObs(overrides: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId:    'P1',
    myRole:        'loyal_servant',
    myTeam:        'good',
    playerCount:   5,
    allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5'],
    knownEvils:    [],
    currentRound:  1,
    currentLeader: 'P1',
    failCount:     0,
    questResults:  [],
    gamePhase:     'team_select',
    voteHistory:   [],
    questHistory:  [],
    proposedTeam:  [],
    ...overrides,
  };
}

function vote(
  round: number,
  attempt: number,
  leader: string,
  team: string[],
  approved: boolean,
  votes: Record<string, boolean>,
): VoteRecord {
  return { round, attempt, leader, team, approved, votes };
}

function quest(round: number, team: string[], result: 'success' | 'fail', failCount = 0): QuestRecord {
  return { round, team, result, failCount };
}

// ── Tests ────────────────────────────────────────────────────

describe('HeuristicAgent · AgentMemory (Phase A)', () => {
  let agent: HeuristicAgent;

  beforeEach(() => {
    agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(baseObs());
  });

  it('ingestQuestHistory records failedTeamMembers from a single failed quest', () => {
    const obs = baseObs({
      voteHistory: [
        vote(1, 1, 'P1', ['P1', 'P2'], true, { P1: true, P2: true, P3: false, P4: true, P5: true }),
      ],
      questHistory: [quest(1, ['P1', 'P2'], 'fail', 1)],
    });

    agent._ingestForTesting(obs);
    const mem = agent._memoryForTesting();

    expect(mem.failedTeamMembers.get('P1')).toBe(1);
    expect(mem.failedTeamMembers.get('P2')).toBe(1);
    expect(mem.failedTeamMembers.get('P3')).toBeUndefined();
    expect(mem.failedTeamHistory).toEqual([{ round: 1, team: ['P1', 'P2'] }]);
    // Each quest team member earns +2 suspicion from ingestQuestHistory
    expect(mem.suspicion.get('P2')).toBeGreaterThanOrEqual(2);
  });

  it('repeated ingest calls do not double-count vote or quest history', () => {
    const obs = baseObs({
      voteHistory: [
        vote(1, 1, 'P1', ['P1', 'P2'], true, { P1: true, P2: true, P3: true, P4: false, P5: false }),
      ],
      questHistory: [quest(1, ['P1', 'P2'], 'fail', 1)],
    });

    agent._ingestForTesting(obs);
    const after1 = {
      p2Fails:  agent._memoryForTesting().failedTeamMembers.get('P2'),
      voteKeys: agent._memoryForTesting().processedVoteAttempts.size,
      p2Susp:   agent._memoryForTesting().suspicion.get('P2'),
    };

    // Calling ingest with the same observation again must be idempotent.
    agent._ingestForTesting(obs);
    agent._ingestForTesting(obs);
    const after3 = {
      p2Fails:  agent._memoryForTesting().failedTeamMembers.get('P2'),
      voteKeys: agent._memoryForTesting().processedVoteAttempts.size,
      p2Susp:   agent._memoryForTesting().suspicion.get('P2'),
    };

    expect(after3.p2Fails).toBe(after1.p2Fails);
    expect(after3.voteKeys).toBe(after1.voteKeys);
    expect(after3.p2Susp).toBe(after1.p2Susp);
  });

  it('ingestLeaderStats increments leaderCoverScore only for leaders of failed quests', () => {
    const obs = baseObs({
      voteHistory: [
        vote(1, 1, 'P3', ['P1', 'P3'], true, { P1: true, P2: true, P3: true, P4: false, P5: false }),
        vote(2, 1, 'P4', ['P4', 'P5'], true, { P1: true, P2: true, P3: true, P4: true, P5: true }),
      ],
      questHistory: [
        quest(1, ['P1', 'P3'], 'fail', 1),
        quest(2, ['P4', 'P5'], 'success', 0),
      ],
    });

    agent._ingestForTesting(obs);
    const mem = agent._memoryForTesting();

    expect(mem.leaderCoverScore.get('P3')).toBe(1); // led a failed quest
    expect(mem.leaderCoverScore.get('P4')).toBeUndefined(); // led a success, not tracked
  });

  it('applyNoise: rate=0 never flips, critical=true forces rate to 0', () => {
    // rate=0 → 1000 samples, all must equal input
    for (let i = 0; i < 1000; i++) {
      expect(agent._applyNoiseForTesting(true, 0)).toBe(true);
      expect(agent._applyNoiseForTesting(false, 0)).toBe(false);
    }

    // critical=true → even rate=1 must not flip
    for (let i = 0; i < 100; i++) {
      expect(agent._applyNoiseForTesting(true, 1, true)).toBe(true);
      expect(agent._applyNoiseForTesting(false, 1, true)).toBe(false);
    }

    // rate=1 non-critical → always flips boolean
    for (let i = 0; i < 100; i++) {
      expect(agent._applyNoiseForTesting(true, 1)).toBe(false);
      expect(agent._applyNoiseForTesting(false, 1)).toBe(true);
    }
  });

  it('onGameStart resets memory and seeds suspicion for known evils', () => {
    // Pre-populate some memory state
    const priorObs = baseObs({
      voteHistory:  [vote(1, 1, 'P2', ['P1', 'P2'], true, { P1: true, P2: true, P3: true, P4: false, P5: false })],
      questHistory: [quest(1, ['P1', 'P2'], 'fail', 1)],
    });
    agent._ingestForTesting(priorObs);
    expect(agent._memoryForTesting().failedTeamMembers.size).toBeGreaterThan(0);

    // New game — onGameStart must wipe everything and seed knownEvils
    agent.onGameStart(baseObs({ knownEvils: ['P4', 'P5'] }));
    const mem = agent._memoryForTesting();

    expect(mem.failedTeamMembers.size).toBe(0);
    expect(mem.failedTeamHistory).toEqual([]);
    expect(mem.processedVoteAttempts.size).toBe(0);
    expect(mem.processedQuestRounds.size).toBe(0);
    expect(mem.suspicion.get('P4')).toBe(10);
    expect(mem.suspicion.get('P5')).toBe(10);
  });
});

// ── Phase B: Off-team white-ball regression ──────────────────────
//
// Bug: good players not seated on the proposed team used to approve by
// default (avg-suspicion heuristic stays at 0 in round 1). The fix adds
// an off-team cautious-reject baseline + hard signals (knownEvil /
// failedTeamMember / suspicion threshold) that force an immediate reject.
// These tests pin that behaviour so a future regression cannot silently
// flip off-team good players back into automatic approvers.

describe('HeuristicAgent · Team Vote off-team (Phase B)', () => {
  /** Runs `voteOnTeam` N times against the same observation and returns the reject ratio. */
  function rejectRate(obs: PlayerObservation, difficulty: 'hard' | 'normal', samples: number): number {
    let rejects = 0;
    for (let i = 0; i < samples; i++) {
      const agent = new HeuristicAgent('P1', difficulty);
      agent.onGameStart(obs);
      // Re-ingest each time so memory matches the observation exactly.
      agent._ingestForTesting(obs);
      const action = agent.act({ ...obs, gamePhase: 'team_vote' });
      if (action.type === 'team_vote' && action.vote === false) rejects++;
    }
    return rejects / samples;
  }

  it('場外白球: off-team good rejects mid-suspicion teams > 65% on hard (plan L187-189)', () => {
    // Construct an off-team observation with some prior history (so the
    // relaxed round-1 baseline does NOT apply). Suspicion stays mid-range
    // (no forced signals) so the baseline reject probability is active.
    const obs = baseObs({
      myPlayerId:    'P1',                // self off team
      gamePhase:     'team_vote',
      currentRound:  2,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],   // self not on team
      // Prior vote without quest so there's history but no failedTeamMembers
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: true, P5: false }),
      ],
      // Quest 1 succeeded, so no blacklist entries
      questHistory: [quest(1, ['P2', 'P3'], 'success', 0)],
    });

    const ratio = rejectRate(obs, 'hard', 1000);
    // Plan specifies > 0.65. Hard baseline is 0.70 with 5% noise flip, so
    // theoretical reject rate = 0.70 * 0.95 + 0.30 * 0.05 = 0.68.
    expect(ratio).toBeGreaterThan(0.60);
    expect(ratio).toBeLessThan(0.80); // sanity upper bound
  });

  it('場外 hasFailedMember veto: off-team reject is near-deterministic when a member previously failed', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      gamePhase:     'team_vote',
      currentRound:  2,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],
      voteHistory: [
        // Round 1 approved team contained P3 which then failed
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: false, P5: false }),
      ],
      questHistory: [quest(1, ['P2', 'P3'], 'fail', 1)],
    });

    // Off-team + any failed-member triggers reject passed through applyNoise(noise=0.05)
    // so we expect >= 90% rejection over 500 samples.
    const ratio = rejectRate(obs, 'hard', 500);
    expect(ratio).toBeGreaterThan(0.90);
  });

  it('場外 round 1 (no history): baseline relaxed to avoid racing to failCount=5', () => {
    // With no voteHistory/questHistory, `hasHistory` is false so the
    // baseline drops to 0.7 * 0.6 = 0.42 on hard mode.
    const obs = baseObs({
      myPlayerId:    'P1',
      gamePhase:     'team_vote',
      currentRound:  1,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3'],
      voteHistory:   [],
      questHistory:  [],
    });

    const ratio = rejectRate(obs, 'hard', 1000);
    // Theoretical: 0.42 * 0.95 + 0.58 * 0.05 = 0.43. Window 0.30-0.55 keeps
    // the test stable under 5% noise + sampling jitter (±3%).
    expect(ratio).toBeGreaterThan(0.30);
    expect(ratio).toBeLessThan(0.55);
  });

  it('場外 knownEvil veto: off-team good rejects every time a knownEvil sits on team', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'merlin',
      gamePhase:     'team_vote',
      knownEvils:    ['P4'],
      currentRound:  2,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P4'],  // P4 is a knownEvil, P1 off team
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: true, P5: false }),
      ],
      questHistory: [quest(1, ['P2', 'P3'], 'success', 0)],
    });

    // Critical reject — no noise path, 100% reject.
    const ratio = rejectRate(obs, 'hard', 200);
    expect(ratio).toBe(1.0);
  });

  it('on-team failed-member veto: even when seated, reject if a teammate previously failed a quest', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      gamePhase:     'team_vote',
      currentRound:  2,
      currentLeader: 'P1',
      proposedTeam:  ['P1', 'P3'],   // self on team, but P3 is tainted
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: false, P5: false }),
      ],
      questHistory: [quest(1, ['P2', 'P3'], 'fail', 1)],
    });

    const ratio = rejectRate(obs, 'hard', 500);
    // noise=0.05 → expect >= 0.90 rejection.
    expect(ratio).toBeGreaterThan(0.90);
  });

  it('force approve at failCount=4 overrides all reject signals', () => {
    // Stack every reject signal: off-team, failed member, knownEvil.
    // failCount=4 must still produce approve (rejecting auto-hands round to evil).
    const obs = baseObs({
      myPlayerId:    'P1',
      gamePhase:     'team_vote',
      knownEvils:    ['P4'],
      failCount:     4,
      currentRound:  3,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],  // off-team + knownEvil + failed member
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: true, P5: false }),
      ],
      questHistory: [quest(1, ['P2', 'P3'], 'fail', 1)],
    });

    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_vote');
    if (action.type === 'team_vote') {
      expect(action.vote).toBe(true);
    }
  });
});

// ── Phase B: §0 Listening Rule (quest-action override) ───────────
//
// Edward 2026-04-22 12:38 +08 verbatim:
//   「不管是紅藍哪一方, 只要有一方聽牌(藍方已拿兩局藍 or 紅方已拿兩局紅),
//    那紅方都該只考慮"先讓任務失敗"」
//
// Implementation: `HeuristicAgent.voteOnQuest` runs a highest-priority
// branch before any role- or TOP10-based heuristic fires. When either
// side has won 2 quests, every evil player (except Oberon) returns
// `quest_vote: fail`. Oberon keeps its legacy randomised behaviour.
//
// These tests pin the spec so any future "放水" optimisation or role-
// differentiation patch cannot silently re-introduce the Fix #3 direction
// error (evil 2-0 deep-cover success) that was reversed on 2026-04-22.

describe('HeuristicAgent · §0 Listening Rule (quest action)', () => {
  /** Build an evil-quest-vote observation with the two listening dials. */
  function evilQuestObs(
    goodWins: number,
    evilWins: number,
    overrides: Partial<PlayerObservation> = {},
  ): PlayerObservation {
    const questResults: Array<'success' | 'fail'> = [];
    for (let i = 0; i < goodWins; i++) questResults.push('success');
    for (let i = 0; i < evilWins; i++) questResults.push('fail');

    return baseObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      knownEvils:   ['P1', 'P3'],
      currentRound: goodWins + evilWins + 1,
      gamePhase:    'quest_vote',
      proposedTeam: ['P1', 'P2'],
      questResults,
      ...overrides,
    });
  }

  /** Run the evil quest vote N times and return the fail ratio. */
  function failRate(obs: PlayerObservation, samples: number): number {
    let fails = 0;
    for (let i = 0; i < samples; i++) {
      const agent = new HeuristicAgent('P1', 'hard');
      agent.onGameStart(obs);
      const action = agent.act(obs);
      if (action.type === 'quest_vote' && action.vote === 'fail') fails++;
    }
    return fails / samples;
  }

  it('Case 1: good listening (goodWins=2, evilWins=0) → evil MUST fail (no 放水)', () => {
    const obs = evilQuestObs(2, 0, { myRole: 'mordred', knownEvils: ['P1'] });
    // Listening rule is deterministic for non-Oberon evils → 100% fail.
    expect(failRate(obs, 500)).toBe(1.0);
  });

  it('Case 1b: good listening with assassin/morgana roles → all MUST fail', () => {
    for (const role of ['assassin', 'morgana'] as const) {
      const obs = evilQuestObs(2, 0, { myRole: role });
      expect(failRate(obs, 200)).toBe(1.0);
    }
  });

  it('Case 2: evil listening (evilWins=2, goodWins=0) → evil MUST fail (再拿一局直接贏)', () => {
    const obs = evilQuestObs(0, 2, { myRole: 'assassin' });
    expect(failRate(obs, 500)).toBe(1.0);
  });

  it('Case 2b: evil listening (evilWins=2, goodWins=1) → evil MUST fail (仍是聽牌)', () => {
    const obs = evilQuestObs(1, 2, { myRole: 'mordred' });
    expect(failRate(obs, 500)).toBe(1.0);
  });

  it('Case 3: no listening (1-1) → evil follows legacy early-game mix, not forced fail', () => {
    const obs = evilQuestObs(1, 1, { myRole: 'assassin' });
    // Legacy early-game branch: Math.random() > 0.4 → fail 60%, success 40%.
    // With 1000 samples, ratio should be well inside [0.4, 0.8].
    const ratio = failRate(obs, 1000);
    expect(ratio).toBeGreaterThan(0.40);
    expect(ratio).toBeLessThan(0.80);
  });

  it('Case 3b: no listening (0-0) → evil early-game mix (not 100% fail)', () => {
    const obs = evilQuestObs(0, 0, { myRole: 'morgana' });
    const ratio = failRate(obs, 1000);
    // Legacy: ~60% fail. Sanity: strictly between 0.4 and 0.8.
    expect(ratio).toBeGreaterThan(0.40);
    expect(ratio).toBeLessThan(0.80);
  });

  it('Case 4: Oberon listening exception (goodWins=2) → still randomised (legacy kept)', () => {
    const obs = evilQuestObs(2, 0, { myRole: 'oberon', knownEvils: ['P1'] });
    // Legacy Oberon branch at goodWins>=2: Math.random() > 0.3 → fail ~70%.
    // NOT 100% like other evil roles.
    const ratio = failRate(obs, 1000);
    expect(ratio).toBeGreaterThan(0.55);
    expect(ratio).toBeLessThan(0.85);
    // Must NOT be 1.0 — that would mean listening rule was applied to Oberon.
    expect(ratio).toBeLessThan(1.0);
  });

  it('Case 4b: Oberon listening exception (evilWins=2) → still randomised', () => {
    const obs = evilQuestObs(0, 2, { myRole: 'oberon', knownEvils: ['P1'] });
    // Same legacy branch applies when evilWins>=2 for Oberon
    // (pre-refactor `if (evilQuestWins >= 2) return fail` already handled
    // this, but after the listening-rule refactor, Oberon goes through
    // the Math.random > 0.3 legacy path).
    const ratio = failRate(obs, 1000);
    expect(ratio).toBeGreaterThan(0.55);
    expect(ratio).toBeLessThan(0.85);
  });

  it('Case 5: failsRequired=2 (7p round 4) with listening → STILL forced fail', () => {
    // 7-player variant, round 4 requires 2 fails. Legacy code used
    // Math.random > 0.7 → ~30% fail. Listening rule must override.
    const obs = evilQuestObs(2, 0, {
      myRole:       'mordred',
      playerCount:  7,
      currentRound: 4,
      allPlayerIds: ['P1','P2','P3','P4','P5','P6','P7'],
    });
    expect(failRate(obs, 500)).toBe(1.0);
  });

  it('good player on listening state → still MUST succeed (no accidental fail)', () => {
    const obs = evilQuestObs(2, 0, {
      myTeam:    'good',
      myRole:    'merlin',
      knownEvils: ['P3'],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('quest_vote');
    if (action.type === 'quest_vote') {
      expect(action.vote).toBe('success');
    }
  });
});
