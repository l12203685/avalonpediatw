/**
 * `teamPassRank` (2026-10-27): a team is scored by its chance to pass, not by its average suspicion.
 *
 * From a bot-only game on the practice platform: R1 and R2 failed (a third fail ends the game); the lake
 * after R2 declared seat 1 red; R1 failed with 5 7 8 on it. Seat 4's fourth proposal of R3 puts 1, 7 and
 * one of Percival's two thumbs (9) on the team. Percival (seat 6) approved it — the average suspicion of
 * the four was middling — and the mission came back with three fail cards.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation, VoteRecord } from './types';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent, teamPassProb } from './forward/ForwardAgent';

const IDS = Array.from({ length: 10 }, (_, i) => `S${i + 1}`);

function vote(round: number, attempt: number, leader: string, team: string[], yes: string[]): VoteRecord {
  const y = new Set(yes);
  return { round, attempt, leader, team, approved: y.size > 5, votes: Object.fromEntries(IDS.map((id) => [id, y.has(id)])) };
}
const S = (...n: number[]) => n.map((x) => `S${x}`);

const OBS: PlayerObservation = {
  myPlayerId: 'S6', myRole: 'percival', myTeam: 'good', playerCount: 10, allPlayerIds: IDS,
  knownEvils: [], knownWizards: S(2, 9),
  currentRound: 3, currentLeader: 'S4', failCount: 3, questResults: ['fail', 'fail'], gamePhase: 'team_vote',
  voteHistory: [
    vote(1, 1, 'S1', S(1, 4, 6), S(1, 4, 6)), vote(1, 2, 'S2', S(2, 6, 10), S(2, 6, 10)),
    vote(1, 3, 'S3', S(1, 3, 7), S(1, 3, 7)), vote(1, 4, 'S4', S(1, 4, 5), S(1, 4, 5)),
    vote(1, 5, 'S5', S(5, 7, 8), IDS),
    vote(2, 1, 'S6', S(1, 2, 6, 10), S(1, 2, 6, 10)), vote(2, 2, 'S7', S(1, 3, 7, 10), S(1, 3, 7, 10)),
    vote(2, 3, 'S8', S(1, 2, 8, 10), S(1, 2, 8, 10)), vote(2, 4, 'S9', S(2, 6, 9, 10), S(2, 6, 9, 10)),
    vote(2, 5, 'S10', S(1, 2, 6, 10), IDS),
    vote(3, 1, 'S1', S(1, 2, 3, 10), S(1, 3, 7)), vote(3, 2, 'S2', S(2, 4, 6, 10), S(1, 2, 4, 6, 10)),
    vote(3, 3, 'S3', S(2, 3, 7, 10), S(1, 3, 7, 10)),
  ],
  questHistory: [
    { round: 1, team: S(5, 7, 8), result: 'fail', failCount: 1 },
    { round: 2, team: S(1, 2, 6, 10), result: 'fail', failCount: 1 },
  ],
  proposedTeam: S(1, 4, 7, 9),
  lakeHistory: [{ round: 2, holderId: 'S10', targetId: 'S1', declaredClaim: 'evil' }],
  myLakeResults: [],
};

// Production routes every R3+ decision through ForwardAgent (vitest's HeuristicAgent.act cannot lazy-load
// it, so it is built directly, as in ForwardAgent.tuning.test.ts).
function decide(teamPassRank: boolean): boolean {
  const agent = new ForwardAgent('S6', new HeuristicAgent('S6', undefined, undefined, { teamPassRank }));
  agent.onGameStart(OBS);
  const a = agent.act(OBS);
  if (a.type !== 'team_vote') throw new Error(a.type);
  return a.vote;
}

describe('teamPassRank', () => {
  it('pass probability: one likely red sinks a one-fail team; R4 at 10 players needs two', () => {
    const p = (id: string) => (id === 'A' ? 0.95 : 0.1);
    expect(teamPassProb(['A', 'B', 'C'], p, 1)).toBeCloseTo(0.05 * 0.9 * 0.9);
    expect(teamPassProb(['A', 'B', 'C'], p, 2)).toBeGreaterThan(0.8);
  });

  it('Percival rejects the match-point team holding the lake-declared red and a failed-mission seat', () => {
    expect(decide(true)).toBe(false);
  });

  it('switch off = the average-suspicion scorer of before (approved)', () => {
    expect(decide(false)).toBe(true);
  });
});
