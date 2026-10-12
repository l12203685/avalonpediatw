/**
 * Agreement benchmark — replay parsing + observation reconstruction.
 *
 * Fixture = 牌譜 #1 (sheets_cache.json), hand-checked:
 *   配置 901836 → 刺 9 / 娜 10 / 德 1 / 奧 8 / 派 3 / 梅 6; loyal 2 4 5 7.
 *   Leaders rotate every proposal from seat 1: R1 1-5, R2 6-10, R3 1-5,
 *   R4 6-7. R1 ooo, R2 ooox (fail), R3 ooox (fail), R4 oooxx (2 fails →
 *   fail) → 三紅 after R4. Lakes: R2 10>2 x (Morgana lies about a loyal),
 *   R3 2>8 x (loyal tells the truth about Oberon).
 */
import { describe, it, expect } from 'vitest';
import { parseReplayGame, type PaipuRow, type ReplayGame } from './sheetsReplay';
import { buildReplayObservation, validLakeTargetSeats } from './replayObservation';
import {
  pinnedQuestCard,
  replaySeat,
  seededRandom,
  withSeededRandom,
  type BenchmarkAgent,
} from './agreement';
import { computeTopPerformers, empiricalPriorStrength, AUTO_PRIOR_MAX } from './cohorts';
import { HeuristicAgent } from '../HeuristicAgent';
import type { AgentAction, PlayerObservation } from '../types';

const NAMES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A0'];

function row(text: string, code: string, result: string, assassin = ''): PaipuRow {
  const r: Record<string, string> = {
    流水號: 'T1', 文字記錄: text, 配置: code, 結果: result, 刺殺: assassin,
  };
  ['玩1', '玩2', '玩3', '玩4', '玩5', '玩6', '玩7', '玩8', '玩9', '玩0']
    .forEach((col, i) => { r[col] = NAMES[i]; });
  return r;
}

const GAME1_TEXT = [
  '147', '269', '349', '468', '358', 'ooo',
  '3589 6+', '3578', '4589', '3589 1+', '3590', 'ooox',
  '0>2 x',
  '1358 5-', '2358 5-', '3459 59-', '3457 45-', '3568', 'ooox',
  '2>8 x',
  '12347 7- 6+', '14679', 'oooxx',
].join('\n');

function game1(): ReplayGame {
  const res = parseReplayGame(row(GAME1_TEXT, '901836', '三紅'));
  if (!res.ok) throw new Error(res.reason);
  return res.game;
}

describe('parseReplayGame — hand-checked 牌譜 #1', () => {
  const g = game1();

  it('decodes roles from 配置 (刺娜德奧派梅, 0 = seat 10)', () => {
    expect(g.seatRoles).toEqual([
      'mordred', 'loyal', 'percival', 'loyal', 'loyal',
      'merlin', 'loyal', 'oberon', 'assassin', 'morgana',
    ]);
    expect(g.names[9]).toBe('A0');
  });

  it('rotates the leader every proposal from seat 1, across rounds', () => {
    expect(g.proposals.map((p) => p.leaderSeat)).toEqual([
      1, 2, 3, 4, 5,
      6, 7, 8, 9, 10,
      1, 2, 3, 4, 5,
      6, 7,
    ]);
    expect(g.proposals.map((p) => p.attempt)).toEqual([
      1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2,
    ]);
  });

  it('reconstructs votes, forced proposals and vote reliability', () => {
    const r2p1 = g.proposals[5]; // 3589 6+ by leader 6
    expect(r2p1.plusSeats).toEqual([6]);
    expect(r2p1.approveCount).toBe(5);
    expect(r2p1.votesReliable).toBe(true); // 5/10 = rejected, consistent
    expect(r2p1.wentOnMission).toBe(false);

    const r2p5 = g.proposals[9]; // 3590 forced
    expect(r2p5.forced).toBe(true);
    expect(r2p5.wentOnMission).toBe(true);
    expect(r2p5.votesReliable).toBe(false);

    const r4p1 = g.proposals[15]; // 12347 7- 6+
    expect(r4p1.votes[5]).toBe(true); // seat 6 off-team approve
    expect(r4p1.votes[6]).toBe(false); // seat 7 on-team reject
    expect(r4p1.approveCount).toBe(5);

    const r4p2 = g.proposals[16]; // 14679 went on the mission with only 5 implied approvals
    expect(r4p2.wentOnMission).toBe(true);
    expect(r4p2.approveCount).toBe(5);
    expect(r4p2.votesReliable).toBe(false);
  });

  it('applies the 10p R4 two-fail rule and ends on the third failure', () => {
    expect(g.quests.map((q) => [q.round, q.failCount, q.failed])).toEqual([
      [1, 0, false], [2, 1, true], [3, 1, true], [4, 2, true],
    ]);
    expect(g.winner).toBe('evil');
    expect(g.assassinTargetSeat).toBeUndefined();
  });

  it('keeps lake claims and validates the holder chain from seat 10', () => {
    expect(g.lakes).toEqual([
      { round: 2, holderSeat: 10, targetSeat: 2, claim: 'evil' },
      { round: 3, holderSeat: 2, targetSeat: 8, claim: 'evil' },
    ]);
    expect(g.lakeChainValid).toBe(true);
    expect(validLakeTargetSeats(g, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(validLakeTargetSeats(g, 1)).toEqual([1, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('pins evil quest cards only when the fail count determines them', () => {
    expect(pinnedQuestCard(g, 1, 8)).toBe('success'); // ooo with Oberon aboard
    expect(pinnedQuestCard(g, 2, 9)).toBeNull(); // 1 fail, 2 evil aboard
    expect(pinnedQuestCard(g, 2, 10)).toBeNull();
    expect(pinnedQuestCard(g, 3, 8)).toBe('fail'); // only evil on 3568
    expect(pinnedQuestCard(g, 4, 1)).toBe('fail'); // 2 fails, 2 evil
    expect(pinnedQuestCard(g, 4, 9)).toBe('fail');
    expect(pinnedQuestCard(g, 1, 3)).toBeNull(); // good seat
  });

  it('rejects records that cannot be replayed exactly', () => {
    const bad = (text: string): string => {
      const res = parseReplayGame(row(text, '901836', '三紅'));
      return res.ok ? 'ok' : res.reason;
    };
    expect(bad('147 1+')).toBe('off-team approve marker on a team member');
    expect(bad('1478')).toBe('team size mismatch (not a 10p record?)');
    expect(bad('147\n269\nooo')).toBe('incomplete game');
    expect(bad('147\n269\n349\n468\n358\n123\nooo')).toBe('more than 5 proposals in a round');
  });
});

describe('buildReplayObservation — production knowledge wiring', () => {
  const g = game1();

  it('Merlin leading R4-P1 sees the history so far and evils except Mordred', () => {
    const obs = buildReplayObservation(g, 6, { kind: 'team_select', proposal: 15 });
    expect(obs.myPlayerId).toBe('P6');
    expect(obs.myRole).toBe('merlin');
    expect(obs.myTeam).toBe('good');
    expect(obs.allPlayerIds).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']);
    expect(obs.knownEvils).toEqual(['P8', 'P9', 'P10']);
    expect(obs.knownWizards).toBeUndefined();
    expect(obs.allEvilIds).toBeUndefined();
    expect(obs.gamePhase).toBe('team_select');
    expect(obs.currentRound).toBe(4);
    expect(obs.currentLeader).toBe('P6');
    expect(obs.failCount).toBe(0);
    expect(obs.proposedTeam).toEqual([]);
    expect(obs.voteHistory).toHaveLength(15);
    // R2-P1 "3589 6+": leader 6 approves off-team, seat 1 rejects.
    expect(obs.voteHistory[5]).toMatchObject({
      round: 2, attempt: 1, leader: 'P6', team: ['P3', 'P5', 'P8', 'P9'], approved: false,
    });
    expect(obs.voteHistory[5].votes.P6).toBe(true);
    expect(obs.voteHistory[5].votes.P1).toBe(false);
    // Forced 5th proposal = synthetic unanimous approve (GameEngine convention).
    expect(Object.values(obs.voteHistory[9].votes).every(Boolean)).toBe(true);
    expect(obs.voteHistory[9].approved).toBe(true);
    expect(obs.questResults).toEqual(['success', 'fail', 'fail']);
    expect(obs.questHistory.map((q) => q.team)).toEqual([
      ['P3', 'P5', 'P8'], ['P3', 'P5', 'P9', 'P10'], ['P3', 'P5', 'P6', 'P8'],
    ]);
    expect(obs.lakeHistory).toEqual([
      { round: 2, holderId: 'P10', targetId: 'P2', declaredClaim: 'evil' },
      { round: 3, holderId: 'P2', targetId: 'P8', declaredClaim: 'evil' },
    ]);
  });

  it('Percival voting on R4-P2 sees both wizards, no known evils', () => {
    const obs = buildReplayObservation(g, 3, { kind: 'team_vote', proposal: 16 });
    expect(obs.knownEvils).toEqual([]);
    expect(obs.knownWizards).toEqual(['P6', 'P10']);
    expect(obs.gamePhase).toBe('team_vote');
    expect(obs.proposedTeam).toEqual(['P1', 'P4', 'P6', 'P7', 'P9']);
    expect(obs.failCount).toBe(1);
    expect(obs.currentLeader).toBe('P7');
    expect(obs.voteHistory).toHaveLength(16);
  });

  it('assassin on the R4 mission knows Morgana + Mordred (not Oberon) and sees the approval', () => {
    const obs = buildReplayObservation(g, 9, { kind: 'quest_vote', round: 4 });
    expect(obs.knownEvils).toEqual(['P1', 'P10']);
    expect(obs.gamePhase).toBe('quest_vote');
    expect(obs.voteHistory).toHaveLength(17);
    expect(obs.questHistory).toHaveLength(3);
    expect(obs.proposedTeam).toEqual(['P1', 'P4', 'P6', 'P7', 'P9']);
    expect(obs.lakeHistory).toHaveLength(2);
  });

  it('lake holder after R3 sees R3 results but only the earlier lake', () => {
    const obs = buildReplayObservation(g, 2, { kind: 'lake', lake: 1 });
    expect(obs.currentRound).toBe(3);
    expect(obs.questHistory).toHaveLength(3);
    expect(obs.voteHistory).toHaveLength(15);
    expect(obs.lakeHistory).toEqual([
      { round: 2, holderId: 'P10', targetId: 'P2', declaredClaim: 'evil' },
    ]);
    expect(obs.knownEvils).toEqual([]); // loyal; production keeps no private lake result
  });

  it('Oberon knows nobody; assassin gets allEvilIds only at assassination', () => {
    expect(buildReplayObservation(g, 8, { kind: 'team_select', proposal: 7 }).knownEvils).toEqual([]);
    // 牌譜 #3 shape with a recorded hit on Merlin (seat 9).
    const res = parseReplayGame(row(
      '156 5-\n248\n379\n458\n389\nooo\n3689 3-\n3789 3-\n3589 17+\noooo\n0>3 o\n3589\noooo',
      '604259', '三藍死', '9',
    ));
    if (!res.ok) throw new Error(res.reason);
    const assassinObs = buildReplayObservation(res.game, 6, { kind: 'assassination' });
    expect(assassinObs.gamePhase).toBe('assassination');
    expect(assassinObs.allEvilIds).toEqual(['P2', 'P4', 'P6', 'P10']);
    expect(assassinObs.knownEvils).toEqual(['P4', 'P10']);
    expect(res.game.winner).toBe('evil');
    expect(res.game.proposals[8].votesReliable).toBe(false); // 3589 approved with 4 implied votes
  });
});

describe('replaySeat — decision enumeration', () => {
  const g = game1();

  /** Stub that always plays the default move. */
  const stub = (): BenchmarkAgent => ({
    onGameStart: () => undefined,
    act: (obs: PlayerObservation): AgentAction => {
      switch (obs.gamePhase) {
        case 'team_select': return { type: 'team_select', teamIds: [obs.myPlayerId] };
        case 'team_vote': return { type: 'team_vote', vote: obs.proposedTeam.includes(obs.myPlayerId) };
        case 'quest_vote': return { type: 'quest_vote', vote: 'fail' };
        case 'assassination': return { type: 'assassinate', targetId: 'P1' };
      }
    },
    pickLakeTarget: (_obs, valid) => (valid ?? [])[0],
    declareLake: (_obs, _t, truth) => (truth === 'good' ? 'evil' : 'good'),
  });

  const count = (seat: number): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const o of replaySeat(g, seat, { makeAgent: stub })) out[o.type] = (out[o.type] ?? 0) + 1;
    return out;
  };

  it('scores leader picks, reliable non-forced votes, pinned cards and lake decisions', () => {
    // Oberon (seat 8): leads R2-P3; 13 reliable votes (3 forced + R4-P2 dropped);
    // pinned cards R1 success + R3 fail.
    expect(count(8)).toEqual({ team: 1, vote: 13, quest: 2 });
    // Morgana (seat 10): leads the forced R2-P5; lake after R2 (target + claim).
    expect(count(10)).toEqual({ team: 1, vote: 13, lakeTarget: 1, lakeClaim: 1 });
  });

  it('records the Morgana lie and the default vote agreement', () => {
    const outs = replaySeat(g, 10, { makeAgent: stub });
    const claim = outs.find((o) => o.type === 'lakeClaim');
    expect(claim).toMatchObject({ human: 'evil', agent: 'evil', match: true, defaultMatch: 0, ruleMatch: 1 });
    expect(claim?.situation).toBe('lakeClaim evil opponent (truth good)');
    const votes = outs.filter((o) => o.type === 'vote');
    expect(votes.every((v) => v.match === (v.defaultMatch === 1))).toBe(true);
  });

  it('is deterministic for the real agent (seeded Math.random)', () => {
    const run = (): unknown => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      .map((seat) => replaySeat(g, seat, { makeAgent: (id) => new HeuristicAgent(id) }));
    expect(run()).toEqual(run());
  });
});

describe('benchmark helpers', () => {
  it('withSeededRandom is reproducible and restores Math.random', () => {
    const original = Math.random;
    const a = withSeededRandom('x', () => [Math.random(), Math.random()]);
    const b = withSeededRandom('x', () => [Math.random(), Math.random()]);
    expect(a).toEqual(b);
    expect(a).toEqual([seededRandom('x')(), (() => { const r = seededRandom('x'); r(); return r(); })()]);
    expect(Math.random).toBe(original);
  });

  it('empirical prior strength is maximal when win rates show no spread beyond noise', () => {
    const flat = Array.from({ length: 10 }, () => ({ games: 50, wins: 15 }));
    expect(empiricalPriorStrength(flat)).toBe(AUTO_PRIOR_MAX);
    const spread = [10, 20, 30, 40, 50, 15, 25, 35, 45, 5].map((w) => ({ games: 60, wins: w }));
    expect(empiricalPriorStrength(spread)).toBeLessThan(AUTO_PRIOR_MAX);
  });

  it('top performers require the minimum games in that role and rank by adjusted win rate', () => {
    const g = game1();
    const cohort = computeTopPerformers([g, g, g], { minGames: 3, perRole: 2, priorStrength: 0 });
    // Every seat of the fixture played 3 games in its role; evil won all three.
    expect(cohort.byRole.mordred).toEqual([
      { name: 'A1', role: 'mordred', games: 3, wins: 3, rawWinRate: 1, adjWinRate: 1 },
    ]);
    expect(cohort.byRole.loyal.map((r) => r.name)).toEqual(['A2', 'A4']);
    expect(cohort.members.has('A1|mordred')).toBe(true);
    expect(computeTopPerformers([g], { minGames: 3 }).members.size).toBe(0);
  });
});
