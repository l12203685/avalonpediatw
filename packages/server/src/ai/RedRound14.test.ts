/**
 * Round 14 (red) candidates, default off: the assassin reads votes with the generic-blue rates re-measured against
 * the round-13 blues (`assassinVoteModel=3`, `assassinVoteEps`); the lone assassin / Morgana hides on R1 (`redHideR1`,
 * adopted as default in round 14).
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { LEGACY_AGENT_TUNING, DEFAULT_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { merlinVoteLogRatio } from './assassin/MerlinVoteRead';
import { redHideR1Card } from './RedRound2';

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

describe('assassinVoteModel=3 (round-13 generic-blue rates)', () => {
  it('flags parse; default off', () => {
    expect(parseTuningFlag('assassinVoteModel=3')).toEqual({ assassinVoteModel: 3 });
    expect(() => parseTuningFlag('assassinVoteModel=4')).toThrow();
    expect(parseTuningFlag('assassinVoteEps=0.03')).toEqual({ assassinVoteEps: 0.03 });
    expect(LEGACY_AGENT_TUNING.assassinVoteEps).toBe(0);
    expect(LEGACY_AGENT_TUNING.redHideR1).toBe(0);
  });
  it('an off-team reject of a seen-red team is almost no evidence now that blues seldom approve; an approve rules Merlin out harder', () => {
    const o = { ...base, voteHistory: [vote(3, ['P1', 'P6', 'P7', 'P8'], ['P1', 'P5', 'P6', 'P7', 'P8'])] } as PlayerObservation;
    const rejOld = merlinVoteLogRatio(o, 'P9', REDS, 'normalFit');
    const rejNew = merlinVoteLogRatio(o, 'P9', REDS, 'normalFit13');
    expect(rejNew).toBeGreaterThan(0);
    expect(rejNew).toBeLessThan(rejOld);
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normalFit13')).toBeLessThan(merlinVoteLogRatio(o, 'P5', REDS, 'normalFit'));
  });
  it('the key-round 內黑 of a seen-red team still leans Merlin; on-team votes elsewhere carry nothing', () => {
    const key = { ...base, questResults: ['fail', 'fail', 'success', 'success', 'success'],
      voteHistory: [vote(3, ['P1', 'P5', 'P6', 'P7'], ['P1', 'P6', 'P7'])] } as unknown as PlayerObservation;
    expect(merlinVoteLogRatio(key, 'P5', REDS, 'normalFit13')).toBeGreaterThan(0.3);
    const calm = { ...base, voteHistory: [vote(3, ['P1', 'P5', 'P6', 'P7'], ['P1', 'P6', 'P7'])] } as PlayerObservation;
    expect(merlinVoteLogRatio(calm, 'P5', REDS, 'normalFit13')).toBe(0);
  });
  it('assassinVoteEps overrides the model eps', () => {
    const o = { ...base, voteHistory: [vote(3, ['P1', 'P6', 'P7', 'P8'], ['P1', 'P5', 'P6', 'P7', 'P8'])] } as PlayerObservation;
    expect(merlinVoteLogRatio(o, 'P5', REDS, 'normalFit13', 0.03)).toBeGreaterThan(merlinVoteLogRatio(o, 'P5', REDS, 'normalFit13'));
  });
});

describe('redHideR1', () => {
  const ON = { ...DEFAULT_AGENT_TUNING, redHideR1: 1 };
  const quest = (p: Partial<PlayerObservation>) => ({
    ...base, myPlayerId: 'P2', myRole: 'morgana', knownEvils: ['P1', 'P2', 'P3'], currentRound: 1, gamePhase: 'quest_vote',
    proposedTeam: ['P2', 'P5', 'P6'], questResults: [], ...p,
  }) as unknown as PlayerObservation;
  it('the lone Morgana or assassin plays success on R1', () => {
    expect(redHideR1Card(ON, quest({}))).toBe('success');
    expect(redHideR1Card(ON, quest({ myPlayerId: 'P1', myRole: 'assassin', proposedTeam: ['P1', 'P5', 'P6'] }))).toBe('success');
  });
  it('untouched: switch off, R2+, a seen teammate on the team, Mordred / Oberon', () => {
    expect(redHideR1Card({ ...DEFAULT_AGENT_TUNING, redHideR1: 0 }, quest({}))).toBeNull();
    expect(DEFAULT_AGENT_TUNING.redHideR1).toBe(1);
    expect(redHideR1Card(ON, quest({ currentRound: 2 }))).toBeNull();
    expect(redHideR1Card(ON, quest({ proposedTeam: ['P2', 'P3', 'P6'] }))).toBeNull();
    expect(redHideR1Card(ON, quest({ myPlayerId: 'P3', myRole: 'mordred', proposedTeam: ['P3', 'P5', 'P6'] }))).toBeNull();
    expect(redHideR1Card(ON, quest({ myPlayerId: 'P4', myRole: 'oberon', knownEvils: [], proposedTeam: ['P4', 'P5', 'P6'] }))).toBeNull();
  });
});
