import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { inKeyCrowdCell69, keyCrowdEstimate69, redKeyCrowd69 } from './Round69';
import { redKeyWhiteVote, redVoteCritical } from './RedVoteCamouflage';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { OPPONENT_TYPES, PROFILE_OVERRIDES, tuningForOpponent } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));

/**
 * R3 at 2:0 for red: the R1 mission P2 P3 P4 and the R2 mission P3 P5 P6 P7 both failed (one fail card each). P10 now proposes P10 P1 P3 P8;
 * P2 (the assassin) is off it, his teammate P3 (Morgana; P7 = Mordred) is on it. If it passes, P3 fails it and red wins.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P2', 'P3', 'P4'];
  const r2 = ['P3', 'P5', 'P6', 'P7'];
  return {
    myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: ids, knownEvils: ['P3', 'P7'],
    currentRound: 3, currentLeader: 'P10', failCount: 0, questResults: ['fail', 'fail'], gamePhase: 'team_vote',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P2', team: r1, approved: true, votes: votes(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) },
      { round: 2, attempt: 1, leader: 'P3', team: r2, approved: true, votes: votes(['P2', 'P3', 'P5', 'P6', 'P7', 'P8']) },
    ],
    questHistory: [{ round: 1, team: r1, result: 'fail', failCount: 1 }, { round: 2, team: r2, result: 'fail', failCount: 1 }],
    proposedTeam: ['P10', 'P1', 'P3', 'P8'], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const at = (tau: number, scope = 0): ReturnType<typeof resolveAgentTuning> => resolveAgentTuning({ redKeyCrowd69: tau, redKeyCrowd69Scope: scope });

describe('round 69 switches', () => {
  it('default off in the default and legacy tables and on every opponent profile; flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.redKeyCrowd69).toBe(0);
      expect(t.redKeyCrowd69Scope).toBe(0);
    }
    for (const k of OPPONENT_TYPES) expect(tuningForOpponent(k).redKeyCrowd69 ?? 0).toBe(PROFILE_OVERRIDES[k].redKeyCrowd69 ?? 0);
    expect(parseTuningFlag('redKeyCrowd69')).toEqual({ redKeyCrowd69: 0.5 });
    expect(parseTuningFlag('redKeyCrowd69=0.3')).toEqual({ redKeyCrowd69: 0.3 });
    expect(parseTuningFlag('redKeyCrowd69Scope')).toEqual({ redKeyCrowd69Scope: 1 });
    expect(parseTuningFlag('redKeyCrowd69Scope=63')).toEqual({ redKeyCrowd69Scope: 63 });
    expect(() => parseTuningFlag('redKeyCrowd69=1.5')).toThrow();
    expect(() => parseTuningFlag('redKeyCrowd69Scope=64')).toThrow();
  });
});

describe('redKeyCrowd69', () => {
  it('the cell: a critical team (teammate on it, red at two fails) where the round-16 key white keeps the loyal vote', () => {
    expect(redVoteCritical(obs())).toBe(true);
    expect(redKeyWhiteVote(DEFAULT_AGENT_TUNING, obs())).toBe(false);
    expect(inKeyCrowdCell69(DEFAULT_AGENT_TUNING, obs())).toBe(true);
  });

  it('the estimate splits the table: team reds + on-team blues past the key threshold, off-team reds (self included), off-team blues by their public view', () => {
    const e = keyCrowdEstimate69(DEFAULT_AGENT_TUNING, obs());
    expect(e.onBlue).toBe(3);
    expect(e.offReds).toBe(2);
    expect(e.offBlueP).toHaveLength(4);
    expect(e.onYes).toBeGreaterThanOrEqual(1);
    expect(e.onYes).toBeLessThanOrEqual(4);
    expect([...e.offBlueP].sort((a, b) => b - a)).toEqual(e.offBlueP);
  });

  it('whites exactly when the on-team yes + off-team reds + off-team blues reading P(clean) ≥ τ reach the majority', () => {
    const e = keyCrowdEstimate69(DEFAULT_AGENT_TUNING, obs());
    const need = 6 - e.onYes - e.offReds; // off-team blues needed
    expect(need).toBeGreaterThan(0);
    expect(need).toBeLessThanOrEqual(e.offBlueP.length);
    const pk = e.offBlueP[need - 1];
    expect(redKeyCrowd69(at(Math.max(0.001, pk - 1e-6)), obs())).toBe(true);
    if (pk < 0.999) expect(redKeyCrowd69(at(Math.min(1, pk + 1e-6)), obs())).toBe(false);
    expect(redKeyCrowd69(LEGACY_AGENT_TUNING, obs())).toBe(false);
    expect(redKeyCrowd69(DEFAULT_AGENT_TUNING, obs())).toBe(false);
  });

  it('outside the cell: on the team, R2, one fail only, no teammate on it, Oberon, blue seats, the forced proposal, other phases', () => {
    const on = at(0.001);
    expect(redKeyCrowd69(on, obs())).toBe(true);
    expect(redKeyCrowd69(on, obs({ proposedTeam: ['P10', 'P2', 'P3', 'P8'] }))).toBe(false);
    expect(redKeyCrowd69(on, obs({ currentRound: 2, questResults: ['fail'] }))).toBe(false);
    expect(redKeyCrowd69(on, obs({ questResults: ['fail', 'success'] }))).toBe(false);
    expect(redKeyCrowd69(on, obs({ proposedTeam: ['P10', 'P1', 'P4', 'P8'] }))).toBe(false);
    expect(redKeyCrowd69(on, obs({ myRole: 'oberon', knownEvils: [] }))).toBe(false);
    expect(redKeyCrowd69(on, obs({ myTeam: 'good', myRole: 'loyal', knownEvils: [] }))).toBe(false);
    expect(redKeyCrowd69(on, obs({ failCount: 4 }))).toBe(false);
    expect(redKeyCrowd69(on, obs({ gamePhase: 'team_select' }))).toBe(false);
  });

  it('scope bits: R4/R5 (2), only the 3rd–4th proposals (4), the tail leader not a red it sees (8)', () => {
    const r4 = obs({ currentRound: 4, questResults: ['fail', 'fail', 'success'] });
    expect(redKeyCrowd69(at(0.001), r4)).toBe(false);
    expect(redKeyCrowd69(at(0.001, 3), r4)).toBe(true);
    expect(redKeyCrowd69(at(0.001, 2), obs())).toBe(false);
    expect(redKeyCrowd69(at(0.001, 5), obs())).toBe(false);
    expect(redKeyCrowd69(at(0.001, 5), obs({ failCount: 2, currentLeader: 'P1' }))).toBe(true);
    // Leader P10 at the 1st proposal → the tail (5th) is P4 (blue); leader P9 → the tail is P3 (Morgana); leader P8 → the tail is me (P2).
    expect(redKeyCrowd69(at(0.001, 9), obs())).toBe(true);
    expect(redKeyCrowd69(at(0.001, 9), obs({ currentLeader: 'P9' }))).toBe(false);
    expect(redKeyCrowd69(at(0.001, 9), obs({ currentLeader: 'P8' }))).toBe(false);
  });

  it('bit 16: the 4th proposal whites without the estimate; bit 32 (with 16): the 3rd too; other proposals keep the estimate', () => {
    const k16 = at(1, 17);
    expect(redKeyCrowd69(k16, obs())).toBe(false);
    expect(redKeyCrowd69(k16, obs({ failCount: 1 }))).toBe(false);
    expect(redKeyCrowd69(k16, obs({ failCount: 2 }))).toBe(false);
    expect(redKeyCrowd69(k16, obs({ failCount: 3 }))).toBe(true);
    expect(redKeyCrowd69(k16, obs({ failCount: 4 }))).toBe(false);
    expect(redKeyCrowd69(at(1, 49), obs({ failCount: 2 }))).toBe(true);
    expect(redKeyCrowd69(at(1, 33), obs({ failCount: 2 }))).toBe(false);
    // Still only in the cell (teammate on the team, red at two fails, off the team); bit 8 still drops a red tail leader (at the 4th
    // proposal the tail is the next seat: leader P1 → tail P2 = me; leader P10 → tail P1, blue).
    expect(redKeyCrowd69(k16, obs({ failCount: 3, questResults: ['fail', 'success'] }))).toBe(false);
    expect(redKeyCrowd69(k16, obs({ failCount: 3, proposedTeam: ['P10', 'P1', 'P4', 'P8'] }))).toBe(false);
    expect(redKeyCrowd69(at(1, 25), obs({ failCount: 3 }))).toBe(true);
    expect(redKeyCrowd69(at(1, 25), obs({ failCount: 3, currentLeader: 'P1' }))).toBe(false);
    expect(redKeyCrowd69(at(1, 25), obs({ failCount: 3, currentLeader: 'P6' }))).toBe(false);
  });

  it('ForwardAgent: off = the loyal vote (reject the key team); on = the outer white', () => {
    const decide = (tuning: ReturnType<typeof resolveAgentTuning>): boolean | null => {
      const base = new HeuristicAgent('P2', undefined, undefined, tuning);
      base.onGameStart(obs({ gamePhase: 'team_select', currentRound: 1, questResults: [], questHistory: [], voteHistory: [] }));
      const a = new ForwardAgent('P2', base).decide({ ...obs(), seatTeam: 'evil' } as PlayerObservation).action;
      return a.type === 'team_vote' ? a.vote : null;
    };
    expect(decide(resolveAgentTuning({}))).toBe(false);
    expect(decide(at(0.001))).toBe(true);
    expect(decide(at(0.999))).toBe(false);
  });
});
