/**
 * 區間派票法 (`merlinZoneSignal`, Edward 2026-10-29; wiki 〈視角與區間派票法〉): Merlin's team holds no seen red and the
 * gaps between its members hold the thumbs.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from '../types';
import { bayesRedShare } from './BayesBelief';
import { bestZoneTeam, zoneGaps, zoneScore, zoneTeamLogProb } from './ZoneModel';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

describe('zone geometry', () => {
  it('wiki example: 1-1 by Merlin 1 sending 158 cuts [2 3 4], [6 7], [9 0]', () => {
    expect(zoneGaps(IDS, new Set(['P1', 'P5', 'P8']))).toEqual([['P2', 'P3', 'P4'], ['P6', 'P7'], ['P9', 'P10']]);
  });

  it('the zone-cutting Merlin puts every thumb in a different gap and none on the team', () => {
    const seen = new Set(['P3', 'P6', 'P9']);
    const team = bestZoneTeam(IDS, 'P1', 3, seen);
    expect(team).not.toBeNull();
    expect(team!.some((id) => seen.has(id))).toBe(false);
    expect(zoneScore(IDS, new Set(team!), seen)).toBe(3);
  });

  it('a team with a seen red is all but impossible; a 3-zone cut beats a 1-zone one', () => {
    const seen = new Set(['P3', 'P6', 'P9']);
    expect(zoneTeamLogProb(IDS, 'P1', ['P1', 'P3', 'P5'], seen)).toBeLessThan(-5);
    expect(zoneTeamLogProb(IDS, 'P1', ['P1', 'P5', 'P8'], seen)).toBeGreaterThan(zoneTeamLogProb(IDS, 'P1', ['P1', 'P2', 'P10'], seen));
  });
});

describe('Percival reads the zone cut', () => {
  // Thumbs P4 and P7; P4 led the 1-1 team P4 P5 P6, P7 led 1-2 P7 P8 P9. P1–P3 have shown nothing.
  const obs = {
    myPlayerId: 'P1', myRole: 'percival', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    knownWizards: ['P4', 'P7'], currentRound: 1, currentLeader: 'P8', failCount: 2, questResults: [],
    gamePhase: 'team_vote', proposedTeam: [], lakeHistory: [], questHistory: [],
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P4', team: ['P4', 'P5', 'P6'], approved: false, votes: {} },
      { round: 1, attempt: 2, leader: 'P7', team: ['P7', 'P8', 'P9'], approved: false, votes: {} },
    ],
  } as unknown as PlayerObservation;
  it('with the zone model the posterior moves; without it the doomed proposals are skipped', () => {
    const off = bayesRedShare(obs, { strictMerlin: true });
    const on = bayesRedShare(obs, { strictMerlin: true, zoneMerlin: true });
    const moved = IDS.some((id) => Math.abs((on.get(id) ?? 0) - (off.get(id) ?? 0)) > 0.02);
    expect(moved).toBe(true);
    expect((on.get('P4') ?? 0) + (on.get('P7') ?? 0)).toBeCloseTo(1, 6);
  });
});
