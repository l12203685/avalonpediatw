import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { r5Lead70Applies, r5Lead70Tuning, round70Stats } from './Round70';
import { HeuristicAgent } from './HeuristicAgent';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));

/**
 * R5 at 2:2: R1 (P1 P2 P3) succeeded, R2 (P2 P4 P5 P6) failed, R3 (P1 P3 P7 P8) succeeded, R4 (P1 P3 P7 P8 P9) failed with two fail cards;
 * R5 proposals by P5 and P6 were rejected. P7 (a loyal) now leads the third R5 proposal.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P1', 'P2', 'P3'];
  const r2 = ['P2', 'P4', 'P5', 'P6'];
  const r3 = ['P1', 'P3', 'P7', 'P8'];
  const r4 = ['P1', 'P3', 'P7', 'P8', 'P9'];
  return {
    myPlayerId: 'P7', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: ids, knownEvils: [],
    currentRound: 5, currentLeader: 'P7', failCount: 2, questResults: ['success', 'fail', 'success', 'fail'], gamePhase: 'team_select',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P1', team: r1, approved: true, votes: votes(['P1', 'P2', 'P3', 'P4', 'P5', 'P7', 'P8']) },
      { round: 2, attempt: 1, leader: 'P2', team: r2, approved: true, votes: votes(['P2', 'P4', 'P5', 'P6', 'P9', 'P10']) },
      { round: 3, attempt: 1, leader: 'P3', team: r3, approved: true, votes: votes(['P1', 'P3', 'P7', 'P8', 'P9', 'P10']) },
      { round: 4, attempt: 1, leader: 'P4', team: r4, approved: true, votes: votes(['P1', 'P3', 'P7', 'P8', 'P9', 'P10']) },
      { round: 5, attempt: 1, leader: 'P5', team: ['P5', 'P1', 'P2', 'P3', 'P10'], approved: false, votes: votes(['P5', 'P2', 'P4', 'P6']) },
      { round: 5, attempt: 2, leader: 'P6', team: ['P6', 'P1', 'P3', 'P7', 'P10'], approved: false, votes: votes(['P6', 'P4', 'P5', 'P10']) },
    ],
    questHistory: [
      { round: 1, team: r1, result: 'success', failCount: 0 }, { round: 2, team: r2, result: 'fail', failCount: 1 },
      { round: 3, team: r3, result: 'success', failCount: 0 }, { round: 4, team: r4, result: 'fail', failCount: 2 },
    ],
    proposedTeam: [], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const at = (bits: number, temper = 0): ReturnType<typeof resolveAgentTuning> => resolveAgentTuning({ r5Lead70: bits, r5Lead70Temper: temper });

describe('round 70 switches', () => {
  it('default off in the default and legacy tables and at every opponent type; flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.r5Lead70).toBe(0);
      expect(t.r5Lead70Temper).toBe(0);
    }
    for (const k of OPPONENT_TYPES) expect(tuningForOpponent(k).r5Lead70 ?? 0).toBe(0);
    expect(parseTuningFlag('r5Lead70')).toEqual({ r5Lead70: 3 });
    expect(parseTuningFlag('r5Lead70=59')).toEqual({ r5Lead70: 59 });
    expect(parseTuningFlag('r5Lead70Temper')).toEqual({ r5Lead70Temper: 0.2 });
    expect(parseTuningFlag('r5Lead70Temper=0.1')).toEqual({ r5Lead70Temper: 0.1 });
    expect(() => parseTuningFlag('r5Lead70=64')).toThrow();
    expect(() => parseTuningFlag('r5Lead70Temper=2')).toThrow();
  });
});

describe('r5Lead70Applies', () => {
  it('R5, non-forced, a blue leader picking the team; loyal + Percival by default', () => {
    expect(r5Lead70Applies(at(3), obs())).toBe(true);
    expect(r5Lead70Applies(at(1), obs({ myRole: 'percival', knownWizards: ['P1', 'P3'] } as Partial<PlayerObservation>))).toBe(true);
    expect(r5Lead70Applies(at(3), obs({ myRole: 'merlin' }))).toBe(false);
    expect(r5Lead70Applies(at(3 | 32), obs({ myRole: 'merlin' }))).toBe(true);
    expect(r5Lead70Applies(at(3 | 32), obs())).toBe(false); // role bits set → only those roles
    expect(r5Lead70Applies(at(3 | 8), obs())).toBe(true);
  });
  it('not: switch off or no reading bit, other rounds, the forced 5th proposal, votes, red seats, not the leader', () => {
    expect(r5Lead70Applies(at(0), obs())).toBe(false);
    expect(r5Lead70Applies(at(8), obs())).toBe(false); // role bit alone changes no reading
    expect(r5Lead70Applies(at(3), obs({ currentRound: 4 }))).toBe(false);
    expect(r5Lead70Applies(at(3), obs({ failCount: 4 }))).toBe(false);
    expect(r5Lead70Applies(at(3), obs({ gamePhase: 'team_vote', proposedTeam: ['P7', 'P1', 'P2', 'P3', 'P4'] }))).toBe(false);
    expect(r5Lead70Applies(at(3), obs({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P4', 'P5'] }))).toBe(false);
    expect(r5Lead70Applies(at(3), obs({ currentLeader: 'P8' }))).toBe(false);
  });
  it('bit 4: only the 3rd and 4th proposals', () => {
    expect(r5Lead70Applies(at(7), obs({ failCount: 2 }))).toBe(true);
    expect(r5Lead70Applies(at(7), obs({ failCount: 3 }))).toBe(true);
    expect(r5Lead70Applies(at(7), obs({ failCount: 1 }))).toBe(false);
    expect(r5Lead70Applies(at(3), obs({ failCount: 0 }))).toBe(true);
  });
});

describe('r5Lead70Tuning', () => {
  it('bit 1 drops the leader-viewpoint reading, bit 2 sets the vote power; the switch itself is cleared', () => {
    const base = resolveAgentTuning({ r5Lead70: 3, viewpoint53: 0.5, viewpointPow53: 0.5, blueVoteTemper57: 0.4 });
    const t = r5Lead70Tuning(base);
    expect(t.r5Lead70).toBe(0);
    expect(t.viewpoint53).toBe(0);
    expect(t.viewpointPow53).toBe(0);
    expect(t.blueVoteTemper57).toBe(0.2);
    const t1 = r5Lead70Tuning({ ...base, r5Lead70: 1 });
    expect(t1.blueVoteTemper57).toBe(0.4);
    const t2 = r5Lead70Tuning({ ...base, r5Lead70: 2, r5Lead70Temper: 0.1 });
    expect(t2.viewpoint53).toBe(0.5);
    expect(t2.blueVoteTemper57).toBe(0.1);
  });
});

describe('HeuristicAgent with r5Lead70', () => {
  const team = (tuning: ReturnType<typeof resolveAgentTuning>): string[] => {
    const agent = new HeuristicAgent('P7', undefined, undefined, tuning);
    agent.onGameStart(obs({ currentRound: 1, failCount: 0, voteHistory: [], questHistory: [], questResults: [] }));
    const a = agent.act(obs());
    if (a.type !== 'team_select') throw new Error('expected a team');
    return [...a.teamIds].sort();
  };
  it('a delegate with the same switches picks the same team (memory is rebuilt from the public record)', () => {
    // viewpoint already 0 and only bit 1 → the delegate's switches equal the agent's own (apart from r5Lead70).
    const plain = resolveAgentTuning({ viewpoint53: 0, viewpointPow53: 0 });
    const before = round70Stats.applied;
    expect(team({ ...plain, r5Lead70: 1 })).toEqual(team(plain));
    expect(round70Stats.applied).toBe(before + 1);
  });
  it('switched on, the leader still proposes a legal five-player team with himself on it', () => {
    const t = team(at(3));
    expect(t).toHaveLength(5);
    expect(new Set(t).size).toBe(5);
    expect(t).toContain('P7');
  });
  it('off: the path is not taken', () => {
    const before = round70Stats.applied;
    team(DEFAULT_AGENT_TUNING);
    expect(round70Stats.applied).toBe(before);
  });
});
