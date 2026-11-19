/**
 * 第 52 回合（站長 11/19「1-5 跟 2-5 的尾派」）：派西在第 1、2 局強制局用最乾淨的隊（`tailClean52`，預設關），
 * 以及尾派的公開特徵（`benchmark/tailPick.ts`）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation, VoteRecord } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { tailClean52Bit, tailClean52Tuning } from './Round52';
import { HeuristicAgent } from './HeuristicAgent';
import { tailPickFeatures } from './benchmark/tailPick';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });

function vote(round: number, attempt: number, leader: string, team: string[], approvers: string[]): VoteRecord {
  return { round, attempt, leader, team, approved: false, votes: Object.fromEntries(IDS.map((id) => [id, approvers.includes(id)])) };
}

/** 2-5（第 1 局 P1 P2 P3 出任務、一張失敗），隊長 P10 派西（拇指 P4、P5）；2-1..2-4 被否決。 */
function r2Forced(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P10', myRole: 'percival', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    knownWizards: ['P4', 'P5'], currentRound: 2, currentLeader: 'P10', gamePhase: 'team_select', failCount: 4, questResults: ['fail'],
    questHistory: [{ round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 }],
    voteHistory: [
      vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']),
      vote(2, 1, 'P6', ['P6', 'P7', 'P8', 'P10'], ['P6', 'P7', 'P8', 'P10']),
      vote(2, 2, 'P7', ['P7', 'P8', 'P9', 'P10'], ['P7', 'P8', 'P9', 'P10']),
      vote(2, 3, 'P8', ['P8', 'P9', 'P10', 'P6'], ['P8', 'P9', 'P10', 'P6']),
      vote(2, 4, 'P9', ['P9', 'P10', 'P6', 'P7'], ['P9', 'P10', 'P6', 'P7']),
    ].map((v, i) => (i === 0 ? { ...v, approved: true } : v)),
    lakeHistory: [], myLakeResults: [], proposedTeam: [],
    ...over,
  } as unknown as PlayerObservation;
}

describe('tailClean52 flag', () => {
  it('exists, off by default, parses', () => {
    expect(LEGACY_AGENT_TUNING.tailClean52).toBe(0);
    expect(DEFAULT_AGENT_TUNING.tailClean52).toBe(0);
    expect(parseTuningFlag('tailClean52')).toEqual({ tailClean52: 2 });
    expect(parseTuningFlag('tailClean52=3')).toEqual({ tailClean52: 3 });
    expect(() => parseTuningFlag('tailClean52=8')).toThrow();
  });
});

describe('tailClean52Bit / tailClean52Tuning', () => {
  it('Percival leading a forced R1 / R2 proposal: bit by round and the R1 result', () => {
    expect(tailClean52Bit(r2Forced())).toBe(2);
    expect(tailClean52Bit(r2Forced({ questResults: ['success'] }))).toBe(4);
    expect(tailClean52Bit(r2Forced({ currentRound: 1, questResults: [], questHistory: [] }))).toBe(1);
  });
  it('not a forced proposal, not the leader, not Percival, R3+: no bit', () => {
    expect(tailClean52Bit(r2Forced({ failCount: 3 }))).toBe(0);
    expect(tailClean52Bit(r2Forced({ currentLeader: 'P9' }))).toBe(0);
    expect(tailClean52Bit(r2Forced({ myRole: 'loyal' }))).toBe(0);
    expect(tailClean52Bit(r2Forced({ gamePhase: 'team_vote' }))).toBe(0);
    expect(tailClean52Bit(r2Forced({ currentRound: 3, questResults: ['fail', 'success'] }))).toBe(0);
  });
  it('off or the bit not set: the same tuning object; on: Percival gets the cleanest-team path', () => {
    const off = T();
    expect(tailClean52Tuning(off, r2Forced())).toBe(off);
    const r1Only = T({ tailClean52: 1 });
    expect(tailClean52Tuning(r1Only, r2Forced())).toBe(r1Only);
    const on = tailClean52Tuning(T({ tailClean52: 2 }), r2Forced());
    expect(on.goodCleanLead & 2).toBe(2);
    expect(on.goodCleanLead & 1).toBe(DEFAULT_AGENT_TUNING.goodCleanLead & 1);
  });
  it('the bot Percival at 2-5 after an R1 fail: off re-proposes freely, on picks a team the cleanest path allows (self on it, legal size)', () => {
    const pick = (t: AgentTuning): string[] => {
      const a = new HeuristicAgent('P10', undefined, undefined, t).act(r2Forced());
      return a.type === 'team_select' ? [...a.teamIds].sort() : [];
    };
    const on = pick(T({ tailClean52: 2 }));
    expect(on).toHaveLength(4);
    expect(on).toContain('P10');
    // Same as Percival with `goodCleanLead` bit 2 everywhere (the switch only scopes it to this decision point).
    expect(on).toEqual(pick(T({ goodCleanLead: (DEFAULT_AGENT_TUNING.goodCleanLead | 2) })));
  });
});

describe('tailPickFeatures', () => {
  const P = (round: number, attempt: number, leaderSeat: number, teamSeats: number[], approvers: number[], forced = false): ReplayProposal => ({
    round, attempt, globalIndex: 0, leaderSeat, teamSeats, plusSeats: [], minusSeats: [],
    votes: Array.from({ length: 10 }, (_, i) => approvers.includes(i + 1)), approveCount: approvers.length, forced, wentOnMission: false, votesReliable: !forced,
  });
  const game = {
    id: 't', playerCount: 10, seatRoles: [], names: [], lakes: [], lakeChainValid: false, winner: 'good',
    quests: [{ round: 1, teamSeats: [1, 2, 3], successCount: 2, failCount: 1, failed: true }],
    proposals: [
      { ...P(1, 1, 1, [1, 2, 3], [1, 2, 3, 4, 5, 6]), wentOnMission: true },
      P(2, 1, 2, [2, 4, 5, 6], [2, 4, 5, 6, 9]), // 9 off-team approve (外白)
      P(2, 2, 3, [3, 4, 5, 7], [3, 4, 5, 7]),
      P(2, 3, 4, [4, 5, 6, 8], [4, 6, 8]), // 5 on-team reject (內黑)
      P(2, 4, 5, [5, 6, 7, 8], [5, 6, 7, 8]),
      P(2, 5, 6, [], [], true),
    ],
  } as unknown as ReplayGame;
  it('reads only the public record before the forced proposal', () => {
    const f = tailPickFeatures(game, 5, [6, 4, 5, 2]);
    expect(f.self).toBe(true);
    expect(f.exactPrev).toBe(true);
    expect(f.maxOverlapPrev).toBe(4);
    expect(f.popular).toBe(2); // 4, 5 picked ≥ 2 times this round; 2 once
    expect(f.neverPicked).toBe(0);
    expect(f.flaggedOffApprove).toBe(2); // 4, 5 approved 1-1 off the team
    expect(f.flaggedOnReject).toBe(1); // 5
    expect(f.r1In).toBe(1); // 2
    expect(f.r1All).toBe(false);
    expect(f.leaderOnR1).toBe(false);
    const g = tailPickFeatures(game, 5, [6, 9, 10, 1]);
    expect(g.exactPrev).toBe(false);
    expect(g.neverPicked).toBe(3);
    expect(g.flaggedOffApprove).toBe(1); // 9
    expect(g.r1In).toBe(1);
  });
});
