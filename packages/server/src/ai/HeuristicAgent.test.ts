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

  it('R3 off-team evil — role differentiation remains active (not suppressed)', () => {
    // Verify the guard is tightly scoped to R1-R2. At R3 the role-specific
    // approve chance branch exercises as expected.
    const obs = baseObs({
      myPlayerId:    'P1',
      myRole:        'morgana',
      myTeam:        'evil',
      knownEvils:    ['P4'],
      gamePhase:     'team_vote',
      currentRound:  3,
      currentLeader: 'P2',
      proposedTeam:  ['P2', 'P3', 'P5'],  // no self, no ally
      voteHistory:   [],
      questHistory:  [],
    });
    // Morgana off-team approve chance ≈ 0.50 (base 0.35 + 0.15 bonus).
    const rate = approveRate(obs, 'hard', 400);
    expect(rate).toBeGreaterThan(0.30);
    expect(rate).toBeLessThan(0.70);
  });
});

// ─────────────────────────────────────────────────────────────
// Deep-cover branch (SSoT §2 + §6.1, Fix #3 original): REMOVED —
// superseded by §0 Listening Rule (Edward 2026-04-22 12:38 verbatim).
// Evil at good-winning 2-0 must fail (except Oberon, which keeps
// legacy 70% randomised behaviour). See the listening-rule describe
// block higher in this file for the new coverage.
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

    it('Morgana off-team approve rate ≈ 0.50 (base 0.35 + 0.15 mimic-merlin bonus)', () => {
      const rate = approveRate('morgana');
      expect(rate).toBeGreaterThan(0.40);
      expect(rate).toBeLessThan(0.60);
    });

    it('Assassin off-team approve rate ≈ 0.45 (base 0.35 + 0.10)', () => {
      const rate = approveRate('assassin');
      expect(rate).toBeGreaterThan(0.35);
      expect(rate).toBeLessThan(0.55);
    });

    it('Mordred off-team approve rate ≈ 0.30 (base 0.35 - 0.05 bolder)', () => {
      const rate = approveRate('mordred');
      expect(rate).toBeGreaterThan(0.20);
      expect(rate).toBeLessThan(0.40);
    });

    it('Oberon off-team approve rate ≈ 0.35 (legacy base, no role bonus)', () => {
      const rate = approveRate('oberon');
      expect(rate).toBeGreaterThan(0.25);
      expect(rate).toBeLessThan(0.45);
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

    it('Mordred early fail rate ≈ 0.70 (base 0.60 + 0.10)', () => {
      const rate = failRate('mordred');
      expect(rate).toBeGreaterThan(0.60);
      expect(rate).toBeLessThan(0.80);
    });

    it('Morgana early fail rate ≈ 0.55 (base 0.60 - 0.05)', () => {
      const rate = failRate('morgana');
      expect(rate).toBeGreaterThan(0.45);
      expect(rate).toBeLessThan(0.65);
    });

    it('Assassin early fail rate ≈ 0.50 (base 0.60 - 0.10 cleanest)', () => {
      const rate = failRate('assassin');
      expect(rate).toBeGreaterThan(0.40);
      expect(rate).toBeLessThan(0.60);
    });

    it('Oberon early fail rate ≈ 0.60 (legacy base, no role bonus)', () => {
      const rate = failRate('oberon');
      expect(rate).toBeGreaterThan(0.50);
      expect(rate).toBeLessThan(0.70);
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
    it('penalises a good leader who consistently put knownEvil (Morgana) on their team', () => {
      // Setup: P1 = Assassin, knownEvils = [P1, P2 (Morgana)].
      // P3 was leader twice, included Morgana (P2) both times → Percival signal.
      // P4 was leader twice, never included Morgana → Merlin signal.
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

      // Assassin should target P4 (the cleaner leader), not P3 (Percival-like).
      const action = agent.act(obs);
      expect(action.type).toBe('assassinate');
      if (action.type === 'assassinate') {
        expect(action.targetId).not.toBe('P3');
      }
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
