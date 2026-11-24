import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { r2Lead72Applies, r2Lead72Tuning, round72Stats } from './Round72';
import { HeuristicAgent } from './HeuristicAgent';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));

/**
 * R2 after an R1 fail: R1 (P1 P2 P3) failed with one fail card; R2 proposals by P2 and P3 were rejected. P4 (a loyal, not on the R1 team)
 * now leads the third R2 proposal.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P1', 'P2', 'P3'];
  return {
    myPlayerId: 'P4', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: ids, knownEvils: [],
    currentRound: 2, currentLeader: 'P4', failCount: 2, questResults: ['fail'], gamePhase: 'team_select',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P1', team: r1, approved: true, votes: votes(['P1', 'P2', 'P3', 'P5', 'P6', 'P7']) },
      { round: 2, attempt: 1, leader: 'P2', team: ['P2', 'P5', 'P6', 'P7'], approved: false, votes: votes(['P2', 'P5', 'P6', 'P7']) },
      { round: 2, attempt: 2, leader: 'P3', team: ['P3', 'P8', 'P9', 'P10'], approved: false, votes: votes(['P3', 'P8', 'P9']) },
    ],
    questHistory: [{ round: 1, team: r1, result: 'fail', failCount: 1 }],
    proposedTeam: [], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const at = (bits: number, temper = 0): ReturnType<typeof resolveAgentTuning> => resolveAgentTuning({ r2Lead72: bits, r2Lead72Temper: temper });

describe('round 72 switches', () => {
  it('default off in the default and legacy tables and at every opponent type; flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.r2Lead72).toBe(0);
      expect(t.r2Lead72Temper).toBe(0);
    }
    for (const k of OPPONENT_TYPES) expect(tuningForOpponent(k).r2Lead72 ?? 0).toBe(0);
    expect(parseTuningFlag('r2Lead72')).toEqual({ r2Lead72: 3 });
    expect(parseTuningFlag('r2Lead72=511')).toEqual({ r2Lead72: 511 });
    expect(parseTuningFlag('r2Lead72Temper')).toEqual({ r2Lead72Temper: 0.2 });
    expect(parseTuningFlag('r2Lead72Temper=0.1')).toEqual({ r2Lead72Temper: 0.1 });
    expect(() => parseTuningFlag('r2Lead72=512')).toThrow();
    expect(() => parseTuningFlag('r2Lead72Temper=2')).toThrow();
  });
});

describe('r2Lead72Applies', () => {
  it('R2 after an R1 fail, non-forced, a blue leader picking the team; loyal + Percival by default', () => {
    expect(r2Lead72Applies(at(1), obs())).toBe(true);
    expect(r2Lead72Applies(at(2), obs({ myRole: 'percival', knownWizards: ['P1', 'P3'] } as Partial<PlayerObservation>))).toBe(true);
    expect(r2Lead72Applies(at(4), obs())).toBe(true);
    expect(r2Lead72Applies(at(3), obs({ myRole: 'merlin' }))).toBe(false);
    expect(r2Lead72Applies(at(3 | 256), obs({ myRole: 'merlin' }))).toBe(true);
    expect(r2Lead72Applies(at(3 | 256), obs())).toBe(false); // role bits set → only those roles
    expect(r2Lead72Applies(at(3 | 64), obs())).toBe(true);
  });
  it('not: switch off or no reading bit, R1 succeeded, other rounds, the forced 5th proposal, votes, red seats, not the leader', () => {
    expect(r2Lead72Applies(at(0), obs())).toBe(false);
    expect(r2Lead72Applies(at(8 | 32 | 64), obs())).toBe(false); // scope bits alone change no reading
    expect(r2Lead72Applies(at(3), obs({ questResults: ['success'], questHistory: [{ round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 }] }))).toBe(false);
    expect(r2Lead72Applies(at(3), obs({ currentRound: 3, questResults: ['fail', 'success'] }))).toBe(false);
    expect(r2Lead72Applies(at(3), obs({ failCount: 4 }))).toBe(false);
    expect(r2Lead72Applies(at(3), obs({ gamePhase: 'team_vote', proposedTeam: ['P4', 'P5', 'P6', 'P7'] }))).toBe(false);
    expect(r2Lead72Applies(at(3), obs({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P5', 'P6'] }))).toBe(false);
    expect(r2Lead72Applies(at(3), obs({ currentLeader: 'P5' }))).toBe(false);
  });
  it('bit 8: only the 3rd and 4th proposals', () => {
    expect(r2Lead72Applies(at(3 | 8), obs({ failCount: 2 }))).toBe(true);
    expect(r2Lead72Applies(at(3 | 8), obs({ failCount: 3 }))).toBe(true);
    expect(r2Lead72Applies(at(3 | 8), obs({ failCount: 1 }))).toBe(false);
    expect(r2Lead72Applies(at(3), obs({ failCount: 0 }))).toBe(true);
  });
  it('bits 16 / 32: the leader on / off the R1 team (both or neither = both)', () => {
    const onR1 = obs({ myPlayerId: 'P2', currentLeader: 'P2' });
    expect(r2Lead72Applies(at(3 | 16), onR1)).toBe(true);
    expect(r2Lead72Applies(at(3 | 16), obs())).toBe(false);
    expect(r2Lead72Applies(at(3 | 32), obs())).toBe(true);
    expect(r2Lead72Applies(at(3 | 32), onR1)).toBe(false);
    expect(r2Lead72Applies(at(3 | 16 | 32), onR1)).toBe(true);
    expect(r2Lead72Applies(at(3 | 16 | 32), obs())).toBe(true);
  });
});

describe('r2Lead72Tuning', () => {
  it('bit 1 drops the leader-viewpoint reading, bit 2 sets the vote power, bit 4 the recursive lead read; the switch itself is cleared', () => {
    const base = resolveAgentTuning({ r2Lead72: 7, viewpoint53: 0.5, viewpointPow53: 0.5, blueVoteTemper57: 0.4, beliefLeadRecursive: 1 });
    const t = r2Lead72Tuning(base);
    expect(t.r2Lead72).toBe(0);
    expect(t.viewpoint53).toBe(0);
    expect(t.viewpointPow53).toBe(0);
    expect(t.blueVoteTemper57).toBe(0.2);
    expect(t.beliefLeadRecursive).toBe(0);
    const t1 = r2Lead72Tuning({ ...base, r2Lead72: 1 });
    expect(t1.blueVoteTemper57).toBe(0.4);
    expect(t1.beliefLeadRecursive).toBe(1);
    const t2 = r2Lead72Tuning({ ...base, r2Lead72: 2, r2Lead72Temper: 0.1 });
    expect(t2.viewpoint53).toBe(0.5);
    expect(t2.blueVoteTemper57).toBe(0.1);
    const t4 = r2Lead72Tuning({ ...base, r2Lead72: 4 });
    expect(t4.viewpoint53).toBe(0.5);
    expect(t4.beliefLeadRecursive).toBe(0);
  });
});

describe('HeuristicAgent with r2Lead72', () => {
  const team = (tuning: ReturnType<typeof resolveAgentTuning>): string[] => {
    const agent = new HeuristicAgent('P4', undefined, undefined, tuning);
    agent.onGameStart(obs({ currentRound: 1, failCount: 0, voteHistory: [], questHistory: [], questResults: [] }));
    const a = agent.act(obs());
    if (a.type !== 'team_select') throw new Error('expected a team');
    return [...a.teamIds].sort();
  };
  it('a delegate with the same switches picks the same team (memory is rebuilt from the public record)', () => {
    // viewpoint already 0 and only bit 1 → the delegate's switches equal the agent's own (apart from r2Lead72).
    const plain = resolveAgentTuning({ viewpoint53: 0, viewpointPow53: 0 });
    const before = round72Stats.applied;
    expect(team({ ...plain, r2Lead72: 1 })).toEqual(team(plain));
    expect(round72Stats.applied).toBe(before + 1);
  });
  it('switched on, the leader still proposes a legal four-player team with himself on it', () => {
    const t = team(at(7));
    expect(t).toHaveLength(4);
    expect(new Set(t).size).toBe(4);
    expect(t).toContain('P4');
  });
  it('off: the path is not taken', () => {
    const before = round72Stats.applied;
    team(DEFAULT_AGENT_TUNING);
    expect(round72Stats.applied).toBe(before);
  });
});
