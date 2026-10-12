/**
 * ForwardAgent — AgentTuning switches (2026-10-12):
 *   - `r3NormalVotePrior`: bonus for the normal vote (on-team approve /
 *     off-team reject) in the R3+ team_vote scorer;
 *   - `humanQuestCardRules`: R1 lone Morgana → fail; R4 lone visible red →
 *     success only while nobody is listening (never in a standard game,
 *     where R4 is always 2-1), decided before the pipeline.
 */
import { describe, it, expect } from 'vitest';
import { ForwardAgent } from './ForwardAgent';
import { HeuristicAgent } from '../HeuristicAgent';
import { LEGACY_AGENT_TUNING, type AgentTuning } from '../AgentTuning';
import type { PlayerObservation, QuestRecord, VoteRecord } from '../types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function vote(round: number, attempt: number, leader: string, team: string[], approvers: string[], approved: boolean): VoteRecord {
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = approvers.includes(id);
  return { round, attempt, leader, team, approved, votes };
}

const QUESTS: QuestRecord[] = [
  { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 1 },
  { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
];
const VOTES: VoteRecord[] = [
  vote(1, 1, 'P2', ['P2', 'P3', 'P4'], ['P2', 'P3', 'P4', 'P9', 'P10'], true),
  vote(2, 1, 'P5', ['P5', 'P6', 'P7', 'P8'], ['P5', 'P6', 'P7', 'P8', 'P1', 'P9'], true),
];

function obs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P1',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: [],
    currentRound: 3,
    currentLeader: 'P6',
    failCount: 0,
    questResults: ['fail', 'success'],
    gamePhase: 'team_vote',
    voteHistory: VOTES,
    questHistory: QUESTS,
    proposedTeam: ['P6', 'P2', 'P3', 'P9'],
    ...partial,
  };
}

function agent(tuning: Partial<AgentTuning>): ForwardAgent {
  return new ForwardAgent('P1', new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING, ...tuning }));
}

describe('ForwardAgent — r3NormalVotePrior', () => {
  const situations: PlayerObservation[] = [
    // loyal off-team, tainted team (legacy often rejects = normal anyway)
    obs({}),
    // loyal on-team with failed-mission members (legacy tends to reject = anomaly)
    obs({ proposedTeam: ['P1', 'P2', 'P3', 'P9'] }),
    // evil off-team, ally on team (legacy tends to approve = anomaly)
    obs({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P3'], proposedTeam: ['P6', 'P2', 'P7', 'P9'] }),
    // merlin off-team, clean team
    obs({ myRole: 'merlin', knownEvils: ['P2', 'P3', 'P4'], proposedTeam: ['P6', 'P7', 'P8', 'P9'] }),
    // loyal on-team, clean team
    obs({ proposedTeam: ['P1', 'P6', 'P7', 'P8'] }),
  ];

  it('a large prior pins every R3+ vote to the normal vote through the forward pipeline', () => {
    const a = agent({ r3NormalVotePrior: 100 });
    for (const o of situations) {
      a.onGameStart(o);
      const d = a.decide(o);
      expect(d.action.type).toBe('team_vote');
      expect(d.reasoningTrace.usedFallback).toBe(false);
      if (d.action.type === 'team_vote') {
        expect(d.action.vote).toBe(o.proposedTeam.includes(o.myPlayerId));
      }
    }
  });

  it('prior 0 leaves at least one anomaly in these situations (so the prior is doing work)', () => {
    const a = agent({ r3NormalVotePrior: 0 });
    let anomalies = 0;
    for (const o of situations) {
      a.onGameStart(o);
      const d = a.decide(o);
      if (d.action.type === 'team_vote' && d.action.vote !== o.proposedTeam.includes(o.myPlayerId)) anomalies++;
    }
    expect(anomalies).toBeGreaterThan(0);
  });

  it('r3NormalVotePriorEvilOnly restricts the prior to evil agents', () => {
    const a = agent({ r3NormalVotePrior: 100, r3NormalVotePriorEvilOnly: true });
    const legacy = agent({ r3NormalVotePrior: 0 });
    for (const o of situations) {
      a.onGameStart(o);
      legacy.onGameStart(o);
      const d = a.decide(o);
      if (o.myTeam === 'evil') {
        if (d.action.type === 'team_vote') expect(d.action.vote).toBe(o.proposedTeam.includes(o.myPlayerId));
      } else {
        expect(d.action).toEqual(legacy.decide(o).action);
      }
    }
  });

  it('R1-R2 votes are still delegated to the baseline (prior never applies there)', () => {
    const a = agent({ r3NormalVotePrior: 100 });
    const o = obs({ currentRound: 2, questResults: ['fail'], questHistory: QUESTS.slice(0, 1), voteHistory: VOTES.slice(0, 1) });
    const d = a.decide(o);
    expect(d.reasoningTrace.summary).toContain('R1-R2 force normal');
  });
});

describe('ForwardAgent — humanQuestCardRules', () => {
  // 1-1 at R4 is artificial (a real R4 is 2-1 / 1-2 = listening); it keeps
  // the R4 branch of the pure rule exercised through the pipeline.
  const r4 = obs({
    myRole: 'mordred', myTeam: 'evil', knownEvils: ['P2', 'P3'],
    currentRound: 4, gamePhase: 'quest_vote', questResults: ['fail', 'success'],
    proposedTeam: ['P1', 'P6', 'P7', 'P8', 'P9'],
  });
  const r1Morgana = obs({
    myRole: 'morgana', myTeam: 'evil', knownEvils: ['P2', 'P3'],
    currentRound: 1, gamePhase: 'quest_vote', questResults: [], questHistory: [], voteHistory: [],
    proposedTeam: ['P1', 'P6', 'P7'],
  });

  it('R4 lone visible red plays success; R1 lone Morgana plays fail', () => {
    const a = agent({ humanQuestCardRules: true });
    const d4 = a.decide(r4);
    expect(d4.action).toEqual({ type: 'quest_vote', vote: 'success' });
    expect(d4.reasoningTrace.summary).toContain('human quest-card rule');
    const d1 = a.decide(r1Morgana);
    expect(d1.action).toEqual({ type: 'quest_vote', vote: 'fail' });
    expect(d1.reasoningTrace.summary).toContain('human quest-card rule');
  });

  it('the baseline HeuristicAgent applies the same rule', () => {
    const h = new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING, humanQuestCardRules: true });
    expect(h.actDirect(r4)).toEqual({ type: 'quest_vote', vote: 'success' });
    expect(h.actDirect(r1Morgana)).toEqual({ type: 'quest_vote', vote: 'fail' });
  });

  it('R4 lone visible red while either side is listening → §0 fail on both paths (hidden Oberon may be on the team)', () => {
    const redListening = { ...r4, questResults: ['fail', 'fail', 'success'] as ('success' | 'fail')[] };
    const blueListening = { ...r4, questResults: ['success', 'success', 'fail'] as ('success' | 'fail')[] };
    const oberon = { ...redListening, myRole: 'oberon' as const, knownEvils: [] as string[] };
    const oberonBlue = { ...blueListening, myRole: 'oberon' as const, knownEvils: [] as string[] };
    const a = agent({ humanQuestCardRules: true });
    for (const o of [redListening, blueListening, oberon, oberonBlue]) {
      const d = a.decide(o);
      expect(d.action).toEqual({ type: 'quest_vote', vote: 'fail' });
      expect(d.reasoningTrace.summary).not.toContain('human quest-card rule');
      const h = new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING, humanQuestCardRules: true });
      expect(h.actDirect(o)).toEqual({ type: 'quest_vote', vote: 'fail' });
    }
  });

  it('with the switch off the rule never fires', () => {
    const a = agent({ humanQuestCardRules: false });
    expect(a.decide(r4).reasoningTrace.summary).not.toContain('human quest-card rule');
    expect(a.decide(r1Morgana).reasoningTrace.summary).not.toContain('human quest-card rule');
  });
});
