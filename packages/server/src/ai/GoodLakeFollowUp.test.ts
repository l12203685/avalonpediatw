/**
 * Blue lake follow-up (`AgentTuning.goodVouchFollowUp`, 2026-10-13 round 3):
 * a good holder keeps its lake word on the teams it leads and on the votes
 * it casts off the team (strength_benchmark.md 第 10 節).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GOOD_VOUCH_OPTIONS,
  goodVouchDeclarations,
  goodVouchOptionsFromEnv,
  goodVouchTeamConstraint,
  goodVouchVoteRule,
  setGoodVouchOptions,
} from './GoodLakeFollowUp';
import { ForwardAgent } from './forward/ForwardAgent';
import { HeuristicAgent } from './HeuristicAgent';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import type { LakePublicRecord, PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function vote(round: number, attempt: number, leader: string, team: string[], approvers: string[], approved: boolean): VoteRecord {
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = approvers.includes(id);
  return { round, attempt, leader, team, approved, votes };
}

// R1 failed with P2 / P5 / P6, R2 succeeded with P1 / P7 / P8 / P9.
const QUESTS: QuestRecord[] = [
  { round: 1, team: ['P2', 'P5', 'P6'], result: 'fail', failCount: 1 },
  { round: 2, team: ['P1', 'P7', 'P8', 'P9'], result: 'success', failCount: 0 },
];
const VOTES: VoteRecord[] = [
  vote(1, 1, 'P2', ['P2', 'P5', 'P6'], ['P2', 'P5', 'P6', 'P9', 'P10', 'P3'], true),
  vote(2, 1, 'P1', ['P1', 'P7', 'P8', 'P9'], ['P1', 'P7', 'P8', 'P9', 'P2', 'P3'], true),
];
// P1 (loyal) laked P5 after R2 and saw blue (P5 sat on the failed mission).
const VOUCH: LakePublicRecord[] = [{ round: 2, holderId: 'P1', targetId: 'P5', declaredClaim: 'good' }];

function obs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P1',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: [],
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

const PROD_OFF: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodVouchFollowUp: false };
const PROD_ON: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodVouchFollowUp: true };

function forward(tuning: AgentTuning, id = 'P1'): ForwardAgent {
  return new ForwardAgent(id, new HeuristicAgent(id, undefined, undefined, tuning));
}

const teamOf = (d: ReturnType<ForwardAgent['decide']>): string[] =>
  d.action.type === 'team_select' ? [...d.action.teamIds] : [];

describe('GoodLakeFollowUp — declarations', () => {
  it('own claims, then (scope=chain, the default) what a seat I declared blue declares later', () => {
    expect(DEFAULT_GOOD_VOUCH_OPTIONS).toEqual({ scope: 'chain', merlin: 'knowledge', onTeam: 'off' });
    const lakes: LakePublicRecord[] = [
      ...VOUCH,
      { round: 3, holderId: 'P5', targetId: 'P7', declaredClaim: 'good' },
      { round: 4, holderId: 'P7', targetId: 'P4', declaredClaim: 'evil' },
    ];
    expect(goodVouchDeclarations(obs({ lakeHistory: lakes }))).toEqual({
      blue: ['P5', 'P7'], red: ['P4'], chainBlue: ['P7'], chainRed: ['P4'],
    });
    expect(goodVouchDeclarations(obs({ lakeHistory: lakes }), { ...DEFAULT_GOOD_VOUCH_OPTIONS, scope: 'own' })).toEqual({
      blue: ['P5'], red: [], chainBlue: [], chainRed: [],
    });
    // A seat I declared red starts no chain; others' claims never bind me.
    const red: LakePublicRecord[] = [
      { round: 2, holderId: 'P1', targetId: 'P5', declaredClaim: 'evil' },
      { round: 3, holderId: 'P5', targetId: 'P7', declaredClaim: 'good' },
    ];
    expect(goodVouchDeclarations(obs({ lakeHistory: red }))).toEqual({ blue: [], red: ['P5'], chainBlue: [], chainRed: [] });
    expect(goodVouchDeclarations(obs({ myPlayerId: 'P8', lakeHistory: lakes }))).toEqual({ blue: [], red: [], chainBlue: [], chainRed: [] });
    // Claims about myself are skipped; red players are not covered.
    expect(goodVouchDeclarations(obs({ lakeHistory: [...VOUCH, { round: 3, holderId: 'P5', targetId: 'P1', declaredClaim: 'good' }] }))?.blue).toEqual(['P5']);
    expect(goodVouchDeclarations(obs({ myTeam: 'evil', myRole: 'assassin' }))).toBeNull();
  });

  it('Merlin (merlin=knowledge): a bound "blue" seat he sees as red is never required', () => {
    const lakes: LakePublicRecord[] = [...VOUCH, { round: 3, holderId: 'P5', targetId: 'P6', declaredClaim: 'good' }];
    const merlin = obs({ myRole: 'merlin', knownEvils: ['P2', 'P6'], lakeHistory: lakes });
    expect(goodVouchTeamConstraint(merlin)).toEqual({ required: ['P5'], banned: ['P6'] });
    expect(goodVouchDeclarations(merlin, { ...DEFAULT_GOOD_VOUCH_OPTIONS, merlin: 'follow' })?.blue).toEqual(['P5', 'P6']);
  });

  it('team constraint: required / banned; null without a binding declaration', () => {
    const lakes: LakePublicRecord[] = [...VOUCH, { round: 3, holderId: 'P1', targetId: 'P4', declaredClaim: 'evil' }];
    expect(goodVouchTeamConstraint(obs({ lakeHistory: lakes }))).toEqual({ required: ['P5'], banned: ['P4'] });
    expect(goodVouchTeamConstraint(obs({ lakeHistory: [] }))).toBeNull();
    expect(goodVouchTeamConstraint(obs({ myTeam: 'evil', myRole: 'assassin', knownEvils: ['P2', 'P3'] }))).toBeNull();
  });

  it('vote rule: off the team only, not on the forced fifth proposal, not the own proposal', () => {
    const v = (team: string[], extra: Partial<PlayerObservation> = {}): PlayerObservation =>
      obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: team, ...extra });
    expect(goodVouchVoteRule(v(['P6', 'P7', 'P8', 'P9']))).toBe('reject');
    expect(goodVouchVoteRule(v(['P6', 'P5', 'P8', 'P9']))).toBeNull();
    expect(goodVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { failCount: 4 }))).toBeNull();
    expect(goodVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { currentLeader: 'P1' }))).toBeNull();
    expect(goodVouchVoteRule(v(['P6', 'P1', 'P8', 'P9']))).toBeNull();
    const red: LakePublicRecord[] = [{ round: 2, holderId: 'P1', targetId: 'P7', declaredClaim: 'evil' }];
    expect(goodVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { lakeHistory: red }))).toBe('reject');
    expect(goodVouchVoteRule(v(['P6', 'P5', 'P8', 'P9'], { lakeHistory: red }))).toBeNull();
    expect(goodVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { myTeam: 'evil', myRole: 'assassin' }))).toBeNull();
  });

  it('benchmark knob AVALON_GOOD_VOUCH_VARIANT (scripts only)', () => {
    expect(goodVouchOptionsFromEnv({})).toEqual(DEFAULT_GOOD_VOUCH_OPTIONS);
    expect(goodVouchOptionsFromEnv({ AVALON_GOOD_VOUCH_VARIANT: 'scope=own,onTeam=reject,merlin=follow' }))
      .toEqual({ scope: 'own', merlin: 'follow', onTeam: 'reject' });
    expect(goodVouchOptionsFromEnv({ AVALON_GOOD_VOUCH_VARIANT: 'scope=maybe' })).toEqual(DEFAULT_GOOD_VOUCH_OPTIONS);
    setGoodVouchOptions({ ...DEFAULT_GOOD_VOUCH_OPTIONS, onTeam: 'reject' });
    try {
      expect(goodVouchVoteRule(obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P1', 'P8', 'P9'] }))).toBe('reject');
    } finally {
      setGoodVouchOptions(undefined);
    }
  });
});

describe('GoodLakeFollowUp — ForwardAgent wiring', () => {
  it('switch off: the usual R3 pick leaves out the vouched seat (it sat on the failed mission); on: it is on the team', () => {
    const o = obs({});
    const off = teamOf(forward(PROD_OFF).decide(o));
    expect(off).not.toContain('P5');
    const d = forward(PROD_ON).decide(o);
    expect(d.reasoningTrace.usedFallback).toBe(false);
    const on = teamOf(d);
    expect(on).toHaveLength(4);
    expect(new Set(on).size).toBe(4);
    expect(on).toEqual(expect.arrayContaining(['P1', 'P5']));
  });

  it('a seat declared red stays off; a chain seat (declared blue by my vouched seat) is on', () => {
    const lakes: LakePublicRecord[] = [
      ...VOUCH,
      { round: 3, holderId: 'P5', targetId: 'P6', declaredClaim: 'good' },
    ];
    const r4 = obs({
      currentRound: 4,
      questResults: ['fail', 'success', 'success'],
      questHistory: [...QUESTS, { round: 3, team: ['P1', 'P7', 'P8', 'P9'], result: 'success', failCount: 0 }],
      voteHistory: [...VOTES, vote(3, 1, 'P1', ['P1', 'P7', 'P8', 'P9'], ['P1', 'P7', 'P8', 'P9', 'P10', 'P3'], true)],
      lakeHistory: lakes,
    });
    const team = teamOf(forward(PROD_ON).decide(r4));
    expect(team).toEqual(expect.arrayContaining(['P1', 'P5', 'P6']));
    const banned = obs({ lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P7', declaredClaim: 'evil' }] });
    expect(teamOf(forward(PROD_ON).decide(banned))).not.toContain('P7');
  });

  it('off the team: a team without the vouched seat is rejected (trace says why); with it, no rule', () => {
    const vo = obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9'] });
    const d = forward(PROD_ON).decide(vo);
    expect(d.action).toEqual({ type: 'team_vote', vote: false });
    expect(d.reasoningTrace.summary).toContain('blue vouch follow-up');
    const ok = obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P5', 'P8', 'P9'] });
    expect(forward(PROD_ON).decide(ok).reasoningTrace.summary).not.toContain('vouch follow-up');
    expect(forward(PROD_ON).decide(ok).action).toEqual(forward(PROD_OFF).decide(ok).action);
    // Forced fifth proposal: everyone approves.
    const forced = obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9'], failCount: 4 });
    expect(forward(PROD_ON).decide(forced).reasoningTrace.summary).not.toContain('vouch follow-up');
  });

  it('red seats are untouched by the switch', () => {
    const red = obs({
      myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P3'],
      currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9'],
      lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P5', declaredClaim: 'good' }],
    });
    expect(forward(PROD_ON).decide(red).action).toEqual(forward(PROD_OFF).decide(red).action);
    const lead = obs({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P3'], lakeHistory: [] });
    expect(forward(PROD_ON).decide(lead).action).toEqual(forward(PROD_OFF).decide(lead).action);
  });
});
