/**
 * Round 16 (red) candidates, default off: which reds hide on R1 (`redHideR1Who`); the key-team outer white only when the
 * team can pass (`redKeyWhite` 1, adopted as default in round 16) and only from as many off-team reds as the majority needs (`redKeyWhite` 2); a clean-team
 * outer white at rate q (`redCleanWhite`); Oberon votes as a public-view loyal too (`oberonNormalVote`).
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { redHideR1Card } from './RedRound2';
import { redCleanWhiteNow, redKeyWhiteVote, redNormalVoteNow } from './RedVoteCamouflage';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

describe('flags', () => {
  it('parse; default and legacy off', () => {
    expect(parseTuningFlag('redHideR1Who=1')).toEqual({ redHideR1Who: 1 });
    expect(parseTuningFlag('redKeyWhite=2')).toEqual({ redKeyWhite: 2 });
    expect(() => parseTuningFlag('redKeyWhite=3')).toThrow();
    expect(LEGACY_AGENT_TUNING.redHideR1Who).toBe(0);
    expect(LEGACY_AGENT_TUNING.redKeyWhite).toBe(0);
    expect(parseTuningFlag('redCleanWhite=0.3')).toEqual({ redCleanWhite: 0.3 });
    expect(parseTuningFlag('oberonNormalVote')).toEqual({ oberonNormalVote: true });
    expect(LEGACY_AGENT_TUNING.redCleanWhite).toBe(0);
    expect(LEGACY_AGENT_TUNING.oberonNormalVote).toBe(false);
  });
});

describe('redHideR1Who', () => {
  const quest = (role: 'assassin' | 'morgana'): PlayerObservation => ({
    myPlayerId: 'P2', myRole: role, myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2', 'P3'],
    currentRound: 1, gamePhase: 'quest_vote', proposedTeam: ['P2', 'P5', 'P6'], questResults: [], questHistory: [],
    voteHistory: [], lakeHistory: [],
  }) as unknown as PlayerObservation;
  const t = (who: number) => ({ ...DEFAULT_AGENT_TUNING, redHideR1: 1, redHideR1Who: who });
  it('0 = both, 1 = the assassin only, 2 = Morgana only', () => {
    expect(redHideR1Card(t(0), quest('assassin'))).toBe('success');
    expect(redHideR1Card(t(0), quest('morgana'))).toBe('success');
    expect(redHideR1Card(t(1), quest('assassin'))).toBe('success');
    expect(redHideR1Card(t(1), quest('morgana'))).toBeNull();
    expect(redHideR1Card(t(2), quest('assassin'))).toBeNull();
    expect(redHideR1Card(t(2), quest('morgana'))).toBe('success');
  });
});

describe('redKeyWhite', () => {
  // R4, red has two fails. Reds P1 (assassin), P2 (teammate on the team), P8. P1 and P8 are off the team.
  const obs = (partial: Partial<PlayerObservation> = {}): PlayerObservation => ({
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2', 'P8'],
    currentRound: 4, currentLeader: 'P3', failCount: 0, questResults: ['fail', 'success', 'fail'], gamePhase: 'team_vote',
    questHistory: [
      { round: 1, team: ['P2', 'P4', 'P9'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P3', 'P5', 'P6', 'P7'], result: 'success', failCount: 0 },
      { round: 3, team: ['P2', 'P5', 'P9', 'P10'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [], proposedTeam: ['P2', 'P3', 'P5', 'P6', 'P7'], lakeHistory: [], ...partial,
  } as unknown as PlayerObservation);
  const on = (mode: number): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, redKeyWhite: mode });
  function decideVote(o: PlayerObservation, tuning: Partial<AgentTuning>): boolean {
    const a = new ForwardAgent(o.myPlayerId, new HeuristicAgent(o.myPlayerId, undefined, undefined, { ...DEFAULT_AGENT_TUNING, ...tuning }));
    a.onGameStart(o);
    const d = a.decide(o);
    if (d.action.type !== 'team_vote') throw new Error(d.action.type);
    return d.action.vote;
  }
  it('off: the key-team outer white as before; default 1 (adopted in round 16)', () => {
    expect(redKeyWhiteVote(on(0), obs())).toBe(true);
    expect(decideVote(obs(), { redKeyWhite: 0 })).toBe(true);
    expect(DEFAULT_AGENT_TUNING.redKeyWhite).toBe(1);
  });
  it('a team the on-team blues will reject (the teammate sat on both failed missions): no outer white', () => {
    expect(redKeyWhiteVote(on(1), obs())).toBe(false);
    expect(redKeyWhiteVote(on(2), obs())).toBe(false);
    expect(decideVote(obs(), { redKeyWhite: 1 })).toBe(false);
  });
  it('a team the public reads as clean can pass: mode 1 whites; mode 2 only as many reds as needed (+1)', () => {
    // R3 after two fails; the failed teams pin three reds on P1 / P8 / P4 / P9 / P10 (P1 and P8 failed twice); the
    // teammate P2 sat on neither, so the on-team blues read the team as clean.
    const clean = obs({
      currentRound: 3, questResults: ['fail', 'fail'], proposedTeam: ['P2', 'P3', 'P5', 'P6'],
      questHistory: [
        { round: 1, team: ['P1', 'P4', 'P8'], result: 'fail', failCount: 2 },
        { round: 2, team: ['P1', 'P8', 'P9', 'P10'], result: 'fail', failCount: 3 },
      ],
    } as Partial<PlayerObservation>);
    expect(redKeyWhiteVote(on(1), clean)).toBe(true);
    // All four on the team approve: two more votes are needed, plus one spare → both off-team reds (P1, P8) white.
    expect(redKeyWhiteVote(on(2), clean)).toBe(true);
    expect(redKeyWhiteVote(on(2), { ...clean, myPlayerId: 'P8' } as PlayerObservation)).toBe(true);

  });
});

describe('redCleanWhite / oberonNormalVote', () => {
  const r3 = (partial: Partial<PlayerObservation> = {}): PlayerObservation => ({
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2', 'P8'],
    currentRound: 3, currentLeader: 'P3', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_vote',
    questHistory: [
      { round: 1, team: ['P4', 'P8', 'P9'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P2', 'P3', 'P5', 'P6'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: ['P3', 'P5', 'P6', 'P7'], lakeHistory: [], ...partial,
  } as unknown as PlayerObservation);
  it('redCleanWhite: q = 1 whites every team without a seen red, never one with a teammate; q = 0 off; not Oberon', () => {
    const all = { ...DEFAULT_AGENT_TUNING, redCleanWhite: 1 };
    expect(redCleanWhiteNow(all, r3())).toBe(true);
    expect(redCleanWhiteNow(all, r3({ proposedTeam: ['P2', 'P5', 'P6', 'P7'] }))).toBe(false);
    expect(redCleanWhiteNow(DEFAULT_AGENT_TUNING, r3())).toBe(false);
    expect(redCleanWhiteNow(all, r3({ myRole: 'oberon', knownEvils: [] } as Partial<PlayerObservation>))).toBe(false);
  });
  it('oberonNormalVote: Oberon falls under redNormalVote only when on', () => {
    const ob = r3({ myPlayerId: 'P4', myRole: 'oberon', knownEvils: [] } as Partial<PlayerObservation>);
    expect(redNormalVoteNow(DEFAULT_AGENT_TUNING, ob)).toBe(false);
    expect(redNormalVoteNow({ ...DEFAULT_AGENT_TUNING, oberonNormalVote: true }, ob)).toBe(true);
  });
});
