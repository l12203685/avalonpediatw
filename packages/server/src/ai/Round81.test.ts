import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { inMpCell81, mpOwnRead81, oberonNormalPick81, ownEnoughReds81 } from './Round81';
import { redNormalVoteNow } from './RedVoteCamouflage';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));

/**
 * R3 at 0:2 (red has two fails). Reds: P2 assassin, P3 Morgana, P7 Mordred (the assassin's teammates), P9 Oberon (unseen by them).
 * R1 P2 P3 P4 failed; R2 P1 P5 P6 P9 failed with no seen red on it — so the unseen red (Oberon) is one of P1 P5 P6 P9.
 * P10 now proposes P1 P5 P6 P9: the assassin is off it, no teammate he sees is on it, and it certainly holds a red.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P2', 'P3', 'P4'];
  const r2 = ['P1', 'P5', 'P6', 'P9'];
  return {
    myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: ids, knownEvils: ['P3', 'P7'],
    currentRound: 3, currentLeader: 'P10', failCount: 0, questResults: ['fail', 'fail'], gamePhase: 'team_vote',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P2', team: r1, approved: true, votes: votes(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) },
      { round: 2, attempt: 1, leader: 'P1', team: r2, approved: true, votes: votes(['P1', 'P5', 'P6', 'P9', 'P8', 'P10']) },
    ],
    questHistory: [
      { round: 1, team: r1, result: 'fail', failCount: 1 }, { round: 2, team: r2, result: 'fail', failCount: 1 },
    ],
    proposedTeam: ['P1', 'P5', 'P6', 'P9'], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const at = (theta: number, scope = 0): ReturnType<typeof resolveAgentTuning> => resolveAgentTuning({ mpOwnRead81: theta, mpOwnRead81Scope: scope });

describe('round 81 switches', () => {
  it('default off in the default and legacy tables and at every opponent type; flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.mpOwnRead81).toBe(0);
      expect(t.mpOwnRead81Scope).toBe(0);
      expect(t.oberonNormalRate81).toBe(0);
    }
    for (const k of OPPONENT_TYPES) {
      expect(tuningForOpponent(k).mpOwnRead81).toBe(0);
      expect(tuningForOpponent(k).oberonNormalRate81).toBe(0);
    }
    expect(parseTuningFlag('mpOwnRead81')).toEqual({ mpOwnRead81: 0.7 });
    expect(parseTuningFlag('mpOwnRead81=0.5')).toEqual({ mpOwnRead81: 0.5 });
    expect(parseTuningFlag('mpOwnRead81Scope=12')).toEqual({ mpOwnRead81Scope: 12 });
    expect(parseTuningFlag('oberonNormalRate81')).toEqual({ oberonNormalRate81: 0.5 });
    expect(() => parseTuningFlag('mpOwnRead81=1.5')).toThrow();
    expect(parseTuningFlag('mpOwnRead81Scope=22')).toEqual({ mpOwnRead81Scope: 22 });
    expect(() => parseTuningFlag('mpOwnRead81Scope=32')).toThrow();
    expect(() => parseTuningFlag('oberonNormalRate81=-0.1')).toThrow();
  });
});

describe('mpOwnRead81', () => {
  it('the cell: red two fails, blue under two wins, non-forced, off the team, not the leader, too few seen teammates', () => {
    expect(inMpCell81(DEFAULT_AGENT_TUNING, obs())).toBe(false);
    const on = at(0.7);
    expect(inMpCell81(on, obs())).toBe(true);
    expect(inMpCell81(on, obs({ proposedTeam: ['P1', 'P5', 'P6', 'P3'] }))).toBe(false); // a seen teammate is enough on a one-fail mission
    expect(inMpCell81(on, obs({ proposedTeam: ['P1', 'P5', 'P6', 'P2'] }))).toBe(false); // on the team
    expect(inMpCell81(on, obs({ failCount: 4 }))).toBe(false); // forced
    expect(inMpCell81(on, obs({ currentLeader: 'P2' }))).toBe(false);
    expect(inMpCell81(on, obs({ questResults: ['fail', 'success'] }))).toBe(false); // red has one fail
    expect(inMpCell81(on, obs({ currentRound: 5, questResults: ['fail', 'fail', 'success', 'success'] }))).toBe(false); // blue two wins (G3)
    expect(inMpCell81(on, obs({ myTeam: 'good', myRole: 'loyal', knownEvils: [] }))).toBe(false);
    expect(inMpCell81(on, obs({ gamePhase: 'team_select' }))).toBe(false);
    // R4 at 1:2 (two fails needed): one seen teammate is not enough → in the cell; bit 8 keeps the switch to R3.
    const r4 = obs({ currentRound: 4, questResults: ['fail', 'fail', 'success'], proposedTeam: ['P1', 'P5', 'P6', 'P9', 'P3'] });
    expect(inMpCell81(on, r4)).toBe(true);
    expect(inMpCell81(at(0.7, 8), r4)).toBe(false);
    // Role bits: 1 = recognised reds, 2 = Oberon.
    expect(inMpCell81(at(0.7, 2), obs())).toBe(false);
    expect(inMpCell81(at(0.7, 1), obs())).toBe(true);
    const oberon = obs({ myPlayerId: 'P9', myRole: 'oberon', knownEvils: [], proposedTeam: ['P1', 'P2', 'P5', 'P6'] });
    expect(inMpCell81(at(0.7, 1), oberon)).toBe(false);
    expect(inMpCell81(at(0.7, 2), oberon)).toBe(true);
    expect(inMpCell81(at(0.7, 2), { ...oberon, proposedTeam: ['P1', 'P3', 'P5', 'P6'] } as PlayerObservation)).toBe(true); // Oberon sees no one
    // Bit 16: half the spots (seat / round / attempt hash), the same spot the same way every time.
    let inHalf = 0;
    let total = 0;
    for (const seat of ['P2', 'P3', 'P7']) for (let fc = 0; fc < 4; fc++) {
      const o = obs({ myPlayerId: seat, knownEvils: ['P2', 'P3', 'P7'].filter((x) => x !== seat), failCount: fc });
      const a = inMpCell81(at(0.7, 16), o);
      expect(inMpCell81(at(0.7, 16), o)).toBe(a);
      if (a) expect(inMpCell81(on, o)).toBe(true);
      inHalf += a ? 1 : 0;
      total++;
    }
    expect(inHalf).toBeGreaterThan(0);
    expect(inHalf).toBeLessThan(total);
  });

  it('white at P(enough reds) ≥ θ; below θ unchanged (null), or black with bit 4', () => {
    expect(ownEnoughReds81(DEFAULT_AGENT_TUNING, obs())).toBeCloseTo(1, 6);
    expect(mpOwnRead81(at(0.7), obs())).toBe(true);
    // Swap P9 for P8: the unseen red may sit off the team now — neither certain nor impossible.
    const partial = obs({ proposedTeam: ['P1', 'P5', 'P6', 'P8'] });
    const p = ownEnoughReds81(DEFAULT_AGENT_TUNING, partial);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(mpOwnRead81(at(Math.max(0.001, p - 1e-6)), partial)).toBe(true);
    expect(mpOwnRead81(at(Math.min(0.999, p + 1e-6)), partial)).toBeNull();
    expect(mpOwnRead81(at(Math.min(0.999, p + 1e-6), 4), partial)).toBe(false);
    expect(mpOwnRead81(DEFAULT_AGENT_TUNING, obs())).toBeNull();
    expect(mpOwnRead81(LEGACY_AGENT_TUNING, obs())).toBeNull();
  });

  it('ForwardAgent: on = white on the team that certainly holds a red; off = the path as before', () => {
    const decide = (tuning: ReturnType<typeof resolveAgentTuning>, over: Partial<PlayerObservation> = {}): boolean | null => {
      const base = new HeuristicAgent('P2', undefined, undefined, tuning);
      base.onGameStart(obs({ gamePhase: 'team_select', currentRound: 1, questResults: [], questHistory: [], voteHistory: [] }));
      const a = new ForwardAgent('P2', base).decide({ ...obs(over), seatTeam: 'evil' } as PlayerObservation).action;
      return a.type === 'team_vote' ? a.vote : null;
    };
    expect(decide(at(0.7))).toBe(true);
    const off = decide(resolveAgentTuning({}));
    expect(typeof off).toBe('boolean');
    // Bit 4 at a threshold the team cannot reach: black whatever the path said.
    expect(decide(at(0.999, 4), { proposedTeam: ['P1', 'P5', 'P6', 'P8'] })).toBe(false);
  });
});

describe('oberonNormalRate81', () => {
  const oberon = (round: number, fc: number, seat = 'P9'): PlayerObservation => obs({ myPlayerId: seat, myRole: 'oberon', knownEvils: [], currentRound: round, failCount: fc, questResults: ['fail', 'success'], proposedTeam: ['P1', 'P4', 'P5', 'P6'] });

  it('oberonNormalVote off → never (as before); on with q = 0 → always (as before); 0 < q < 1 → a deterministic share', () => {
    expect(oberonNormalPick81(resolveAgentTuning({}), oberon(3, 0))).toBe(false);
    expect(oberonNormalPick81(resolveAgentTuning({ oberonNormalVote: true }), oberon(3, 0))).toBe(true);
    const half = resolveAgentTuning({ oberonNormalVote: true, oberonNormalRate81: 0.5 });
    let picked = 0;
    let total = 0;
    for (const seat of ids) for (let r = 3; r <= 5; r++) for (let fc = 0; fc < 4; fc++) {
      const a = oberonNormalPick81(half, oberon(r, fc, seat));
      expect(oberonNormalPick81(half, oberon(r, fc, seat))).toBe(a);
      picked += a ? 1 : 0;
      total++;
    }
    expect(picked / total).toBeGreaterThan(0.3);
    expect(picked / total).toBeLessThan(0.7);
  });

  it('redNormalVoteNow follows it for Oberon only', () => {
    const t = resolveAgentTuning({ oberonNormalVote: true, oberonNormalRate81: 0.5 });
    const hits = ids.filter((seat) => !['P1', 'P4', 'P5', 'P6'].includes(seat)).map((seat) => [redNormalVoteNow(t, oberon(3, 0, seat)), oberonNormalPick81(t, oberon(3, 0, seat))]);
    for (const [a, b] of hits) expect(a).toBe(b);
    // A recognised red is untouched by the Oberon rate.
    expect(redNormalVoteNow(t, obs({ proposedTeam: ['P1', 'P4', 'P5', 'P6'] }))).toBe(redNormalVoteNow(resolveAgentTuning({ oberonNormalVote: true }), obs({ proposedTeam: ['P1', 'P4', 'P5', 'P6'] })));
  });
});
