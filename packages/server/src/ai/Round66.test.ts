import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { r2InnerBlack66, teamRedProb66 } from './Round66';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { PROFILE_OVERRIDES } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const allYes = (team: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, team.includes(id) || id === 'P9']));

/**
 * R2 (0:1): the R1 mission P2 P3 P4 (leader P2) failed with one fail card. Now P6 proposes P1 P2 P3 P6 and P1 (a loyal) is on it.
 * Two members of the failed mission on the team → the reading puts a red on it with a high probability.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P2', 'P3', 'P4'];
  return {
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: ids, knownEvils: [],
    currentRound: 2, currentLeader: 'P6', failCount: 0, questResults: ['fail'], gamePhase: 'team_vote',
    voteHistory: [{ round: 1, attempt: 1, leader: 'P2', team: r1, approved: true, votes: allYes(r1) }],
    questHistory: [{ round: 1, team: r1, result: 'fail', failCount: 1 }],
    proposedTeam: ['P1', 'P2', 'P3', 'P6'], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

describe('round 66 switches', () => {
  it('default off in the default and the legacy tables and on every opponent profile; flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.r2InnerBlack66).toBe(0);
      expect(t.r2InnerBlack66Roles).toBe(0);
      expect(t.r2InnerBlack66Mix).toBe(0);
    }
    // Round 66: the three human tables carry θ = 0.9 (Percival + Merlin, the default roles); the bot-only baseline stays off.
    expect(PROFILE_OVERRIDES.ai.r2InnerBlack66 ?? 0).toBe(0);
    for (const k of ['weakHuman', 'avgHuman', 'strongHuman'] as const) {
      expect(PROFILE_OVERRIDES[k].r2InnerBlack66).toBe(0.9);
      expect(PROFILE_OVERRIDES[k].r2InnerBlack66Roles ?? 0).toBe(0);
    }
    expect(parseTuningFlag('r2InnerBlack66')).toEqual({ r2InnerBlack66: 0.9 });
    expect(parseTuningFlag('r2InnerBlack66=0.85')).toEqual({ r2InnerBlack66: 0.85 });
    expect(parseTuningFlag('r2InnerBlack66Roles=7')).toEqual({ r2InnerBlack66Roles: 7 });
    expect(parseTuningFlag('r2InnerBlack66Roles')).toEqual({ r2InnerBlack66Roles: 6 });
    expect(parseTuningFlag('r2InnerBlack66Mix')).toEqual({ r2InnerBlack66Mix: 0.5 });
    expect(() => parseTuningFlag('r2InnerBlack66=1.5')).toThrow();
    expect(() => parseTuningFlag('r2InnerBlack66Roles=64')).toThrow();
  });
});

describe('r2InnerBlack66', () => {
  const p = teamRedProb66(DEFAULT_AGENT_TUNING, obs(), obs().proposedTeam);

  it('the reading puts a red on a team with two members of the failed R1 mission', () => {
    expect(p).not.toBeNull();
    expect(p as number).toBeGreaterThan(0.5);
    expect(p as number).toBeLessThan(1);
  });

  it('a loyal (bit 1) inner-blacks exactly when P(red on the team) ≥ θ', () => {
    expect(r2InnerBlack66(resolveAgentTuning({ r2InnerBlack66: (p as number) - 0.01, r2InnerBlack66Roles: 1 }), obs())).toBe(true);
    expect(r2InnerBlack66(resolveAgentTuning({ r2InnerBlack66: Math.min(1, (p as number) + 0.01), r2InnerBlack66Roles: 1 }), obs())).toBe(false);
    expect(r2InnerBlack66(DEFAULT_AGENT_TUNING, obs())).toBe(false);
  });

  it('off the team, as the leader, R1, R3, the forced proposal, red seats and the public-view copy: never', () => {
    const on = resolveAgentTuning({ r2InnerBlack66: 0.01, r2InnerBlack66Roles: 31 });
    expect(r2InnerBlack66(on, obs())).toBe(true);
    expect(r2InnerBlack66(on, obs({ proposedTeam: ['P2', 'P3', 'P5', 'P6'] }))).toBe(false);
    expect(r2InnerBlack66(on, obs({ currentLeader: 'P1' }))).toBe(false);
    expect(r2InnerBlack66(on, obs({ currentRound: 1, questResults: [], questHistory: [], voteHistory: [] }))).toBe(false);
    expect(r2InnerBlack66(on, obs({ currentRound: 3, questResults: ['fail', 'success'] }))).toBe(false);
    expect(r2InnerBlack66(on, obs({ failCount: 4 }))).toBe(false);
    expect(r2InnerBlack66(on, obs({ myTeam: 'evil', myRole: 'assassin', knownEvils: ['P7'] }))).toBe(false);
    expect(r2InnerBlack66(on, obs({ publicLoyalView: true }))).toBe(false);
    expect(r2InnerBlack66(on, obs({ gamePhase: 'team_select' }))).toBe(false);
  });

  it('roles: 0 = Percival + Merlin (public view); the loyal needs bit 1', () => {
    const dflt = resolveAgentTuning({ r2InnerBlack66: 0.01 });
    expect(r2InnerBlack66(dflt, obs())).toBe(false);
    expect(r2InnerBlack66(dflt, obs({ myRole: 'percival', knownWizards: ['P7', 'P8'] }))).toBe(true);
    expect(r2InnerBlack66(dflt, obs({ myRole: 'merlin', knownEvils: ['P7', 'P8', 'P9'] }))).toBe(true);
    const loyalOnly = resolveAgentTuning({ r2InnerBlack66: 0.01, r2InnerBlack66Roles: 1 });
    expect(r2InnerBlack66(loyalOnly, obs())).toBe(true);
    expect(r2InnerBlack66(loyalOnly, obs({ myRole: 'percival', knownWizards: ['P7', 'P8'] }))).toBe(false);
    expect(r2InnerBlack66(loyalOnly, obs({ myRole: 'merlin', knownEvils: ['P7', 'P8', 'P9'] }))).toBe(false);
    const pm = resolveAgentTuning({ r2InnerBlack66: 0.01, r2InnerBlack66Roles: 6 });
    expect(r2InnerBlack66(pm, obs())).toBe(false);
    expect(r2InnerBlack66(pm, obs({ myRole: 'percival', knownWizards: ['P7', 'P8'] }))).toBe(true);
    expect(r2InnerBlack66(pm, obs({ myRole: 'merlin', knownEvils: ['P7', 'P8', 'P9'] }))).toBe(true);
  });

  it('Merlin (bit 4) reads only the public view: his seen reds do not move it', () => {
    const at = (theta: number): Readonly<ReturnType<typeof resolveAgentTuning>> => resolveAgentTuning({ r2InnerBlack66: theta, r2InnerBlack66Roles: 4 });
    // Seeing a red on the team (P2) or none gives the same answer at the same θ.
    for (const theta of [(p as number) - 0.01, Math.min(1, (p as number) + 0.01)]) {
      const seen = r2InnerBlack66(at(theta), obs({ myRole: 'merlin', knownEvils: ['P2', 'P7', 'P8'] }));
      const unseen = r2InnerBlack66(at(theta), obs({ myRole: 'merlin', knownEvils: ['P7', 'P8', 'P9'] }));
      expect(seen).toBe(unseen);
    }
  });

  it('private bits (measured only): Percival with both thumbs on the team, Merlin with a seen red on it', () => {
    const hi = 0.999;
    const perc = resolveAgentTuning({ r2InnerBlack66: hi, r2InnerBlack66Roles: 8 });
    expect(r2InnerBlack66(perc, obs({ myRole: 'percival', knownWizards: ['P2', 'P3'] }))).toBe(true);
    expect(r2InnerBlack66(perc, obs({ myRole: 'percival', knownWizards: ['P2', 'P7'] }))).toBe(false);
    const merl = resolveAgentTuning({ r2InnerBlack66: hi, r2InnerBlack66Roles: 16 });
    expect(r2InnerBlack66(merl, obs({ myRole: 'merlin', knownEvils: ['P3', 'P7', 'P8'] }))).toBe(true);
    expect(r2InnerBlack66(merl, obs({ myRole: 'merlin', knownEvils: ['P7', 'P8', 'P9'] }))).toBe(false);
  });

  it('mix p: only part of the spots (hash of seat, proposal, team), the same spot always the same', () => {
    let n = 0;
    const half = resolveAgentTuning({ r2InnerBlack66: 0.01, r2InnerBlack66Roles: 1, r2InnerBlack66Mix: 0.5 });
    for (const me of ['P1', 'P5', 'P7', 'P8', 'P9', 'P10']) for (const fc of [0, 1, 2, 3]) {
      const o = obs({ myPlayerId: me, failCount: fc, proposedTeam: [me, 'P2', 'P3', 'P6'] });
      const v = r2InnerBlack66(half, o);
      expect(r2InnerBlack66(half, o)).toBe(v);
      if (v) n++;
    }
    expect(n).toBeGreaterThan(3);
    expect(n).toBeLessThan(21);
    expect(r2InnerBlack66(resolveAgentTuning({ r2InnerBlack66: 0.01, r2InnerBlack66Roles: 1, r2InnerBlack66Mix: 1 }), obs())).toBe(true);
  });

  it('ForwardAgent: off = the R1–R2 normal vote (approve on the team); on = inner black', () => {
    const decide = (tuning: ReturnType<typeof resolveAgentTuning>): boolean | null => {
      const base = new HeuristicAgent('P1', undefined, undefined, tuning);
      base.onGameStart(obs({ gamePhase: 'team_select', currentRound: 1, questResults: [], questHistory: [], voteHistory: [] }));
      const a = new ForwardAgent('P1', base).decide({ ...obs(), seatTeam: 'good' } as PlayerObservation).action;
      return a.type === 'team_vote' ? a.vote : null;
    };
    expect(decide(resolveAgentTuning({}))).toBe(true);
    expect(decide(resolveAgentTuning({ r2InnerBlack66: 0.01, r2InnerBlack66Roles: 1 }))).toBe(false);
    expect(decide(resolveAgentTuning({ r2InnerBlack66: 0.01 }))).toBe(true);
  });
});
