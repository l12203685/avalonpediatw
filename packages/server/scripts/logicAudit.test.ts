/**
 * `scripts/logicAudit.ts` 的規則檢查：用 Edward 2026-11-03 實戰回報的三個情況（座位改成虛構的）重現每條規則
 * 的機會與違反，確認計數對、也確認正常的做法不算違反。
 */
import { describe, expect, it } from 'vitest';
import type { Role } from '@avalon/shared';
import type { PlayerObservation } from '../src/ai/types';
import { Tally, auditTrace, cellOf, FirstPerson, whyRule, type GameTrace, type TraceProposal } from './logicAudit';

// 座位 0..9；紅方：1 刺客、4 莫甘娜、7 莫德雷德、5 奧伯倫；藍方：0 梅林、2 派西、其餘忠臣。
const ROLES: Role[] = ['merlin', 'assassin', 'percival', 'loyal', 'morgana', 'oberon', 'loyal', 'mordred', 'loyal', 'loyal'];

function votesFor(team: number[], overrides: Record<number, boolean> = {}): boolean[] {
  return Array.from({ length: 10 }, (_, s) => (s in overrides ? overrides[s] : team.includes(s)));
}

function prop(round: number, attempt: number, leader: number, team: number[], overrides: Record<number, boolean> = {}): TraceProposal {
  const votes = votesFor(team, overrides);
  return { round, attempt, leader, team, votes, approved: votes.filter(Boolean).length >= 6, forced: false };
}

function baseTrace(): GameTrace {
  return {
    n: 10,
    roles: ROLES,
    proposals: [],
    quests: [],
    lakes: [],
    lakesValid: true,
  };
}

function count(t: GameTrace, rule: string, role?: string): { opp: number; viol: number } {
  const tally = new Tally();
  auditTrace(t, tally);
  return cellOf(tally.counts, rule, (r) => role === undefined || r === role);
}

describe('logicAudit rules', () => {
  it('(a)(b) 派西在隊上內黑 T，下一次自己當隊長照派 T、又對自己的隊投黑', () => {
    const t = baseTrace();
    const T = [2, 3, 6, 8];
    t.quests = [{ round: 1, team: [3, 6, 8], failCount: 0 }, { round: 2, team: [2, 3, 6, 9], failCount: 0 }];
    t.proposals = [
      prop(1, 1, 3, [3, 6, 8], { 0: true, 2: true, 9: true }),
      prop(2, 1, 4, [2, 3, 6, 9], { 0: true, 8: true }),
      prop(3, 1, 0, T, { 2: false }),
      prop(3, 2, 2, T, { 2: false }),
    ];
    expect(count(t, 'b_repropose_inside_rejected', 'percival')).toEqual({ opp: 1, viol: 1 });
    expect(count(t, 'a_leader_rejects_own', 'percival')).toEqual({ opp: 1, viol: 1 });
    // 第 3 局第 1 次提議：梅林隊長在自己的隊上投白，不算違反。
    expect(count(t, 'a_leader_rejects_own', 'merlin').viol).toBe(0);
  });

  it('(e) 第 2 局 {2,4,5,9} 一張失敗，下一隊只拿掉 5（鐵咬 5）：奧伯倫 5 投白 = 認壞', () => {
    const t = baseTrace();
    t.quests = [
      { round: 1, team: [0, 3, 6], failCount: 0 },
      { round: 2, team: [2, 4, 5, 9], failCount: 1 },
    ];
    t.proposals = [
      prop(1, 1, 0, [0, 3, 6], { 2: true, 8: true, 9: true }),
      prop(2, 1, 9, [2, 4, 5, 9], { 0: true, 3: true }),
      prop(3, 1, 1, [1, 2, 4, 9], { 5: true }),
    ];
    expect(count(t, 'e_approve_iron_bite_on_me', 'oberon')).toEqual({ opp: 1, viol: 1 });
    // 派西 2 在那個失敗隊上、這隊沒拿掉他：不是鐵咬他。
    expect(count(t, 'e_approve_iron_bite_on_me', 'percival').opp).toBe(0);
    // 派西 2 的「其餘隊員」{4,5,9} 沒有全在這隊上（5 被拿掉）：(g) 不適用。
    expect(count(t, 'g_approve_failed_rest', 'percival').opp).toBe(0);
  });

  it('(g)(h) 好人出過失敗任務：其餘隊員全在的隊確定會失敗', () => {
    const t = baseTrace();
    t.quests = [
      { round: 1, team: [0, 3, 6], failCount: 0 },
      { round: 2, team: [3, 4, 6, 9], failCount: 1 },
    ];
    t.proposals = [
      prop(1, 1, 0, [0, 3, 6], { 2: true, 8: true, 9: true }),
      prop(2, 1, 9, [3, 4, 6, 9], { 0: true, 2: true }),
      // 忠臣 3 不在隊上，但隊上有 4、6、9（失敗隊其餘全部）：他投白就是違反。
      prop(3, 1, 4, [4, 6, 8, 9], { 3: true }),
    ];
    // 只有 3 的「其餘隊員」{4,6,9} 全在隊上；6、9 的其餘隊員都含不在隊上的 3。
    expect(count(t, 'g_approve_failed_rest', 'loyal')).toEqual({ opp: 1, viol: 1 });
    const fp = new FirstPerson(t);
    expect(fp.minReds(3, 3, [4, 6, 8, 9])).toBe(1);
    expect(count(t, 'h_approve_must_fail', 'loyal').viol).toBeGreaterThanOrEqual(1);
  });

  it('(f) 藍方兩藍、全藍的第 4 局隊：暴露的奧伯倫外白', () => {
    const t = baseTrace();
    t.quests = [
      { round: 1, team: [0, 3, 6], failCount: 0 },
      { round: 2, team: [2, 4, 5, 9], failCount: 1 },
      { round: 3, team: [0, 2, 3, 6], failCount: 0 },
    ];
    t.proposals = [
      prop(1, 1, 0, [0, 3, 6], { 2: true, 8: true, 9: true }),
      prop(2, 1, 9, [2, 4, 5, 9], { 0: true, 3: true }),
      prop(3, 1, 0, [0, 2, 3, 6], { 8: true, 9: true }),
      prop(4, 1, 2, [0, 2, 3, 6, 8], { 5: true }),
    ];
    expect(count(t, 'f_red_approves_blue_win', 'oberon')).toEqual({ opp: 1, viol: 1 });
    expect(count(t, 'f_red_approves_blue_win', 'assassin')).toEqual({ opp: 1, viol: 0 });
    // 5 白 + 奧伯倫 = 6 = 剛好過半。
    expect(count(t, 'f2_red_pivotal_blue_win', 'oberon')).toEqual({ opp: 1, viol: 1 });
  });

  it('(c/d) 持湖者宣紅的人：之後派進隊或投白都算違反', () => {
    const t = baseTrace();
    t.quests = [
      { round: 1, team: [0, 3, 6], failCount: 0 },
      { round: 2, team: [2, 3, 6, 9], failCount: 0 },
    ];
    t.lakes = [{ round: 2, holder: 9, target: 1, claim: 'evil', result: 'evil' }];
    t.proposals = [
      prop(1, 1, 0, [0, 3, 6], { 2: true, 8: true, 9: true }),
      prop(2, 1, 9, [2, 3, 6, 9], { 0: true, 8: true }),
      prop(3, 1, 1, [1, 3, 6, 9], { 9: true }),
      prop(3, 2, 9, [1, 2, 6, 9]),
    ];
    expect(count(t, 'cd_approve_declared_red', 'loyal')).toEqual({ opp: 1, viol: 1 });
    expect(count(t, 'cd_propose_declared_red', 'loyal')).toEqual({ opp: 1, viol: 1 });
    expect(count(t, 'c0_good_lake_lie', 'loyal')).toEqual({ opp: 1, viol: 0 });
  });

  it('whyRule：投票當下判斷 (a)(e)(f)', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
    const camp = (id: string): 'good' | 'evil' => (['P2', 'P5', 'P6', 'P8'].includes(id) ? 'evil' : 'good');
    const obs = (me: string, leader: string, team: string[], quests: Array<{ round: number; team: string[]; failCount: number }>): PlayerObservation => ({
      myPlayerId: me, myRole: camp(me) === 'evil' ? 'oberon' : 'loyal', myTeam: camp(me), playerCount: 10, allPlayerIds: ids,
      knownEvils: [], currentRound: quests.length + 1, currentLeader: leader, failCount: 0,
      questResults: quests.map((q) => (q.failCount > 0 ? 'fail' : 'success')), gamePhase: 'team_vote',
      voteHistory: [], questHistory: quests.map((q) => ({ ...q, result: q.failCount > 0 ? 'fail' : 'success' })), proposedTeam: team,
    }) as PlayerObservation;
    const q2 = { round: 2, team: ['P3', 'P5', 'P6', 'P10'], failCount: 1 };
    const q1 = { round: 1, team: ['P1', 'P4', 'P7'], failCount: 0 };
    expect(whyRule(obs('P6', 'P2', ['P2', 'P3', 'P5', 'P10'], [q1, q2]), true, camp)).toBe('e_approve_iron_bite_on_me');
    expect(whyRule(obs('P3', 'P3', ['P3', 'P4', 'P7', 'P9'], [q1, q2]), false, camp)).toBe('a_leader_rejects_own');
    const q3 = { round: 3, team: ['P1', 'P4', 'P7', 'P9'], failCount: 0 };
    expect(whyRule(obs('P6', 'P3', ['P1', 'P3', 'P4', 'P7', 'P9'], [q1, q2, q3]), true, camp)).toBe('f_red_approves_blue_win');
    expect(whyRule(obs('P6', 'P3', ['P1', 'P3', 'P4', 'P7', 'P9'], [q1, q2, q3]), false, camp)).toBeNull();
  });

  it('強制提議沒有投票：投票規則不算機會', () => {
    const t = baseTrace();
    const p = prop(3, 5, 2, [2, 3, 6, 8], { 2: false });
    t.proposals = [{ ...p, forced: true, votes: null }];
    expect(count(t, 'a_leader_rejects_own').opp).toBe(0);
  });
});
