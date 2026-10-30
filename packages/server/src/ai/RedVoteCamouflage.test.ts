/**
 * Strong-table gap R1 `redNormalVote`: off the team, a red votes as a public-view loyal in its seat would, except when
 * the team decides the game for one camp.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { loyalViewOf } from './RedR1Teammate';
import { redLoyalLeadEarlyNow, redNormalVoteNow, redVoteCritical } from './RedVoteCamouflage';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
// R3: P3 sends P2 P3 P5 P6; P1 (assassin) is off the team, its teammate P2 is on it.
const obs = (partial: Partial<PlayerObservation> = {}): PlayerObservation => ({
  myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P1', 'P2', 'P8'],
  currentRound: 3, currentLeader: 'P3', failCount: 0, questResults: ['fail', 'success'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P4', 'P8', 'P9'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P2', 'P3', 'P5', 'P6'], result: 'success', failCount: 0 },
  ],
  voteHistory: [], proposedTeam: ['P2', 'P3', 'P5', 'P6'], lakeHistory: [], ...partial,
} as unknown as PlayerObservation);

function decideVote(o: PlayerObservation, tuning: Partial<AgentTuning>, id = 'P1'): boolean {
  const a = new ForwardAgent(id, new HeuristicAgent(id, undefined, undefined, { ...DEFAULT_AGENT_TUNING, ...tuning }));
  a.onGameStart(o);
  const d = a.decide(o);
  if (d.action.type !== 'team_vote') throw new Error(d.action.type);
  return d.action.vote;
}

describe('redNormalVote', () => {
  it('q = 1: the vote a loyal in the seat would cast', () => {
    expect(decideVote(obs(), { redNormalVote: 1 })).toBe(decideVote(loyalViewOf(obs()), {}));
  });
  it('critical teams: a teammate with two fails in → approve; no teammate with two wins in → reject', () => {
    expect(redVoteCritical(obs({ questResults: ['fail', 'fail'] }))).toBe(true);
    expect(redVoteCritical(obs({ questResults: ['success', 'success'], proposedTeam: ['P3', 'P4', 'P5', 'P6'] }))).toBe(false);
    expect(redVoteCritical(obs())).toBeNull();
    expect(decideVote(obs({ questResults: ['fail', 'fail'] }), { redNormalVote: 1 })).toBe(true);
  });
  it('only off-team reds (not Oberon), R3+, non-forced', () => {
    const on = { ...DEFAULT_AGENT_TUNING, redNormalVote: 1 };
    expect(redNormalVoteNow(on, obs())).toBe(true);
    expect(redNormalVoteNow(on, obs({ proposedTeam: ['P1', 'P3', 'P5', 'P6'] }))).toBe(false);
    expect(redNormalVoteNow(on, obs({ myRole: 'oberon' } as Partial<PlayerObservation>))).toBe(false);
    expect(redNormalVoteNow(on, obs({ currentRound: 2 }))).toBe(false);
    expect(redNormalVoteNow(on, obs({ failCount: 4 }))).toBe(false);
    expect(redNormalVoteNow({ ...DEFAULT_AGENT_TUNING, redNormalVote: 0 }, obs())).toBe(false);
  });
});

describe('redLoyalLeadEarly', () => {
  // R2, first proposal, P1 (assassin) leads; teammates P2 and P8.
  const r2 = (partial: Partial<PlayerObservation> = {}): PlayerObservation => obs({
    currentRound: 2, currentLeader: 'P1', gamePhase: 'team_select', proposedTeam: [], questResults: ['fail'],
    questHistory: [{ round: 1, team: ['P4', 'P8', 'P9'], result: 'fail', failCount: 1 }], ...partial,
  } as Partial<PlayerObservation>);
  const team = (o: PlayerObservation, tuning: Partial<AgentTuning>): string[] => {
    const a = new ForwardAgent(o.myPlayerId, new HeuristicAgent(o.myPlayerId, undefined, undefined, { ...DEFAULT_AGENT_TUNING, ...tuning }));
    a.onGameStart(o);
    const d = a.decide(o);
    if (d.action.type !== 'team_select') throw new Error(d.action.type);
    return [...d.action.teamIds].sort();
  };
  it('on: the team a loyal in the seat would send', () => {
    expect(team(r2(), { redLoyalLeadEarly: true })).toEqual(team(loyalViewOf(r2()), {}));
  });
  it('only red leaders, R1–R2, non-forced', () => {
    const on = { ...DEFAULT_AGENT_TUNING, redLoyalLeadEarly: true };
    expect(redLoyalLeadEarlyNow(on, r2())).toBe(true);
    expect(redLoyalLeadEarlyNow(on, r2({ failCount: 4 }))).toBe(false);
    expect(redLoyalLeadEarlyNow(on, r2({ currentRound: 3 }))).toBe(false);
    expect(redLoyalLeadEarlyNow(on, r2({ myRole: 'oberon' } as Partial<PlayerObservation>))).toBe(false);
    expect(redLoyalLeadEarlyNow(DEFAULT_AGENT_TUNING, r2())).toBe(false);
  });
});
