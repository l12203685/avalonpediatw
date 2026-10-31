/**
 * `beliefBotTables` (Edward 2026-10-30): with the bot-fitted tables the off-team votes say much more. Since round 13 the bot
 * blues vote normal off the team (reject) and the reds still outer-white their teammates' teams in the critical spots, so in
 * the round-15 refit the off-team approver of a team reads red.
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
  it('the off-team approver reads much redder than with the human tables (round-15 refit: bot blues outer-white a red team 4.5%, reds 32%)', () => {
    // The table fitted at the round-6 defaults (blues outer-whited 30–69%) read the off-team rejecters red instead.
    const human = bayesRedShare(obs);
    const bot = bayesRedShare(obs, { botTables: 1 });
    expect(bot.get('P6') ?? 0).toBeGreaterThan((human.get('P6') ?? 0) + 0.1);
    expect(bot.get('P7') ?? 1).toBeLessThan((bot.get('P6') ?? 0) - 0.25);
    expect(bot.get('P3') ?? 1).toBeLessThan(human.get('P3') ?? 0);
  });
  it('weight 0 is the human posterior', () => {
    expect(bayesRedShare(obs, { botTables: 0 }).get('P6')).toBeCloseTo(bayesRedShare(obs).get('P6') ?? 0, 12);
  });
});

// Round 15: since round 14 the lone red hides on R1. The table fitted before that (0 of 315 R1 one-red teams succeeded) read an
// R1 success as near-proof of a clean team; the round-15 refit (adopted: 664 of 794 succeed) reads it as weak evidence.
// `beliefBotMissionNext` reads only the mission cells from the refit slot (identical to the current table once adopted).
const r1 = {
  myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 2, currentLeader: 'P5', failCount: 0, questResults: ['success'], gamePhase: 'team_select',
  questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }], lakeHistory: [], proposedTeam: [],
  voteHistory: [],
} as unknown as PlayerObservation;

describe('round-15 bot table (R1 hiding)', () => {
  it('an R1 success no longer reads as near-proof of a clean team', () => {
    const bot = bayesRedShare(r1, { botTables: 1 });
    expect(bot.get('P2') ?? 0).toBeGreaterThan(0.25);
    expect(bot.get('P2') ?? 1).toBeLessThan(bayesRedShare(r1).get('P5') ?? 0);
  });
  it('beliefBotMissionNext reads the mission cells from the refit slot', () => {
    const missionNext = bayesRedShare(r1, { botTables: 1, botMissionNext: true });
    // No votes or proposals here: the same as reading the whole refit table.
    expect(missionNext.get('P2')).toBeCloseTo(bayesRedShare(r1, { botTables: 1, botTablesNext: true }).get('P2') ?? 0, 12);
  });
});
