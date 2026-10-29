/**
 * `merlinLoyalStyle` (Edward 2026-10-29): Merlin proposes the team a public-view loyal finds most plausible, never with
 * a red it sees.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { merlinLoyalStyleTeam } from './MerlinLoyalStyle';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const ON = { ...DEFAULT_AGENT_TUNING, merlinLoyalStyle: true };
const obs = {
  myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P4', 'P6', 'P9'],
  currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_select',
  // R2 P2 P3 P5 P7 clean in public; R1 P4 P6 P8 one fail.
  questHistory: [
    { round: 1, team: ['P4', 'P6', 'P8'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P2', 'P3', 'P5', 'P7'], result: 'success', failCount: 0 },
  ],
  voteHistory: [], proposedTeam: [], lakeHistory: [],
} as unknown as PlayerObservation;

describe('merlinLoyalStyle', () => {
  it('a team a loyal would send (the clean R2 seats), never a seen red', () => {
    const a = merlinLoyalStyleTeam(ON, obs, { type: 'team_select', teamIds: ['P1', 'P4', 'P8', 'P10'] });
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P1');
    expect(a.teamIds.some((id) => ['P4', 'P6', 'P9'].includes(id))).toBe(false);
    expect(a.teamIds.filter((id) => ['P2', 'P3', 'P5', 'P7'].includes(id)).length).toBeGreaterThanOrEqual(2);
  });
  it('off / not Merlin: unchanged', () => {
    const t = { type: 'team_select' as const, teamIds: ['P1', 'P4', 'P8', 'P10'] };
    expect(merlinLoyalStyleTeam(DEFAULT_AGENT_TUNING, obs, t)).toBe(t);
    expect(merlinLoyalStyleTeam(ON, { ...obs, myRole: 'loyal' } as PlayerObservation, t)).toBe(t);
  });
});
