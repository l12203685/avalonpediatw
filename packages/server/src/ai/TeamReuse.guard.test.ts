/**
 * TeamReuse — the reuse guard (review 2026-10-13, docs/ai/strength_benchmark.md 第 11.2 節).
 *
 * The positions below come from bot self-play (5–10 player games; no human
 * game records). With the first version of the switch, each one led a good
 * leader to re-propose a seat it could deduce was red, or to break its own
 * lake word, because the reuse bonus outweighed the base score and the old
 * `PRIOR_PENALTY` was dropped for every team. The guard now refuses those
 * teams (no bonus, old penalty kept) and refused reuse candidates are never
 * added, so a refused team is only chosen where the switch-off agent would
 * choose it too.
 */
import { describe, it, expect } from 'vitest';
import { GUARD_RED_SUSPICION, teamReuseGuard, teamReusePlan, teamReuseScorer } from './TeamReuse';
import { ForwardAgent } from './forward/ForwardAgent';
import { HeuristicAgent } from './HeuristicAgent';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { computePyramidScores } from './baseline/pyramidScorer';
import type { LadyOfTheLakeRecord, PlayerObservation, QuestRecord, VoteRecord } from './types';

function v(round: number, attempt: number, leader: string, team: string, approved: boolean, yes: string): VoteRecord {
  const ids = yes.split(',');
  const votes: Record<string, boolean> = {};
  for (let i = 1; i <= 10; i++) votes[`P${i}`] = ids.includes(`P${i}`);
  return { round, attempt, leader, team: team.split(','), approved, votes };
}
function q(round: number, team: string, result: 'success' | 'fail', failCount: number): QuestRecord {
  return { round, team: team.split(','), result, failCount };
}
function lk(round: number, holderId: string, targetId: string, declaredClaim: 'good' | 'evil'): LadyOfTheLakeRecord {
  return { round, holderId, targetId, declaredClaim } as LadyOfTheLakeRecord;
}
function obsOf(o: Omit<PlayerObservation, 'gamePhase' | 'proposedTeam'>): PlayerObservation {
  const ids = new Set(o.allPlayerIds);
  const voteHistory = o.voteHistory.map((r) => ({
    ...r,
    votes: Object.fromEntries(Object.entries(r.votes).filter(([id]) => ids.has(id))),
  }));
  return { ...o, voteHistory, gamePhase: 'team_select', proposedTeam: [] };
}

const POS = {
  ownVouch10: obsOf({
    myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', playerCount: 10,
    allPlayerIds: ['P9', 'P10', 'P6', 'P7', 'P2', 'P5', 'P8', 'P1', 'P4', 'P3'], knownEvils: [],
    currentRound: 4, currentLeader: 'P3', failCount: 4, questResults: ['fail', 'success', 'fail'],
    voteHistory: [
      v(1, 1, 'P9', 'P9,P1,P3', false, 'P1,P3,P9'),
      v(1, 2, 'P10', 'P10,P9,P8', false, 'P8,P9,P10'),
      v(1, 3, 'P6', 'P6,P9,P5', false, 'P5,P6,P9'),
      v(1, 4, 'P7', 'P7,P9,P2', false, 'P2,P7,P9'),
      v(1, 5, 'P2', 'P2,P10,P5', true, 'P9,P10,P6,P7,P2,P5,P8,P1,P4,P3'),
      v(2, 1, 'P5', 'P5,P10,P7,P4', false, 'P4,P5,P7,P10'),
      v(2, 2, 'P8', 'P8,P10,P4,P9', false, 'P4,P8,P9,P10'),
      v(2, 3, 'P1', 'P1,P10,P5,P7', false, 'P1,P5,P7,P10'),
      v(2, 4, 'P4', 'P4,P10,P9,P8', false, 'P4,P8,P9,P10'),
      v(2, 5, 'P3', 'P3,P10,P5,P1', true, 'P9,P10,P6,P7,P2,P5,P8,P1,P4,P3'),
      v(3, 1, 'P9', 'P9,P3,P1,P10', false, 'P2,P3,P8,P9,P10'),
      v(3, 2, 'P10', 'P10,P1,P3,P5', false, 'P1,P3,P5,P10'),
      v(3, 3, 'P6', 'P6,P3,P7,P4', false, 'P3,P7'),
      v(3, 4, 'P7', 'P7,P6,P4,P1', false, 'P3,P5,P6,P7,P10'),
      v(3, 5, 'P2', 'P2,P9,P1,P10', true, 'P9,P10,P6,P7,P2,P5,P8,P1,P4,P3'),
      v(4, 1, 'P5', 'P5,P1,P4,P6,P9', false, 'P2,P5,P6,P8,P9'),
      v(4, 2, 'P8', 'P8,P4,P1,P5,P9', false, 'P2,P5,P8,P9'),
      v(4, 3, 'P1', 'P1,P6,P7,P5,P2', false, 'P1,P5,P6,P8,P9'),
      v(4, 4, 'P4', 'P4,P5,P1,P9,P8', false, 'P2,P5,P8,P9'),
    ],
    questHistory: [q(1, 'P2,P10,P5', 'fail', 1), q(2, 'P3,P10,P5,P1', 'success', 0), q(3, 'P2,P9,P1,P10', 'fail', 2)],
    lakeHistory: [lk(2, 'P3', 'P10', 'good'), lk(3, 'P10', 'P1', 'good')],
  }),
  percivalVouch10: obsOf({
    myPlayerId: 'P1', myRole: 'percival', myTeam: 'good', playerCount: 10,
    allPlayerIds: ['P3', 'P4', 'P7', 'P8', 'P6', 'P5', 'P2', 'P1', 'P9', 'P10'], knownEvils: [],
    knownWizards: ['P8', 'P9'],
    currentRound: 5, currentLeader: 'P1', failCount: 2, questResults: ['fail', 'success', 'success', 'fail'],
    voteHistory: [
      v(1, 1, 'P3', 'P3,P7,P10', false, 'P3,P7,P10'),
      v(1, 2, 'P4', 'P4,P3,P2', false, 'P2,P3,P4'),
      v(1, 3, 'P7', 'P7,P5,P2', false, 'P2,P5,P7'),
      v(1, 4, 'P8', 'P8,P2,P10', false, 'P2,P8,P10'),
      v(1, 5, 'P6', 'P6,P8,P1', true, 'P3,P4,P7,P8,P6,P5,P2,P1,P9,P10'),
      v(2, 1, 'P5', 'P5,P8,P1,P6', false, 'P1,P5,P6,P8'),
      v(2, 2, 'P2', 'P2,P8,P1,P5', false, 'P1,P2,P5,P8'),
      v(2, 3, 'P1', 'P1,P4,P5,P2', false, 'P1,P2,P4,P5'),
      v(2, 4, 'P9', 'P9,P8,P1,P5', false, 'P1,P5,P8,P9'),
      v(2, 5, 'P10', 'P10,P8,P1,P2', true, 'P3,P4,P7,P8,P6,P5,P2,P1,P9,P10'),
      v(3, 1, 'P3', 'P3,P10,P2,P8', false, 'P2,P3,P8,P10'),
      v(3, 2, 'P4', 'P4,P2,P8,P1', false, 'P1'),
      v(3, 3, 'P7', 'P7,P2,P8,P10', true, 'P1,P2,P3,P7,P8,P10'),
      v(4, 1, 'P8', 'P8,P2,P10,P7,P1', false, 'P1,P7,P8'),
      v(4, 2, 'P6', 'P6,P2,P4,P7,P9', true, 'P2,P3,P5,P6,P7,P9,P10'),
      v(5, 1, 'P5', 'P5,P4,P2,P10,P6', false, 'P4,P5,P6,P9'),
      v(5, 2, 'P2', 'P2,P4,P7,P5,P6', false, 'P4,P5,P6,P7,P9'),
    ],
    questHistory: [q(1, 'P6,P8,P1', 'fail', 1), q(2, 'P10,P8,P1,P2', 'success', 0), q(3, 'P7,P2,P8,P10', 'success', 0), q(4, 'P6,P2,P4,P7,P9', 'fail', 3)],
    lakeHistory: [lk(2, 'P10', 'P8', 'good'), lk(3, 'P8', 'P1', 'good'), lk(4, 'P1', 'P3', 'good')],
  }),
  deduced10: obsOf({
    myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', playerCount: 10,
    allPlayerIds: ['P2', 'P8', 'P3', 'P1', 'P7', 'P4', 'P6', 'P5', 'P10', 'P9'], knownEvils: [],
    currentRound: 3, currentLeader: 'P3', failCount: 2, questResults: ['fail', 'fail'],
    voteHistory: [
      v(1, 1, 'P2', 'P2,P3,P10', false, 'P2,P3,P10'),
      v(1, 2, 'P8', 'P8,P6,P10', false, 'P6,P8,P10'),
      v(1, 3, 'P3', 'P3,P7,P5', false, 'P3,P5,P7'),
      v(1, 4, 'P1', 'P1,P4,P6', false, 'P1,P4,P6'),
      v(1, 5, 'P7', 'P7,P2,P8', true, 'P2,P8,P3,P1,P7,P4,P6,P5,P10,P9'),
      v(2, 1, 'P4', 'P4,P3,P6,P5', false, 'P3,P4,P5,P6'),
      v(2, 2, 'P6', 'P6,P3,P4,P5', false, 'P3,P4,P5,P6'),
      v(2, 3, 'P5', 'P5,P3,P4,P6', false, 'P3,P4,P5,P6'),
      v(2, 4, 'P10', 'P10,P2,P3,P7', false, 'P2,P3,P7,P10'),
      v(2, 5, 'P9', 'P9,P10,P3,P7', true, 'P2,P8,P3,P1,P7,P4,P6,P5,P10,P9'),
      v(3, 1, 'P2', 'P2,P3,P10,P7', false, 'P1,P7,P9,P10'),
      v(3, 2, 'P8', 'P8,P3,P2,P10', false, 'P1,P2,P4,P8,P9'),
    ],
    questHistory: [q(1, 'P7,P2,P8', 'fail', 1), q(2, 'P9,P10,P3,P7', 'fail', 3)],
    lakeHistory: [lk(2, 'P9', 'P3', 'good')],
  }),
  deduced7: obsOf({
    myPlayerId: 'P5', myRole: 'loyal', myTeam: 'good', playerCount: 7,
    allPlayerIds: ['P7', 'P2', 'P4', 'P1', 'P5', 'P6', 'P3'], knownEvils: [],
    currentRound: 3, currentLeader: 'P5', failCount: 1, questResults: ['fail', 'fail'],
    voteHistory: [
      v(1, 1, 'P7', 'P7,P2', false, 'P2,P7'),
      v(1, 2, 'P2', 'P2,P5', false, 'P2,P5'),
      v(1, 3, 'P4', 'P4,P3', false, 'P3,P4'),
      v(1, 4, 'P1', 'P1,P2', false, 'P1,P2'),
      v(1, 5, 'P5', 'P5,P1', true, 'P7,P2,P4,P1,P5,P6,P3'),
      v(2, 1, 'P6', 'P6,P7,P3', false, 'P3,P6,P7'),
      v(2, 2, 'P3', 'P3,P7,P6', false, 'P3,P6,P7'),
      v(2, 3, 'P7', 'P7,P4,P3', false, 'P3,P4,P7'),
      v(2, 4, 'P2', 'P2,P7,P4', false, 'P2,P4,P7'),
      v(2, 5, 'P4', 'P4,P7,P2', true, 'P7,P2,P4,P1,P5,P6,P3'),
      v(3, 1, 'P1', 'P1,P5,P4', false, 'P1'),
    ],
    questHistory: [q(1, 'P5,P1', 'fail', 1), q(2, 'P4,P7,P2', 'fail', 2)],
    lakeHistory: [lk(2, 'P3', 'P1', 'evil')],
  }),
  merlin7: obsOf({
    myPlayerId: 'P2', myRole: 'merlin', myTeam: 'good', playerCount: 7,
    allPlayerIds: ['P2', 'P1', 'P5', 'P4', 'P7', 'P6', 'P3'], knownEvils: ['P6', 'P3'],
    currentRound: 2, currentLeader: 'P2', failCount: 2, questResults: ['fail'],
    voteHistory: [
      v(1, 1, 'P2', 'P2,P4', false, 'P2,P4'),
      v(1, 2, 'P1', 'P1,P2', false, 'P1,P2'),
      v(1, 3, 'P5', 'P5,P6', false, 'P5,P6'),
      v(1, 4, 'P4', 'P4,P5', false, 'P4,P5'),
      v(1, 5, 'P7', 'P7,P2', true, 'P2,P1,P5,P4,P7,P6,P3'),
      v(2, 1, 'P6', 'P6,P3,P7', false, 'P3,P6,P7'),
      v(2, 2, 'P3', 'P3,P6,P7', false, 'P3,P6,P7'),
    ],
    questHistory: [q(1, 'P7,P2', 'fail', 1)],
    lakeHistory: [],
  }),
};

function pick(o: PlayerObservation, teamReuse: boolean): string[] {
  const a = new ForwardAgent(o.myPlayerId, new HeuristicAgent(o.myPlayerId, undefined, undefined, { ...DEFAULT_AGENT_TUNING, teamReuse }));
  a.onGameStart(o);
  const d = a.decide(o);
  expect(d.reasoningTrace.usedFallback).toBe(false);
  expect(d.action.type).toBe('team_select');
  return d.action.type === 'team_select' ? [...d.action.teamIds].sort() : [];
}

/** Seats a good leader can prove red from one failed mission (fail cards cover everyone but itself). */
function certainReds(o: PlayerObservation): Set<string> {
  const out = new Set<string>();
  for (const m of o.questHistory) {
    const others = m.team.filter((id) => id !== o.myPlayerId);
    if (m.result === 'fail' && m.failCount >= others.length) for (const id of others) out.add(id);
  }
  return out;
}

describe('TeamReuse guard — deduced reds', () => {
  it('refuses a mission-certain red and a seat the pyramid scores at or above the threshold', () => {
    const o = POS.deduced7; // loyal P5; R1 [P5, P1] failed with one card → P1 is red
    const guard = teamReuseGuard(o);
    expect(guard(['P5', 'P4', 'P1'])).toBe(false);
    expect(guard(['P5', 'P4', 'P6'])).toBe(true);
    const plan = teamReusePlan(o)!;
    expect(teamReuseScorer(plan, o)(['P5', 'P4', 'P1'])).toBe(0); // P1's own rejected team: no bonus
    // P2 (on the R2 mission that failed with two cards out of three) is scored ≥ 0.85
    // by the pyramid without a certain deduction: refused on that score alone.
    const pyr = computePyramidScores(o);
    expect(certainReds(o).has('P2')).toBe(false);
    expect(pyr.scores.get('P2')).toBeGreaterThanOrEqual(GUARD_RED_SUSPICION);
    expect(guard(['P5', 'P4', 'P2'])).toBe(false);
    const capped = { ...pyr, scores: new Map([...pyr.scores].map(([id, s]) => [id, Math.min(s, 0.8)] as const)) };
    expect(teamReuseGuard(o, capped)(['P5', 'P4', 'P2'])).toBe(true);
    expect(teamReuseGuard(o, capped)(['P5', 'P4', 'P1'])).toBe(false); // still a certain red
  });

  it('red leaders: only 硬1 / 硬2 count (they know who is red)', () => {
    const o = { ...POS.deduced7, myRole: 'assassin' as const, myTeam: 'evil' as const };
    expect(teamReuseGuard(o)(['P5', 'P4', 'P1'])).toBe(true);
  });

  for (const key of ['deduced10', 'deduced7', 'merlin7'] as const) {
    it(`${key}: the switch never adds a certain red to a good leader's team`, () => {
      const o = POS[key];
      const reds = certainReds(o);
      expect(reds.size).toBeGreaterThan(0);
      const on = pick(o, true).filter((id) => reds.has(id));
      const off = pick(o, false).filter((id) => reds.has(id));
      expect(on.length).toBeLessThanOrEqual(off.length);
      expect(on.every((id) => off.includes(id))).toBe(true);
    });
  }

  it('Merlin whose two-seat mission failed does not take the partner back (rejected-team credit)', () => {
    expect(pick(POS.merlin7, true)).not.toContain('P7');
  });
});

describe('TeamReuse guard — own lake word', () => {
  it('forced fifth proposal: the holder keeps the seat it vouched for', () => {
    const o = POS.ownVouch10; // loyal P3 declared P10 blue; R4, failCount 4
    expect(o.failCount).toBe(4);
    expect(pick(o, false)).toContain('P10');
    expect(pick(o, true)).toContain('P10');
  });

  it('R5: Percival keeps the seat it vouched for instead of swapping it out for a tiny score gain', () => {
    const o = POS.percivalVouch10; // Percival P1 declared P3 blue
    expect(pick(o, true)).toContain('P3');
  });

  it('a refused team is only chosen where the switch-off agent chooses it too', () => {
    for (const o of Object.values(POS)) {
      const on = pick(o, true);
      if (!teamReuseGuard(o)(on)) expect(on).toEqual(pick(o, false));
    }
  });
});
