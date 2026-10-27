/**
 * TeamReuse — the team reuse prior behind `AgentTuning.teamReuse`
 * (2026-10-13 round 3, docs/ai/strength_benchmark.md 第 11 節).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_TEAM_REUSE_OPTIONS,
  keptShare,
  setTeamReuseOptions,
  teamReuseActive,
  teamReuseCandidateTeams,
  teamReuseGuard,
  teamReuseOptionsFromEnv,
  teamReusePlan,
  teamReuseScorer,
} from './TeamReuse';
import { ForwardAgent } from './forward/ForwardAgent';
import { HeuristicAgent } from './HeuristicAgent';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { LEGACY_BELIEF_OPTIONS } from './belief/BeliefOptions';
import type { PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function vote(round: number, attempt: number, leader: string, team: string[], approved: boolean): VoteRecord {
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = approved ? team.includes(id) || id === 'P10' || id === 'P9' : team.includes(id);
  return { round, attempt, leader, team, approved, votes };
}

/** R1 failed (P2 P3 P4), R2 succeeded (P5 P6 P7 P8); P1 leads the first R3 proposal. */
const QUESTS: QuestRecord[] = [
  { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 1 },
  { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
];
const VOTES: VoteRecord[] = [
  vote(1, 1, 'P2', ['P2', 'P3', 'P4'], true),
  vote(2, 1, 'P5', ['P5', 'P6', 'P7', 'P8'], true),
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
    currentLeader: 'P1',
    failCount: 0,
    questResults: ['fail', 'success'],
    gamePhase: 'team_select',
    voteHistory: VOTES,
    questHistory: QUESTS,
    proposedTeam: [],
    lakeHistory: [],
    ...partial,
  };
}

function agentWith(tuning: Partial<AgentTuning>, id = 'P1'): ForwardAgent {
  return new ForwardAgent(id, new HeuristicAgent(id, undefined, undefined, { ...DEFAULT_AGENT_TUNING, ...tuning }));
}

function pick(o: PlayerObservation, tuning: Partial<AgentTuning>): string[] {
  const a = agentWith(tuning, o.myPlayerId);
  a.onGameStart(o);
  const d = a.decide(o);
  expect(d.reasoningTrace.usedFallback).toBe(false);
  expect(d.action.type).toBe('team_select');
  return d.action.type === 'team_select' ? [...d.action.teamIds].sort() : [];
}

afterEach(() => setTeamReuseOptions(undefined));

describe('TeamReuse — options', () => {
  it('parses the benchmark-only variant knob (both camps, one camp, camps=)', () => {
    expect(teamReuseOptionsFromEnv({})).toEqual(DEFAULT_TEAM_REUSE_OPTIONS);
    const o = teamReuseOptionsFromEnv({ AVALON_TEAM_REUSE_VARIANT: 'success=3,evil.reject=0.2,bogus=1,mission=x' });
    expect(o.good).toEqual({ ...DEFAULT_TEAM_REUSE_OPTIONS.good, success: 3 });
    expect(o.evil).toEqual({ ...DEFAULT_TEAM_REUSE_OPTIONS.evil, success: 3, reject: 0.2 });
    const g = teamReuseOptionsFromEnv({ AVALON_TEAM_REUSE_VARIANT: 'camps=good' });
    expect(g.good).toEqual(DEFAULT_TEAM_REUSE_OPTIONS.good);
    expect(g.evil).toEqual({ success: 0, reject: 0, mission: 0, r1: 0 });
  });

  it('acts only with the switch on and some weight for the leader camp', () => {
    expect(teamReuseActive({ teamReuse: false }, obs({}))).toBe(false);
    expect(teamReuseActive({ teamReuse: true }, obs({}))).toBe(true);
    setTeamReuseOptions(teamReuseOptionsFromEnv({ AVALON_TEAM_REUSE_VARIANT: 'camps=evil' }));
    expect(teamReuseActive({ teamReuse: true }, obs({}))).toBe(false);
    expect(teamReuseActive({ teamReuse: true }, obs({ myTeam: 'evil', myRole: 'assassin' }))).toBe(true);
  });
});

describe('TeamReuse — references', () => {
  it('first proposal after a successful mission: the mission team', () => {
    const plan = teamReusePlan(obs({}));
    expect(plan?.refs).toEqual([{ team: QUESTS[1].team, weight: DEFAULT_TEAM_REUSE_OPTIONS.good.success, kind: 'mission' }]);
    expect(plan?.replacesPriorPenalty).toBe(true);
  });

  it('first proposal after a failed mission: no reference', () => {
    const o = obs({ currentRound: 2, questResults: ['fail'], questHistory: [QUESTS[0]], voteHistory: [VOTES[0]] });
    expect(teamReusePlan(o)?.refs).toEqual([]);
  });

  it('later proposals: every earlier proposal of the round, plus the mission team after a success', () => {
    const r3a = vote(3, 1, 'P9', ['P9', 'P5', 'P6', 'P7'], false);
    const r3b = vote(3, 2, 'P10', ['P10', 'P5', 'P6', 'P8'], false);
    const plan = teamReusePlan(obs({ voteHistory: [...VOTES, r3a, r3b], failCount: 2 }));
    const w = DEFAULT_TEAM_REUSE_OPTIONS.good;
    expect(plan?.refs).toEqual([
      { team: r3a.team, weight: w.reject, kind: 'proposal' },
      { team: r3b.team, weight: w.reject, kind: 'proposal' },
      { team: QUESTS[1].team, weight: w.mission, kind: 'mission' },
    ]);
  });

  it('R1 keeps the old behaviour unless r1 > 0', () => {
    const r1 = obs({
      currentRound: 1, questResults: [], questHistory: [], failCount: 1,
      voteHistory: [vote(1, 1, 'P10', ['P10', 'P2', 'P3'], false)],
    });
    expect(teamReusePlan(r1)).toBeNull();
    setTeamReuseOptions(teamReuseOptionsFromEnv({ AVALON_TEAM_REUSE_VARIANT: 'r1=0.2' }));
    expect(teamReusePlan(r1)?.refs).toHaveLength(1);
  });
});

describe('TeamReuse — candidates and bonus', () => {
  it('builds the reference with self swapped in, grown, and one-seat swaps, all legal', () => {
    const o = obs({});
    const plan = teamReusePlan(o);
    expect(plan).not.toBeNull();
    const teams = teamReuseCandidateTeams(plan!, o, IDS.filter((id) => id !== 'P1'));
    expect(teams.length).toBeGreaterThan(0);
    for (const t of teams) {
      expect(t).toHaveLength(4);
      expect(t).toContain('P1');
      expect(new Set(t).size).toBe(4);
    }
    // Self swapped in for each of the four mission members.
    for (const drop of QUESTS[1].team) {
      const want = ['P1', ...QUESTS[1].team.filter((id) => id !== drop)].sort();
      expect(teams.some((t) => [...t].sort().join() === want.join())).toBe(true);
    }
  });

  it('only draws from the pool it is given (role exclusions stay out)', () => {
    const o = obs({});
    const plan = teamReusePlan(o)!;
    const teams = teamReuseCandidateTeams(plan, o, ['P5', 'P6', 'P9', 'P10']);
    for (const t of teams) expect(t.every((id) => ['P1', 'P5', 'P6', 'P9', 'P10'].includes(id))).toBe(true);
  });

  it('bonus = weight × kept share; 0 for a 硬1 / 硬2 breach or a red a good leader can see', () => {
    expect(keptShare(['P1', 'P5', 'P6', 'P7'], ['P5', 'P6', 'P7', 'P8'], 'P1')).toBeCloseTo(0.75);
    expect(keptShare(['P1', 'P5', 'P6', 'P7'], ['P1', 'P5', 'P6', 'P7'], 'P1')).toBe(1);
    const w = DEFAULT_TEAM_REUSE_OPTIONS.good.success;
    const o = obs({});
    const bonus = teamReuseScorer(teamReusePlan(o)!, o);
    expect(bonus(['P1', 'P5', 'P6', 'P7'])).toBeCloseTo(0.75 * w);
    expect(bonus(['P1', 'P2', 'P3', 'P9'])).toBe(0);
    // P6 declared P9 blue: a team with P6 must hold P9 (硬1).
    const lake = obs({ lakeHistory: [{ round: 2, holderId: 'P6', targetId: 'P9', declaredClaim: 'good' }] });
    const lakeBonus = teamReuseScorer(teamReusePlan(lake)!, lake);
    expect(lakeBonus(['P1', 'P5', 'P6', 'P7'])).toBe(0);
    expect(lakeBonus(['P1', 'P6', 'P7', 'P9'])).toBeCloseTo(0.5 * w);
    // P5 declared P9 blue but led R2 without P9. Legacy beliefs: a 硬3 violator,
    // treated as red by a good leader (bonus 0). Batch 1C (`rule3PostLakeOnly`,
    // the default): that team came before P5's lake, and a 硬3 flag is a
    // probability anyway — the guard keeps only certain reds, so the bonus stays.
    const r3 = obs({ lakeHistory: [{ round: 2, holderId: 'P5', targetId: 'P9', declaredClaim: 'good' }] });
    expect(teamReuseScorer(teamReusePlan(r3)!, r3, teamReuseGuard(r3, undefined, LEGACY_BELIEF_OPTIONS))(['P1', 'P5', 'P6', 'P9'])).toBe(0);
    expect(teamReuseScorer(teamReusePlan(r3)!, r3)(['P1', 'P5', 'P6', 'P9'])).toBeCloseTo(0.5 * w);
    // A certain red is refused under the 1C guard: R1 showed three fail cards,
    // so P2 / P3 / P4 are red for everyone (C4).
    const certain = obs({ questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 3 }, QUESTS[1]] });
    expect(teamReuseScorer(teamReusePlan(certain)!, certain)(['P1', 'P5', 'P6', 'P2'])).toBe(0);
    expect(teamReuseScorer(teamReusePlan(certain)!, certain)(['P1', 'P5', 'P6', 'P7'])).toBeCloseTo(0.75 * w);
    // The leader itself declared P6 red (硬2 on its own team).
    const own = obs({ lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P6', declaredClaim: 'evil' }] });
    expect(teamReuseScorer(teamReusePlan(own)!, own)(['P1', 'P5', 'P6', 'P7'])).toBe(0);
    // Merlin sees P7 red.
    const merlin = obs({ myRole: 'merlin', knownEvils: ['P7', 'P2'] });
    expect(teamReuseScorer(teamReusePlan(merlin)!, merlin)(['P1', 'P5', 'P6', 'P7'])).toBe(0);
  });
});

describe('TeamReuse — ForwardAgent wiring', () => {
  it('on: a loyal on the successful team keeps it', () => {
    const o = obs({
      myPlayerId: 'P5',
      currentLeader: 'P5',
      voteHistory: VOTES,
    });
    expect(pick(o, { teamReuse: true })).toEqual(['P5', 'P6', 'P7', 'P8']);
  });

  it('R2+ later proposal: off keeps the old penalty and avoids the rejected team; on re-proposes it', () => {
    // R1 failed, so the only reference is R2's rejected first proposal (P10's team, with P1 on it).
    const rejected = ['P10', 'P1', 'P5', 'P6'];
    const o = obs({
      currentRound: 2, failCount: 1, questResults: ['fail'], questHistory: [QUESTS[0]],
      voteHistory: [VOTES[0], vote(2, 1, 'P10', rejected, false)],
    });
    const off = pick(o, { teamReuse: false });
    expect(off.filter((id) => rejected.includes(id)).length).toBeLessThanOrEqual(2); // overlap ≤ 50%: no penalty
    expect(pick(o, { ...LEGACY_AGENT_TUNING })).not.toEqual([...rejected].sort());
    // Isolated from `teamPassRank` (2026-10-27): ranked by pass chance, this rejected team keeps P1 of the
    // failed R1 mission and loses to cleaner teams — the switch under test here is the reuse bonus alone.
    expect(pick(o, { teamReuse: true, teamPassRank: false })).toEqual([...rejected].sort());
  });

  it('red leaders use the red weights (3× the good ones by default)', () => {
    const red = obs({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P3', 'P4'] });
    expect(DEFAULT_TEAM_REUSE_OPTIONS.evil.success).toBe(3 * DEFAULT_TEAM_REUSE_OPTIONS.good.success);
    expect(teamReusePlan(red)?.refs[0].weight).toBe(DEFAULT_TEAM_REUSE_OPTIONS.evil.success);
    // After the successful R2 mission the red leader keeps three of its four and swaps itself in.
    const team = pick(red, { teamReuse: true });
    expect(team).toContain('P1');
    expect(team.filter((id) => QUESTS[1].team.includes(id))).toHaveLength(3);
  });

  it('5 players: reuse candidates take the size of the round and the team stays legal', () => {
    const five = ['P1', 'P2', 'P3', 'P4', 'P5'];
    const fiveVote = (round: number, attempt: number, leader: string, team: string[], approved: boolean): VoteRecord => ({
      round, attempt, leader, team, approved,
      votes: Object.fromEntries(five.map((id) => [id, approved || team.includes(id)])),
    });
    const o = obs({
      allPlayerIds: five, playerCount: 5, currentRound: 2, questResults: ['success'],
      questHistory: [{ round: 1, team: ['P2', 'P3'], result: 'success', failCount: 0 }],
      voteHistory: [fiveVote(1, 1, 'P2', ['P2', 'P3'], true)],
    });
    const plan = teamReusePlan(o)!;
    for (const t of teamReuseCandidateTeams(plan, o, ['P2', 'P3', 'P4', 'P5'])) expect(t).toHaveLength(3);
    const team = pick(o, { teamReuse: true });
    expect(team).toHaveLength(3);
    expect(team).toEqual(['P1', 'P2', 'P3']);
  });

  it('a leader off the successful team swaps itself in and keeps three of the four', () => {
    const team = pick(obs({}), { teamReuse: true });
    expect(team).toContain('P1');
    expect(team.filter((id) => QUESTS[1].team.includes(id))).toHaveLength(3);
  });

  it('Merlin never takes a red it sees, even when it sat on the reference team', () => {
    const o = obs({ myRole: 'merlin', knownEvils: ['P7', 'P2', 'P3'] });
    for (const success of ['1', '9']) {
      setTeamReuseOptions(teamReuseOptionsFromEnv({ AVALON_TEAM_REUSE_VARIANT: `success=${success}` }));
      const team = pick(o, { teamReuse: true });
      expect(team.some((id) => o.knownEvils.includes(id))).toBe(false);
    }
  });

  it('a holder keeps its own declaration: the vouched seat stays on its team', () => {
    const o = obs({ lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P10', declaredClaim: 'good' }] });
    setTeamReuseOptions(teamReuseOptionsFromEnv({ AVALON_TEAM_REUSE_VARIANT: 'success=9' }));
    const team = pick(o, { teamReuse: true });
    // A huge reuse weight never pays for dropping P10 (no bonus on 硬1 / 硬3 breaches):
    // the best-paid teams keep P10 plus two of the mission team.
    expect(team).toContain('P10');
    expect(team.filter((id) => QUESTS[1].team.includes(id))).toHaveLength(2);
  });

  it('R1 proposals are unchanged with the default weights', () => {
    const r1 = obs({
      currentRound: 1, questResults: [], questHistory: [], failCount: 1, myPlayerId: 'P2', currentLeader: 'P2',
      voteHistory: [vote(1, 1, 'P1', ['P1', 'P2', 'P3'], false)],
    });
    expect(pick(r1, { teamReuse: true })).toEqual(pick(r1, { teamReuse: false }));
  });
});
