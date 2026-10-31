/**
 * Strong-table gap B1 `merlinNormalVote`: Merlin votes as a public-view loyal in its seat would — so on its own team it
 * approves even with a red it sees (正常票內白, Edward 2026-10-30) — and blocks a team whose seen reds could end the game on
 * the spot and, off the team, any team that must fail in its own view (the good vote gates, INV-V1).
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
  it('on the team (正常票內白, Edward 10/30): q = 1 approves as a loyal would, even with a seen red', () => {
    // The seen red P4 hid on R2 (the same four succeeded), so the public view reads this team clean. (Round 15: with the bot
    // table refit after the reds started hiding on R1, the two R1–R2 successes without P4 no longer clear P2 / P3 enough.)
    const o = obs({ questHistory: [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 },
      { round: 2, team: ['P1', 'P2', 'P3', 'P4'], result: 'success', failCount: 0 },
    ] } as Partial<PlayerObservation>);
    expect(vote(o, { merlinNormalVote: 0 })).toBe(false);
    expect(vote(o, { merlinNormalVote: 1 })).toBe(true);
  });
  it('off the team (外白): a team that must fail in Merlin\'s view stays rejected even at q = 1 (INV-V1)', () => {
    const o = obs({ proposedTeam: ['P2', 'P3', 'P5', 'P4'] });
    expect(vote(o, { merlinNormalVote: 1 })).toBe(false);
    const a = new ForwardAgent('P1', new HeuristicAgent('P1', undefined, undefined, { ...DEFAULT_AGENT_TUNING, merlinNormalVote: 1 }));
    a.onGameStart(o);
    const s = a.decide(o).reasoningTrace?.summary ?? '';
    // either the loyal in this seat already rejects it, or the gate blocks the approval
    expect(s).toContain('merlin normal vote');
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
    expect(merlinNormalVoteNow({ ...DEFAULT_AGENT_TUNING, merlinNormalVote: 0 }, obs())).toBe(false);
    // round 11 adopted it (Edward 10/30 rulings): on by default
    expect(merlinNormalVoteNow(DEFAULT_AGENT_TUNING, obs())).toBe(true);
  });
});
