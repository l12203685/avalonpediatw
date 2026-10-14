/**
 * `AgentTuning.percivalNoThumbsR1` (2026-10-14, docs/ai/percival_thumbs.md 第 9 節):
 * Percival leaves both thumbs (Merlin / Morgana, which he cannot tell apart)
 * off every R1 team he leads; R2+ unchanged. Fake games only.
 */
import { describe, it, expect } from 'vitest';
import { PERCIVAL_NO_THUMBS_R1_PLAYER_COUNT, percivalNoThumbsR1Active } from './PercivalThumbs';
import {
  AGENT_TUNING_ENV,
  DEFAULT_AGENT_TUNING,
  LEGACY_AGENT_TUNING,
  describeAgentTuning,
  parseTuningFlag,
  tuningFromEnv,
  type AgentTuning,
} from './AgentTuning';
import { ForwardAgent } from './forward/ForwardAgent';
import { applyRoleBias } from './forward/RoleStrategy';
import { HeuristicAgent } from './HeuristicAgent';
import { replayRule } from './explain';
import type { AgentAction, PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

/** An R1 proposal the `attempt`-th leader made and everyone voted on normally (rejected). */
function rejected(attempt: number, ids: readonly string[] = IDS): VoteRecord {
  const leader = ids[attempt - 1];
  const team = [leader, ids[attempt % ids.length], ids[(attempt + 1) % ids.length]];
  const votes: Record<string, boolean> = {};
  for (const id of ids) votes[id] = team.includes(id);
  return { round: 1, attempt, leader, team, approved: false, votes };
}

/**
 * Percival leads the `attempt`-th R1 proposal (attempt 5 = the forced one).
 * Leaders rotate from P1, so Percival sits at seat `attempt`; `thumbs` are
 * the two seats he sees (in seat order, as the engine hands them over).
 */
function r1(thumbs: [string, string], attempt = 1, partial: Partial<PlayerObservation> = {}): PlayerObservation {
  const me = IDS[attempt - 1];
  return {
    myPlayerId: me,
    myRole: 'percival',
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: [],
    knownWizards: thumbs,
    currentRound: 1,
    currentLeader: me,
    failCount: attempt - 1,
    questResults: [],
    gamePhase: 'team_select',
    voteHistory: Array.from({ length: attempt - 1 }, (_, i) => rejected(i + 1)),
    questHistory: [],
    proposedTeam: [],
    lakeHistory: [],
    ...partial,
  };
}

/** R2 first proposal by Percival (P6) after an R1 mission (`r1Team`, `result`). */
function r2(thumbs: [string, string], r1Team: string[], result: 'success' | 'fail'): PlayerObservation {
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = r1Team.includes(id);
  const voteHistory: VoteRecord[] = [
    ...[1, 2, 3, 4].map((a) => rejected(a)),
    { round: 1, attempt: 5, leader: 'P5', team: r1Team, approved: true, votes },
  ];
  const questHistory: QuestRecord[] = [{ round: 1, team: r1Team, result, failCount: result === 'fail' ? 1 : 0 }];
  return {
    ...r1(thumbs, 6),
    currentRound: 2,
    failCount: 0,
    questResults: [result],
    voteHistory,
    questHistory,
  };
}

const tuned = (on: boolean): Partial<AgentTuning> => ({ ...DEFAULT_AGENT_TUNING, percivalNoThumbsR1: on });

function forwardDecision(o: PlayerObservation, on: boolean): ReturnType<ForwardAgent['decide']> {
  const base = new HeuristicAgent(o.myPlayerId, undefined, undefined, tuned(on));
  const a = new ForwardAgent(o.myPlayerId, base);
  a.onGameStart(o);
  return a.decide(o);
}

function forwardTeam(o: PlayerObservation, on: boolean): string[] {
  const d = forwardDecision(o, on);
  expect(d.reasoningTrace.usedFallback).toBe(false);
  if (d.action.type !== 'team_select') throw new Error('expected a team');
  return d.action.teamIds;
}

/** Every thumb pair: both before / one before / both after Percival, for each Percival seat 1–5. */
function thumbPairs(attempt: number): [string, string][] {
  const others = IDS.filter((_, i) => i !== attempt - 1);
  const out: [string, string][] = [];
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) out.push([others[i], others[j]]);
  }
  return out;
}

describe('percivalNoThumbsR1Active', () => {
  const ON = { percivalNoThumbsR1: true };
  const OFF = { percivalNoThumbsR1: false };

  it('covers Percival in R1 of a 10-player game with the switch on, nothing else', () => {
    expect(PERCIVAL_NO_THUMBS_R1_PLAYER_COUNT).toBe(10);
    for (const attempt of [1, 2, 3, 4, 5]) expect(percivalNoThumbsR1Active(ON, r1(['P3', 'P7'], attempt))).toBe(true);
    expect(percivalNoThumbsR1Active(OFF, r1(['P3', 'P7']))).toBe(false);
    expect(percivalNoThumbsR1Active(ON, r2(['P3', 'P7'], ['P5', 'P8', 'P9'], 'success'))).toBe(false);
    expect(percivalNoThumbsR1Active(ON, r1(['P3', 'P7'], 1, { myRole: 'loyal', knownWizards: undefined }))).toBe(false);
    expect(percivalNoThumbsR1Active(ON, r1(['P3', 'P7'], 1, { myRole: 'merlin' }))).toBe(false);
    expect(percivalNoThumbsR1Active(ON, r1(['P3', 'P7'], 1, { knownWizards: [] }))).toBe(false);
    for (const n of [5, 6, 7, 8, 9]) {
      expect(percivalNoThumbsR1Active(ON, r1(['P3', 'P4'], 1, { playerCount: n, allPlayerIds: IDS.slice(0, n) }))).toBe(false);
    }
  });

  it('flag plumbing: legacy off, on in the default (adopted 2026-10-14), CLI flag, env var, description', () => {
    // strength_benchmark.md 第 14 節: blue stance pooled over 515151 + 626262 + 737373
    // +0.01pp [−0.31pp, +0.32pp], confirmation seeds −0.08pp [−0.47pp, +0.32pp]; red 0.
    expect(LEGACY_AGENT_TUNING.percivalNoThumbsR1).toBe(false);
    expect(DEFAULT_AGENT_TUNING.percivalNoThumbsR1).toBe(true);
    expect(parseTuningFlag('percivalNoThumbsR1')).toEqual({ percivalNoThumbsR1: true });
    expect(parseTuningFlag('percivalNoThumbsR1=0')).toEqual({ percivalNoThumbsR1: false });
    expect(AGENT_TUNING_ENV.percivalNoThumbsR1).toBe('AVALON_TUNING_PERCIVAL_NO_THUMBS_R1');
    expect(tuningFromEnv({ AVALON_TUNING_PERCIVAL_NO_THUMBS_R1: '1' })).toEqual({ percivalNoThumbsR1: true });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, percivalNoThumbsR1: true })).toBe('percivalNoThumbsR1');
  });
});

describe('ForwardAgent — percivalNoThumbsR1', () => {
  it('switch off (the old behaviour): with no vote yet the R1-P1 team holds the lower-seated thumb', () => {
    for (const thumbs of thumbPairs(1)) {
      const team = forwardTeam(r1(thumbs, 1), false);
      expect(team).toContain(thumbs[0]);
      expect(team).not.toContain(thumbs[1]);
    }
  });

  it('switch on: no thumb on any R1 team, every seat 1–5 and every thumb pair (C2 / C1 / C0), forced fifth included', () => {
    for (const attempt of [1, 2, 3, 4, 5]) {
      for (const thumbs of thumbPairs(attempt)) {
        const o = r1(thumbs, attempt);
        const team = forwardTeam(o, true);
        expect(team).toHaveLength(3);
        expect(new Set(team).size).toBe(3);
        expect(team).toContain(o.myPlayerId);
        expect(team.filter((id) => thumbs.includes(id))).toEqual([]);
      }
    }
  });

  it('switch on: never one of the banned R1-P1 trios (123 / 150 / 234 / 678)', () => {
    const banned = new Set(['P1,P2,P3', 'P1,P5,P10', 'P2,P3,P4', 'P6,P7,P8']);
    for (const thumbs of thumbPairs(1)) {
      const team = forwardTeam(r1(thumbs, 1), true);
      expect(banned.has([...team].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(','))).toBe(false);
    }
  });

  it('R2+ is unchanged: same team with the switch on and off', () => {
    const cases: PlayerObservation[] = [
      r2(['P3', 'P7'], ['P5', 'P8', 'P9'], 'success'),
      r2(['P3', 'P7'], ['P3', 'P5', 'P8'], 'fail'),
      r2(['P2', 'P9'], ['P2', 'P4', 'P10'], 'success'),
      r2(['P8', 'P10'], ['P5', 'P8', 'P9'], 'fail'),
    ];
    for (const o of cases) expect(forwardTeam(o, true)).toEqual(forwardTeam(o, false));
  });

  it('votes are untouched: R1 (delegated to the baseline) and R3 team votes are the same on and off', () => {
    const vote = (o: PlayerObservation, on: boolean): AgentAction => forwardDecision(o, on).action;
    const r1Vote = r1(['P3', 'P7'], 3, { gamePhase: 'team_vote', currentLeader: 'P2', proposedTeam: ['P2', 'P3', 'P4'] });
    const r3Vote: PlayerObservation = {
      ...r2(['P3', 'P7'], ['P5', 'P8', 'P9'], 'success'),
      currentRound: 3,
      questResults: ['success', 'fail'],
      questHistory: [
        { round: 1, team: ['P5', 'P8', 'P9'], result: 'success', failCount: 0 },
        { round: 2, team: ['P2', 'P4', 'P7', 'P10'], result: 'fail', failCount: 1 },
      ],
      gamePhase: 'team_vote',
      currentLeader: 'P4',
      proposedTeam: ['P3', 'P4', 'P5', 'P8'],
    };
    for (const o of [r1Vote, r3Vote]) expect(vote(o, true)).toEqual(vote(o, false));
  });

  it('red leaders and other good roles in R1 are untouched', () => {
    const loyal = r1(['P3', 'P7'], 2, { myRole: 'loyal', knownWizards: undefined });
    expect(forwardTeam(loyal, true)).toEqual(forwardTeam(loyal, false));
    const merlin = r1(['P3', 'P7'], 2, { myRole: 'merlin', knownWizards: undefined, knownEvils: ['P4', 'P8', 'P9'] });
    expect(forwardTeam(merlin, true)).toEqual(forwardTeam(merlin, false));
  });

  it('5–9 players: the same R1 team with the switch on and off', () => {
    for (const n of [5, 6, 7, 8, 9]) {
      const ids = IDS.slice(0, n);
      const o: PlayerObservation = {
        ...r1(['P2', 'P4'], 1),
        playerCount: n,
        allPlayerIds: ids,
      };
      expect(forwardTeam(o, true)).toEqual(forwardTeam(o, false));
    }
  });
});

describe('RoleStrategy — no bonus for thumb A in R1 with the switch on', () => {
  const signals = {
    numKnownEvilOnTeam: 0,
    avgSuspicion: 0.5,
    includesKnownEvil: false,
    merlinProbForTarget: 0,
    teamIncludesPercivalA: true,
    teamIncludesPercivalB: false,
    merlinHidingFromAssassin: false,
    morganaBetrayal: false,
    mordredR1Leader: false,
    targetIsKnownAlly: false,
    targetIsOberon: false,
    oberonMissionParticipatedBefore: false,
    oberonFailedInMission: false,
  };
  const team: AgentAction = { type: 'team_select', teamIds: ['P1', 'P3', 'P5'] };
  const o = r1(['P3', 'P7']);

  it('A only: the usual bonus with the switch off, none with it on; B keeps its penalty', () => {
    expect(applyRoleBias('percival', team, o, signals)).toEqual({ findMerlin: 0.6, hidePercival: 0.2, threeBlueWins: 0.3 });
    expect(applyRoleBias('percival', team, o, { ...signals, percivalNoThumbsR1: false }))
      .toEqual({ findMerlin: 0.6, hidePercival: 0.2, threeBlueWins: 0.3 });
    expect(applyRoleBias('percival', team, o, { ...signals, percivalNoThumbsR1: true })).toEqual({});
    const withB = { ...signals, teamIncludesPercivalA: false, teamIncludesPercivalB: true, percivalNoThumbsR1: true };
    expect(applyRoleBias('percival', team, o, withB)).toEqual({ findMerlin: -0.8, hidePercival: -0.4, threeBlueWins: -0.4 });
  });
});

describe('HeuristicAgent.selectPercivalTeam (fallback path) — percivalNoThumbsR1', () => {
  const pick = (o: PlayerObservation, on: boolean): string[] => {
    const agent = new HeuristicAgent(o.myPlayerId, undefined, undefined, tuned(on));
    agent.onGameStart(o);
    const pool = IDS.filter((id) => id !== o.myPlayerId);
    return agent._selectPercivalTeamForTesting(o, 3, pool, null);
  };

  it('switch on: R1-P2..P5 also leave both thumbs off (R1-P1 already did)', () => {
    for (const attempt of [1, 2, 3, 4, 5]) {
      const o = r1(['P6', 'P7'], attempt);
      const team = pick(o, true);
      expect(team).toHaveLength(3);
      expect(team).toContain(o.myPlayerId);
      expect(team).not.toContain('P6');
      expect(team).not.toContain('P7');
    }
    // R1-P1 is the same either way (the old rule).
    expect(pick(r1(['P6', 'P7'], 1), false)).toEqual(pick(r1(['P6', 'P7'], 1), true));
  });

  it('switch off: from R1-P2 on the old decision tree may take the inferred Merlin', () => {
    // The thumbs P2 / P3 are the least suspicious seats of the pool, so the
    // old tree (no-thumb rule only at R1-P1) puts one of them on the team.
    const o = r1(['P2', 'P3'], 4);
    const off = pick(o, false);
    expect(off.filter((id) => id === 'P2' || id === 'P3')).toHaveLength(1);
    const on = pick(o, true);
    expect(on.filter((id) => id === 'P2' || id === 'P3')).toEqual([]);
  });
});

describe('post-game review (explain.replayRule)', () => {
  it('names the rule for an R1 Percival team with the switch on and checks the replay', () => {
    const o = r1(['P3', 'P7'], 2);
    const agent = new HeuristicAgent(o.myPlayerId, undefined, undefined, tuned(true));
    const real = forwardTeam(o, true);
    const r = replayRule(o, agent, { type: 'team_select', teamIds: real }, { forwardActive: true });
    expect(r?.rule).toMatch(/^派西首局不放拇指/);
    expect(r?.mismatch).toBe(false);
    const other = replayRule(o, agent, { type: 'team_select', teamIds: ['P2', 'P3', 'P7'] }, { forwardActive: true });
    expect(other?.mismatch).toBe(true);
    // Switch off: the generic forward-reasoning description.
    const offAgent = new HeuristicAgent(o.myPlayerId, undefined, undefined, tuned(false));
    const off = replayRule(o, offAgent, { type: 'team_select', teamIds: forwardTeam(o, false) }, { forwardActive: true });
    expect(off?.rule).not.toMatch(/派西首局不放拇指/);
  });
});
