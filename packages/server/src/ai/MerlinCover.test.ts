/**
 * 派拇指躲刺 (`merlinDoomedRed`, Edward 2026-10-28): Merlin puts one seen red on a proposal the R1–R2 normal
 * votes always reject (non-forced) — and nowhere else.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING } from './AgentTuning';
import { doomedProposal, merlinDoomedRedCover } from './MerlinCover';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const SEEN = ['P3', 'P5', 'P7'];

function obs(partial: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: SEEN,
    currentRound: 1, currentLeader: 'P1', failCount: 0, questResults: [], gamePhase: 'team_select',
    voteHistory: [], questHistory: [], proposedTeam: [], lakeHistory: [], ...partial,
  };
}
const team = (o: PlayerObservation, ids: string[]) =>
  merlinDoomedRedCover(DEFAULT_AGENT_TUNING, o, { type: 'team_select', teamIds: ids });

describe('merlinDoomedRed', () => {
  it('doomed = R1–R2, attempts 1–4', () => {
    expect(doomedProposal(obs())).toBe(true);
    expect(doomedProposal(obs({ currentRound: 2, failCount: 3 }))).toBe(true);
    expect(doomedProposal(obs({ failCount: 4 }))).toBe(false); // forced fifth: goes on the mission
    expect(doomedProposal(obs({ currentRound: 3 }))).toBe(false);
  });

  it('Merlin keeps itself, swaps one teammate for one seen red; deterministic', () => {
    const a = team(obs(), ['P1', 'P2', 'P4']);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds).toContain('P1');
    expect(a.teamIds.filter((id) => SEEN.includes(id))).toHaveLength(1);
    expect(a.teamIds).toHaveLength(3);
    expect(team(obs(), ['P1', 'P2', 'P4'])).toEqual(a);
  });

  it('untouched: forced fifth, R3+, other roles, a team that already holds a seen red, switch off', () => {
    const t = ['P1', 'P2', 'P4'];
    for (const o of [obs({ failCount: 4 }), obs({ currentRound: 3 }), obs({ myRole: 'loyal', knownEvils: [] }), obs({ myRole: 'percival' })]) {
      expect(team(o, t)).toEqual({ type: 'team_select', teamIds: t });
    }
    expect(team(obs(), ['P1', 'P3', 'P4'])).toEqual({ type: 'team_select', teamIds: ['P1', 'P3', 'P4'] });
    expect(merlinDoomedRedCover(LEGACY_AGENT_TUNING, obs(), { type: 'team_select', teamIds: t })).toEqual({ type: 'team_select', teamIds: t });
  });
});
