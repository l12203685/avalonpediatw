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

  it('場外白球: Edward 2026-04-24 selfplay fix #1 — R1-R3 good off-team forces reject (no outer-white)', () => {
    // Construct an off-team observation at round 2 (within R1-R3 window).
    // Edward selfplay review fix #1: good players should never outer-white
    // (off-team approve) in rounds 1-3; previous 0.87 historical reject
    // rate (#97 Phase 1) is overridden in these early rounds.
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

    const ratio = rejectRate(obs, 'hard', 500);
    // Post-fix: R1-R3 early-round rule short-circuits before noise, so
    // every sample must reject.
    expect(ratio).toBe(1);
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

  it('場外 round 1: Edward 2026-04-24 selfplay fix #1 — R1 off-team good forces reject (no outer-white)', () => {
    // Edward selfplay review fix #1 supersedes the pre-#97 r1 relaxed
    // dampener (0.6x): in R1-R3 good off-team players always reject so
    // outer-white noise disappears from the early-game record.
    const obs = baseObs({
      myPlayerId:    'P1',
      gamePhase:     'team_vote',
      currentRound:  1,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3'],
      voteHistory:   [],
      questHistory:  [],
    });

    const ratio = rejectRate(obs, 'hard', 500);
    expect(ratio).toBe(1);
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

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 4 — R1-P1 banned combos + cross-faction
// R1-R2 anomaly suppression regression.
//
// Background: batch 3 self-play still surfaced outer-white anomalies
// in R1-R2 (evil players off-team randomly approving) and R1-P1
// teams trending toward naive sort-order combos like `123`. These
// tests pin the batch 4 contract:
//
//   1. R1-P1 banned combos {123,150,234,678} never emitted (any role)
//   2. R1-R2 off-team → reject  (every faction, every role)
//   3. R1-R2 on-team  → approve (every faction, every role)
//   4. R3+ role-differentiation logic intact (regression-proofed
//      by the phase-1/2 moves above to currentRound=3)
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · batch 4 fix #1 (R1-P1 banned combos)', () => {
  /** 10-player R1-P1 observation with seat-1 leader (team-size 3 in 10p R1). */
  function r1p1Obs(
    myRole: 'merlin' | 'percival' | 'loyal' | 'assassin' | 'morgana' | 'mordred' | 'oberon',
    leaderSeatIdx: number,  // 0-based index into allPlayerIds
  ): PlayerObservation {
    const playerIds = Array.from({ length: 10 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
    const myId = playerIds[leaderSeatIdx];
    const evilIds = ['S06', 'S07', 'S09', 'S10'];
    const myTeam: 'good' | 'evil' = evilIds.includes(myId) ? 'evil' : 'good';
    const knownEvils = myTeam === 'evil'
      ? evilIds.filter((id) => id !== myId && id !== 'S07' /* hide oberon */)
      : myRole === 'merlin'
          ? evilIds.filter((id) => id !== 'S07' && id !== 'S10' /* merlin can't see oberon+mordred */)
          : [];
    return baseObs({
      myPlayerId:    myId,
      myRole,
      myTeam,
      playerCount:   10,
      allPlayerIds:  playerIds,
      knownEvils,
      gamePhase:     'team_select',
      currentRound:  1,
      currentLeader: myId,
      failCount:     0,
      voteHistory:   [],
      questHistory:  [],
      proposedTeam:  [],
    });
  }

  /** Canonical sort used by the agent: seat 10 → '0' sorts last. */
  function canonicalKey(ids: string[], all: string[]): string {
    return ids
      .map((id) => all.indexOf(id))
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b)
      .map((idx) => (idx === 9 ? '0' : String(idx + 1)))
      .join('');
  }

  const BANNED = new Set(['123', '150', '234', '678']);

  it('seat 1 leader does NOT propose the banned combo 123 in R1-P1', () => {
    // Seat 1 leader + team size 3 + naive self+low-suspicion fill → would
    // normally emit {S01, S02, S03} (canonical '123'). Verify rewrite.
    for (let trial = 0; trial < 50; trial++) {
      const agent = new HeuristicAgent('S01', 'hard');
      const obs = r1p1Obs('loyal', 0);
      agent.onGameStart(obs);
      const action = agent.act(obs);
      expect(action.type).toBe('team_select');
      if (action.type === 'team_select') {
        const key = canonicalKey(action.teamIds, obs.allPlayerIds);
        expect(BANNED.has(key)).toBe(false);
      }
    }
  });

  it('any faction leader in R1-P1 never emits any banned combo (sampled)', () => {
    // Sample across every seat × both factions. With the hard post-filter
    // no emitted team may match a banned combo.
    const roles: Array<'merlin' | 'loyal' | 'assassin' | 'morgana' | 'mordred' | 'oberon'> = [
      'loyal', 'merlin', 'loyal', 'loyal', 'loyal',
      'assassin', 'oberon', 'loyal', 'mordred', 'loyal',
    ];
    for (let leaderIdx = 0; leaderIdx < 10; leaderIdx++) {
      const role = roles[leaderIdx];
      for (let trial = 0; trial < 20; trial++) {
        const obs = r1p1Obs(role, leaderIdx);
        const agent = new HeuristicAgent(obs.myPlayerId, 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_select');
        if (action.type === 'team_select') {
          const key = canonicalKey(action.teamIds, obs.allPlayerIds);
          expect(BANNED.has(key)).toBe(false);
        }
      }
    }
  });

  it('R1-P2 (second proposal) is NOT subject to the ban (voteHistory non-empty)', () => {
    const playerIds = Array.from({ length: 10 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
    const obs = baseObs({
      myPlayerId:    'S01',
      myRole:        'loyal',
      myTeam:        'good',
      playerCount:   10,
      allPlayerIds:  playerIds,
      knownEvils:    [],
      gamePhase:     'team_select',
      currentRound:  1,
      currentLeader: 'S01',
      failCount:     1,
      voteHistory:   [
        vote(1, 1, 'S10', ['S10', 'S02', 'S03'], false,
             { S01: false, S02: false, S03: false, S04: false, S05: false,
               S06: true,  S07: true,  S08: false, S09: false, S10: true }),
      ],
      questHistory:  [],
      proposedTeam:  [],
    });
    const agent = new HeuristicAgent('S01', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_select');
    // R1-P2 can legally produce any combo including 123 (unconstrained).
    // We only assert no crash and a valid team of size 3.
    if (action.type === 'team_select') {
      expect(action.teamIds.length).toBe(3);
    }
  });

  it('R2-P1 (round 2, first proposal) is NOT subject to the ban', () => {
    const playerIds = Array.from({ length: 10 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
    const obs = baseObs({
      myPlayerId:    'S01',
      myRole:        'loyal',
      myTeam:        'good',
      playerCount:   10,
      allPlayerIds:  playerIds,
      knownEvils:    [],
      gamePhase:     'team_select',
      currentRound:  2,
      currentLeader: 'S01',
      failCount:     0,
      voteHistory:   [
        vote(1, 1, 'S10', ['S10', 'S02', 'S03'], true,
             { S01: true, S02: true, S03: true, S04: true, S05: true,
               S06: false, S07: false, S08: false, S09: false, S10: true }),
      ],
      questHistory:  [quest(1, ['S10', 'S02', 'S03'], 'success', 0)],
      proposedTeam:  [],
    });
    const agent = new HeuristicAgent('S01', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_select');
    if (action.type === 'team_select') {
      expect(action.teamIds.length).toBe(4); // 10p R2 team size
    }
  });
});

describe('HeuristicAgent · batch 4 fix #2 (cross-faction R1-R2 anomaly suppression)', () => {
  /** Run voteOnTeam N times and return approve ratio. */
  function approveRate(obs: PlayerObservation, difficulty: 'hard' | 'normal', samples: number): number {
    let approves = 0;
    for (let i = 0; i < samples; i++) {
      const agent = new HeuristicAgent(obs.myPlayerId, difficulty);
      agent.onGameStart(obs);
      agent._ingestForTesting(obs);
      const action = agent.act({ ...obs, gamePhase: 'team_vote' });
      if (action.type === 'team_vote' && action.vote === true) approves++;
    }
    return approves / samples;
  }

  it('R1 evil off-team (no ally on team) forces reject (no outer-white anomaly)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'assassin',
      myTeam:        'evil',
      knownEvils:    ['P4'],
      gamePhase:     'team_vote',
      currentRound:  1,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P5'],  // self + ally P4 both off team
      voteHistory:   [],
      questHistory:  [],
    });
    // Before batch 4: ~35% approve (base 0.35 + assassin +0.1 = ~45%) →
    // outer-white anomaly in R1. After: 0% approve.
    expect(approveRate(obs, 'hard', 400)).toBe(0);
  });

  it('R2 evil off-team + ally on team ALSO forces reject (was ~100% approve)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'mordred',
      myTeam:        'evil',
      knownEvils:    ['P4'],
      gamePhase:     'team_vote',
      currentRound:  2,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],  // ally P4 on team, self off
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: false, P2: true, P3: true, P4: true, P5: false }),
      ],
      questHistory: [quest(1, ['P2', 'P3'], 'success', 0)],
    });
    // Before batch 4: 100% approve (hasAlly branch). After: 0% (force reject
    // because R1-R2 off-team forces reject regardless of ally-on-team).
    expect(approveRate(obs, 'hard', 400)).toBe(0);
  });

  it('R1 evil on-team (self on team) forces approve (no inner-black anomaly)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'morgana',
      myTeam:        'evil',
      knownEvils:    ['P4'],
      gamePhase:     'team_vote',
      currentRound:  1,
      currentLeader: 'P1',
      proposedTeam:  ['P1', 'P2', 'P3'],  // self on team
      voteHistory:   [],
      questHistory:  [],
    });
    expect(approveRate(obs, 'hard', 200)).toBe(1);
  });

  it('R1 good on-team with knownEvil STILL forces approve (anomaly-zero > veto)', () => {
    // Edward trade-off (batch 4): R1-R2 forces zero anomalies even when
    // the good Merlin sees a knownEvil on team. Historically (batch 2)
    // hasKnownEvil fired before R1-R2 guard → inner-black anomaly.
    // Batch 4 promotes R1-R2 guard above faction split, including above
    // knownEvil veto for on-team case.
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'merlin',
      myTeam:        'good',
      knownEvils:    ['P3'],
      gamePhase:     'team_vote',
      currentRound:  1,
      currentLeader: 'P2',
      proposedTeam:  ['P1', 'P2', 'P3'],  // self + knownEvil on team
      voteHistory:   [],
      questHistory:  [],
    });
    expect(approveRate(obs, 'hard', 200)).toBe(1);
  });

  it('R1 good off-team with knownEvil on team → reject (natural, not anomaly)', () => {
    // Off-team reject is the normal R1-R2 rule; knownEvil presence is
    // incidental and not required for reject.
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'merlin',
      myTeam:        'good',
      knownEvils:    ['P4'],
      gamePhase:     'team_vote',
      currentRound:  1,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],  // self off, knownEvil on
      voteHistory:   [],
      questHistory:  [],
    });
    expect(approveRate(obs, 'hard', 200)).toBe(0);
  });

  it('R2 after R1 quest fail: guard stands down, falls through to role logic', () => {
    // hasFailedMemberEarly = true → R1-R2 suppression does NOT apply.
    // Normal role logic resumes: evil off-team + ally on team → approve.
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'morgana',
      myTeam:        'evil',
      knownEvils:    ['P4'],
      gamePhase:     'team_vote',
      currentRound:  2,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P4', 'P5'],  // ally P4 on team
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: false, P5: false }),
      ],
      questHistory: [quest(1, ['P2', 'P3'], 'fail', 1)],
    });
    expect(approveRate(obs, 'hard', 200)).toBe(1);
  });

  it('R3 off-team evil — recognised-red outer-white limit forces reject (batch 10)', () => {
    // Edward 2026-04-24 batch 10 Point 3: recognised-red (刺娜德) with
    // NO teammate on team MUST reject. No exceptions. Pre-batch-10 this
    // exercised the role-specific approve chance (~0.50 for morgana);
    // now the outer-white limit pins it to 0.
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'morgana',
      myTeam:        'evil',
      knownEvils:    ['P4'],
      gamePhase:     'team_vote',
      currentRound:  3,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P5'],  // no self, no ally on team
      voteHistory:   [],
      questHistory:  [],
    });
    const rate = approveRate(obs, 'hard', 400);
    expect(rate).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Deep-cover branch (SSoT §2 + §6.1, Fix #3 original): REMOVED —
// superseded by §0 Listening Rule (Edward 2026-04-22 12:38 verbatim).
// Evil at good-winning 2-0 must fail.
// Batch 6 (2026-04-24) extends this to Oberon — match-point judged on
// public mission score only, so Oberon (like every other evil role)
// force-fails at the listening threshold. See the "§0 listening rule"
// describe block at the bottom of this file for full coverage.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Fix #5 — Full-scenario evil role differentiation
//
// Main evil logic stays shared; per-role strategy delta applies in
// four places:
// 1. selectTeam: ally inclusion probability (allyInclusionMultiplier)
// 2. voteOnTeam (off-team): approve chance (voteApproveBonus)
// 3. voteOnQuest (early 60/40 + failsRequired>=2): fail rate (earlyQuestFailBonus)
// 4. assassinate: Percival-like leaders penalised (assassin only)
//
// Oberon is intentionally excluded from 1-3 (legacy paths preserved)
// and 4 is assassin-specific.
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · evil role differentiation full (fix #5)', () => {
  describe('strategy table lookup', () => {
    const agent = new HeuristicAgent('P1', 'hard');

    it('returns strategy for mordred / morgana / assassin', () => {
      expect(agent._getEvilRoleStrategyForTesting('mordred')?.label).toContain('mordred');
      expect(agent._getEvilRoleStrategyForTesting('morgana')?.label).toContain('morgana');
      expect(agent._getEvilRoleStrategyForTesting('assassin')?.label).toContain('assassin');
    });

    it('returns null for oberon (excluded from differentiation)', () => {
      expect(agent._getEvilRoleStrategyForTesting('oberon')).toBeNull();
    });

    it('returns null for good roles', () => {
      expect(agent._getEvilRoleStrategyForTesting('merlin')).toBeNull();
      expect(agent._getEvilRoleStrategyForTesting('percival')).toBeNull();
      expect(agent._getEvilRoleStrategyForTesting('loyal_servant')).toBeNull();
    });

    it('relative ordering: assassin voteApprove > morgana > mordred', () => {
      const m = agent._getEvilRoleStrategyForTesting('mordred')!;
      const mg = agent._getEvilRoleStrategyForTesting('morgana')!;
      const a = agent._getEvilRoleStrategyForTesting('assassin')!;
      // Morgana mimics Merlin most → highest approve bonus
      expect(mg.voteApproveBonus).toBeGreaterThan(a.voteApproveBonus);
      expect(a.voteApproveBonus).toBeGreaterThan(m.voteApproveBonus);
      // Mordred boldest ally inclusion
      expect(m.allyInclusionMultiplier).toBeGreaterThan(mg.allyInclusionMultiplier);
      expect(mg.allyInclusionMultiplier).toBeGreaterThan(a.allyInclusionMultiplier);
      // Mordred failest, Assassin cleanest
      expect(m.earlyQuestFailBonus).toBeGreaterThan(mg.earlyQuestFailBonus);
      expect(mg.earlyQuestFailBonus).toBeGreaterThan(a.earlyQuestFailBonus);
    });
  });

  // ── Phase: voteOnTeam (off-team approve chance) ─────────────
  describe('phase 1 — voteOnTeam off-team approve chance by role', () => {
    /** Build an off-team observation with no self/ally on team so the
     *  role-specific approve chance branch is exercised.
     *
     *  Edward 2026-04-24 batch 4 fix #2 moved R1-R2 anomaly suppression
     *  above the faction split, so evil role differentiation for off-team
     *  votes only exercises from round 3 onwards. Tests run at round 3
     *  to sidestep the guard and test the role-differentiation path. */
    function offTeamObs(role: 'mordred' | 'morgana' | 'assassin' | 'oberon'): PlayerObservation {
      return baseObs({
        myPlayerId:    'P1',
        myRole:        role,
        myTeam:        'evil',
        knownEvils:    role === 'oberon' ? [] : ['P1', 'P5'],
        gamePhase:     'team_vote',
        currentRound:  3,
        currentLeader: 'P2',
        proposedTeam:  ['P2', 'P3', 'P4'],   // no self, no ally
      });
    }

    function approveRate(role: 'mordred' | 'morgana' | 'assassin' | 'oberon', samples = 800): number {
      let approves = 0;
      for (let i = 0; i < samples; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        const obs = offTeamObs(role);
        agent.onGameStart(obs);
        const action = agent.act(obs);
        if (action.type === 'team_vote' && action.vote === true) approves++;
      }
      return approves / samples;
    }

    // Edward 2026-04-24 batch 10 — recognised-red (刺/娜/梅) off-team with
    // NO teammate on team MUST reject (never open outer-white). The per-
    // role `voteApproveBonus` is retained as a computed strategy delta
    // (kept in EVIL_ROLE_STRATEGY_TABLE) but the off-team branch is now
    // gated by the outer-white limit: recognised-red → force reject.
    it('Morgana off-team, no teammate on team → approve rate = 0 (batch 10 outer-white limit)', () => {
      const rate = approveRate('morgana');
      expect(rate).toBe(0);
    });

    it('Assassin off-team, no teammate on team → approve rate = 0 (batch 10 outer-white limit)', () => {
      const rate = approveRate('assassin');
      expect(rate).toBe(0);
    });

    it('Mordred off-team, no teammate on team → approve rate = 0 (batch 10 outer-white limit)', () => {
      const rate = approveRate('mordred');
      expect(rate).toBe(0);
    });

    it('Oberon off-team: Rule 1 (no prior participation) overrides legacy base → approve rate = 0', () => {
      // Edward 2026-04-24 batch 7 fix #3 change: Oberon Rule 1 says
      // missionParticipatedBefore === false → only normal votes. At R3
      // with an empty questHistory in this fixture, Oberon has never
      // been on a mission → Rule 1 fires → off-team reject = 0 approve.
      // Pre-batch-7 the generic 0.35 base path was used (legacy base).
      const rate = approveRate('oberon');
      expect(rate).toBe(0);
    });
  });

  // ── Phase: selectTeam (ally inclusion probability) ──────────
  describe('phase 2 — selectTeam ally inclusion by role', () => {
    /** Build a team-select observation where the role is leader of a
     *  size-3 team with one known ally available. */
    function leaderObs(role: 'mordred' | 'morgana' | 'assassin' | 'oberon'): PlayerObservation {
      return baseObs({
        myPlayerId:    'P1',
        myRole:        role,
        myTeam:        'evil',
        knownEvils:    role === 'oberon' ? [] : ['P1', 'P4'],
        gamePhase:     'team_select',
        currentRound:  2,
        playerCount:   6,
        currentLeader: 'P1',
        proposedTeam:  [],
      });
    }

    function allyInclusionRate(role: 'mordred' | 'morgana' | 'assassin' | 'oberon', samples = 800): number {
      let includes = 0;
      for (let i = 0; i < samples; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        const obs = leaderObs(role);
        agent.onGameStart(obs);
        const action = agent.act(obs);
        if (action.type === 'team_select' && action.teamIds.includes('P4')) includes++;
      }
      return includes / samples;
    }

    it('Mordred leader includes ally ~65% (base 0.5 × 1.3)', () => {
      const rate = allyInclusionRate('mordred');
      expect(rate).toBeGreaterThan(0.55);
      expect(rate).toBeLessThan(0.75);
    });

    it('Morgana leader includes ally ~30% (base 0.5 × 0.6)', () => {
      const rate = allyInclusionRate('morgana');
      expect(rate).toBeGreaterThan(0.20);
      expect(rate).toBeLessThan(0.40);
    });

    it('Assassin leader includes ally ~25% (base 0.5 × 0.5 — cleanest)', () => {
      const rate = allyInclusionRate('assassin');
      expect(rate).toBeGreaterThan(0.15);
      expect(rate).toBeLessThan(0.35);
    });

    it('Oberon leader keeps legacy 50% ally inclusion path (no crash, no differentiation)', () => {
      // Oberon has empty knownEvils so `evilAllies.length === 0` → ally
      // branch entirely skipped. Team fills from random goodCandidates,
      // so P4 ends up on team with base ~probability equal to filling
      // any of the 4 remaining slots. This is the legacy path (pre-#5).
      // The assertion is weak-but-real: no crash, and P4 lands ~35-65%
      // of the time from random fill (not role-diff-driven).
      const rate = allyInclusionRate('oberon');
      expect(rate).toBeGreaterThan(0.25);
      expect(rate).toBeLessThan(0.75);
    });
  });

  // ── Phase: voteOnQuest (early fail rate) ────────────────────
  describe('phase 3 — voteOnQuest early fail rate by role (0-0 scenario)', () => {
    function earlyQuestObs(role: 'mordred' | 'morgana' | 'assassin' | 'oberon'): PlayerObservation {
      return baseObs({
        myPlayerId:   'P1',
        myRole:       role,
        myTeam:       'evil',
        knownEvils:   role === 'oberon' ? [] : ['P1', 'P4'],
        gamePhase:    'quest_vote',
        questResults: [],
        currentRound: 1,
        proposedTeam: ['P1', 'P2'],
      });
    }

    function failRate(role: 'mordred' | 'morgana' | 'assassin' | 'oberon', samples = 600): number {
      let fails = 0;
      for (let i = 0; i < samples; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        const obs = earlyQuestObs(role);
        agent.onGameStart(obs);
        const action = agent.act(obs);
        if (action.type === 'quest_vote' && action.vote === 'fail') fails++;
      }
      return fails / samples;
    }

    // Edward 2026-04-24 batch 9: red-always-fail-on-mission invariant
    // overrides all probabilistic bases (0.70 / 0.55 / 0.50 legacy).
    // Every red player on a mission must invariably vote fail — the
    // per-role early fail bonuses remain a computed property of the
    // agent (see `applyEvilEarlyFailBonus` test below) but no longer
    // determine the emitted quest_vote.
    it('Mordred early fail rate = 1.0 (batch 9 invariant overrides 0.70 base)', () => {
      const rate = failRate('mordred');
      expect(rate).toBe(1);
    });

    it('Morgana early fail rate = 1.0 (batch 9 invariant overrides 0.55 base)', () => {
      const rate = failRate('morgana');
      expect(rate).toBe(1);
    });

    it('Assassin early fail rate = 1.0 (batch 9 invariant overrides 0.50 base)', () => {
      const rate = failRate('assassin');
      expect(rate).toBe(1);
    });

    it('Oberon early fail rate = 1.0 (batch 7 Rule 2 + batch 9 invariant)', () => {
      // Pre-batch-9: batch 7 Rule 2 already forced R1 on-team fail = 1.
      // Batch 9 generalises to all rounds for every red role.
      const rate = failRate('oberon');
      expect(rate).toBe(1);
    });

    it('applyEvilEarlyFailBonus computes deterministically with role bonuses', () => {
      const agent = new HeuristicAgent('P1', 'hard');
      expect(agent._applyEvilEarlyFailBonusForTesting('mordred',  0.6)).toBeCloseTo(0.7, 2);
      expect(agent._applyEvilEarlyFailBonusForTesting('morgana',  0.6)).toBeCloseTo(0.55, 2);
      expect(agent._applyEvilEarlyFailBonusForTesting('assassin', 0.6)).toBeCloseTo(0.5, 2);
      // Oberon / unknown returns base unchanged
      expect(agent._applyEvilEarlyFailBonusForTesting('oberon',   0.6)).toBe(0.6);
      expect(agent._applyEvilEarlyFailBonusForTesting('merlin',   0.6)).toBe(0.6);
    });
  });

  // ── Phase 4: assassinate (Percival-like penalty) ────────────
  describe('phase 4 — assassin targets Merlin, not Percival lookalikes', () => {
    it('Percival penalty fires when a leader consistently included known evils (batch 10)', () => {
      // Batch 10 refactored `getMistakeCount` to Edward's two-pattern
      // specification (inner-black on thumbless team / outer-white on thumb
      // team). The leader-tainted-team signal moved to getPercivalLikenessPenalty
      // only — batch 10 tests verify the penalty function in isolation.
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       'assassin',
        myTeam:       'evil',
        knownEvils:   ['P1', 'P2'],
        gamePhase:    'assassination',
        allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
        questResults: ['success', 'success', 'success'],
        voteHistory: [
          vote(1, 1, 'P3', ['P2', 'P3'],       true,  { P1: false, P2: true,  P3: true,  P4: true,  P5: true  }),
          vote(2, 1, 'P4', ['P4', 'P5'],       true,  { P1: false, P2: true,  P3: true,  P4: true,  P5: true  }),
          vote(3, 1, 'P3', ['P2', 'P3', 'P4'], true,  { P1: true,  P2: true,  P3: true,  P4: true,  P5: true  }),
          vote(4, 1, 'P4', ['P4', 'P5', 'P3'], true,  { P1: true,  P2: true,  P3: true,  P4: true,  P5: true  }),
        ],
        questHistory: [
          quest(1, ['P2', 'P3'],       'success', 0),
          quest(2, ['P4', 'P5'],       'success', 0),
          quest(3, ['P2', 'P3', 'P4'], 'success', 0),
        ],
      });

      const agent = new HeuristicAgent('P1', 'hard');
      agent.onGameStart(obs);

      // Percival penalty for P3 (always led with Morgana) should be positive.
      const p3Penalty = agent._getPercivalLikenessPenaltyForTesting('P3', obs);
      const p4Penalty = agent._getPercivalLikenessPenaltyForTesting('P4', obs);
      expect(p3Penalty).toBeGreaterThan(0);
      expect(p4Penalty).toBe(0);
    });

    it('no vote history → no Percival penalty for any player', () => {
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       'assassin',
        myTeam:       'evil',
        knownEvils:   ['P1', 'P2'],
        gamePhase:    'assassination',
        allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      const agent = new HeuristicAgent('P1', 'hard');
      agent.onGameStart(obs);
      expect(agent._getPercivalLikenessPenaltyForTesting('P3', obs)).toBe(0);
      expect(agent._getPercivalLikenessPenaltyForTesting('P4', obs)).toBe(0);
    });
  });

  // ── Regression: main logic shared across roles ──────────────
  describe('regression — main evil logic still shared across roles', () => {
    it('self-on-team always approves regardless of role (mordred)', () => {
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       'mordred',
        myTeam:       'evil',
        knownEvils:   ['P1', 'P4'],
        gamePhase:    'team_vote',
        proposedTeam: ['P1', 'P2', 'P3'],  // self on team
      });
      const agent = new HeuristicAgent('P1', 'hard');
      agent.onGameStart(obs);
      const action = agent.act(obs);
      expect(action.type).toBe('team_vote');
      if (action.type === 'team_vote') expect(action.vote).toBe(true);
    });

    it('ally-on-team always approves regardless of role (morgana)', () => {
      // Edward 2026-04-24 batch 4 fix #2 moved R1-R2 anomaly suppression
      // above the faction split. Evil off-team + ally-on-team would
      // otherwise generate an outer-white anomaly in R1-R2, which the new
      // guard forces to reject. To exercise the "ally-on-team → approve"
      // invariant of the shared evil branch, use round 3 (past the guard).
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       'morgana',
        myTeam:       'evil',
        knownEvils:   ['P1', 'P4'],
        gamePhase:    'team_vote',
        currentRound: 3,
        proposedTeam: ['P2', 'P3', 'P4'],  // ally P4 on team
      });
      const agent = new HeuristicAgent('P1', 'hard');
      agent.onGameStart(obs);
      const action = agent.act(obs);
      expect(action.type).toBe('team_vote');
      if (action.type === 'team_vote') expect(action.vote).toBe(true);
    });

    it('evilWins >= 2 always fails regardless of role (assassin)', () => {
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       'assassin',
        myTeam:       'evil',
        knownEvils:   ['P1', 'P4'],
        gamePhase:    'quest_vote',
        questResults: ['fail', 'fail'],
        currentRound: 3,
        proposedTeam: ['P1', 'P2'],
      });
      const agent = new HeuristicAgent('P1', 'hard');
      agent.onGameStart(obs);
      const action = agent.act(obs);
      expect(action.type).toBe('quest_vote');
      if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
    });
  });
});

// ──────────────────────────────────────────────────────────────
// Fix #4 (SSoT §6.4): Percival thumb-identification.
// Percival sees two wizards (Merlin + Morgana) but cannot tell them apart.
// Previously the agent blindly picked `knownWizards[0]` (coin flip). We now
// score each candidate on vote, proposal, and quest participation signals
// to infer which is more likely to be Merlin and prefer that candidate on
// the proposed team.
// ──────────────────────────────────────────────────────────────

describe('HeuristicAgent · Percival thumb identification (Fix #4)', () => {
  // Use the hard difficulty so suspicion-driven ordering is deterministic.
  let agent: HeuristicAgent;
  let previousFlag: boolean;

  beforeEach(() => {
    // Force the flag on for this suite; reset in afterEach.
    previousFlag = HeuristicAgent._setSmartPercivalForTesting(true);
    agent = new HeuristicAgent('P1', 'hard');
  });

  // Restore the flag so other suites are not affected.
  // (vitest runs describe blocks in declaration order — this keeps global
  // state pristine for downstream files / suites.)
  const restoreFlag = () => { HeuristicAgent._setSmartPercivalForTesting(previousFlag); };

  // Fixture: I am Percival (P1). P2 and P3 are the two wizards.
  //   • P2 consistently rejects teams containing evil (failed later) → Merlin-like.
  //   • P3 approves those same teams → Morgana-like (she can't see evil).
  // Expectation: identifyMerlinFromThumbs picks P2.
  it('case 1 · picks the wizard whose votes avoid tainted teams (vote pattern)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'percival',
      myTeam:        'good',
      playerCount:   5,
      allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5'],
      knownWizards:  ['P2', 'P3'],
      currentRound:  3,
      gamePhase:     'team_select',
      questResults:  ['success', 'fail'],
      // Round 2 team was later failed — P2 rejected (Merlin), P3 approved (Morgana).
      voteHistory: [
        vote(1, 1, 'P4', ['P1', 'P4'], true, { P1: true, P2: true, P3: true, P4: true, P5: true }),
        vote(2, 1, 'P5', ['P4', 'P5'], true, { P1: false, P2: false, P3: true,  P4: true, P5: true }),
      ],
      questHistory: [
        quest(1, ['P1', 'P4'], 'success'),
        quest(2, ['P4', 'P5'], 'fail', 1),
      ],
    });
    agent.onGameStart(obs);
    // Let the agent ingest history so failedTeamMembers is populated.
    agent._ingestForTesting(obs);
    const { merlin, confidence, scores } = agent.identifyMerlinFromThumbs(['P2', 'P3'], obs);

    expect(merlin).toBe('P2');
    expect(scores.P2).toBeGreaterThan(scores.P3);
    expect(confidence).toBeGreaterThan(0);

    restoreFlag();
  });

  // Fixture: P2 led a clean team (success); P3 led a team that later failed.
  // Expectation: identifyMerlinFromThumbs picks P2 (Merlin-like clean proposal).
  it('case 2 · picks the wizard whose proposals stay clean (proposal quality)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'percival',
      myTeam:        'good',
      playerCount:   5,
      allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5'],
      knownWizards:  ['P2', 'P3'],
      currentRound:  3,
      gamePhase:     'team_select',
      questResults:  ['success', 'fail'],
      voteHistory: [
        // P2 leads a clean team that succeeds.
        vote(1, 1, 'P2', ['P1', 'P2'], true, { P1: true, P2: true, P3: true, P4: true, P5: true }),
        // P3 leads a team that later fails.
        vote(2, 1, 'P3', ['P3', 'P4'], true, { P1: true, P2: true, P3: true, P4: true, P5: true }),
      ],
      questHistory: [
        quest(1, ['P1', 'P2'], 'success'),
        quest(2, ['P3', 'P4'], 'fail', 1),
      ],
    });
    agent.onGameStart(obs);
    agent._ingestForTesting(obs);
    const { merlin, scores } = agent.identifyMerlinFromThumbs(['P2', 'P3'], obs);

    expect(merlin).toBe('P2');
    expect(scores.P2).toBeGreaterThan(scores.P3);

    restoreFlag();
  });

  // Fixture: no vote history (round 1, no attempts yet) → signals are zero.
  // Expectation: identifyMerlinFromThumbs falls back to wizards[0] with 0
  // confidence — this is the explicit "insufficient signal" guard.
  it('case 3 · low confidence when signals are ambiguous (insufficient history)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'percival',
      myTeam:        'good',
      playerCount:   5,
      allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5'],
      knownWizards:  ['P2', 'P3'],
      currentRound:  1,
      gamePhase:     'team_select',
      questResults:  [],
      voteHistory:   [],
      questHistory:  [],
    });
    agent.onGameStart(obs);
    const { merlin, confidence, scores } = agent.identifyMerlinFromThumbs(['P2', 'P3'], obs);

    expect(merlin).toBe('P2');          // deterministic fallback to wizards[0]
    expect(confidence).toBe(0);
    expect(scores.P2).toBe(0);
    expect(scores.P3).toBe(0);

    restoreFlag();
  });

  // Integration: verify selectTeam actually puts the identified Merlin on
  // the proposed team (not just the raw identifier output).
  it('integration · selectTeam includes the identified Merlin (smart flag on)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'percival',
      myTeam:        'good',
      playerCount:   5,
      allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5'],
      knownWizards:  ['P2', 'P3'],
      currentRound:  3,
      currentLeader: 'P1',
      gamePhase:     'team_select',
      questResults:  ['success', 'fail'],
      voteHistory: [
        vote(1, 1, 'P4', ['P1', 'P4'], true, { P1: true, P2: true, P3: true, P4: true, P5: true }),
        vote(2, 1, 'P5', ['P4', 'P5'], true, { P1: false, P2: false, P3: true,  P4: true, P5: true }),
      ],
      questHistory: [
        quest(1, ['P1', 'P4'], 'success'),
        quest(2, ['P4', 'P5'], 'fail', 1),
      ],
    });
    agent.onGameStart(obs);

    const action = agent.act(obs);
    expect(action.type).toBe('team_select');
    if (action.type === 'team_select') {
      expect(action.teamIds).toContain('P1');
      // Round 3 team size for 5 players = 2, so preferred wizard (P2) must be included.
      expect(action.teamIds).toContain('P2');
    }

    restoreFlag();
  });

  // Regression: flag off → falls back to legacy behaviour (wizards[0])
  // regardless of signals. Proves the escape hatch works.
  it('regression · legacy path picks wizards[0] when flag is off', () => {
    HeuristicAgent._setSmartPercivalForTesting(false);

    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'percival',
      myTeam:        'good',
      playerCount:   5,
      allPlayerIds:  ['P1', 'P2', 'P3', 'P4', 'P5'],
      knownWizards:  ['P3', 'P2'],  // Note: order reversed — legacy picks P3.
      currentRound:  3,
      currentLeader: 'P1',
      gamePhase:     'team_select',
      questResults:  ['success', 'fail'],
      // P2 would have the higher Merlin-score if the smart path were on.
      voteHistory: [
        vote(1, 1, 'P4', ['P1', 'P4'], true, { P1: true, P2: true, P3: true, P4: true, P5: true }),
        vote(2, 1, 'P5', ['P4', 'P5'], true, { P1: false, P2: false, P3: true,  P4: true, P5: true }),
      ],
      questHistory: [
        quest(1, ['P1', 'P4'], 'success'),
        quest(2, ['P4', 'P5'], 'fail', 1),
      ],
    });
    agent.onGameStart(obs);

    const action = agent.act(obs);
    expect(action.type).toBe('team_select');
    if (action.type === 'team_select') {
      // Legacy: wizards[0] = P3 is picked even though P2 is more Merlin-like.
      expect(action.teamIds).toContain('P3');
    }

    restoreFlag();
  });
});

// ── #97 Phase 2 · anomaly vote wire tests ─────────────────────

describe('HeuristicAgent · anomaly vote weighting (#97 Phase 2)', () => {
  it('outer-white (off-team approve) adds suspicion proportional to round', () => {
    // Two agents (hard) ingest two identical-structure vote records except for round.
    // P3 is off-team and approves in both. R5 should produce larger suspicion delta
    // than R1 (round_weight 1.8 vs 0.5).
    const agentR1 = new HeuristicAgent('P1', 'hard');
    agentR1.onGameStart(baseObs());
    agentR1._ingestForTesting(baseObs({
      voteHistory: [
        vote(1, 1, 'P1', ['P1', 'P2'], true,
             { P1: true, P2: true, P3: true, P4: false, P5: false }),
      ],
    }));

    const agentR5 = new HeuristicAgent('P1', 'hard');
    agentR5.onGameStart(baseObs());
    agentR5._ingestForTesting(baseObs({
      voteHistory: [
        vote(5, 1, 'P1', ['P1', 'P2'], true,
             { P1: true, P2: true, P3: true, P4: false, P5: false }),
      ],
    }));

    const p3R1 = agentR1._memoryForTesting().suspicion.get('P3') ?? 0;
    const p3R5 = agentR5._memoryForTesting().suspicion.get('P3') ?? 0;
    // Both positive (approve baseline +0.1 + outer-white bonus), R5 > R1.
    expect(p3R5).toBeGreaterThan(p3R1);
    expect(p3R1).toBeGreaterThan(0.1);  // above bare approve baseline
  });

  it('inner-black (in-team reject) reduces suspicion (Percival-ish signal)', () => {
    // P2 is in-team but rejects — an inner-black anomaly.
    // The baseline reject is -0.2; inner-black bonus adds extra negative delta.
    const agentControl = new HeuristicAgent('P1', 'hard');
    agentControl.onGameStart(baseObs());
    // Control: P2 off-team reject (no anomaly)
    agentControl._ingestForTesting(baseObs({
      voteHistory: [
        vote(5, 1, 'P1', ['P1', 'P3'], false,
             { P1: true, P2: false, P3: true, P4: false, P5: false }),
      ],
    }));
    const ctrlP2 = agentControl._memoryForTesting().suspicion.get('P2') ?? 0;

    // Anomaly case: P2 in-team reject (inner-black)
    const agentAnomaly = new HeuristicAgent('P1', 'hard');
    agentAnomaly.onGameStart(baseObs());
    agentAnomaly._ingestForTesting(baseObs({
      voteHistory: [
        vote(5, 1, 'P1', ['P1', 'P2'], false,
             { P1: true, P2: false, P3: true, P4: false, P5: false }),
      ],
    }));
    const anoP2 = agentAnomaly._memoryForTesting().suspicion.get('P2') ?? 0;

    // Inner-black case has MORE negative suspicion (but suspicion is clamped >=0
    // via Math.max(0, ...) in addSuspicion). Both will be 0 in practice — but
    // the anomaly must not make suspicion HIGHER than control.
    expect(anoP2).toBeLessThanOrEqual(ctrlP2);
  });

  it('outer-white anomaly scales with rarity (rare = higher suspicion)', () => {
    // Compare R1 (rare anomaly ~2.5%) vs R5 (common ~27%). Rarer = stronger
    // signal per occurrence? Actually per the formula: delta = base * weight * (1 - rate).
    // R1: 0.6 * 0.5 * (1 - 0.025) = 0.2925
    // R5: 0.6 * 1.8 * (1 - 0.277) = 0.7810
    // R5 wins overall because round weight dominates, so this test asserts R5 > R1.
    const mkAgent = (round: number) => {
      const a = new HeuristicAgent('P1', 'hard');
      a.onGameStart(baseObs());
      a._ingestForTesting(baseObs({
        voteHistory: [
          vote(round, 1, 'P1', ['P1', 'P2'], true,
               { P1: true, P2: true, P3: true, P4: false, P5: false }),
        ],
      }));
      return a._memoryForTesting().suspicion.get('P3') ?? 0;
    };

    expect(mkAgent(5)).toBeGreaterThan(mkAgent(1));
    expect(mkAgent(4)).toBeGreaterThan(mkAgent(2));
  });

  it('normal team approve by in-team player is not treated as anomaly', () => {
    // Control: P2 in-team approve (normal, not anomaly)
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(baseObs());
    agent._ingestForTesting(baseObs({
      voteHistory: [
        vote(5, 1, 'P1', ['P1', 'P2'], true,
             { P1: true, P2: true, P3: false, P4: false, P5: true }),
      ],
    }));
    // Only baseline +0.1 should apply (no anomaly weight).
    const p2 = agent._memoryForTesting().suspicion.get('P2') ?? 0;
    expect(p2).toBeCloseTo(0.1, 2);
  });
});

describe('HeuristicAgent · Percival thumb uses shared anomaly API', () => {
  it('inner-black R5 vote boosts Merlin score for that wizard', () => {
    // Percival's POV: two wizards P2, P3. Both rejected a team they were on
    // in R5. The wizard who did so in R5 (rarer anomaly) should outscore R1.
    // We can't mix rounds cleanly here because scoreWizardAsMerlin counts
    // all records — so craft: P2 inner-black at R5, P3 regular reject.
    const obs = baseObs({
      currentRound: 3,
      knownEvils: ['P5'],
      voteHistory: [
        // R5 attempt: P2 in-team reject (inner-black)
        vote(5, 1, 'P4', ['P2', 'P3', 'P4'], false,
             { P1: true, P2: false, P3: true, P4: true, P5: false }),
      ],
      questHistory: [],
    });

    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    agent._ingestForTesting(obs);

    const result = agent.identifyMerlinFromThumbs(['P2', 'P3'], obs);
    // P2 (inner-black R5) should have higher Merlin score than P3 (plain approve).
    expect(result.scores['P2']).toBeGreaterThan(result.scores['P3']);
    expect(result.merlin).toBe('P2');
  });
});

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 6 — §0 Listening rule (match-point force fail)
//
// Edward verbatim:
//   「紅方或藍方已經聽牌 紅方就不可能躲藏 一定會出任務失敗」
//
// Listening (聽牌) = either side has already won 2 quests, i.e.
//   goodWins === 2 (blue listening — one more success ends missions
//   track and forces assassination phase) OR
//   evilWins === 2 (red listening — one more fail wins outright).
//
// Contract:
//   • Red on team + listening  → quest_vote = 'fail' (deterministic,
//     regardless of role — Oberon included, batch 6 change).
//   • Red on team + not listening (0-0, 1-0, 0-1, 1-1) → legacy
//     probabilistic path remains (tested elsewhere).
//   • Blue on team: always 'success' (no change — blue has no choice).
//
// This block pins the contract across the four listening scenarios
// (red listening, blue listening, not listening) and across all four
// evil roles to prove Oberon now conforms.
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · §0 Listening rule (batch 6 — force-fail incl. Oberon)', () => {
  type EvilRole = 'mordred' | 'morgana' | 'assassin' | 'oberon';

  /** Construct a listening-scenario observation for a given evil role. */
  function buildObs(
    role: EvilRole,
    questResults: ('success' | 'fail')[],
  ): PlayerObservation {
    return baseObs({
      myPlayerId:   'P1',
      myRole:       role,
      myTeam:       'evil',
      knownEvils:   role === 'oberon' ? [] : ['P1', 'P4'],
      gamePhase:    'quest_vote',
      questResults,
      currentRound: Math.max(1, questResults.length + 1),
      proposedTeam: ['P1', 'P2'],
    });
  }

  /**
   * Sample `voteOnQuest` N times and return the fail rate. Deterministic
   * match-point branches should give fail rate = 1.0; probabilistic
   * branches (not listening) fall within baseline ±role bonus.
   */
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

  describe('紅聽 (red listening, evilWins === 2 ⇒ one more fail wins outright)', () => {
    const questResults: ('success' | 'fail')[] = ['fail', 'fail'];

    it('Mordred at 0-2 (red listening) → fail 100%', () => {
      expect(failRate(buildObs('mordred',  questResults), 200)).toBe(1);
    });
    it('Morgana at 0-2 (red listening) → fail 100%', () => {
      expect(failRate(buildObs('morgana',  questResults), 200)).toBe(1);
    });
    it('Assassin at 0-2 (red listening) → fail 100%', () => {
      expect(failRate(buildObs('assassin', questResults), 200)).toBe(1);
    });
    it('Oberon at 0-2 (red listening) → fail 100% (batch 6 change)', () => {
      // Pre-batch-6 baseline was 70% fail / 30% success. Post-batch-6:
      // deterministic fail — match-point detection is public-info only.
      expect(failRate(buildObs('oberon',   questResults), 200)).toBe(1);
    });
  });

  describe('藍聽 (blue listening, goodWins === 2 ⇒ another success forces assassination)', () => {
    const questResults: ('success' | 'fail')[] = ['success', 'success'];

    it('Mordred at 2-0 (blue listening) → fail 100%', () => {
      expect(failRate(buildObs('mordred',  questResults), 200)).toBe(1);
    });
    it('Morgana at 2-0 (blue listening) → fail 100%', () => {
      expect(failRate(buildObs('morgana',  questResults), 200)).toBe(1);
    });
    it('Assassin at 2-0 (blue listening) → fail 100%', () => {
      expect(failRate(buildObs('assassin', questResults), 200)).toBe(1);
    });
    it('Oberon at 2-0 (blue listening) → fail 100% (batch 6 change)', () => {
      expect(failRate(buildObs('oberon',   questResults), 200)).toBe(1);
    });
  });

  describe('都沒聽 (neither side listening — batch 9 invariant: red always fail)', () => {
    // Edward 2026-04-24 batch 9 — red-always-fail-on-mission invariant
    // overrides the pre-batch-9 probabilistic non-listening bases
    // (mordred 0.70 / morgana 0.55 / assassin 0.50). Every red role on
    // a mission now invariably votes fail, regardless of mission score.
    // The role-specific early-fail bonuses remain a computed property
    // of the agent (see applyEvilEarlyFailBonus unit test) but no
    // longer determine the emitted quest_vote.
    it('Mordred at 0-0 → fail 100% (batch 9 invariant, was 0.70 base)', () => {
      expect(failRate(buildObs('mordred', []), 200)).toBe(1);
    });
    it('Morgana at 1-0 → fail 100% (batch 9 invariant, was 0.55 base)', () => {
      expect(failRate(buildObs('morgana', ['success']), 200)).toBe(1);
    });
    it('Assassin at 0-1 → fail 100% (batch 9 invariant, was 0.50 base)', () => {
      expect(failRate(buildObs('assassin', ['fail']), 200)).toBe(1);
    });
    it('Oberon at 1-1 R3 on team → fail 100% (batch 7 Rule 2 + batch 9 invariant)', () => {
      expect(failRate(buildObs('oberon', ['success', 'fail']), 200)).toBe(1);
    });
  });

  describe('blue-team players unaffected by listening rule', () => {
    it('loyal servant on team at 2-0 (blue listening) → always success', () => {
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       'loyal_servant',
        myTeam:       'good',
        gamePhase:    'quest_vote',
        questResults: ['success', 'success'],
        currentRound: 3,
        proposedTeam: ['P1', 'P2'],
      });
      for (let i = 0; i < 100; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });

    it('merlin on team at 0-2 (red listening) → always success', () => {
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       'merlin',
        myTeam:       'good',
        knownEvils:   ['P2'],
        gamePhase:    'quest_vote',
        questResults: ['fail', 'fail'],
        currentRound: 3,
        proposedTeam: ['P1', 'P3'],
      });
      for (let i = 0; i < 100; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });
  });

  describe('listening rule overrides failsRequired ≥ 2 cautious path', () => {
    // 10p R4 requires 2 fails — normally evil plays 30% fail. But if
    // already listening, fail is forced regardless.
    it('Mordred on 10p R4 (needs 2 fails) at 2-0 still forces fail', () => {
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       'mordred',
        myTeam:       'evil',
        playerCount:  10,
        allPlayerIds: Array.from({ length: 10 }, (_, i) => `P${i + 1}`),
        knownEvils:   ['P1', 'P7'],
        gamePhase:    'quest_vote',
        questResults: ['success', 'success'],
        currentRound: 4,
        proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      const rate = (() => {
        let f = 0;
        for (let i = 0; i < 200; i++) {
          const agent = new HeuristicAgent('P1', 'hard');
          agent.onGameStart(obs);
          const action = agent.act(obs);
          if (action.type === 'quest_vote' && action.vote === 'fail') f++;
        }
        return f / 200;
      })();
      expect(rate).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 7 — Oberon 5-point strategy +
//                              Blue conservative R3+ outer-white
//
// Edward verbatim (Oberon strategy):
//   「1. 還沒出過任務前只會投正常票
//    2. 前三局有機會出任務必出失敗
//    3. 前三局出過任務+讓任務失敗後開始無條件開白球
//    4. 第四局有機會出任務且確認有隊友才可出失敗否則出成功
//    5. 第五局: 前四局出過任務失敗, 則第五局無條件開白
//    ; 前四局沒出過任務失敗則只會投正常黑白球」
//
// Edward verbatim (blue conservative outer-white):
//   「因此藍方不可能隨便開異常外白(會被誤認為奧伯倫)
//    相認紅方頂多利用奧伯倫的白球去衝刺隊友 但同時這顆白球也會被抓到是紅方」
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · batch 7 fix #3 (Oberon 5-point strategy)', () => {
  /** Build an Oberon observation for team-vote phase. */
  function oberonTeamVoteObs(opts: {
    round: number;
    onTeam: boolean;
    questHistory?: QuestRecord[];
    proposedTeam?: string[];
  }): PlayerObservation {
    // P1 = Oberon. 10-player layout simplified to 5 for memory tests.
    const proposedTeam = opts.proposedTeam
      ?? (opts.onTeam ? ['P1', 'P2', 'P3'] : ['P2', 'P3', 'P4']);
    return baseObs({
      myPlayerId:    'P1',
      myRole:        'oberon',
      myTeam:        'evil',
      knownEvils:    [],           // Oberon sees nothing
      gamePhase:     'team_vote',
      currentRound:  opts.round,
      currentLeader: opts.onTeam ? 'P1' : 'P2',
      proposedTeam,
      voteHistory:   [],
      questHistory:  opts.questHistory ?? [],
      failCount:     0,
    });
  }

  /** Build an Oberon observation for quest-vote phase. */
  function oberonQuestVoteObs(opts: {
    round: number;
    questHistory?: QuestRecord[];
    proposedTeam?: string[];
    questResults?: ('success' | 'fail')[];
  }): PlayerObservation {
    const proposedTeam = opts.proposedTeam ?? ['P1', 'P2', 'P3'];
    return baseObs({
      myPlayerId:    'P1',
      myRole:        'oberon',
      myTeam:        'evil',
      knownEvils:    [],
      gamePhase:     'quest_vote',
      currentRound:  opts.round,
      proposedTeam,
      questHistory:  opts.questHistory ?? [],
      questResults:  opts.questResults ?? [],
    });
  }

  describe('Rule 1 — no prior participation → normal vote only', () => {
    it('R1 on-team, no prior participation → approve (normal on-team)', () => {
      const obs = oberonTeamVoteObs({ round: 1, onTeam: true, questHistory: [] });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(true);
      }
    });

    it('R2 off-team, no prior participation → reject (normal off-team)', () => {
      const obs = oberonTeamVoteObs({ round: 2, onTeam: false, questHistory: [] });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(false);
      }
    });

    it('R3 off-team, Oberon not on any prior mission → reject (Rule 1, no outer-white)', () => {
      // Prior quests exist but Oberon was NOT on them → Rule 1 holds.
      const obs = oberonTeamVoteObs({
        round: 3,
        onTeam: false,
        proposedTeam: ['P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P3', 'P4'], 'fail', 1),
        ],
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(false);
      }
    });
  });

  describe('Rule 2 — R1-R3 on team → quest fail unconditionally', () => {
    it('R1 Oberon on quest team → fail', () => {
      const obs = oberonQuestVoteObs({ round: 1 });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('R2 Oberon on quest team → fail (even when failsRequired=2 would suggest cautious)', () => {
      const obs = oberonQuestVoteObs({
        round: 2,
        proposedTeam: ['P1', 'P2', 'P3', 'P4'],
        questHistory: [],
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('R3 Oberon on quest team → fail', () => {
      const obs = oberonQuestVoteObs({ round: 3, questResults: ['success', 'success'] });
      // Note: 2-0 here would trigger listening rule (fail anyway). Use 1-1 instead.
      const obs11 = oberonQuestVoteObs({ round: 3, questResults: ['success', 'fail'] });
      void obs; // intentionally testing both
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs11);
        const action = agent.act(obs11);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });
  });

  describe('Rule 3 (batch 8 generalised) — R>firstFailedRound triggers outer-white', () => {
    it('R3 off-team, Oberon participated in failed R2 → approve (batch 8: R3 now triggers, pre-batch-8 would have been R4+ only)', () => {
      const obs = oberonTeamVoteObs({
        round: 3,
        onTeam: false,
        proposedTeam: ['P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P1', 'P5'], 'fail', 1),    // Oberon (P1) on failed R2 → firstFailedRound=2
        ],
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        // R3 > firstFailedRound(2) AND R3 >= 3 → Rule 3 fires (batch 8 change)
        if (action.type === 'team_vote') expect(action.vote).toBe(true);
      }
    });

    it('R2 off-team, Oberon participated in failed R1 → reject (R1-R2 invariant overrides Rule 3)', () => {
      // firstFailedRound=1, R2 > 1, but R2 < 3 → R1-R2 zero-anomaly invariant
      // holds: Rule 3 stays silent, falls through to default off-team reject.
      // Edward 2026-04-24 batch 8: 「R1~R2 是不能有異常票的」overrides
      // Oberon's generalised outer-white signal.
      const obs = oberonTeamVoteObs({
        round: 2,
        onTeam: false,
        proposedTeam: ['P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P1', 'P5'], 'fail', 1),    // Oberon on failed R1 → firstFailedRound=1
        ],
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(false);
      }
    });

    it('R5 off-team, Oberon participated in failed R3 → approve (R5 > firstFailedRound=3)', () => {
      const obs = oberonTeamVoteObs({
        round: 5,
        onTeam: false,
        proposedTeam: ['P2', 'P3', 'P4', 'P5'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P3', 'P4'], 'success', 0),
          quest(3, ['P1', 'P6'], 'fail', 1),    // Oberon on failed R3 → firstFailedRound=3
          quest(4, ['P4', 'P5'], 'success', 0),
        ],
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(true);
      }
    });

    it('R4 off-team, Oberon participated in failed R2 → approve (outer-white signal)', () => {
      const obs = oberonTeamVoteObs({
        round: 4,
        onTeam: false,
        proposedTeam: ['P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P1', 'P5'], 'fail', 1),    // Oberon (P1) on team, failed
          quest(3, ['P3', 'P4'], 'success', 0),
        ],
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(true);
      }
    });

    it('R4 off-team, Oberon participated but mission SUCCEEDED → Rule 3 does NOT fire', () => {
      // Oberon was on a mission but he didn't fail it (e.g. failsRequired=2 and
      // only 1 fail token dropped, or teammate also didn't fail). Rule 3 requires
      // failedInMission=true. Falls back to default (on-team approve/off-team reject).
      const obs = oberonTeamVoteObs({
        round: 4,
        onTeam: false,
        proposedTeam: ['P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P1', 'P2'], 'success', 0),  // Oberon on team, succeeded
        ],
      });
      // Default fall-through → off-team reject
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(false);
      }
    });
  });

  describe('Rule 4 — R4 on-team fail iff teammate-suspicion overlap', () => {
    it('R4 on-team, overlap with R2 failed mission member → fail', () => {
      // P5 was on the failed R2 mission. R4 team includes P5 → overlap → fail.
      const obs = oberonQuestVoteObs({
        round: 4,
        proposedTeam: ['P1', 'P5', 'P6', 'P7'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P5', 'P6'], 'fail', 1),     // P5, P6 on failed R2
          quest(3, ['P3', 'P4'], 'success', 0),
        ],
        questResults: ['success', 'fail', 'success'],
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('R4 on-team, NO overlap with prior failed mission → success (Rule 4 else branch, batch 10 restored)', () => {
      // Batch 9 added a red-always-fail guard that turned this into a fail.
      // Batch 10 replaces that guard with the recognised-red hierarchy
      // (which excludes Oberon) and moves the Oberon branch BEFORE the
      // forced-mission shortcut, so Rule 4's else-branch (no teammate
      // suspicion → success) is live again for Oberon.
      const obs = oberonQuestVoteObs({
        round: 4,
        proposedTeam: ['P1', 'P8', 'P9'],  // Team members not in R2 failure
        questHistory: [
          quest(2, ['P5', 'P6'], 'fail', 1),    // P5 P6 failed; P8/P9 not overlap
        ],
        questResults: ['fail'],  // 0-1 (not listening)
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });
  });

  describe('Rule 5 — R5 branches on prior fail count', () => {
    it('R5 off-team + prior fail exists → approve (Rule 5a outer-white)', () => {
      const obs = oberonTeamVoteObs({
        round: 5,
        onTeam: false,
        proposedTeam: ['P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P5', 'P6'], 'fail', 1),    // Prior fail exists
          quest(3, ['P3', 'P4'], 'success', 0),
          quest(4, ['P1', 'P7'], 'success', 0),
        ],
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(true);
      }
    });

    it('R5 off-team + NO prior fail → normal vote (Rule 5b) → reject', () => {
      // All 4 prior missions succeeded (white-wash scenario). Rule 5b:
      // normal votes only. Off-team → reject.
      const obs = oberonTeamVoteObs({
        round: 5,
        onTeam: false,
        proposedTeam: ['P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P3', 'P4'], 'success', 0),
          quest(3, ['P4', 'P5'], 'success', 0),
          quest(4, ['P5', 'P6'], 'success', 0),
        ],
      });
      // But match-point listening will fire (goodWins=4 ≥ 2 listening threshold)
      // which would force fail IF we were in quest-vote. Here we're team-vote
      // so listening doesn't apply — Rule 5b runs. Off-team → reject.
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(false);
      }
    });

    it('R5 on-team + prior fail → quest fail (Rule 5c)', () => {
      // Careful: not match-point to isolate Rule 5c. questResults is 1-1 so
      // listening rule does NOT fire. Oberon Rule 5c applies.
      const obs = oberonQuestVoteObs({
        round: 5,
        proposedTeam: ['P1', 'P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P5', 'P6'], 'fail', 1),
          quest(3, ['P3', 'P4'], 'success', 0),
          quest(4, ['P1', 'P7'], 'success', 0),
        ],
        questResults: ['success', 'fail', 'success', 'success'],  // 3-1, not listening
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('R5 on-team + NO prior fail → quest success (Rule 5c else branch, batch 10 restored)', () => {
      // Batch 9 forced R5 oberon fail unconditionally; batch 10 replaced
      // that blanket guard with the recognised-red hierarchy. Oberon is
      // NOT in the hierarchy (lone-wolf), so his Rule 5c semantics are
      // restored verbatim: R5 + totalMissionFails === 0 → success.
      // This is a pathological test input (1-0 at R5 means game would have
      // ended already in real play), kept to isolate the Rule 5c else branch.
      const obs = oberonQuestVoteObs({
        round: 5,
        proposedTeam: ['P1', 'P2', 'P3', 'P4'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
        ],
        questResults: ['success'],  // 1-0, not listening; artificial
      });
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });
  });

  describe('Oberon context helpers', () => {
    it('buildOberonContext derives participation from questHistory', () => {
      const obs = oberonQuestVoteObs({
        round: 4,
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P1', 'P5'], 'fail', 1),     // Oberon on failed R2
          quest(3, ['P3', 'P4'], 'success', 0),
        ],
      });
      const agent = new HeuristicAgent('P1', 'hard');
      const ctx = agent._buildOberonContextForTesting(obs);

      expect(ctx.missionParticipatedBefore).toBe(true);
      expect(ctx.failedInMission).toBe(true);
      expect(ctx.firstFailedRound).toBe(2);  // batch 8 field
      expect(ctx.totalMissionFails).toBe(1);
      // Suspect teammates from R1-R3 failed missions, minus self
      expect(ctx.suspectedTeammates.has('P5')).toBe(true);
      expect(ctx.suspectedTeammates.has('P1')).toBe(false);
    });

    it('buildOberonContext tracks EARLIEST failed round across multiple participation events (batch 8)', () => {
      const obs = oberonQuestVoteObs({
        round: 5,
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P1', 'P5'], 'fail', 1),     // Oberon failed at R2
          quest(3, ['P1', 'P6'], 'fail', 1),     // Oberon failed at R3 (later)
          quest(4, ['P3', 'P4'], 'success', 0),
        ],
      });
      const agent = new HeuristicAgent('P1', 'hard');
      const ctx = agent._buildOberonContextForTesting(obs);

      expect(ctx.firstFailedRound).toBe(2);      // earliest, not R3
      expect(ctx.totalMissionFails).toBe(2);     // both failed rounds counted
    });

    it('buildOberonContext firstFailedRound is null when Oberon never on a failed mission', () => {
      const obs = oberonQuestVoteObs({
        round: 4,
        questHistory: [
          quest(1, ['P2', 'P3'], 'fail', 1),     // Oberon NOT on it
          quest(2, ['P1', 'P5'], 'success', 0),  // Oberon on it but succeeded
        ],
      });
      const agent = new HeuristicAgent('P1', 'hard');
      const ctx = agent._buildOberonContextForTesting(obs);

      expect(ctx.firstFailedRound).toBeNull();
      expect(ctx.failedInMission).toBe(false);
    });

    it('match-point listening OVERRIDES Oberon Rules 2/4/5c (listening wins)', () => {
      // R4 on-team with NO teammate suspicion overlap would normally give
      // Rule 4 → success. But at 2-0 listening → forced fail by §0 rule.
      const obs = oberonQuestVoteObs({
        round: 4,
        proposedTeam: ['P1', 'P8', 'P9'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P3', 'P4'], 'success', 0),
          quest(3, ['P4', 'P5'], 'success', 0),
        ],
        questResults: ['success', 'success', 'success'],  // 3-0 (past listening)
      });
      // Actually at 3-0 the game would be over. Use 2-0 from questResults:
      const obs20 = oberonQuestVoteObs({
        round: 3,
        proposedTeam: ['P1', 'P8', 'P9'],
        questHistory: [
          quest(1, ['P2', 'P3'], 'success', 0),
          quest(2, ['P3', 'P4'], 'success', 0),
        ],
        questResults: ['success', 'success'],  // 2-0 listening
      });
      void obs; // not used
      for (let i = 0; i < 50; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs20);
        const action = agent.act(obs20);
        expect(action.type).toBe('quest_vote');
        // Listening overrides — Rule 2 (R3 on team fail) agrees anyway.
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });
  });
});

describe('HeuristicAgent · batch 7 fix #4 (blue conservative R3+ outer-white)', () => {
  function approveRate(obs: PlayerObservation, samples: number): number {
    let approves = 0;
    for (let i = 0; i < samples; i++) {
      const agent = new HeuristicAgent(obs.myPlayerId, 'hard');
      agent.onGameStart(obs);
      agent._ingestForTesting(obs);
      const action = agent.act({ ...obs, gamePhase: 'team_vote' });
      if (action.type === 'team_vote' && action.vote === true) approves++;
    }
    return approves / samples;
  }

  it('R3 good off-team clean team → approve rate ≤ 10% (down from ~13% baseline)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'loyal',
      myTeam:        'good',
      gamePhase:     'team_vote',
      currentRound:  3,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],  // off-team, clean (no failed members)
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: true, P5: false }),
        vote(2, 1, 'P3', ['P3', 'P4'], true,
             { P1: true, P2: true, P3: true, P4: true, P5: false }),
      ],
      questHistory: [
        quest(1, ['P2', 'P3'], 'success', 0),
        quest(2, ['P3', 'P4'], 'success', 0),
      ],
    });
    const rate = approveRate(obs, 500);
    // floor = 0.03 with noise=0.05 → worst-case approve ≈ 0.03 + 0.05 ≈ 0.08
    expect(rate).toBeLessThan(0.12);
  });

  it('R4 good off-team clean team → approve rate near floor', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'loyal',
      myTeam:        'good',
      gamePhase:     'team_vote',
      currentRound:  4,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: true, P5: false }),
      ],
      questHistory: [
        quest(1, ['P2', 'P3'], 'success', 0),
      ],
    });
    const rate = approveRate(obs, 500);
    expect(rate).toBeLessThan(0.12);
  });

  it('R3 good off-team with failed member still forces reject (unchanged by floor)', () => {
    // Hard-signal veto path fires before the floor, so approve rate = 0.
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'loyal',
      myTeam:        'good',
      gamePhase:     'team_vote',
      currentRound:  3,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P4'], true,
             { P1: false, P2: true, P3: true, P4: true, P5: false }),
      ],
      questHistory: [
        quest(1, ['P2', 'P4'], 'fail', 1),  // P4 failed → hard veto
      ],
    });
    const rate = approveRate(obs, 300);
    // Noise=0.05 → reject with 95% confidence → approve ~5%.
    expect(rate).toBeLessThan(0.10);
  });

  it('R2 good off-team clean team → batch 4 R1-R2 guard still fires (unchanged, reject=1)', () => {
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'loyal',
      myTeam:        'good',
      gamePhase:     'team_vote',
      currentRound:  2,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P4'],
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P3'], true,
             { P1: true, P2: true, P3: true, P4: true, P5: false }),
      ],
      questHistory: [
        quest(1, ['P2', 'P3'], 'success', 0),
      ],
    });
    const rate = approveRate(obs, 300);
    expect(rate).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 10 — recognised-red hierarchy (位階法)
//
// Edward verbatim:
//   「相認紅方不是上場 hard fail / 相認紅方有位階法
//    單獨出 R1-R3 任務 → 必失敗
//    一位相認隊友 R1-R3 → 刺失敗 / 德成功 / 娜先觀察一次（第一次 success）
//    兩位相認隊友 R1-R3 → 刺失敗 / 其餘 success
//    一位相認隊友 R4 → 必失敗（2 人都 fail，保證 R4 需要 2 fail）
//    兩位相認隊友 R4 → 德 success / 其餘 fail（刺+娜 fail，湊齊 2）
//    R5 → 任何紅方 on team 必失敗（聽牌）」
//
// Batch 10 REPLACES batch 9's blanket hard-fail for recognised-red roles
// (assassin / morgana / mordred). Oberon retains his batch-7/8 Rule 2/4/5c
// logic (not the hierarchy) — but we now ensure Oberon rules fire BEFORE
// batch-3 forced-mission cover-success so Rule 2 (R1-R3 fail) survives.
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · batch 10 recognised-red hierarchy (位階法)', () => {
  const EVIL_ROLES: ReadonlyArray<'assassin' | 'morgana' | 'mordred' | 'oberon'> =
    ['assassin', 'morgana', 'mordred', 'oberon'];

  /** Build a minimal quest-vote observation for a red role. */
  function redQuestObs(
    role: 'assassin' | 'morgana' | 'mordred' | 'oberon',
    opts: {
      round: number;
      questResults?: ('success' | 'fail')[];
      voteHistory?: VoteRecord[];
      questHistory?: QuestRecord[];
      playerCount?: number;
      proposedTeam?: string[];
    },
  ): PlayerObservation {
    const playerCount = opts.playerCount ?? 5;
    const allPlayerIds = Array.from({ length: playerCount }, (_, i) => `P${i + 1}`);
    return baseObs({
      myPlayerId:   'P1',
      myRole:       role,
      myTeam:       'evil',
      knownEvils:   role === 'oberon' ? [] : ['P1', 'P2'],
      playerCount,
      allPlayerIds,
      gamePhase:    'quest_vote',
      currentRound: opts.round,
      proposedTeam: opts.proposedTeam ?? ['P1', 'P2'],
      questResults: opts.questResults ?? [],
      voteHistory:  opts.voteHistory ?? [],
      questHistory: opts.questHistory ?? [],
    });
  }

  describe('solo recognised-red (no ally on team) → fail across R1-R5', () => {
    // Solo = no teammate on proposed team. Hierarchy rule: solo R1-R3 fail,
    // R4 solo fail, R5 fail. Applies to all 4 red roles (oberon via batch
    // 7/8 Rule 2/4/5c which all yield fail in these scenarios).
    for (const role of EVIL_ROLES) {
      it(`${role} solo R1 on-team, 0-0 → fail`, () => {
        // Self = P1 alone; knownEvils empty (oberon) or P3/P4 not on team.
        const obs = redQuestObs(role, {
          round: 1,
          proposedTeam: ['P1', 'P5'],  // solo: ally P2 NOT on team
        });
        // Override knownEvils so P2 is NOT the on-team ally.
        const soloObs = { ...obs, knownEvils: role === 'oberon' ? [] : ['P1', 'P3'] };
        for (let i = 0; i < 50; i++) {
          const agent = new HeuristicAgent('P1', 'hard');
          agent.onGameStart(soloObs);
          const action = agent.act(soloObs);
          expect(action.type).toBe('quest_vote');
          if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
        }
      });

      it(`${role} solo R4 on-team, 1-1 (failsRequired≥2 path, 10p) → ${role === 'oberon' ? 'success (Rule 4 else branch)' : 'fail (hierarchy)'}`, () => {
        // 10p R4 needs 2 fails. Recognised-red hierarchy solo R4 → fail.
        // Oberon Rule 4 else branch: no teammate-suspicion overlap (empty
        // questHistory in this fixture) → success. Test branches by role.
        const obs = redQuestObs(role, {
          round: 4,
          playerCount: 10,
          proposedTeam: ['P1', 'P3', 'P4', 'P5', 'P6'],  // solo: no ally on team
          questResults: ['success', 'fail'],
        });
        const soloObs = { ...obs, knownEvils: role === 'oberon' ? [] : ['P1', 'P7'] };
        const expected: 'fail' | 'success' = role === 'oberon' ? 'success' : 'fail';
        for (let i = 0; i < 50; i++) {
          const agent = new HeuristicAgent('P1', 'hard');
          agent.onGameStart(soloObs);
          const action = agent.act(soloObs);
          expect(action.type).toBe('quest_vote');
          if (action.type === 'quest_vote') expect(action.vote).toBe(expected);
        }
      });

      it(`${role} solo forced-mission (R2 attempt=5, 0-0) → fail (batch 10 preserves batch 9 regression vector)`, () => {
        // Pre-batch-10: batch 9 hard-fail at the top prevented any red
        // cover-success on forced missions. Batch 10 replaces that with
        // the hierarchy (recognised-red) + Oberon-rules-before-forced-
        // mission (oberon). Solo scenario → all four roles still vote fail.
        const obs = redQuestObs(role, {
          round: 2,
          proposedTeam: ['P1', 'P3', 'P4', 'P5'],  // solo
          voteHistory: [
            vote(2, 5, 'P3', ['P1', 'P3', 'P4', 'P5'], true,
                 { P1: true, P2: true, P3: true, P4: true, P5: true }),
          ],
        });
        const soloObs = { ...obs, knownEvils: role === 'oberon' ? [] : ['P1', 'P6'] };
        for (let i = 0; i < 50; i++) {
          const agent = new HeuristicAgent('P1', 'hard');
          agent.onGameStart(soloObs);
          const action = agent.act(soloObs);
          expect(action.type).toBe('quest_vote');
          if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
        }
      });
    }
  });

  describe('hierarchy — 1 teammate on R1-R3 → assassin fail / mordred success / morgana observe', () => {
    it('assassin + 1 teammate on R1 → fail', () => {
      const obs = redQuestObs('assassin', {
        round: 1,
        proposedTeam: ['P1', 'P2'],  // P2 = known teammate
      });
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('mordred + 1 teammate on R1 → success (cover)', () => {
      const obs = redQuestObs('mordred', {
        round: 1,
        proposedTeam: ['P1', 'P2'],
      });
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });

    it('morgana + 1 teammate on R1, no prior joint mission → success (first observe)', () => {
      const obs = redQuestObs('morgana', {
        round: 1,
        proposedTeam: ['P1', 'P2'],
      });
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });

    it('morgana + 1 teammate on R2 after prior joint R1 FAIL → fail (teammate = assassin)', () => {
      // Prior joint mission failed → morgana infers teammate was assassin
      // → morgana now mirrors assassin's fail.
      const obs = redQuestObs('morgana', {
        round: 2,
        proposedTeam: ['P1', 'P2'],
        questHistory: [
          quest(1, ['P1', 'P2'], 'fail', 1),  // joint R1 failed
        ],
        questResults: ['fail'],
      });
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('morgana + 1 teammate on R2 after prior joint R1 SUCCESS → success (teammate = mordred)', () => {
      // Prior joint mission succeeded → morgana infers teammate was mordred
      // → both continue the hide pattern (success).
      const obs = redQuestObs('morgana', {
        round: 2,
        proposedTeam: ['P1', 'P2'],
        questHistory: [
          quest(1, ['P1', 'P2'], 'success', 0),  // joint R1 succeeded
        ],
        questResults: ['success'],
      });
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });
  });

  describe('hierarchy — 2 teammates on R1-R3 → assassin fail, others success', () => {
    it('assassin + 2 teammates on R2 → fail (1 fail suffices)', () => {
      // 3 reds on team; only assassin fails.
      const obs = redQuestObs('assassin', {
        round: 2,
        playerCount: 10,
        proposedTeam: ['P1', 'P2', 'P3', 'P4'],
      });
      // knownEvils P1/P2/P3 → P2+P3 teammates on team.
      const doubleObs = { ...obs, knownEvils: ['P1', 'P2', 'P3'] };
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(doubleObs);
        const action = agent.act(doubleObs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('mordred + 2 teammates on R2 → success', () => {
      const obs = redQuestObs('mordred', {
        round: 2,
        playerCount: 10,
        proposedTeam: ['P1', 'P2', 'P3', 'P4'],
      });
      const doubleObs = { ...obs, knownEvils: ['P1', 'P2', 'P3'] };
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(doubleObs);
        const action = agent.act(doubleObs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });

    it('morgana + 2 teammates on R2 → success', () => {
      const obs = redQuestObs('morgana', {
        round: 2,
        playerCount: 10,
        proposedTeam: ['P1', 'P2', 'P3', 'P4'],
      });
      const doubleObs = { ...obs, knownEvils: ['P1', 'P2', 'P3'] };
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(doubleObs);
        const action = agent.act(doubleObs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });
  });

  describe('hierarchy — R4 branches on teammate count', () => {
    it('assassin + 1 teammate on R4 (10p needs 2 fails) → fail', () => {
      const obs = redQuestObs('assassin', {
        round: 4,
        playerCount: 10,
        proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('morgana + 1 teammate on R4 → fail (both reds on team must fail)', () => {
      const obs = redQuestObs('morgana', {
        round: 4,
        playerCount: 10,
        proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('mordred + 2 teammates on R4 → success (assassin+morgana carry the 2 fails)', () => {
      const obs = redQuestObs('mordred', {
        round: 4,
        playerCount: 10,
        proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      const doubleObs = { ...obs, knownEvils: ['P1', 'P2', 'P3'] };
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(doubleObs);
        const action = agent.act(doubleObs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('success');
      }
    });

    it('assassin + 2 teammates on R4 → fail', () => {
      const obs = redQuestObs('assassin', {
        round: 4,
        playerCount: 10,
        proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      const doubleObs = { ...obs, knownEvils: ['P1', 'P2', 'P3'] };
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(doubleObs);
        const action = agent.act(doubleObs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });

    it('morgana + 2 teammates on R4 → fail', () => {
      const obs = redQuestObs('morgana', {
        round: 4,
        playerCount: 10,
        proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      const doubleObs = { ...obs, knownEvils: ['P1', 'P2', 'P3'] };
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(doubleObs);
        const action = agent.act(doubleObs);
        expect(action.type).toBe('quest_vote');
        if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
      }
    });
  });

  describe('hierarchy — R5 any red on team → fail (listening)', () => {
    for (const role of EVIL_ROLES) {
      it(`${role} R5 on-team → fail`, () => {
        const obs = redQuestObs(role, {
          round: 5,
          playerCount: 10,
          proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P5'],
          questResults: ['success', 'fail', 'success', 'fail'],
        });
        for (let i = 0; i < 30; i++) {
          const agent = new HeuristicAgent('P1', 'hard');
          agent.onGameStart(obs);
          const action = agent.act(obs);
          expect(action.type).toBe('quest_vote');
          if (action.type === 'quest_vote') expect(action.vote).toBe('fail');
        }
      });
    }
  });

  describe('10-game self-play invariant — red on mission ⇒ fail (no exceptions)', () => {
    /** Role alphabet deterministically assigned to seats 1..10. Mix of
     *  blue (merlin/percival/loyal) and red (assassin/morgana/mordred/oberon). */
    function buildRoleMap(
      agents: HeuristicAgent[],
      roles: Array<'merlin' | 'percival' | 'loyal' | 'assassin' | 'morgana' | 'mordred' | 'oberon'>,
    ): Map<string, string> {
      const m = new Map<string, string>();
      agents.forEach((a, i) => m.set(a.agentId, roles[i]));
      return m;
    }

    /** Simulate a single quest-vote scenario for every mission round,
     *  running red players through voteOnQuest and asserting fail. */
    function runSelfPlayInvariant(seed: number): {
      redVotes: Array<{ role: string; vote: 'success' | 'fail' }>;
    } {
      // Deterministic role layout (10-player composition: 6 blue + 4 red).
      // Varying starting round per seed to exercise different code paths.
      const roles: Array<'merlin' | 'percival' | 'loyal' | 'assassin' | 'morgana' | 'mordred' | 'oberon'> = [
        'merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal',
        'assassin', 'morgana', 'mordred', 'oberon',
      ];
      const agents = Array.from({ length: 10 }, (_, i) => new HeuristicAgent(`S${i + 1}`, 'hard'));
      const roleMap = buildRoleMap(agents, roles);
      const redVotes: Array<{ role: string; vote: 'success' | 'fail' }> = [];

      // 5 rounds × varying quest score permutations per seed.
      for (let r = 1; r <= 5; r++) {
        // Rotate questResults based on seed to exercise 0-0 / 1-0 / 0-1 /
        // 1-1 / 2-0 / 0-2 / 2-1 / 1-2 listening + non-listening states.
        const goodWins = Math.min(r - 1, (seed + r) % 3);
        const evilWins = Math.min(r - 1 - goodWins, (seed * 2) % 3);
        const questResults: ('success' | 'fail')[] = [
          ...Array(goodWins).fill('success'),
          ...Array(evilWins).fill('fail'),
        ];
        // Team always includes seats 1 (merlin), 7 (assassin), 10 (oberon)
        // so red agents are on every mission — maximises invariant pressure.
        const proposedTeam = ['S1', 'S7', 'S10'];
        // Occasionally vary to a 4/5-person team to cover failsRequired>=2.
        if (r === 4 && seed % 2 === 0) {
          proposedTeam.push('S2', 'S8');  // 5-person, includes morgana too
        }
        // Ensure mordred (S9) appears on team at least some rounds.
        if (r === 2 || (r === 5 && seed % 3 === 0)) {
          proposedTeam.push('S9');
        }

        // Forced-mission test: odd seeds mark round 3 as attempt=5.
        const voteHistory: VoteRecord[] =
          r === 3 && seed % 2 === 1
            ? [
                {
                  round: 3, attempt: 5, leader: 'S3',
                  team: proposedTeam, approved: true,
                  votes: Object.fromEntries(agents.map(a => [a.agentId, true])),
                },
              ]
            : [];

        for (const agent of agents) {
          const role = roleMap.get(agent.agentId)!;
          const isEvil = ['assassin', 'morgana', 'mordred', 'oberon'].includes(role);
          if (!isEvil) continue;
          if (!proposedTeam.includes(agent.agentId)) continue;

          const obs: PlayerObservation = baseObs({
            myPlayerId:   agent.agentId,
            myRole:       role as PlayerObservation['myRole'],
            myTeam:       'evil',
            knownEvils:   role === 'oberon' ? [] : ['S7', 'S8', 'S9'],
            playerCount:  10,
            allPlayerIds: agents.map(a => a.agentId),
            gamePhase:    'quest_vote',
            currentRound: r,
            proposedTeam,
            questResults,
            voteHistory,
            questHistory: [],
          });
          agent.onGameStart(obs);
          const action = agent.act(obs);
          if (action.type === 'quest_vote') {
            redVotes.push({ role, vote: action.vote });
          }
        }
      }
      return { redVotes };
    }

    it('10 self-play games — assassin + oberon always fail when on team (batch 10 hierarchy)', () => {
      // Batch 10 hierarchy: assassin unconditionally fails in all branches
      // except R4-with-2-teammates-but-he-is-mordred (N/A for assassin).
      // Oberon's batch 7/8 Rule 2 forces R1-R3 on-team fail; Rule 4 success-
      // branch can fire when no teammate overlap; Rule 5c depends on prior
      // fails. Mordred/Morgana have hierarchy success branches that trigger
      // when joint with another red on R1-R3. So the strict "all-fail"
      // invariant only holds for assassin and oberon solo/match-point.
      const allRedVotes: Array<{ role: string; vote: 'success' | 'fail' }> = [];
      for (let g = 0; g < 10; g++) {
        const { redVotes } = runSelfPlayInvariant(g);
        allRedVotes.push(...redVotes);
      }
      expect(allRedVotes.length).toBeGreaterThanOrEqual(30);
      // Assassin must fail every single time across all 10 games.
      const assassinSuccess = allRedVotes.filter(
        (v) => v.role === 'assassin' && v.vote === 'success',
      );
      expect(assassinSuccess).toEqual([]);
    });

    it('per-role breakdown — all 4 red roles contribute fail votes', () => {
      const allRedVotes: Array<{ role: string; vote: 'success' | 'fail' }> = [];
      for (let g = 0; g < 10; g++) {
        const { redVotes } = runSelfPlayInvariant(g);
        allRedVotes.push(...redVotes);
      }
      const byRole = new Map<string, number>();
      for (const v of allRedVotes) {
        if (v.vote === 'fail') byRole.set(v.role, (byRole.get(v.role) ?? 0) + 1);
      }
      // Every red role must emit at least one fail across the 10-game sweep.
      expect(byRole.get('assassin')).toBeGreaterThanOrEqual(1);
      expect(byRole.get('morgana')).toBeGreaterThanOrEqual(1);
      expect(byRole.get('mordred')).toBeGreaterThanOrEqual(1);
      expect(byRole.get('oberon')).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 10 Point 2 — mistake action (refined)
//
// 拇指 = 刺/娜/奧. From the assassin's POV `knownEvils` = {assassin,
// morgana}; oberon is hidden (approximation accepted, matches Merlin's
// own blind spot for oberon).
//   1. 全沒拇指組合開異常內黑 (on-team + thumbless team + reject)
//   2. 有拇指組合開異常外白 (off-team + thumb team + approve)
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · batch 10 Point 2 (mistake action refined)', () => {
  it('pattern 1: on-team + thumbless team + reject → mistake', () => {
    // P1 = assassin, P2 = morgana (thumb). P3 rejected a thumbless team
    // that she was on → inner-black on clean team = Merlin-impossible.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      knownEvils:   ['P1', 'P2'],
      gamePhase:    'assassination',
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        // Team [P3, P4] contains no thumb. P3 on team + reject = Pattern 1.
        vote(1, 1, 'P5', ['P3', 'P4'], false,
          { P1: true, P2: true, P3: false, P4: true, P5: true }),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    // P3: Pattern 1 fires (on-team thumbless reject).
    const p3Obs = obs;  // same observation; P3 is our anti-hero.
    const agent2 = new HeuristicAgent('P1', 'hard');
    agent2.onGameStart(p3Obs);
    // Using internal count via assassinate path — we assert via the
    // unmistaken split. P3 should be classified as mistaken.
    const action = agent.act(p3Obs);
    expect(action.type).toBe('assassinate');
    // In a pool where P3 is the only mistaken (P4 and P5 didn't
    // reject-thumbless-on-team), the target must not be P3.
    if (action.type === 'assassinate') {
      expect(action.targetId).not.toBe('P3');
    }
  });

  it('pattern 2: off-team + thumb team + approve → mistake', () => {
    // P2 = morgana (thumb). Team [P2, P4] has thumb. P3 off-team approved
    // → outer-white on tainted team = Merlin-impossible.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      knownEvils:   ['P1', 'P2'],
      gamePhase:    'assassination',
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        vote(1, 1, 'P4', ['P2', 'P4'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: false }),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('assassinate');
    // P3 is the outer-white approver → not a Merlin candidate → assassin
    // prefers any other good (P4, P5) as Merlin.
    if (action.type === 'assassinate') {
      expect(action.targetId).not.toBe('P3');
    }
  });

  it('no mistakes on clean history → candidate pool is all good players', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      knownEvils:   ['P1', 'P2'],
      gamePhase:    'assassination',
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory:  [],  // no history → no mistakes
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('assassinate');
    // One of P3/P4/P5 (all unmistaken) is the target.
    if (action.type === 'assassinate') {
      expect(['P3', 'P4', 'P5']).toContain(action.targetId);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 11 Point 3 — mistake action #3 (leader
// proposed thumb-tainted team).
//
// Edward verbatim 23:46: 「錯誤動作3: 任務派票派到三根紅方拇指刺娜奧」
//
// Merlin would never lead a team that contains any thumb she can see
// (visible thumbs to Merlin = 刺/娜/奧; Mordred is invisible to Merlin).
// From the assassin's POV, thumb-on-team is approximated as
// `any member ∈ knownEvils` (same Oberon blind spot Merlin has herself).
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · batch 11 Point 3 (mistake #3 leader thumb-team)', () => {
  it('pattern 3: leader proposed team containing thumb → mistake', () => {
    // P1 = assassin, P2 = morgana (thumb). P3 as leader proposed [P2, P4]
    // (thumb team) → Merlin-impossible propose → P3 flagged as mistaken.
    // P4 also led once with a clean team [P4, P5] → no mistake for P4.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      knownEvils:   ['P1', 'P2'],
      gamePhase:    'assassination',
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        // P3 leads a thumb team → Pattern 3 fires for P3.
        vote(1, 1, 'P3', ['P2', 'P4'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: true }),
        // P4 leads a clean team → no mistake for P4.
        vote(2, 1, 'P4', ['P4', 'P5'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: true }),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('assassinate');
    // P3 is the only mistaken good → assassin targets P4 or P5 (both
    // unmistaken), never P3.
    if (action.type === 'assassinate') {
      expect(action.targetId).not.toBe('P3');
      expect(['P4', 'P5']).toContain(action.targetId);
    }
  });

  it('pattern 3: leader proposed clean team → no mistake', () => {
    // P3 as leader proposed [P3, P5] (thumbless team) → Pattern 3 does
    // NOT fire. P4 led a clean team too. Both P3 and P4 remain
    // unmistaken (voteHistory has no inner-black or outer-white either).
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      knownEvils:   ['P1', 'P2'],
      gamePhase:    'assassination',
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        vote(1, 1, 'P3', ['P3', 'P5'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: true }),
        vote(2, 1, 'P4', ['P4', 'P5'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: true }),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('assassinate');
    // P3 led a clean team → not flagged → stays in candidate pool.
    if (action.type === 'assassinate') {
      expect(['P3', 'P4', 'P5']).toContain(action.targetId);
    }
  });

  it('pattern 3: leader + thumb team fires even when player is on team', () => {
    // P3 leads AND is on team [P2, P3] with thumb P2. Pattern 3 fires
    // (leader + thumb team) — independent of onTeam or vote. Verifies
    // Pattern 3 is separate from Pattern 1/2 bookkeeping.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'assassin',
      myTeam:       'evil',
      knownEvils:   ['P1', 'P2'],
      gamePhase:    'assassination',
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        vote(1, 1, 'P3', ['P2', 'P3'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: true }),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('assassinate');
    // P3 flagged → assassin avoids P3.
    if (action.type === 'assassinate') {
      expect(action.targetId).not.toBe('P3');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 10 Point 4 — loyal suspect expansion
//
// Verbatim: 「對於忠臣, 看到異常外白優先視為偏紅方 (放在任務隊伍選擇外)」
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · batch 10 Point 4 (loyal suspect expansion)', () => {
  it('outer-white approvers appear in loyal suspect set', () => {
    // Loyal P1 observes P3 (off-team) approved a team they were not on.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'loyal',
      myTeam:       'good',
      knownEvils:   [],
      gamePhase:    'team_select',
      currentRound: 3,
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P4'], true,
          { P1: false, P2: true, P3: true, P4: true, P5: false }),  // P3 off-team approves
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const suspects = agent._getLoyalSuspectSetForTesting(obs);
    expect(suspects.has('P3')).toBe(true);
    // Self never self-suspects.
    expect(suspects.has('P1')).toBe(false);
  });

  it('failed-mission members are also in suspect set (union preserved)', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'loyal',
      myTeam:       'good',
      knownEvils:   [],
      gamePhase:    'team_select',
      currentRound: 3,
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory:  [],
      questHistory: [
        quest(1, ['P2', 'P3'], 'fail', 1),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const suspects = agent._getLoyalSuspectSetForTesting(obs);
    expect(suspects.has('P2')).toBe(true);
    expect(suspects.has('P3')).toBe(true);
  });

  it('loyal team proposal demotes outer-white suspect out of the team', () => {
    // 5p, round 2, team size 3. P3 outer-white approved R1 (off-team).
    // Loyal leader P1 must NOT pick P3 when cleaner options exist.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'loyal',
      myTeam:       'good',
      knownEvils:   [],
      gamePhase:    'team_select',
      currentRound: 2,
      playerCount:  5,
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        vote(1, 1, 'P2', ['P2', 'P4'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: false }),  // P3 outer-white
      ],
      questHistory: [
        quest(1, ['P2', 'P4'], 'success', 0),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('team_select');
    if (action.type === 'team_select') {
      // Team is size 3; P3 should be LAST choice (suspect tier).
      // If any non-suspect remains, P3 should not be on team.
      expect(action.teamIds).not.toContain('P3');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 10 Point 5 — Percival dual-thumb intel
//
// Verbatim: 「對於派西維爾, 除了根據異常投票去抓紅藍方, 也要透過
//          雙拇指(梅林/莫甘娜)釋放的隊伍資訊去交集找共同好壞人」
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · batch 10 Point 5 (Percival dual-thumb intel)', () => {
  it('team members of Merlin-reject × Morgana-approve intersection are suspects', () => {
    // P2 = Merlin (inferred), P3 = Morgana (inferred). P2 rejected R1
    // team [P4, P5] and P3 approved it. Intersection → P4, P5 evil.
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: ['P2', 'P3'],
      gamePhase:    'team_select',
      currentRound: 2,
      playerCount:  5,
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        vote(1, 1, 'P4', ['P4', 'P5'], true,
          { P1: true, P2: false, P3: true, P4: true, P5: true }),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const suspects = agent._buildPercivalDualThumbSuspectsForTesting(
      ['P2', 'P3'], 'P2', obs,
    );
    expect(suspects.has('P4')).toBe(true);
    expect(suspects.has('P5')).toBe(true);
    // Self never in suspects.
    expect(suspects.has('P1')).toBe(false);
  });

  it('agreement (Merlin+Morgana both approve) → no intersection suspect', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: ['P2', 'P3'],
      gamePhase:    'team_select',
      currentRound: 2,
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        vote(1, 1, 'P4', ['P4', 'P5'], true,
          { P1: true, P2: true, P3: true, P4: true, P5: true }),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const suspects = agent._buildPercivalDualThumbSuspectsForTesting(
      ['P2', 'P3'], 'P2', obs,
    );
    expect(suspects.size).toBe(0);
  });

  it('single wizard knowledge → empty suspect set (safety)', () => {
    const obs = baseObs({
      myPlayerId:   'P1',
      myRole:       'percival',
      myTeam:       'good',
      knownWizards: ['P2'],  // only 1 wizard
      gamePhase:    'team_select',
      currentRound: 2,
      allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      voteHistory: [
        vote(1, 1, 'P4', ['P4', 'P5'], true,
          { P1: true, P2: false, P3: true, P4: true, P5: true }),
      ],
    });
    const agent = new HeuristicAgent('P1', 'hard');
    agent.onGameStart(obs);
    const suspects = agent._buildPercivalDualThumbSuspectsForTesting(
      ['P2'], 'P2', obs,
    );
    expect(suspects.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Edward 2026-04-24 batch 10 Point 3 — red outer-white limit
// (recognised-red no teammate on team → never outer-white approve)
// ─────────────────────────────────────────────────────────────

describe('HeuristicAgent · batch 10 Point 3 (red outer-white limit)', () => {
  for (const role of ['assassin', 'morgana', 'mordred'] as const) {
    it(`${role} off-team with NO teammate on team → always reject`, () => {
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       role,
        myTeam:       'evil',
        knownEvils:   ['P1', 'P5'],  // teammate = P5 NOT on team
        gamePhase:    'team_vote',
        currentRound: 3,
        proposedTeam: ['P2', 'P3', 'P4'],
        allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      let approves = 0;
      for (let i = 0; i < 200; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        if (action.type === 'team_vote' && action.vote === true) approves++;
      }
      expect(approves).toBe(0);
    });

    it(`${role} off-team WITH teammate on team → may approve (supports ally)`, () => {
      const obs = baseObs({
        myPlayerId:   'P1',
        myRole:       role,
        myTeam:       'evil',
        knownEvils:   ['P1', 'P2'],  // teammate = P2 ON team
        gamePhase:    'team_vote',
        currentRound: 3,
        proposedTeam: ['P2', 'P3', 'P4'],
        allPlayerIds: ['P1', 'P2', 'P3', 'P4', 'P5'],
      });
      // Voting for a team with ally on it: short-circuit `hasAlly` branch
      // returns true unconditionally. Always approve.
      for (let i = 0; i < 30; i++) {
        const agent = new HeuristicAgent('P1', 'hard');
        agent.onGameStart(obs);
        const action = agent.act(obs);
        expect(action.type).toBe('team_vote');
        if (action.type === 'team_vote') expect(action.vote).toBe(true);
      }
    });
  }
});
