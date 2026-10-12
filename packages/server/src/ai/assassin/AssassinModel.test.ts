import { describe, it, expect } from 'vitest';
import {
  ASSASSIN_FEATURE_NAMES,
  assassinCandidateFeatures,
  assassinTargetProbabilities,
  pickAssassinTargetByModel,
  scoreAssassinCandidates,
  type AssassinModelWeights,
} from './AssassinModel';
import { ASSASSIN_MODEL_WEIGHTS } from './assassinModelWeights';
import { HeuristicAgent } from '../HeuristicAgent';
import { LEGACY_AGENT_TUNING } from '../AgentTuning';
import type { PlayerObservation, VoteRecord, QuestRecord } from '../types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
const EVIL = ['P1', 'P2', 'P3', 'P4']; // P1 assassin, P2 morgana, P3 mordred, P4 oberon
const GOOD = IDS.filter((id) => !EVIL.includes(id));

function vote(round: number, attempt: number, leader: string, team: string[], approvers: string[], approved: boolean): VoteRecord {
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = approvers.includes(id);
  return { round, attempt, leader, team, approved, votes };
}

function assassinObs(): PlayerObservation {
  const voteHistory: VoteRecord[] = [
    vote(1, 1, 'P1', ['P1', 'P5', 'P6'], ['P1', 'P5', 'P6', 'P2'], false),
    vote(1, 2, 'P2', ['P2', 'P6', 'P7'], ['P2', 'P6', 'P7', 'P1', 'P3', 'P4'], true),
    vote(2, 1, 'P3', ['P3', 'P5', 'P8', 'P9'], ['P3', 'P5', 'P8', 'P9', 'P1', 'P2'], true),
    vote(3, 1, 'P4', ['P5', 'P6', 'P7', 'P8'], ['P5', 'P6', 'P7', 'P8', 'P9', 'P10'], true),
    vote(4, 1, 'P5', ['P5', 'P6', 'P7', 'P8', 'P9'], ['P5', 'P6', 'P7', 'P8', 'P9', 'P10'], true),
  ];
  const questHistory: QuestRecord[] = [
    { round: 1, team: ['P2', 'P6', 'P7'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P3', 'P5', 'P8', 'P9'], result: 'success', failCount: 0 },
    { round: 3, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    { round: 4, team: ['P5', 'P6', 'P7', 'P8', 'P9'], result: 'success', failCount: 0 },
  ];
  return {
    myPlayerId: 'P1',
    myRole: 'assassin',
    myTeam: 'evil',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: ['P2', 'P3'],
    allEvilIds: EVIL,
    currentRound: 4,
    currentLeader: 'P5',
    failCount: 0,
    questResults: ['fail', 'success', 'success', 'success'],
    gamePhase: 'assassination',
    voteHistory,
    questHistory,
    proposedTeam: [],
    lakeHistory: [
      { round: 2, holderId: 'P10', targetId: 'P5', declaredClaim: 'good' },
      { round: 3, holderId: 'P5', targetId: 'P2', declaredClaim: 'evil' },
    ],
  };
}

describe('AssassinModel — features', () => {
  it('feature vector matches the name list and the stored weights', () => {
    const obs = assassinObs();
    for (const id of GOOD) {
      expect(assassinCandidateFeatures(obs, id)).toHaveLength(ASSASSIN_FEATURE_NAMES.length);
    }
    expect(ASSASSIN_MODEL_WEIGHTS.features).toEqual([...ASSASSIN_FEATURE_NAMES]);
    expect(ASSASSIN_MODEL_WEIGHTS.weights).toHaveLength(ASSASSIN_FEATURE_NAMES.length);
    expect(ASSASSIN_MODEL_WEIGHTS.weights.some((w) => w !== 0)).toBe(true);
  });

  it('reads only the public history + own allies (named features behave)', () => {
    const obs = assassinObs();
    const f = (id: string, name: string): number =>
      assassinCandidateFeatures(obs, id)[ASSASSIN_FEATURE_NAMES.indexOf(name)];
    // P5 led R4, laked P2 (a known evil) and was declared good by P10 (not evil from P1's view).
    expect(f('P5', 'ledRate')).toBeCloseTo(1 / 5);
    expect(f('P5', 'heldLake')).toBe(1);
    expect(f('P5', 'lakeTargetEvil')).toBe(1);
    expect(f('P5', 'lakedByOtherGood')).toBe(1);
    expect(f('P5', 'lakedByEvilGood')).toBe(0);
    // P6 was on the failed R1 mission, P5 never was.
    expect(f('P6', 'failMissions')).toBe(1);
    expect(f('P5', 'failMissions')).toBe(0);
    expect(f('P5', 'cleanRecord')).toBe(1);
    // P10 approved R3/R4 off-team on teams without visible red → clean outer-white.
    expect(f('P10', 'approveCleanOffRate')).toBeGreaterThan(0);
    // P5 rejected the R1-P1 team that contained the assassin? No: P5 approved it (on team).
    expect(f('P5', 'rejectSelfTeamRate')).toBe(0);
    // Seat one-hot.
    expect(f('P7', 'seat7')).toBe(1);
    expect(f('P7', 'seat8')).toBe(0);
  });

  it('is unaffected by information the assassin cannot see (roles of good seats)', () => {
    const obs = assassinObs();
    const a = assassinCandidateFeatures(obs, 'P6');
    const b = assassinCandidateFeatures({ ...obs, knownWizards: ['P6', 'P7'] }, 'P6');
    expect(a).toEqual(b);
  });
});

describe('AssassinModel — scoring', () => {
  const toy: AssassinModelWeights = {
    version: 'test',
    features: [...ASSASSIN_FEATURE_NAMES],
    weights: ASSASSIN_FEATURE_NAMES.map((n) => (n === 'failMissions' ? -5 : n === 'succMissions' ? 1 : 0)),
  };

  it('picks the argmax deterministically and breaks ties by seat order', () => {
    const obs = assassinObs();
    const scores = scoreAssassinCandidates(obs, GOOD, toy);
    // P6 / P7 were on the failed mission → strongly penalised.
    expect(scores.get('P6')).toBeLessThan(scores.get('P5') ?? 0);
    const target = pickAssassinTargetByModel(obs, GOOD, toy);
    expect(GOOD).toContain(target);
    expect(target).not.toBe('P6');
    expect(target).not.toBe('P7');
    // All-zero weights → every candidate ties → first seat in allPlayerIds order.
    const zeros: AssassinModelWeights = { version: 'z', features: toy.features, weights: toy.weights.map(() => 0) };
    expect(pickAssassinTargetByModel(obs, ['P9', 'P5', 'P7'], zeros)).toBe('P5');
    expect(pickAssassinTargetByModel(obs, GOOD, toy)).toBe(pickAssassinTargetByModel(obs, GOOD, toy));
  });

  it('probabilities sum to one over the candidates', () => {
    const p = assassinTargetProbabilities(assassinObs(), GOOD);
    let sum = 0;
    for (const v of p.values()) sum += v;
    expect(sum).toBeCloseTo(1, 9);
    expect(p.size).toBe(GOOD.length);
  });

  it('throws on an empty candidate list', () => {
    expect(() => pickAssassinTargetByModel(assassinObs(), [])).toThrow();
  });
});

describe('HeuristicAgent — assassinModel tuning', () => {
  it('with the switch on, the agent shoots the model target and never an evil seat', () => {
    const obs = assassinObs();
    const agent = new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING, assassinModel: true });
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('assassinate');
    if (action.type === 'assassinate') {
      expect(EVIL).not.toContain(action.targetId);
      expect(action.targetId).toBe(pickAssassinTargetByModel(obs, GOOD));
    }
  });

  it('injected weights replace the bundled file (scripts/assassinModel.ts fresh-fit baseline)', () => {
    const obs = assassinObs();
    // Only `succMissions` counts → the candidate on the most successful missions wins (P5/P8 tie → seat order → P5).
    const succOnly: AssassinModelWeights = {
      version: 'succ-only',
      features: [...ASSASSIN_FEATURE_NAMES],
      weights: ASSASSIN_FEATURE_NAMES.map((n) => (n === 'succMissions' ? 1 : 0)),
    };
    // Only `failMissions` counts → the candidate on the failed mission wins (P6/P7 tie → P6).
    const failOnly: AssassinModelWeights = { ...succOnly, version: 'fail-only', weights: ASSASSIN_FEATURE_NAMES.map((n) => (n === 'failMissions' ? 1 : 0)) };
    const on = { ...LEGACY_AGENT_TUNING, assassinModel: true };
    const a = new HeuristicAgent('P1', undefined, undefined, on, succOnly);
    const b = new HeuristicAgent('P1', undefined, undefined, on, failOnly);
    a.onGameStart(obs);
    b.onGameStart(obs);
    const ta = a.act(obs);
    const tb = b.act(obs);
    expect(ta).toEqual({ type: 'assassinate', targetId: pickAssassinTargetByModel(obs, GOOD, succOnly) });
    expect(tb).toEqual({ type: 'assassinate', targetId: pickAssassinTargetByModel(obs, GOOD, failOnly) });
    expect(ta).toEqual({ type: 'assassinate', targetId: 'P5' });
    expect(tb).toEqual({ type: 'assassinate', targetId: 'P6' });
    // No injection → the bundled weights.
    const bundled = new HeuristicAgent('P1', undefined, undefined, on);
    bundled.onGameStart(obs);
    expect(bundled.act(obs)).toEqual({ type: 'assassinate', targetId: pickAssassinTargetByModel(obs, GOOD, ASSASSIN_MODEL_WEIGHTS) });
  });

  it('with the switch off, the legacy scorer is used (may differ from the model)', () => {
    const obs = assassinObs();
    const agent = new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING });
    agent.onGameStart(obs);
    const action = agent.act(obs);
    expect(action.type).toBe('assassinate');
    if (action.type === 'assassinate') expect(EVIL).not.toContain(action.targetId);
  });
});
