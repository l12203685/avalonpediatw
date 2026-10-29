/**
 * Round 6 (red) `assassinLeadRead`: a blue whose non-forced proposals were clean (no red Merlin sees) reads as Merlin;
 * one who put a seen red on the team does not; no leads is neutral.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from '../types';
import { merlinLeadLogRatio } from './MerlinLeadRead';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const REDS = ['P1', 'P2', 'P3', 'P4'];
const vote = (round: number, attempt: number, leader: string, team: string[]) => ({
  round, attempt, leader, team, approved: false,
  votes: Object.fromEntries(IDS.map((id) => [id, team.includes(id)])),
});

const obs = {
  myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: REDS,
  allEvilIds: REDS, allEvilRoles: { P1: 'assassin', P2: 'morgana', P3: 'oberon', P4: 'mordred' },
  currentRound: 3, gamePhase: 'assassination', questHistory: [], questResults: [], lakeHistory: [],
  voteHistory: [
    vote(1, 1, 'P5', ['P5', 'P7', 'P8']),
    vote(1, 2, 'P6', ['P6', 'P1', 'P2']),
    vote(1, 3, 'P5', ['P5', 'P9', 'P10']),
    vote(1, 4, 'P6', ['P6', 'P1', 'P3']),
  ],
} as unknown as PlayerObservation;

describe('merlinLeadLogRatio', () => {
  it('clean leads read as Merlin, seen-red leads do not', () => {
    const p5 = merlinLeadLogRatio(obs, 'P5', REDS);
    const p6 = merlinLeadLogRatio(obs, 'P6', REDS);
    expect(p5).toBeGreaterThan(0);
    expect(p6).toBeLessThan(0);
  });
  it('Mordred on the team is not a seen red', () => {
    const withMordred = { ...obs, voteHistory: [vote(3, 1, 'P7', ['P7', 'P4', 'P8', 'P9'])] } as PlayerObservation;
    expect(merlinLeadLogRatio(withMordred, 'P7', REDS)).toBeGreaterThan(0);
  });
  it('no leads: neutral', () => {
    expect(merlinLeadLogRatio(obs, 'P8', REDS)).toBe(0);
  });
});
