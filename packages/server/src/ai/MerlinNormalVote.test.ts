/**
 * Strong-table gap B1 `merlinNormalVote`: Merlin votes as a public-view loyal in its seat would — so on its own team it
 * approves even with a red it sees — and blocks only a team whose seen reds could end the game on the spot.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { merlinNormalVoteNow, merlinVoteFatal } from './MerlinLoyalStyle';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
// R3, first proposal: P2 sends P1 (Merlin) P2 P3 P4; Merlin sees P4 (red). R1 / R2 succeeded with P1 P2 P3 on them.
const obs = (partial: Partial<PlayerObservation> = {}): PlayerObservation => ({
  myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P4', 'P7', 'P9'],
  currentRound: 3, currentLeader: 'P2', failCount: 0, questResults: ['success', 'success'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 },
    { round: 2, team: ['P1', 'P2', 'P3', 'P5'], result: 'success', failCount: 0 },
  ],
  voteHistory: [], proposedTeam: ['P1', 'P2', 'P3', 'P4'], lakeHistory: [], ...partial,
} as unknown as PlayerObservation);

function vote(o: PlayerObservation, tuning: Partial<AgentTuning>): boolean {
  const a = new ForwardAgent('P1', new HeuristicAgent('P1', undefined, undefined, { ...DEFAULT_AGENT_TUNING, ...tuning }));
  a.onGameStart(o);
  const d = a.decide(o);
  if (d.action.type !== 'team_vote') throw new Error(d.action.type);
  return d.action.vote;
}

describe('merlinNormalVote', () => {
  it('off: Merlin rejects its own team holding a seen red; q = 1: it votes as a loyal would (approve)', () => {
    expect(vote(obs(), {})).toBe(false);
    expect(vote(obs(), { merlinNormalVote: 1 })).toBe(true);
  });
  it('a fatal team stays blocked (two fails already)', () => {
    const o = obs({ questResults: ['fail', 'fail'], questHistory: [] } as Partial<PlayerObservation>);
    expect(merlinVoteFatal(o)).toBe(true);
    expect(vote(o, { merlinNormalVote: 1 })).toBe(false);
  });
  it('only Merlin, R3+, non-forced', () => {
    const on = { ...DEFAULT_AGENT_TUNING, merlinNormalVote: 1 };
    expect(merlinNormalVoteNow(on, obs())).toBe(true);
    expect(merlinNormalVoteNow(on, obs({ myRole: 'loyal' } as Partial<PlayerObservation>))).toBe(false);
    expect(merlinNormalVoteNow(on, obs({ currentRound: 2 }))).toBe(false);
    expect(merlinNormalVoteNow(on, obs({ failCount: 4 }))).toBe(false);
    expect(merlinNormalVoteNow(DEFAULT_AGENT_TUNING, obs())).toBe(false);
  });
});
