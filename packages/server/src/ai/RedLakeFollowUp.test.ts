/**
 * Red lake follow-up (`AgentTuning.evilVouchFollowUp`, 2026-10-13 round 2):
 * a red holder keeps its lake word on the teams it leads and the votes it
 * casts (strength_benchmark.md 第 8 節).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOUCH_FOLLOW_UP_OPTIONS,
  evilVouchFollowUpActive,
  evilVouchTeamConstraint,
  evilVouchVoteRule,
  ownLakeDeclarations,
  setVouchFollowUpOptions,
  vouchFollowUpOptionsFromEnv,
} from './RedLakeFollowUp';
import { ForwardAgent } from './forward/ForwardAgent';
import { interpret } from './forward';
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

  it('red decisive window (Q11: red listening / R5 cleanup): the word is kept there too by default', () => {
    expect(DEFAULT_VOUCH_FOLLOW_UP_OPTIONS.decisiveWindow).toBe('follow');
    const listening = obs({ questResults: ['fail', 'success', 'fail'], currentRound: 4 });
    expect(evilVouchTeamConstraint(listening)).toEqual({ required: ['P3'], banned: [] });
    expect(evilVouchVoteRule({ ...listening, currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9', 'P10'] })).toBe('reject');
  });

  it('decisiveWindow=exempt (first cut, benchmark knob only) lifts the rules in red\'s decisive window', () => {
    expect(vouchFollowUpOptionsFromEnv({})).toEqual(DEFAULT_VOUCH_FOLLOW_UP_OPTIONS);
    expect(vouchFollowUpOptionsFromEnv({ AVALON_VOUCH_FOLLOW_UP_VARIANT: 'decisiveWindow=exempt' })).toEqual({ decisiveWindow: 'exempt' });
    expect(vouchFollowUpOptionsFromEnv({ AVALON_VOUCH_FOLLOW_UP_VARIANT: 'decisiveWindow=maybe' })).toEqual(DEFAULT_VOUCH_FOLLOW_UP_OPTIONS);
    const listening = obs({ questResults: ['fail', 'success', 'fail'], currentRound: 4 });
    setVouchFollowUpOptions({ decisiveWindow: 'exempt' });
    try {
      expect(evilVouchTeamConstraint(listening)).toBeNull();
      expect(evilVouchVoteRule({ ...listening, currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9', 'P10'] })).toBeNull();
      // Oberon never coordinates → no Q11 exception for him.
      const oberon = obs({ myRole: 'oberon', knownEvils: [], questResults: ['fail', 'success', 'fail'], currentRound: 4 });
      expect(evilVouchTeamConstraint(oberon)).toEqual({ required: ['P3'], banned: [] });
    } finally {
      setVouchFollowUpOptions(undefined);
    }
    expect(evilVouchTeamConstraint(listening)).toEqual({ required: ['P3'], banned: [] });
  });

  it('vote rule (off the team): reject a team without the vouched seat or with the framed seat; not own team, not forced', () => {
    const v = (team: string[], extra: Partial<PlayerObservation> = {}): PlayerObservation =>
      obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: team, ...extra });
    expect(evilVouchVoteRule(v(['P6', 'P7', 'P8', 'P9']))).toBe('reject');
    expect(evilVouchVoteRule(v(['P6', 'P3', 'P8', 'P9']))).toBeNull();
    expect(evilVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { failCount: 4 }))).toBeNull();
    expect(evilVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { currentLeader: 'P1' }))).toBeNull();
    // On the team himself: humans mostly approve → no rule.
    expect(evilVouchVoteRule(v(['P6', 'P1', 'P8', 'P9']))).toBeNull();
    const framed: LakePublicRecord[] = [{ round: 2, holderId: 'P1', targetId: 'P7', declaredClaim: 'evil' }];
    expect(evilVouchVoteRule(v(['P6', 'P7', 'P8', 'P9'], { lakeHistory: framed }))).toBe('reject');
    expect(evilVouchVoteRule(v(['P6', 'P5', 'P8', 'P9'], { lakeHistory: framed }))).toBeNull();
  });
});

describe('RedLakeFollowUp — ForwardAgent wiring', () => {
  // The follow-up acts only together with the lake strategy (`evilVouchFollowUpActive`).
  const LAKE: Partial<AgentTuning> = { evilLakeHumanStrategy: true };
  const FOLLOW: Partial<AgentTuning> = { evilLakeHumanStrategy: true, evilVouchFollowUp: true };
  const declare = (blue: string[], red: string[] = []): LakePublicRecord[] => [
    ...blue.map((id) => ({ round: 2, holderId: 'P1', targetId: id, declaredClaim: 'good' as const })),
    ...red.map((id) => ({ round: 2, holderId: 'P1', targetId: id, declaredClaim: 'evil' as const })),
  ];
  const teamOf = (d: ReturnType<ForwardAgent['decide']>): string[] =>
    d.action.type === 'team_select' ? [...d.action.teamIds] : [];
  const keepsWord = (team: string[], blue: string[], red: string[]): boolean =>
    blue.every((id) => team.includes(id)) && !red.some((id) => team.includes(id));
  const usualCandidates = (o: PlayerObservation): string[][] =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((forward(LAKE) as any).generateCandidates('team_select', o, interpret(o)) as Array<{ action: { teamIds: string[] } }>)
      .map((c) => c.action.teamIds);

  it('the usual R3 pick already keeps the word (P3 on, P9 off) → the same team, not a rebuilt one', () => {
    const o = obs({ lakeHistory: declare(['P3'], ['P9']) });
    const off = teamOf(forward(LAKE).decide(o));
    expect(keepsWord(off, ['P3'], ['P9'])).toBe(true);
    expect(teamOf(forward(FOLLOW).decide(o))).toEqual(off);
  });

  it('the usual pick breaks the word (P5 vouched, P4 framed) → the best usual candidate that keeps it', () => {
    const o = obs({ lakeHistory: declare(['P5'], ['P4']) });
    const off = teamOf(forward(LAKE).decide(o));
    expect(off).toContain('P4');
    expect(off).not.toContain('P5');
    const d = forward(FOLLOW).decide(o);
    expect(d.reasoningTrace.usedFallback).toBe(false);
    const on = teamOf(d);
    expect(on).toHaveLength(4);
    expect(on).toContain('P1');
    expect(keepsWord(on, ['P5'], ['P4'])).toBe(true);
    // A filter on the usual candidates, never a combination the usual
    // low-suspicion cut had dropped (review 2026-10-13).
    const usual = usualCandidates(o).map((t) => [...t].sort().join(','));
    expect(usual).toContain([...on].sort().join(','));
  });

  it('no usual candidate keeps the word (P3 and P5 vouched) → teams are built around the vouched seats', () => {
    const o = obs({ lakeHistory: declare(['P3', 'P5']) });
    expect(usualCandidates(o).some((t) => keepsWord(t, ['P3', 'P5'], []))).toBe(false);
    const d = forward(FOLLOW).decide(o);
    expect(d.reasoningTrace.usedFallback).toBe(false);
    const on = teamOf(d);
    expect(on).toHaveLength(4);
    expect(new Set(on).size).toBe(4);
    expect(on).toEqual(expect.arrayContaining(['P1', 'P3', 'P5']));
  });

  it('only acts when the rule applies: no own declaration, or the vouched seat on the team → same as off', () => {
    const others: LakePublicRecord[] = [{ round: 2, holderId: 'P6', targetId: 'P5', declaredClaim: 'good' }];
    const o = obs({ lakeHistory: others });
    expect(forward(FOLLOW).decide(o).action).toEqual(forward(LAKE).decide(o).action);
    const vo = obs({ lakeHistory: declare(['P3']), currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P3', 'P8', 'P9'] });
    const d = forward(FOLLOW).decide(vo);
    expect(d.action).toEqual(forward(LAKE).decide(vo).action);
    expect(d.reasoningTrace.summary).not.toContain('red vouch follow-up');
  });

  it('without evilLakeHumanStrategy the switch does nothing (so AVALON_TUNING_EVIL_LAKE_HUMAN_STRATEGY=0 restores the previous default)', () => {
    const o = obs({ lakeHistory: declare(['P5'], ['P4']) });
    expect(teamOf(forward(FOLLOW).decide(o))).not.toEqual(teamOf(forward(LAKE).decide(o)));
    expect(forward({ evilVouchFollowUp: true }).decide(o).action).toEqual(forward({}).decide(o).action);
    const vo = obs({ lakeHistory: declare(['P3']), currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9'] });
    expect(forward({ evilVouchFollowUp: true }).decide(vo).reasoningTrace.summary).not.toContain('red vouch follow-up');
    expect(evilVouchFollowUpActive({ evilVouchFollowUp: true, evilLakeHumanStrategy: false })).toBe(false);
    expect(evilVouchFollowUpActive({ evilVouchFollowUp: true, evilLakeHumanStrategy: true })).toBe(true);
    expect(evilVouchFollowUpActive({ evilVouchFollowUp: false, evilLakeHumanStrategy: true })).toBe(false);
  });

  it('switch on: R3+ vote on a team without the vouched seat is a reject (trace says why)', () => {
    const vo = obs({ currentLeader: 'P6', gamePhase: 'team_vote', proposedTeam: ['P6', 'P7', 'P8', 'P9'] });
    const d = forward(FOLLOW).decide(vo);
    expect(d.action).toEqual({ type: 'team_vote', vote: false });
    expect(d.reasoningTrace.summary).toContain('red vouch follow-up');
  });
});
