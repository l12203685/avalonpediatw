/**
 * `AgentTuning.redR1Teammate` (2026-10-13 round 3, strength_benchmark.md 第 12 節):
 * an R1 red leader who sees teammates no longer leaves them out of every
 * R1 team. Pure plan (`redR1TeamPlan`) + the ForwardAgent wiring.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_RED_R1_TEAMMATE_OPTIONS,
  HUMAN_R1_TEAMMATE_RATE,
  loyalViewOf,
  redR1TeamPlan,
  redR1TeammateOptionsFromEnv,
  setRedR1TeammateOptions,
  visibleTeammatesOn,
} from './RedR1Teammate';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { ForwardAgent } from './forward/ForwardAgent';
import { HeuristicAgent } from './HeuristicAgent';
import type { PlayerObservation, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function rejected(attempt: number): VoteRecord {
  const leader = IDS[attempt - 1];
  const team = [leader, IDS[attempt], IDS[attempt + 1]];
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = team.includes(id);
  return { round: 1, attempt, leader, team, approved: false, votes };
}

/** R1 team pick of the `attempt`-th leader (a seeing red; teammates 3 and 6 seats on, e.g. P1 → P4, P7). */
function r1(partial: Partial<PlayerObservation> = {}, attempt = 1): PlayerObservation {
  return {
    myPlayerId: IDS[attempt - 1],
    myRole: 'assassin',
    myTeam: 'evil',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: [IDS[(attempt + 2) % 10], IDS[(attempt + 5) % 10]],
    currentRound: 1,
    currentLeader: IDS[attempt - 1],
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

const ON: Pick<AgentTuning, 'redR1Teammate'> = { redR1Teammate: true };
const OFF: Pick<AgentTuning, 'redR1Teammate'> = { redR1Teammate: false };

afterEach(() => {
  setRedR1TeammateOptions(undefined);
  vi.restoreAllMocks();
});

describe('redR1TeamPlan', () => {
  it('only covers an R1 team pick of a red who sees teammates, with the switch on', () => {
    const always = { talk: 'always', forced: 'never' } as const;
    expect(redR1TeamPlan(r1(), OFF, always)).toBeNull();
    expect(redR1TeamPlan(r1(), ON, always)).toBe('withTeammate');
    expect(redR1TeamPlan(r1({ myRole: 'morgana' }), ON, always)).toBe('withTeammate');
    expect(redR1TeamPlan(r1({ myRole: 'mordred' }), ON, always)).toBe('withTeammate');
    // Oberon sees nobody; blue leaders; R2+; votes.
    expect(redR1TeamPlan(r1({ myRole: 'oberon', knownEvils: [] }), ON, always)).toBeNull();
    expect(redR1TeamPlan(r1({ myRole: 'loyal', myTeam: 'good', knownEvils: [] }), ON, always)).toBeNull();
    expect(redR1TeamPlan(r1({ currentRound: 2 }), ON, always)).toBeNull();
    expect(redR1TeamPlan(r1({ gamePhase: 'team_vote' }), ON, always)).toBeNull();
  });

  it('the forced fifth proposal keeps the old rule unless forced=humanRate', () => {
    const forced = r1({}, 5);
    expect(forced.failCount).toBe(4);
    expect(redR1TeamPlan(forced, ON, { talk: 'always', forced: 'never' })).toBeNull();
    const rnd = vi.spyOn(Math, 'random');
    rnd.mockReturnValue(HUMAN_R1_TEAMMATE_RATE.forced - 0.01);
    expect(redR1TeamPlan(forced, ON, { talk: 'never', forced: 'humanRate' })).toBe('withTeammate');
    rnd.mockReturnValue(HUMAN_R1_TEAMMATE_RATE.forced + 0.01);
    expect(redR1TeamPlan(forced, ON, { talk: 'never', forced: 'humanRate' })).toBeNull();
  });

  it('humanRate (the default) draws once against the human talk rate; loyal / never modes', () => {
    expect(DEFAULT_RED_R1_TEAMMATE_OPTIONS).toEqual({ talk: 'humanRate', forced: 'never' });
    expect(HUMAN_R1_TEAMMATE_RATE.talk).toBeCloseTo(0.48, 2);
    expect(HUMAN_R1_TEAMMATE_RATE.forced).toBeCloseTo(0.277, 3);
    const rnd = vi.spyOn(Math, 'random');
    rnd.mockReturnValue(0.47);
    expect(redR1TeamPlan(r1({}, 3), ON)).toBe('withTeammate');
    rnd.mockReturnValue(0.49);
    expect(redR1TeamPlan(r1({}, 3), ON)).toBeNull();
    expect(rnd).toHaveBeenCalledTimes(2);
    // Switch off / not covered → no draw at all.
    redR1TeamPlan(r1(), OFF);
    redR1TeamPlan(r1({ currentRound: 2 }), ON);
    expect(rnd).toHaveBeenCalledTimes(2);
    expect(redR1TeamPlan(r1(), ON, { talk: 'loyal', forced: 'never' })).toBe('asLoyal');
    expect(redR1TeamPlan(r1(), ON, { talk: 'never', forced: 'never' })).toBeNull();
  });

  it('benchmark knob parses from the environment; helpers', () => {
    expect(redR1TeammateOptionsFromEnv({})).toEqual(DEFAULT_RED_R1_TEAMMATE_OPTIONS);
    expect(redR1TeammateOptionsFromEnv({ AVALON_RED_R1_TEAMMATE_VARIANT: 'talk=always, forced=humanRate' }))
      .toEqual({ talk: 'always', forced: 'humanRate' });
    expect(redR1TeammateOptionsFromEnv({ AVALON_RED_R1_TEAMMATE_VARIANT: 'talk=bogus' })).toEqual(DEFAULT_RED_R1_TEAMMATE_OPTIONS);
    const view = loyalViewOf(r1());
    expect(view).toMatchObject({ myRole: 'loyal', myTeam: 'good', knownEvils: [] });
    expect(visibleTeammatesOn(r1(), ['P1', 'P4', 'P5'])).toBe(1);
    expect(visibleTeammatesOn(r1(), ['P1', 'P4', 'P7'])).toBe(2);
  });

  it('is off in legacy and in the production default until adopted', () => {
    expect(LEGACY_AGENT_TUNING.redR1Teammate).toBe(false);
    expect(typeof DEFAULT_AGENT_TUNING.redR1Teammate).toBe('boolean');
  });
});

describe('ForwardAgent — redR1Teammate', () => {
  const tuned = (on: boolean): Partial<AgentTuning> => ({ ...DEFAULT_AGENT_TUNING, redR1Teammate: on });
  const teamOf = (o: PlayerObservation, on: boolean): string[] => {
    const a = new ForwardAgent(o.myPlayerId, new HeuristicAgent(o.myPlayerId, undefined, undefined, tuned(on)));
    a.onGameStart(o);
    const d = a.decide(o);
    expect(d.reasoningTrace.usedFallback).toBe(false);
    if (d.action.type !== 'team_select') throw new Error('expected a team');
    return d.action.teamIds;
  };

  it('switch off: the R1 red leader never takes a visible teammate (mimic-loyal bias)', () => {
    for (const attempt of [1, 2, 3, 4, 5]) {
      const o = r1({}, attempt);
      for (const role of ['assassin', 'morgana', 'mordred'] as const) {
        const team = teamOf({ ...o, myRole: role }, false);
        expect(team).toHaveLength(3);
        expect(team).toContain(o.myPlayerId);
        expect(visibleTeammatesOn(o, team)).toBe(0);
      }
    }
  });

  it('talk=always: exactly one visible teammate on attempts 1–4, the forced proposal unchanged', () => {
    setRedR1TeammateOptions({ talk: 'always', forced: 'never' });
    for (const attempt of [1, 2, 3, 4]) {
      const o = r1({}, attempt);
      for (const role of ['assassin', 'morgana', 'mordred'] as const) {
        const team = teamOf({ ...o, myRole: role }, true);
        expect(team).toHaveLength(3);
        expect(team).toContain(o.myPlayerId);
        expect(visibleTeammatesOn(o, team)).toBe(1);
      }
    }
    const forced = r1({}, 5);
    expect(teamOf(forced, true)).toEqual(teamOf(forced, false));
  });

  it('talk=loyal proposes the team a loyal in the seat would; R2+ and blue leaders are untouched', () => {
    setRedR1TeammateOptions({ talk: 'loyal', forced: 'never' });
    const o = r1({}, 2);
    expect(teamOf(o, true)).toEqual(teamOf(loyalViewOf(o), false));
    const blue = r1({ myRole: 'percival', myTeam: 'good', knownEvils: [], knownWizards: ['P5', 'P8'] }, 2);
    expect(teamOf(blue, true)).toEqual(teamOf(blue, false));
    const r2 = r1({ currentRound: 2, failCount: 0, voteHistory: [], questHistory: [{ round: 1, team: ['P5', 'P6', 'P8'], result: 'fail', failCount: 1 }], questResults: ['fail'] }, 1);
    expect(teamOf(r2, true)).toEqual(teamOf(r2, false));
  });
});
