/**
 * Red lake follow-up (`AgentTuning.evilVouchFollowUp`, 2026-10-13 round 2):
 * a red holder keeps its lake word on the teams it leads and the votes it
 * casts (strength_benchmark.md 第 7 節).
 */
import { describe, it, expect } from 'vitest';
import {
  evilVouchTeamConstraint,
  evilVouchVoteRule,
  ownLakeDeclarations,
} from './RedLakeFollowUp';
import { ForwardAgent } from './forward/ForwardAgent';
import { HeuristicAgent } from './HeuristicAgent';
import { LEGACY_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import type { LakePublicRecord, PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function vote(round: number, attempt: number, leader: string, team: string[], approvers: string[], approved: boolean): VoteRecord {
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = approvers.includes(id);
  return { round, attempt, leader, team, approved, votes };
}

const QUESTS: QuestRecord[] = [
  { round: 1, team: ['P2', 'P5', 'P6'], result: 'fail', failCount: 1 },
  { round: 2, team: ['P1', 'P7', 'P8', 'P9'], result: 'success', failCount: 0 },
];
const VOTES: VoteRecord[] = [
  vote(1, 1, 'P2', ['P2', 'P5', 'P6'], ['P2', 'P5', 'P6', 'P9', 'P10', 'P3'], true),
  vote(2, 1, 'P1', ['P1', 'P7', 'P8', 'P9'], ['P1', 'P7', 'P8', 'P9', 'P2', 'P3'], true),
];
// P1 (assassin, sees P2 Morgana + P3 Mordred) laked P3 after R2 and declared blue.
const VOUCH: LakePublicRecord[] = [{ round: 2, holderId: 'P1', targetId: 'P3', declaredClaim: 'good' }];

function obs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P1',
    myRole: 'assassin',
    myTeam: 'evil',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: ['P2', 'P3'],
    currentRound: 3,
    currentLeader: 'P1',
    failCount: 0,
    questResults: ['fail', 'success'],
    gamePhase: 'team_select',
    voteHistory: VOTES,
    questHistory: QUESTS,
    proposedTeam: [],
    lakeHistory: VOUCH,
    ...partial,
  };
}

function forward(tuning: Partial<AgentTuning>): ForwardAgent {
  return new ForwardAgent('P1', new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING, ...tuning }));
}

describe('RedLakeFollowUp — pure rules', () => {
  it('ownLakeDeclarations reads only the holder\'s own public claims', () => {
    const lakes: LakePublicRecord[] = [
      ...VOUCH,
      { round: 3, holderId: 'P3', targetId: 'P6', declaredClaim: 'evil' },
      { round: 4, holderId: 'P1', targetId: 'P5', declaredClaim: 'evil' },
    ];
    expect(ownLakeDeclarations(obs({ lakeHistory: lakes }))).toEqual({ blue: ['P3'], red: ['P5'] });
    expect(ownLakeDeclarations(obs({ myPlayerId: 'P3', lakeHistory: lakes }))).toEqual({ blue: [], red: ['P6'] });
    expect(ownLakeDeclarations(obs({ lakeHistory: undefined }))).toEqual({ blue: [], red: [] });
  });

  it('team constraint: declared-blue seats required, declared-red seats banned; none for blue or without a declaration', () => {
    const lakes: LakePublicRecord[] = [...VOUCH, { round: 3, holderId: 'P1', targetId: 'P5', declaredClaim: 'evil' }];
    expect(evilVouchTeamConstraint(obs({ lakeHistory: lakes }))).toEqual({ required: ['P3'], banned: ['P5'] });
    expect(evilVouchTeamConstraint(obs({ lakeHistory: [] }))).toBeNull();
    expect(evilVouchTeamConstraint(obs({ myRole: 'loyal', myTeam: 'good', knownEvils: [] }))).toBeNull();
  });

  it('red decisive window (Q11: red listening / R5 cleanup) lifts the rules', () => {
    const listening = obs({ questResults: ['fail', 'success', 'fail'], currentRound: 4 });
    expect(evilVouchTeamConstraint(listening)).toBeNull();
    expect(evilVouchVoteRule({ ...listening, currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9', 'P10'] })).toBeNull();
  });

  it('vote rule: reject a team without the vouched seat or with the framed seat; not own team, not forced', () => {
    const v = (team: string[], extra: Partial<PlayerObservation> = {}): PlayerObservation =>
      obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: team, ...extra });
    expect(evilVouchVoteRule(v(['P6', 'P7', 'P8', 'P9']))).toBe('reject');
    expect(evilVouchVoteRule(v(['P6', 'P3', 'P8', 'P9']))).toBeNull();
    expect(evilVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { failCount: 4 }))).toBeNull();
    expect(evilVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { currentLeader: 'P1' }))).toBeNull();
    const framed: LakePublicRecord[] = [{ round: 2, holderId: 'P1', targetId: 'P7', declaredClaim: 'evil' }];
    expect(evilVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { lakeHistory: framed }))).toBe('reject');
    expect(evilVouchVoteRule(v(['P6', 'P5', 'P8', 'P9'], { lakeHistory: framed }))).toBeNull();
  });
});

describe('RedLakeFollowUp — ForwardAgent wiring', () => {
  it('switch on: the red leader\'s own R3 team always carries the vouched seat and never the framed one', () => {
    const lakes: LakePublicRecord[] = [...VOUCH, { round: 2, holderId: 'P1', targetId: 'P9', declaredClaim: 'evil' }];
    const on = forward({ evilVouchFollowUp: true });
    const d = on.decide(obs({ lakeHistory: lakes }));
    expect(d.reasoningTrace.usedFallback).toBe(false);
    expect(d.action.type).toBe('team_select');
    if (d.action.type === 'team_select') {
      expect(d.action.teamIds).toHaveLength(4);
      expect(d.action.teamIds).toContain('P1');
      expect(d.action.teamIds).toContain('P3');
      expect(d.action.teamIds).not.toContain('P9');
    }
  });

  it('switch off: the pipeline is unchanged (same action as the legacy agent)', () => {
    const o = obs({});
    expect(forward({ evilVouchFollowUp: false }).decide(o).action).toEqual(forward({}).decide(o).action);
    const vo = obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9'] });
    expect(forward({ evilVouchFollowUp: false }).decide(vo).action).toEqual(forward({}).decide(vo).action);
  });

  it('switch on: R3+ vote on a team without the vouched seat is a reject (trace says why)', () => {
    const vo = obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9'] });
    const d = forward({ evilVouchFollowUp: true }).decide(vo);
    expect(d.action).toEqual({ type: 'team_vote', vote: false });
    expect(d.reasoningTrace.summary).toContain('red vouch follow-up');
  });
});
