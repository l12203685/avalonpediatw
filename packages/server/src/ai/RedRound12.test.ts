/**
 * Round 12 (red) candidates, all default off: the assassin reads the round-11 Merlin's votes (`assassinVoteModel`) and
 * lakes (`assassinLakeRead`); the red leader reads blue with blue's own tables (`redCleanLookBot`); the lone Mordred
 * hides on R1 (`mordredHideR1`).
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { merlinVoteLogRatio } from './assassin/MerlinVoteRead';
import { merlinLakeLogRatio } from './assassin/MerlinLakeRead';
import { mordredHideR1Card } from './RedRound2';
import { redCleanLookTeam } from './RedRound4';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const REDS = ['P1', 'P2', 'P3', 'P4'];
const ROLES = { P1: 'assassin', P2: 'morgana', P3: 'mordred', P4: 'oberon' } as const;
const vote = (round: number, team: string[], yes: string[]) => ({
  round, attempt: 1, leader: team[0], team, approved: true,
  votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const base = {
  myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2'],
  allEvilIds: REDS, allEvilRoles: ROLES, currentRound: 5, gamePhase: 'assassination', questHistory: [], lakeHistory: [],
  questResults: ['success', 'fail', 'success', 'success'], voteHistory: [],
} as unknown as PlayerObservation;

describe('assassinVoteModel (normal Merlin model)', () => {
  it('approving a seen-red team while on it no longer reads as "not Merlin"', () => {
    // R3: P5 on a team with the assassin, approves (a loyal-style 內白).
    const o = { ...base, voteHistory: [vote(3, ['P1', 'P5', 'P6', 'P7'], ['P1', 'P5', 'P6', 'P7'])] } as PlayerObservation;
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'strict')).toBeLessThan(-1);
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normal')).toBe(0);
  });
  it('an off-team approve of a seen-red team still reads as not Merlin; a reject reads as Merlin', () => {
    const o = { ...base, voteHistory: [vote(3, ['P1', 'P6', 'P7', 'P8'], ['P1', 'P5', 'P6', 'P7', 'P8'])] } as PlayerObservation;
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normal')).toBeLessThan(-0.5);
    expect(merlinVoteLogRatio(o, 'P9', REDS, 'normal')).toBeGreaterThan(0);
  });
  it('Mordred is known at the assassination: a Mordred-only team carries no Merlin signal', () => {
    const o = { ...base, voteHistory: [vote(3, ['P3', 'P6', 'P7', 'P8'], ['P3', 'P5', 'P6', 'P7', 'P8'])] } as PlayerObservation;
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normal')).toBe(0);
  });
  it('red at two fails: approving a seen-red team even on it reads as not Merlin', () => {
    const o = { ...base, questResults: ['fail', 'fail', 'success', 'success', 'success'],
      voteHistory: [vote(3, ['P1', 'P5', 'P6', 'P7'], ['P1', 'P5', 'P6', 'P7'])] } as unknown as PlayerObservation;
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normal')).toBeLessThan(-0.5);
  });
});

describe('assassinLakeRead', () => {
  const lake = (holderId: string, targetId: string) => ({ round: 2, holderId, targetId, declaredClaim: 'good' as const });
  it('laking a red Merlin sees reads as not Merlin; laking a blue or Mordred leans Merlin', () => {
    const o = { ...base, lakeHistory: [lake('P5', 'P2'), lake('P6', 'P7'), lake('P7', 'P3')] } as unknown as PlayerObservation;
    expect(merlinLakeLogRatio(o, 'P5', REDS)).toBeLessThan(-1);
    expect(merlinLakeLogRatio(o, 'P6', REDS)).toBeGreaterThan(0);
    expect(merlinLakeLogRatio(o, 'P7', REDS)).toBeGreaterThan(0);
    expect(merlinLakeLogRatio(o, 'P8', REDS)).toBe(0);
  });
});

describe('mordredHideR1', () => {
  const ON = DEFAULT_AGENT_TUNING;
  const quest = (p: Partial<PlayerObservation>) => ({
    ...base, myPlayerId: 'P3', myRole: 'mordred', knownEvils: ['P1', 'P2'], currentRound: 1, gamePhase: 'quest_vote',
    proposedTeam: ['P3', 'P5', 'P6'], questResults: [], ...p,
  }) as unknown as PlayerObservation;
  it('the lone Mordred plays success on R1', () => {
    expect(mordredHideR1Card(ON, quest({}))).toBe('success');
  });
  it('untouched: switch off, R2+, a seen teammate on the team, other reds', () => {
    expect(mordredHideR1Card({ ...DEFAULT_AGENT_TUNING, mordredHideR1: false }, quest({}))).toBeNull();
    expect(mordredHideR1Card(ON, quest({ currentRound: 2 }))).toBeNull();
    expect(mordredHideR1Card(ON, quest({ proposedTeam: ['P3', 'P1', 'P6'] }))).toBeNull();
    expect(mordredHideR1Card(ON, quest({ myPlayerId: 'P1', myRole: 'assassin', proposedTeam: ['P1', 'P5', 'P6'] }))).toBeNull();
  });
});

describe('redCleanLookBot', () => {
  it('still proposes a team of the same size with just enough reds', () => {
    const o = {
      myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P3'],
      currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_select',
      questHistory: [
        { round: 1, team: ['P5', 'P6', 'P7'], result: 'fail', failCount: 1 },
        { round: 2, team: ['P4', 'P8', 'P9', 'P10'], result: 'success', failCount: 0 },
      ],
      voteHistory: [], proposedTeam: [], lakeHistory: [],
    } as unknown as PlayerObservation;
    const a = redCleanLookTeam({ ...DEFAULT_AGENT_TUNING, redStackRatio: 0, redCleanLookBot: true }, o, { type: 'team_select', teamIds: ['P1', 'P2', 'P5', 'P6'] });
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toHaveLength(4);
    expect(a.teamIds).toContain('P1');
    expect(a.teamIds.filter((id) => ['P2', 'P3'].includes(id))).toHaveLength(0);
  });
});

describe('round 12 switches', () => {
  it('default: the fitted vote model and the Mordred R1 hide on (round 12), the rest off; parse from flags', () => {
    expect(LEGACY_AGENT_TUNING.assassinVoteModel).toBe(0);
    expect(DEFAULT_AGENT_TUNING.assassinVoteModel).toBe(2);
    expect(LEGACY_AGENT_TUNING.mordredHideR1).toBe(false);
    expect(DEFAULT_AGENT_TUNING.mordredHideR1).toBe(true);
    for (const t of [LEGACY_AGENT_TUNING, DEFAULT_AGENT_TUNING]) {
      expect(t.assassinLakeRead).toBe(0);
      expect(t.redCleanLookBot).toBe(false);
    }
    expect(parseTuningFlag('assassinLakeRead=0.5')).toEqual({ assassinLakeRead: 0.5 });
    expect(parseTuningFlag('assassinVoteModel')).toEqual({ assassinVoteModel: 1 });
    expect(parseTuningFlag('assassinVoteModel=2')).toEqual({ assassinVoteModel: 2 });
  });
});

describe('assassinVoteModel=2 (round-11 self-play rates)', () => {
  it('reads the same cells, with the fitted generic-blue rates', () => {
    const o = { ...base, voteHistory: [vote(3, ['P1', 'P6', 'P7', 'P8'], ['P1', 'P5', 'P6', 'P7', 'P8'])] } as PlayerObservation;
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normalFit')).toBeCloseTo(Math.log(0.05 / 0.27), 6);
    expect(merlinVoteLogRatio(o, 'P9', REDS, 'normalFit')).toBeCloseTo(Math.log(0.95 / 0.73), 6);
    const on = { ...base, voteHistory: [vote(3, ['P1', 'P5', 'P6', 'P7'], ['P1', 'P5', 'P6', 'P7'])] } as PlayerObservation;
    expect(merlinVoteLogRatio(on, 'P5', REDS, 'normalFit')).toBe(0);
  });
});
