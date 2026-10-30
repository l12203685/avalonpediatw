/**
 * `beliefBotTables` (Edward 2026-10-30): with the bot-fitted tables the off-team votes say much more — bot reds approve
 * their teammates' teams off-team most of the time and almost never a team without one, so the off-team rejecters of
 * a team read red and its members clean.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from '../types';
import { bayesRedShare } from './BayesBelief';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: false, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});

// R3: P2 proposes P2 P3 P4 P5; off-team P6 approves, everyone else off-team rejects.
const obs = {
  myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 3, currentLeader: 'P3', failCount: 1, questResults: ['success', 'success'], gamePhase: 'team_select',
  questHistory: [], lakeHistory: [], proposedTeam: [],
  voteHistory: [vote(3, 1, 'P2', ['P2', 'P3', 'P4', 'P5'], ['P2', 'P3', 'P4', 'P5', 'P6'])],
} as unknown as PlayerObservation;

describe('beliefBotTables', () => {
  it('the off-team rejecters read redder and the team cleaner than with the human tables', () => {
    const human = bayesRedShare(obs);
    const bot = bayesRedShare(obs, { botTables: 1 });
    expect(bot.get('P7') ?? 0).toBeGreaterThan((human.get('P7') ?? 0) + 0.1);
    expect(bot.get('P3') ?? 1).toBeLessThan((human.get('P3') ?? 0) - 0.1);
  });
  it('weight 0 is the human posterior', () => {
    expect(bayesRedShare(obs, { botTables: 0 }).get('P6')).toBeCloseTo(bayesRedShare(obs).get('P6') ?? 0, 12);
  });
});
