/**
 * 第 51 回合（站長 11/18）：這一局之後還會當隊長 → 內黑的傾向上升；不會再當隊長 → 外白的傾向上升（`Round51.ts`，預設關）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { bayesVoteCriteria } from './BlueRound33';
import { leaderOppEarly51, leaderOppRed51, leaderOppShift51, untaintedLakePick51 } from './Round51';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
// The default holds L1 (leaderOppVote51=1, δ 0.05; site owner 2026-11-19); these tests start from the switch off.
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, leaderOppVote51: 0, leaderOppVote51Delta: 0, ...over });

/** 第 3 局第 3 次提議（failCount 2）、隊長 P3：P4、P5 之後還會當隊長（第 4、5 次），其他人不會。 */
function r3(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P4', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P3', gamePhase: 'team_vote', failCount: 2, questResults: ['success', 'fail'],
    questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 },
      { round: 2, team: ['P6', 'P7', 'P8', 'P9'], result: 'fail', failCount: 1 },
    ],
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P1', team: ['P1', 'P2', 'P3'], approved: true, votes: { P1: true, P2: true, P3: true, P4: false, P5: false, P6: false, P7: false, P8: true, P9: true, P10: true } },
      { round: 2, attempt: 1, leader: 'P2', team: ['P6', 'P7', 'P8', 'P9'], approved: true, votes: { P1: false, P2: true, P3: false, P4: true, P5: false, P6: true, P7: true, P8: true, P9: true, P10: true } },
    ],
    lakeHistory: [], myLakeResults: [], proposedTeam: ['P3', 'P4', 'P1', 'P2'],
    ...over,
  } as unknown as PlayerObservation;
}

describe('flags', () => {
  it('exist, off in the legacy table, L1 in the default, parse', () => {
    for (const k of ['leaderOppVote51', 'leaderOppVote51Delta', 'leaderOppVoteRed51'] as const) expect(LEGACY_AGENT_TUNING[k]).toBe(0);
    // round 51 L1 adopted by the site owner 2026-11-19: inner black only, δ 0.05
    expect(DEFAULT_AGENT_TUNING.leaderOppVote51).toBe(1);
    expect(DEFAULT_AGENT_TUNING.leaderOppVote51Delta).toBe(0.05);
    expect(DEFAULT_AGENT_TUNING.leaderOppVoteRed51).toBe(0);
    expect(parseTuningFlag('leaderOppVote51')).toEqual({ leaderOppVote51: 3 });
    expect(parseTuningFlag('leaderOppVote51=7')).toEqual({ leaderOppVote51: 7 });
    expect(parseTuningFlag('leaderOppVote51Delta=0.2')).toEqual({ leaderOppVote51Delta: 0.2 });
    expect(parseTuningFlag('leaderOppVoteRed51')).toEqual({ leaderOppVoteRed51: 0.07 });
    expect(parseTuningFlag('leaderOppVote51DeltaOut=0.3')).toEqual({ leaderOppVote51DeltaOut: 0.3 });
    expect(parseTuningFlag('lakeUntainted51')).toEqual({ lakeUntainted51: 0.5 });
    expect(LEGACY_AGENT_TUNING.leaderOppVote51DeltaOut).toBe(0);
    expect(DEFAULT_AGENT_TUNING.lakeUntainted51).toBe(0);
    expect(() => parseTuningFlag('leaderOppVote51=16')).toThrow();
    expect(() => parseTuningFlag('leaderOppVoteRed51=1')).toThrow();
  });
});

describe('leaderOppShift51 (R3+ thresholds)', () => {
  const on = T({ leaderOppVote51: 3, leaderOppVote51Delta: 0.15 });
  it('off: no shift anywhere', () => {
    expect(leaderOppShift51(T(), r3(), true)).toBe(0);
    expect(leaderOppShift51(T(), r3({ myPlayerId: 'P8' }), false)).toBe(0);
  });
  it('on the team and leading later this round (P4 leads the 4th, P5 the forced 5th): inner-black threshold drops by δ', () => {
    expect(leaderOppShift51(on, r3(), true)).toBe(0.15);
    expect(leaderOppShift51(on, r3({ myPlayerId: 'P5', proposedTeam: ['P3', 'P5', 'P1', 'P2'] }), true)).toBe(0.15);
    expect(leaderOppShift51(on, r3({ myPlayerId: 'P1' }), true)).toBe(0); // P1 does not lead again this round
  });
  it('off the team and not leading again: outer-white threshold drops by δ (its own δ when set); a later leader off the team: unchanged', () => {
    expect(leaderOppShift51(on, r3({ myPlayerId: 'P8' }), false)).toBe(0.15);
    expect(leaderOppShift51(T({ leaderOppVote51: 3, leaderOppVote51Delta: 0.05, leaderOppVote51DeltaOut: 0.3 }), r3({ myPlayerId: 'P8' }), false)).toBe(0.3);
    expect(leaderOppShift51(T({ leaderOppVote51: 3, leaderOppVote51Delta: 0.05, leaderOppVote51DeltaOut: 0.3 }), r3(), true)).toBe(0.05);
    expect(leaderOppShift51(on, r3({ myPlayerId: 'P5' }), false)).toBe(0);
  });
  it('the 4th proposal: only the forced fifth\'s leader still leads; δ defaults to 0.1; bits pick the side', () => {
    expect(leaderOppShift51(T({ leaderOppVote51: 1 }), r3({ failCount: 3, currentLeader: 'P4', myPlayerId: 'P5', proposedTeam: ['P4', 'P5', 'P1', 'P2'] }), true)).toBe(0.1);
    expect(leaderOppShift51(T({ leaderOppVote51: 1 }), r3({ failCount: 3, currentLeader: 'P4', myPlayerId: 'P6' }), false)).toBe(0);
    expect(leaderOppShift51(T({ leaderOppVote51: 2 }), r3(), true)).toBe(0);
  });
  it('not for Merlin\'s loyal view, a red\'s loyal view, Percival without bit 8, R1–R2, the leader', () => {
    expect(leaderOppShift51(on, r3({ publicLoyalView: true } as Partial<PlayerObservation>), true)).toBe(0);
    expect(leaderOppShift51(on, r3({ redLoyalView: true } as Partial<PlayerObservation>), true)).toBe(0);
    expect(leaderOppShift51(on, r3({ myRole: 'percival' }), true)).toBe(0);
    expect(leaderOppShift51(T({ leaderOppVote51: 11 }), r3({ myRole: 'percival' }), true)).toBe(0.1);
    expect(leaderOppShift51(on, r3({ currentRound: 2 }), true)).toBe(0);
    expect(leaderOppShift51(on, r3({ myPlayerId: 'P3' }), true)).toBe(0);
  });
});

describe('bayesVoteCriteria with leaderOppVote51', () => {
  it('a large δ turns the on-team later leader into an inner black and the off-team non-leader into an outer white; others unchanged', () => {
    const big = T({ leaderOppVote51: 3, leaderOppVote51Delta: 0.95 });
    const base4 = bayesVoteCriteria(T(), r3());
    const now4 = bayesVoteCriteria(big, r3());
    expect(base4).not.toBeNull();
    expect(now4).toEqual({ vote: false, reason: 'bad' });
    // P1 on the team does not lead again: same verdict as the default
    expect(bayesVoteCriteria(big, r3({ myPlayerId: 'P1' }))).toEqual(bayesVoteCriteria(T(), r3({ myPlayerId: 'P1' })));
    const off = r3({ myPlayerId: 'P10' });
    const offBase = bayesVoteCriteria(T(), off);
    const offNow = bayesVoteCriteria(big, off);
    expect(offNow?.vote).toBe(true);
    expect(offBase === null || offBase.vote === false || offBase.vote === offNow?.vote).toBe(true);
    // P5 off the team still leads the forced fifth: same as the default
    const p5 = r3({ myPlayerId: 'P5' });
    expect(bayesVoteCriteria(big, p5)).toEqual(bayesVoteCriteria(T(), p5));
  });
});

describe('leaderOppEarly51 (R1–R2, bit 4)', () => {
  const r1 = (over: Partial<PlayerObservation> = {}): PlayerObservation => r3({
    currentRound: 1, questResults: [], questHistory: [], voteHistory: [], proposedTeam: ['P3', 'P1', 'P2'], ...over,
  } as Partial<PlayerObservation>);
  it('off without bit 4 and in R3+', () => {
    expect(leaderOppEarly51(T({ leaderOppVote51: 3 }), r1())).toBeNull();
    expect(leaderOppEarly51(T({ leaderOppVote51: 4 }), r3())).toBeNull();
  });
  it('outer white only for a non-later-leader off the team, inner black only for a later leader on the team; rates near the human ones; same state same vote', () => {
    const t = T({ leaderOppVote51: 4 });
    let white = 0;
    let black = 0;
    let wrong = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const team = ['P3', `X${i}`, `Y${i}`];
      // P8 off the team, does not lead again (leader P3, failCount 2 → P4, P5 lead later)
      const a = leaderOppEarly51(t, r1({ myPlayerId: 'P8', proposedTeam: team } as Partial<PlayerObservation>));
      expect(leaderOppEarly51(t, r1({ myPlayerId: 'P8', proposedTeam: team } as Partial<PlayerObservation>))).toBe(a);
      if (a === true) white++;
      if (a === false) wrong++;
      // P4 on the team, leads the 4th
      const b = leaderOppEarly51(t, r1({ myPlayerId: 'P4', currentRound: 2, proposedTeam: [...team, 'P4'] } as Partial<PlayerObservation>));
      if (b === false) black++;
      if (b === true) wrong++;
      // P5 off the team leads later; P1 on the team does not: never
      if (leaderOppEarly51(t, r1({ myPlayerId: 'P5', proposedTeam: team } as Partial<PlayerObservation>)) !== null) wrong++;
      if (leaderOppEarly51(t, r1({ myPlayerId: 'P1', proposedTeam: [...team, 'P1'] } as Partial<PlayerObservation>)) !== null) wrong++;
    }
    expect(wrong).toBe(0);
    expect(white / N).toBeGreaterThan(0.012);
    expect(white / N).toBeLessThan(0.036);
    expect(black / N).toBeGreaterThan(0.05);
    expect(black / N).toBeLessThan(0.09);
  });
});

describe('leaderOppRed51 (red mimic)', () => {
  const red = (over: Partial<PlayerObservation> = {}): PlayerObservation => r3({ myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil', ...over } as Partial<PlayerObservation>);
  it('off by default; never Oberon, off the team, a non-later-leader, R1–R2, or at red\'s match point', () => {
    const all = T({ leaderOppVoteRed51: 0.9999 });
    expect(leaderOppRed51(T(), red())).toBe(false);
    expect(leaderOppRed51(all, red())).toBe(true);
    expect(leaderOppRed51(all, red({ myRole: 'oberon' }))).toBe(false);
    expect(leaderOppRed51(all, red({ proposedTeam: ['P3', 'P1', 'P2', 'P6'] }))).toBe(false);
    expect(leaderOppRed51(all, red({ myPlayerId: 'P1' }))).toBe(false);
    expect(leaderOppRed51(all, red({ currentRound: 2 }))).toBe(false);
    expect(leaderOppRed51(all, red({ questResults: ['fail', 'fail'] }))).toBe(false);
    expect(leaderOppRed51(all, r3())).toBe(false);
  });
});

describe('untaintedLakePick51 (B: loyal lake holder)', () => {
  // P6..P9 sat on the failed R2 mission (tainted)
  const an = (_o: PlayerObservation, c: readonly string[]): { candidates: Array<{ id: string; score: number; infoGain: number }> } => ({
    candidates: c.map((id) => ({ id, infoGain: id === 'P7' ? 1.0 : id === 'P10' ? 0.7 : 0.5, score: id === 'P7' ? 1.0 : id === 'P10' ? 0.7 : 0.5 })),
  });
  const holder = (over: Partial<PlayerObservation> = {}): PlayerObservation => r3({ myPlayerId: 'P2', gamePhase: 'team_select', ...over } as Partial<PlayerObservation>);
  it('off: null; on: a tainted best candidate is docked w × best info', () => {
    expect(untaintedLakePick51(T(), holder(), ['P7', 'P10', 'P5'], an)).toBeNull();
    expect(untaintedLakePick51(T({ lakeUntainted51: 0.2 }), holder(), ['P7', 'P10', 'P5'], an)).toBe('P7'); // 1.0 − 0.2 = 0.8 > 0.7
    expect(untaintedLakePick51(T({ lakeUntainted51: 0.5 }), holder(), ['P7', 'P10', 'P5'], an)).toBe('P10'); // 1.0 − 0.5 = 0.5 < 0.7
  });
  it('loyal and Percival holders only (Percival lakes as a loyal, INV-PL2)', () => {
    expect(untaintedLakePick51(T({ lakeUntainted51: 0.5 }), holder({ myRole: 'percival' }), ['P7', 'P10'], an)).toBe('P10');
    expect(untaintedLakePick51(T({ lakeUntainted51: 0.5 }), holder({ myRole: 'merlin' }), ['P7', 'P10'], an)).toBeNull();
    expect(untaintedLakePick51(T({ lakeUntainted51: 0.5 }), holder({ myRole: 'assassin', myTeam: 'evil' } as Partial<PlayerObservation>), ['P7', 'P10'], an)).toBeNull();
  });
});
