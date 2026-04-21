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
