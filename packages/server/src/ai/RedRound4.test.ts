/**
 * Round 4 (red) B1 `redCleanLook`: from R3 the red leader proposes, among teams with just enough reds to fail,
 * the one blue rates cleanest.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { redCleanLookTeam } from './RedRound4';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const ON = { ...DEFAULT_AGENT_TUNING, redCleanLook: true };

function obs(partial: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P2', 'P3'],
    currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_select',
    // R1: one fail on P5–P7; R2: P4, P8, P9, P10 came back clean.
    questHistory: [
      { round: 1, team: ['P5', 'P6', 'P7'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P4', 'P8', 'P9', 'P10'], result: 'success', failCount: 0 },
    ],
    voteHistory: [], proposedTeam: [], lakeHistory: [], ...partial,
  } as PlayerObservation;
}
const pick = (o: PlayerObservation, ids: string[]) => redCleanLookTeam(ON, o, { type: 'team_select', teamIds: ids });

describe('redCleanLook', () => {
  it('R3: the leader alone carries the fail, filled with the seats blue trusts', () => {
    const a = pick(obs(), ['P1', 'P2', 'P5', 'P6']);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toHaveLength(4);
    expect(a.teamIds).toContain('P1');
    expect(a.teamIds.filter((id) => ['P2', 'P3'].includes(id))).toHaveLength(0);
    expect(a.teamIds.filter((id) => ['P5', 'P6', 'P7'].includes(id))).toHaveLength(0);
  });

  it('R4 at 10 players: two reds (the leader and one teammate)', () => {
    const a = pick(obs({ currentRound: 4, questResults: ['fail', 'success', 'fail'] }), ['P1', 'P2', 'P4', 'P8', 'P9']);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toHaveLength(5);
    expect(a.teamIds.filter((id) => ['P1', 'P2', 'P3'].includes(id))).toHaveLength(2);
  });

  it('untouched: switch off, R1–R2, blue, Oberon, votes', () => {
    const t = { type: 'team_select' as const, teamIds: ['P1', 'P2', 'P5', 'P6'] };
    expect(redCleanLookTeam(DEFAULT_AGENT_TUNING, obs(), t)).toBe(t);
    expect(redCleanLookTeam(ON, obs({ currentRound: 2 }), t)).toBe(t);
    expect(redCleanLookTeam(ON, obs({ myRole: 'loyal', myTeam: 'good', knownEvils: [] }), t)).toBe(t);
    expect(redCleanLookTeam(ON, obs({ myRole: 'oberon', knownEvils: [] }), t)).toBe(t);
    const v = { type: 'team_vote' as const, vote: true };
    expect(redCleanLookTeam(ON, obs(), v)).toBe(v);
  });
});
