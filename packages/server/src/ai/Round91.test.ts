import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_AGENT_TUNING,
  parseTuningFlag,
  type AgentTuning,
} from './AgentTuning';
import {
  analyzeLookahead91Lake,
  evaluateTerminalValue91,
  lookahead91Cfg,
  lookahead91LakeTarget,
  lookahead91Team,
  lookahead91Vote,
} from './Round91';
import { HeuristicAgent } from './HeuristicAgent';
import { decideLakeClaimForTeam, pickLakeTargetForTeam } from './LakePolicy';
import { SelfPlayEngine } from './SelfPlayEngine';
import type { PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS_10 = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];

function makeObs(overrides: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'p1',
    myRole: 'loyal',
    myTeam: 'good',
    seatTeam: 'good',
    playerCount: 10,
    allPlayerIds: IDS_10,
    knownEvils: [],
    currentRound: 3,
    currentLeader: 'p2',
    failCount: 3,
    questResults: ['fail', 'fail'],
    gamePhase: 'team_vote',
    voteHistory: [] as VoteRecord[],
    questHistory: [
      { round: 1, team: ['p8', 'p9', 'p10'], result: 'fail', failCount: 1, successCount: 2 },
      { round: 2, team: ['p7', 'p8', 'p9', 'p10'], result: 'fail', failCount: 2, successCount: 2 },
    ] as QuestRecord[],
    proposedTeam: ['p1', 'p2', 'p3', 'p4'],
    lakeHistory: [
      { round: 2, holderId: 'p10', targetId: 'p2', declaredClaim: 'good' },
    ],
    ...overrides,
  };
}

describe('Round 91 (Phase D): Depth-Limited Lookahead & Terminal Value Estimator', () => {
  it('parses lookahead91 and lookahead91Scope flags cleanly', () => {
    expect(lookahead91Cfg(DEFAULT_AGENT_TUNING)).toBeNull();
    expect(parseTuningFlag('lookahead91')).toEqual({ lookahead91: 1 });
    expect(parseTuningFlag('lookahead91=2')).toEqual({ lookahead91: 2 });
    expect(parseTuningFlag('lookahead91Scope=15')).toEqual({ lookahead91Scope: 15 });
    expect(() => parseTuningFlag('lookahead91=3')).toThrow();
    expect(() => parseTuningFlag('lookahead91Scope=16')).toThrow();

    const cfgDefaultScope = lookahead91Cfg({ ...DEFAULT_AGENT_TUNING, lookahead91: 1, lookahead91Scope: 0 });
    expect(cfgDefaultScope).toEqual({ mode: 1, team: true, vote: true, lake: true, merlin: false });

    const cfgMerlin = lookahead91Cfg({ ...DEFAULT_AGENT_TUNING, lookahead91: 2, lookahead91Scope: 15 });
    expect(cfgMerlin).toEqual({ mode: 2, team: true, vote: true, lake: true, merlin: true });
  });

  it('Terminal Value Estimator obeys boundary conditions and monotonicity', () => {
    expect(evaluateTerminalValue91({
      bluePasses: 1, redFails: 3, nextRound: 5, playerCount: 10,
      pCleanNext: 0.9, nextLeaderGoodProb: 1, nextLakeGoodProb: 1, hasFutureLake: false,
    })).toBe(0);

    expect(evaluateTerminalValue91({
      bluePasses: 3, redFails: 1, nextRound: 5, playerCount: 10,
      pCleanNext: 0.1, nextLeaderGoodProb: 0, nextLakeGoodProb: 0, hasFutureLake: false,
    })).toBeCloseTo(0.60, 6);

    const v20 = evaluateTerminalValue91({
      bluePasses: 2, redFails: 0, nextRound: 3, playerCount: 10,
      pCleanNext: 0.6, nextLeaderGoodProb: 0.6, nextLakeGoodProb: 0.6, hasFutureLake: true,
    });
    const v11 = evaluateTerminalValue91({
      bluePasses: 1, redFails: 1, nextRound: 3, playerCount: 10,
      pCleanNext: 0.6, nextLeaderGoodProb: 0.6, nextLakeGoodProb: 0.6, hasFutureLake: true,
    });
    const v02 = evaluateTerminalValue91({
      bluePasses: 0, redFails: 2, nextRound: 3, playerCount: 10,
      pCleanNext: 0.6, nextLeaderGoodProb: 0.6, nextLakeGoodProb: 0.6, hasFutureLake: true,
    });
    expect(v20).toBeGreaterThan(v11);
    expect(v11).toBeGreaterThan(v02);

    // Good lake holder > evil lake holder when another lake follows
    const vGoodLake = evaluateTerminalValue91({
      bluePasses: 1, redFails: 1, nextRound: 3, playerCount: 10,
      pCleanNext: 0.6, nextLeaderGoodProb: 0.5, nextLakeGoodProb: 1.0, hasFutureLake: true,
    });
    const vEvilLake = evaluateTerminalValue91({
      bluePasses: 1, redFails: 1, nextRound: 3, playerCount: 10,
      pCleanNext: 0.6, nextLeaderGoodProb: 0.5, nextLakeGoodProb: 0.0, hasFutureLake: true,
    });
    expect(vGoodLake).toBeGreaterThan(vEvilLake);

    // When no future lake follows, nextLakeGoodProb has no effect
    const vNoLakeA = evaluateTerminalValue91({
      bluePasses: 2, redFails: 2, nextRound: 5, playerCount: 10,
      pCleanNext: 0.6, nextLeaderGoodProb: 0.5, nextLakeGoodProb: 1.0, hasFutureLake: false,
    });
    const vNoLakeB = evaluateTerminalValue91({
      bluePasses: 2, redFails: 2, nextRound: 5, playerCount: 10,
      pCleanNext: 0.6, nextLeaderGoodProb: 0.5, nextLakeGoodProb: 0.0, hasFutureLake: false,
    });
    expect(vNoLakeA).toBeCloseTo(vNoLakeB, 10);
  });

  it('Spot 1 (n-5 / n-4 team): avoids suspected reds, respects gateOk, and is deterministic', () => {
    const tuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, lookahead91: 1, lookahead91Scope: 7 };
    // p8/p9/p10 failed twice; p1 leads n-5 (failCount=4)
    const obs = makeObs({
      gamePhase: 'team_select',
      currentLeader: 'p1',
      failCount: 4,
      proposedTeam: [],
    });
    // Suppose baseline picked a suboptimal team containing p9
    const badBase = { type: 'team_select' as const, teamIds: ['p1', 'p2', 'p3', 'p9'] };
    const gateOk = (team: readonly string[]): boolean => !team.includes('p10');
    const picked1 = lookahead91Team(tuning, obs, badBase, gateOk);
    const picked2 = lookahead91Team(tuning, obs, badBase, gateOk);

    expect(picked1).toEqual(picked2);
    expect(picked1.teamIds).toHaveLength(4);
    expect(picked1.teamIds).toContain('p1');
    expect(picked1.teamIds).not.toContain('p10');
    expect(picked1.teamIds).not.toContain('p9');

    // Off switch returns exact same reference
    expect(lookahead91Team(DEFAULT_AGENT_TUNING, obs, badBase, gateOk)).toBe(badBase);
  });

  it('Spot 2 (critical vote): washes tail when n-5 leader is suspect red, and respects hard rules', () => {
    const tuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, lookahead91: 1, lookahead91Scope: 7 };
    // currentLeader = p7, failCount = 3 => n-5 tail leader is p8 (who sat on two failed quests!)
    // Proposed team ['p2', 'p3', 'p4', 'p5'] is clean; p1 is off-team at 0:2 (redFails=2)
    const obsWash = makeObs({
      gamePhase: 'team_vote',
      currentLeader: 'p7',
      failCount: 3,
      proposedTeam: ['p2', 'p3', 'p4', 'p5'],
      questHistory: [
        { round: 1, team: ['p8', 'p9', 'p10'], result: 'fail', failCount: 2, successCount: 1 },
        { round: 2, team: ['p7', 'p8', 'p9', 'p10'], result: 'fail', failCount: 3, successCount: 1 },
      ],
      lakeHistory: [
        { round: 2, holderId: 'p1', targetId: 'p8', declaredClaim: 'evil' },
      ],
      myLakeResults: [
        { round: 2, targetId: 'p8', result: 'evil' },
      ],
    });
    const decWash = lookahead91Vote(tuning, obsWash);
    expect(decWash).not.toBeNull();
    expect(decWash!.vote).toBe(true);
    expect(decWash!.evApprove).toBeGreaterThan(decWash!.evReject);

    // Proposed team contains p8, p9, p10 (strongly red) while tail leader is p2 (clean)
    const obsReject = makeObs({
      gamePhase: 'team_vote',
      currentLeader: 'p1',
      myPlayerId: 'p3',
      failCount: 3,
      proposedTeam: ['p1', 'p8', 'p9', 'p10'],
    });
    const decReject = lookahead91Vote(tuning, obsReject);
    expect(decReject).not.toBeNull();
    expect(decReject!.vote).toBe(false);
    expect(decReject!.evReject).toBeGreaterThan(decReject!.evApprove);

    // Never overrides forced 5th (failCount === 4) or R1-R2 or leader self-approve
    expect(lookahead91Vote(tuning, { ...obsWash, failCount: 4 })).toBeNull();
    expect(lookahead91Vote(tuning, { ...obsWash, currentRound: 2 })).toBeNull();
    expect(lookahead91Vote(tuning, { ...obsWash, currentLeader: 'p1' })).toBeNull();

    // Merlin with bit 8 never approves a team with a visible red (INV-M1)
    const merlinTuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, lookahead91: 2, lookahead91Scope: 15 };
    const merlinObs = makeObs({
      myRole: 'merlin',
      knownEvils: ['p5', 'p8', 'p9'],
      currentLeader: 'p7',
      failCount: 3,
      proposedTeam: ['p2', 'p3', 'p4', 'p5'],
    });
    const merlinDec = lookahead91Vote(merlinTuning, merlinObs);
    expect(merlinDec === null || merlinDec.vote === false).toBe(true);
  });

  it('Spot 3 (lake 2-ply lookahead): preserves INV-PL2 for Percival and A0 truthful claims', () => {
    const tuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, lookahead91: 1, lookahead91Scope: 7 };
    const baseLakeObs = makeObs({
      myPlayerId: 'p10',
      myRole: 'percival',
      knownWizards: ['p2', 'p6'],
      currentRound: 2,
      questResults: ['fail', 'success'],
      questHistory: [
        { round: 1, team: ['p7', 'p8', 'p9'], result: 'fail', failCount: 1, successCount: 2 },
        { round: 2, team: ['p1', 'p2', 'p3', 'p4'], result: 'success', failCount: 0, successCount: 4 },
      ],
      lakeHistory: [],
    });
    const validTargets = IDS_10.filter((id) => id !== 'p10');
    const percivalPick = pickLakeTargetForTeam('good', baseLakeObs, validTargets, tuning);
    const loyalWithThumbsPick = pickLakeTargetForTeam(
      'good',
      { ...baseLakeObs, myRole: 'loyal' },
      validTargets,
      tuning,
    );
    // INV-PL2: Percival and loyal with identical thumb info must pick the exact same lake target
    expect(percivalPick).toBe(loyalWithThumbsPick);

    const analysis = analyzeLookahead91Lake(tuning, baseLakeObs, validTargets);
    expect(analysis).not.toBeNull();
    expect(analysis![0].id).toBe(percivalPick);

    // A0: Good holder ALWAYS declares the true faction truthfully
    expect(decideLakeClaimForTeam('good', baseLakeObs, percivalPick, 'good', tuning)).toBe('good');
    expect(decideLakeClaimForTeam('good', baseLakeObs, percivalPick, 'evil', tuning)).toBe('evil');
  });

  it('strictly preserves A1 (red match-point fail) and INV-Q1 (good always success)', () => {
    const tuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, lookahead91: 1, lookahead91Scope: 15 };
    const goodAgent = new HeuristicAgent('good-bot', undefined, undefined, tuning);
    const redAgent = new HeuristicAgent('red-bot', undefined, undefined, tuning);

    const goodQuestObs = makeObs({
      gamePhase: 'quest_vote',
      myTeam: 'good',
      myRole: 'loyal',
      proposedTeam: ['p1', 'p2', 'p3', 'p4'],
    });
    expect(goodAgent.act(goodQuestObs)).toEqual({ type: 'quest_vote', vote: 'success' });

    const redQuestObs = makeObs({
      gamePhase: 'quest_vote',
      myPlayerId: 'p8',
      myTeam: 'evil',
      seatTeam: 'evil',
      myRole: 'assassin',
      knownEvils: ['p8', 'p9', 'p10'],
      questResults: ['fail', 'fail'],
      proposedTeam: ['p1', 'p2', 'p3', 'p8'],
    });
    expect(redAgent.act(redQuestObs)).toEqual({ type: 'quest_vote', vote: 'fail' });
  });

  it('meets < 50 ms single-decision latency budget across all 3 spots', () => {
    const tuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, lookahead91: 1, lookahead91Scope: 7 };
    const obsTeam = makeObs({ gamePhase: 'team_select', currentLeader: 'p1', failCount: 3 });
    const obsVote = makeObs({ gamePhase: 'team_vote', currentLeader: 'p7', failCount: 3 });
    const obsLake = makeObs({ currentRound: 2, questResults: ['fail', 'success'], lakeHistory: [] });
    const validTargets = IDS_10.filter((id) => id !== 'p1');
    const baseTeam = { type: 'team_select' as const, teamIds: ['p1', 'p2', 'p3', 'p4'] };

    // Warm up JIT once
    lookahead91Team(tuning, obsTeam, baseTeam, () => true);
    lookahead91Vote(tuning, obsVote);
    lookahead91LakeTarget(tuning, obsLake, validTargets);

    const t0 = performance.now();
    lookahead91Team(tuning, obsTeam, baseTeam, () => true);
    const dtTeam = performance.now() - t0;

    const t1 = performance.now();
    lookahead91Vote(tuning, obsVote);
    const dtVote = performance.now() - t1;

    const t2 = performance.now();
    lookahead91LakeTarget(tuning, obsLake, validTargets);
    const dtLake = performance.now() - t2;

    expect(dtTeam).toBeLessThan(50);
    expect(dtVote).toBeLessThan(50);
    expect(dtLake).toBeLessThan(50);
  });

  it('is 100% deterministic in full 10-player self-play and identical to baseline when off', async () => {
    const withSeed = async <T>(seed: number, fn: () => Promise<T>): Promise<T> => {
      let s = seed >>> 0;
      const orig = Math.random;
      Math.random = () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0x100000000;
      };
      try {
        return await fn();
      } finally {
        Math.random = orig;
      }
    };

    const run = (seed: number, tuning: AgentTuning) => withSeed(seed, async () => {
      const engine = new SelfPlayEngine();
      const agents = Array.from({ length: 10 }, (_, i) => new HeuristicAgent(`P${i + 1}`, undefined, undefined, tuning));
      const res = await engine.runGame(agents, false);
      return {
        winner: res.winner,
        rounds: res.rounds,
        questResults: res.questResults,
        threeBlue: res.threeBlue,
        merlinKilled: res.merlinKilled,
      };
    });

    const offTuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, lookahead91: 0 };
    const onTuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, lookahead91: 1, lookahead91Scope: 7 };

    // When off, identical to DEFAULT_AGENT_TUNING
    expect(await run(91001, offTuning)).toEqual(await run(91001, DEFAULT_AGENT_TUNING));

    // When on, deterministic across runs with same seed
    const r1 = await run(91001, onTuning);
    const r2 = await run(91001, onTuning);
    expect(r1).toEqual(r2);
  });
});
