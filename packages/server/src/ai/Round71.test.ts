import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { assassinSight71, inR5Cell71, ownRedOnTeam71, redR5Red71 } from './Round71';
import { redVoteCritical } from './RedVoteCamouflage';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { OPPONENT_TYPES, PROFILE_OVERRIDES, tuningForOpponent } from './humanProfile';
import { ASSASSIN_FEATURE_NAMES, assassinCandidateFeatures } from './assassin/AssassinModel';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));

/**
 * R5 at 2:2. Reds: P2 assassin, P3 Morgana, P7 Mordred (the assassin's teammates), P9 Oberon (unseen by them).
 * R1 P2 P3 P4 failed; R2 P1 P5 P6 P9 failed with no seen red on it — so the unseen red (Oberon) is one of P1 P5 P6 P9;
 * R3 P1 P4 P8 P10 and R4 P1 P4 P6 P8 P10 succeeded. P10 now proposes P1 P5 P6 P9 P8: the assassin is off it, no teammate he sees is on it,
 * and it certainly holds a red.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P2', 'P3', 'P4'];
  const r2 = ['P1', 'P5', 'P6', 'P9'];
  const r3 = ['P1', 'P4', 'P8', 'P10'];
  const r4 = ['P1', 'P4', 'P6', 'P8', 'P10'];
  return {
    myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: ids, knownEvils: ['P3', 'P7'],
    currentRound: 5, currentLeader: 'P10', failCount: 0, questResults: ['fail', 'fail', 'success', 'success'], gamePhase: 'team_vote',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P2', team: r1, approved: true, votes: votes(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) },
      { round: 2, attempt: 1, leader: 'P1', team: r2, approved: true, votes: votes(['P1', 'P5', 'P6', 'P9', 'P8', 'P10']) },
      { round: 3, attempt: 1, leader: 'P4', team: r3, approved: true, votes: votes(['P1', 'P4', 'P8', 'P10', 'P5', 'P6']) },
      { round: 4, attempt: 1, leader: 'P8', team: r4, approved: true, votes: votes(['P1', 'P4', 'P6', 'P8', 'P10', 'P5']) },
    ],
    questHistory: [
      { round: 1, team: r1, result: 'fail', failCount: 1 }, { round: 2, team: r2, result: 'fail', failCount: 1 },
      { round: 3, team: r3, result: 'success', failCount: 0 }, { round: 4, team: r4, result: 'success', failCount: 0 },
    ],
    proposedTeam: ['P1', 'P5', 'P6', 'P9', 'P8'], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const at = (theta: number, scope = 0): ReturnType<typeof resolveAgentTuning> => resolveAgentTuning({ redR5Red71: theta, redR5Red71Scope: scope });

describe('round 71 switches', () => {
  it('default off in the default and legacy tables; on at the human tables (redR5Red71 only); flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.assassinSight71).toBe(0);
      expect(t.redR5Red71).toBe(0);
      expect(t.redR5Red71Scope).toBe(0);
    }
    // Round 71: the human tables carry `redR5Red71 = 1` (rules-only certainty); the bot baseline stays off; the assassin switch is off everywhere.
    for (const k of OPPONENT_TYPES) expect(tuningForOpponent(k).assassinSight71).toBe(0);
    expect(PROFILE_OVERRIDES.ai.redR5Red71).toBeUndefined();
    expect(tuningForOpponent('ai').redR5Red71).toBe(0);
    for (const k of ['weakHuman', 'avgHuman', 'strongHuman'] as const) {
      expect(tuningForOpponent(k).redR5Red71).toBe(1);
      expect(tuningForOpponent(k).redR5Red71Scope).toBe(0);
    }
    expect(parseTuningFlag('assassinSight71')).toEqual({ assassinSight71: 7 });
    expect(parseTuningFlag('assassinSight71=2')).toEqual({ assassinSight71: 2 });
    expect(parseTuningFlag('redR5Red71')).toEqual({ redR5Red71: 0.9 });
    expect(parseTuningFlag('redR5Red71=1')).toEqual({ redR5Red71: 1 });
    expect(parseTuningFlag('redR5Red71Scope=2')).toEqual({ redR5Red71Scope: 2 });
    expect(() => parseTuningFlag('assassinSight71=8')).toThrow();
    expect(() => parseTuningFlag('redR5Red71=1.5')).toThrow();
    expect(parseTuningFlag('redR5Red71Scope=4')).toEqual({ redR5Red71Scope: 4 });
    expect(() => parseTuningFlag('redR5Red71Scope=8')).toThrow();
  });
});

describe('redR5Red71', () => {
  it('the cell: today a team without a seen teammate at blue two wins is "camp interest: reject", though it certainly holds a red', () => {
    expect(redVoteCritical(obs())).toBe(false);
    expect(inR5Cell71(DEFAULT_AGENT_TUNING, obs())).toBe(false);
    expect(inR5Cell71(at(1), obs())).toBe(true);
    expect(ownRedOnTeam71(DEFAULT_AGENT_TUNING, obs())).toBeCloseTo(1, 6);
  });

  it('θ = 1 approves only on the certainty layer; θ < 1 on the own-view P(a red on the team)', () => {
    expect(redR5Red71(at(1), obs())).toBe(true);
    // Drop P9: Oberon may be P9 (off the team) — no longer certain.
    const partial = obs({ proposedTeam: ['P1', 'P5', 'P6', 'P4', 'P8'] });
    const p = ownRedOnTeam71(DEFAULT_AGENT_TUNING, partial);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(redR5Red71(at(1), partial)).toBe(false);
    expect(redR5Red71(at(Math.max(0.001, p - 1e-6)), partial)).toBe(true);
    expect(redR5Red71(at(Math.min(0.999, p + 1e-6)), partial)).toBe(false);
    // Bit 4 reads the conventions too (L1*); here the rules alone (the R2 fail with no seen red on it) already name the red, so both agree.
    expect(redR5Red71(at(1, 4), obs())).toBe(true);
    expect(redR5Red71(LEGACY_AGENT_TUNING, obs())).toBe(false);
    expect(redR5Red71(DEFAULT_AGENT_TUNING, obs())).toBe(false);
  });

  it('outside the cell: on the team, a seen teammate on it, other rounds, the forced proposal, blue seats, other phases; scope bits', () => {
    const on = at(1);
    expect(redR5Red71(on, obs({ proposedTeam: ['P1', 'P5', 'P6', 'P9', 'P2'] }))).toBe(false);
    expect(redR5Red71(on, obs({ proposedTeam: ['P1', 'P5', 'P6', 'P9', 'P3'] }))).toBe(false);
    expect(redR5Red71(on, obs({ currentRound: 4 }))).toBe(false);
    expect(redR5Red71(on, obs({ failCount: 4 }))).toBe(false);
    expect(redR5Red71(on, obs({ myTeam: 'good', myRole: 'loyal', knownEvils: [] }))).toBe(false);
    expect(redR5Red71(on, obs({ gamePhase: 'team_select' }))).toBe(false);
    expect(redR5Red71(at(1, 2), obs())).toBe(false); // Oberon only
    expect(redR5Red71(at(1, 1), obs())).toBe(true);
    const oberon = obs({ myPlayerId: 'P7', myRole: 'oberon', knownEvils: [], proposedTeam: ['P1', 'P2', 'P5', 'P6', 'P8'] });
    expect(inR5Cell71(at(1, 1), oberon)).toBe(false);
    expect(inR5Cell71(at(1, 2), oberon)).toBe(true);
  });

  it('ForwardAgent: off = reject (no seen teammate at blue two wins); on = approve the team that certainly holds a red', () => {
    const decide = (tuning: ReturnType<typeof resolveAgentTuning>, over: Partial<PlayerObservation> = {}): boolean | null => {
      const base = new HeuristicAgent('P2', undefined, undefined, tuning);
      base.onGameStart(obs({ gamePhase: 'team_select', currentRound: 1, questResults: [], questHistory: [], voteHistory: [] }));
      const a = new ForwardAgent('P2', base).decide({ ...obs(over), seatTeam: 'evil' } as PlayerObservation).action;
      return a.type === 'team_vote' ? a.vote : null;
    };
    expect(decide(resolveAgentTuning({}))).toBe(false);
    expect(decide(at(1))).toBe(true);
    expect(decide(at(1), { proposedTeam: ['P1', 'P5', 'P6', 'P4', 'P8'] })).toBe(false);
  });
});

describe('assassinSight71', () => {
  const roles = { P2: 'assassin', P3: 'morgana', P7: 'mordred', P9: 'oberon' } as const;
  const atAssassination = (over: Partial<PlayerObservation> = {}): PlayerObservation => obs({
    gamePhase: 'assassination', allEvilIds: ['P2', 'P3', 'P7', 'P9'], allEvilRoles: { ...roles }, proposedTeam: [], ...over,
  } as Partial<PlayerObservation>);

  it('off, or without the shown cards: undefined; on: every red Merlin sees but the assassin himself (no Mordred)', () => {
    expect(assassinSight71(DEFAULT_AGENT_TUNING, atAssassination())).toBeUndefined();
    expect(assassinSight71(resolveAgentTuning({ assassinSight71: 7 }), obs({ gamePhase: 'assassination' }))).toBeUndefined();
    const s = assassinSight71(resolveAgentTuning({ assassinSight71: 3 }), atAssassination());
    expect(s?.parts).toBe(3);
    expect([...(s?.ally ?? [])].sort()).toEqual(['P3', 'P9']);
  });

  it('features: a team with Oberon only is clean in the old reference and red in Merlin\'s; the per-group bits switch each group', () => {
    const o = atAssassination();
    const s = assassinSight71(resolveAgentTuning({ assassinSight71: 7 }), o);
    const ix = (name: string): number => ASSASSIN_FEATURE_NAMES.indexOf(name);
    // P1 led R2 (P1 P5 P6 P9): Oberon on it, no assassin teammate (P3 / P7).
    const old = assassinCandidateFeatures(o, 'P1');
    const now = assassinCandidateFeatures(o, 'P1', s);
    expect(old[ix('ledWithAllyRate')]).toBe(0);
    expect(now[ix('ledWithAllyRate')]).toBeGreaterThan(0);
    expect(now[ix('ledCleanCount')]).toBeLessThan(old[ix('ledCleanCount')]);
    // Bit 1 only: the lead features stay as trained.
    const votesOnly = assassinCandidateFeatures(o, 'P1', { ally: s!.ally, parts: 1 });
    expect(votesOnly[ix('ledWithAllyRate')]).toBe(old[ix('ledWithAllyRate')]);
    // Absent sight = the trained features, bit for bit.
    expect(assassinCandidateFeatures(o, 'P1', undefined)).toEqual(old);
  });
});
