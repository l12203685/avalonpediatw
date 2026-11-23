import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { publicTeamRedProb67, redEarlyBlack67 } from './Round67';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { OPPONENT_TYPES, PROFILE_OVERRIDES, tuningForOpponent } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const allYes = (team: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, team.includes(id) || id === 'P9']));

/**
 * R2 (0:1): the R1 mission P2 P3 P4 (leader P2) failed with one fail card. Now P6 proposes P1 P2 P3 P6; P2 (the assassin) is on it with
 * his teammate P3 (Morgana; P7 = Mordred). Two members of the failed mission on the team → the public loyal view puts a red on it.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P2', 'P3', 'P4'];
  return {
    myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: ids, knownEvils: ['P3', 'P7'],
    currentRound: 2, currentLeader: 'P6', failCount: 0, questResults: ['fail'], gamePhase: 'team_vote',
    voteHistory: [{ round: 1, attempt: 1, leader: 'P2', team: r1, approved: true, votes: allYes(r1) }],
    questHistory: [{ round: 1, team: r1, result: 'fail', failCount: 1 }],
    proposedTeam: ['P1', 'P2', 'P3', 'P6'], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const r1Obs = (over: Partial<PlayerObservation> = {}): PlayerObservation =>
  obs({ currentRound: 1, questResults: [], questHistory: [], voteHistory: [], proposedTeam: ['P1', 'P2', 'P3'], currentLeader: 'P1', ...over });

describe('round 67 switches', () => {
  it('default off in the default and the legacy tables and on every opponent profile; flags parse', () => {
    // Round 67: the default (bot-only baseline) carries θ = 0.89 with the default scope (Morgana / Mordred, R2 after an R1 fail, a teammate on
    // the team, not the decisive vote); the legacy table is off; the human tables inherit the baseline (no override).
    expect(DEFAULT_AGENT_TUNING.redEarlyBlack67).toBe(0.89);
    expect(LEGACY_AGENT_TUNING.redEarlyBlack67).toBe(0);
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) expect(t.redEarlyBlack67Scope).toBe(0);
    for (const k of OPPONENT_TYPES) {
      expect(PROFILE_OVERRIDES[k].redEarlyBlack67).toBeUndefined();
      expect(tuningForOpponent(k).redEarlyBlack67).toBe(0.89);
    }
    expect(parseTuningFlag('redEarlyBlack67')).toEqual({ redEarlyBlack67: 0.8 });
    expect(parseTuningFlag('redEarlyBlack67=0.6')).toEqual({ redEarlyBlack67: 0.6 });
    expect(parseTuningFlag('redEarlyBlack67Scope')).toEqual({ redEarlyBlack67Scope: 25 });
    expect(parseTuningFlag('redEarlyBlack67Scope=127')).toEqual({ redEarlyBlack67Scope: 127 });
    expect(() => parseTuningFlag('redEarlyBlack67=1.5')).toThrow();
    expect(() => parseTuningFlag('redEarlyBlack67Scope=128')).toThrow();
  });
});

describe('redEarlyBlack67', () => {
  const p = publicTeamRedProb67(DEFAULT_AGENT_TUNING, obs(), obs().proposedTeam ?? []);
  // Scope without the decisive-vote check (bit 16): 1 + 8.
  const at = (theta: number, scope = 73): ReturnType<typeof resolveAgentTuning> => resolveAgentTuning({ redEarlyBlack67: theta, redEarlyBlack67Scope: scope });

  it('the public loyal view reads a red on a team with two members of the failed R1 mission (not the red\'s private knowledge)', () => {
    expect(p).not.toBeNull();
    expect(p as number).toBeGreaterThan(0.5);
    expect(p as number).toBeLessThan(1);
    // The same answer whatever the red knows about its teammates.
    expect(publicTeamRedProb67(DEFAULT_AGENT_TUNING, obs({ knownEvils: ['P8', 'P9'] }), obs().proposedTeam ?? [])).toBeCloseTo(p as number, 9);
  });

  it('inner-blacks exactly when P(red on the team) ≥ θ; off in the legacy table', () => {
    expect(redEarlyBlack67(at((p as number) - 0.01), obs())).toBe(true);
    expect(redEarlyBlack67(at(Math.min(1, (p as number) + 0.01)), obs())).toBe(false);
    expect(redEarlyBlack67(LEGACY_AGENT_TUNING, obs())).toBe(false);
    expect(redEarlyBlack67({ ...DEFAULT_AGENT_TUNING, redEarlyBlack67: 0 }, obs({ myRole: 'morgana', myPlayerId: 'P3', knownEvils: ['P2', 'P7'] }))).toBe(false);
  });

  it('off the team, as the leader, R3, the forced proposal, blue seats and other phases: never', () => {
    const on = at(0.01, 127);
    expect(redEarlyBlack67(on, obs())).toBe(true);
    expect(redEarlyBlack67(on, obs({ proposedTeam: ['P1', 'P3', 'P5', 'P6'] }))).toBe(false);
    expect(redEarlyBlack67(on, obs({ currentLeader: 'P2' }))).toBe(false);
    expect(redEarlyBlack67(on, obs({ currentRound: 3, questResults: ['fail', 'success'] }))).toBe(false);
    expect(redEarlyBlack67(on, obs({ failCount: 4 }))).toBe(false);
    expect(redEarlyBlack67(on, obs({ myTeam: 'good', myRole: 'loyal', knownEvils: [] }))).toBe(false);
    expect(redEarlyBlack67(on, obs({ gamePhase: 'team_select' }))).toBe(false);
  });

  it('scope bits: R2 after an R1 fail (1), R2 after an R1 success (2), R1 (4)', () => {
    expect(redEarlyBlack67(at(0.01, 65), obs())).toBe(true);
    expect(redEarlyBlack67(at(0.01, 66), obs())).toBe(false);
    const r1Ok = obs({ questResults: ['success'], questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }] });
    expect(redEarlyBlack67(at(0.01, 65), r1Ok)).toBe(false);
    expect(redEarlyBlack67(at(0.01, 66), r1Ok)).toBe(true);
    expect(redEarlyBlack67(at(0.01, 65), r1Obs())).toBe(false);
    expect(redEarlyBlack67(at(0.01, 68), r1Obs())).toBe(true);
  });

  it('bit 8: only with a teammate it sees on the team; bit 32: Oberon', () => {
    expect(redEarlyBlack67(at(0.01, 73), obs({ knownEvils: ['P7', 'P8'] }))).toBe(false);
    expect(redEarlyBlack67(at(0.01, 65), obs({ knownEvils: ['P7', 'P8'] }))).toBe(true);
    const oberon = obs({ myRole: 'oberon', knownEvils: [] });
    expect(redEarlyBlack67(at(0.01, 65), oberon)).toBe(false);
    expect(redEarlyBlack67(at(0.01, 33), oberon)).toBe(true);
    // Bit 64: the assassin (the default scope 0 = 25 gives only Morgana and Mordred).
    expect(redEarlyBlack67(at(0.01, 25), obs())).toBe(false);
    expect(redEarlyBlack67(at(0.01, 25), obs({ myRole: 'morgana', myPlayerId: 'P3', knownEvils: ['P2', 'P7'] }))).toBe(true);
    expect(redEarlyBlack67(at(0.01, 25), obs({ myRole: 'mordred', myPlayerId: 'P3', knownEvils: ['P2', 'P7'] }))).toBe(true);
  });

  it('bit 16: not when its own vote would be the sixth approval (the decisive one)', () => {
    // Everyone off the team who reads the team as clean counts as approving; with θ tiny the four team members plus nobody else → not decisive.
    expect(redEarlyBlack67(at(0.01, 89), obs())).toBe(true);
    // A six-player team: five others on it approve → my approve would be the sixth → decisive → keep the approve.
    const six = obs({ proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] });
    expect(redEarlyBlack67(at(0.01, 73), six)).toBe(true);
    expect(redEarlyBlack67(at(0.01, 89), six)).toBe(false);
  });

  it('ForwardAgent: off = the R1–R2 normal vote (approve on the team); on = inner black', () => {
    const decide = (tuning: ReturnType<typeof resolveAgentTuning>): boolean | null => {
      const base = new HeuristicAgent('P2', undefined, undefined, tuning);
      base.onGameStart(r1Obs({ gamePhase: 'team_select' }));
      const a = new ForwardAgent('P2', base).decide({ ...obs(), seatTeam: 'evil' } as PlayerObservation).action;
      return a.type === 'team_vote' ? a.vote : null;
    };
    expect(decide(resolveAgentTuning({ redEarlyBlack67: 0 }))).toBe(true);
    expect(decide(resolveAgentTuning({}))).toBe(true); // the default scope leaves the assassin out
    expect(decide(resolveAgentTuning({ redEarlyBlack67: 0.01, redEarlyBlack67Scope: 89 }))).toBe(false);
    expect(decide(resolveAgentTuning({ redEarlyBlack67: 0.01 }))).toBe(true); // the assassin needs bit 64
    expect(decide(resolveAgentTuning({ redEarlyBlack67: 0.999, redEarlyBlack67Scope: 89 }))).toBe(true);
  });
});
