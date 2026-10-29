/**
 * Round 5 (blue) L5 `goodCleanLead`: from R2 the blue leader sends the team the posterior rates cleanest.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { goodCleanLeadTeam } from './GoodRound5';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const ON = { ...DEFAULT_AGENT_TUNING, goodCleanLead: 3 };

function obs(partial: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_select',
    // R1: P2, P3, P4 failed twice → two of them red; R2: P5, P6, P7, P8 clean.
    questHistory: [
      { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 2 },
      { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: [], lakeHistory: [], ...partial,
  } as PlayerObservation;
}

describe('goodCleanLead', () => {
  it('R3: me plus the seats the posterior trusts, none of the failed trio', () => {
    const a = goodCleanLeadTeam(ON, obs(), { type: 'team_select', teamIds: ['P1', 'P2', 'P9', 'P10'] });
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toHaveLength(4);
    expect(a.teamIds).toContain('P1');
    expect(a.teamIds.filter((id) => ['P2', 'P3', 'P4'].includes(id))).toHaveLength(0);
  });

  it('the logic gates still bind: a barred top team gives way to the next best', () => {
    const t = { type: 'team_select' as const, teamIds: ['P1', 'P2', 'P9', 'P10'] };
    const top = goodCleanLeadTeam(ON, obs(), t);
    if (top.type !== 'team_select') throw new Error(top.type);
    const key = [...top.teamIds].sort().join(',');
    const next = goodCleanLeadTeam(ON, obs(), t, (team) => [...team].sort().join(',') !== key);
    if (next.type !== 'team_select') throw new Error(next.type);
    expect([...next.teamIds].sort().join(',')).not.toBe(key);
    expect(goodCleanLeadTeam(ON, obs(), t, () => false)).toBe(t);
  });

  it('untouched: off, R1, Merlin, red, the role not in scope', () => {
    const t = { type: 'team_select' as const, teamIds: ['P1', 'P2', 'P9', 'P10'] };
    expect(goodCleanLeadTeam({ ...DEFAULT_AGENT_TUNING, goodCleanLead: 0 }, obs(), t)).toBe(t);
    expect(goodCleanLeadTeam(ON, obs({ currentRound: 1 }), t)).toBe(t);
    expect(goodCleanLeadTeam(ON, obs({ myRole: 'merlin' }), t)).toBe(t);
    expect(goodCleanLeadTeam(ON, obs({ myRole: 'assassin', myTeam: 'evil' }), t)).toBe(t);
    expect(goodCleanLeadTeam({ ...ON, goodCleanLead: 2 }, obs(), t)).toBe(t);
  });
});
