import { describe, expect, it } from 'vitest';
import type { DecisionOutcome } from './agreement';
import {
  aggregateSpots,
  assassinationForTeammate,
  datasetKeyOfSource,
  disagreementKind,
  excludedDatasetKeys,
  isInside,
  metricsOf,
  spotFromOutcome,
  topDisagreements,
  topDisagreementsByType,
  type GameDbRow,
} from './playerAgreement';

const base = { gameId: 'g1', seat: 3, name: '', role: 'loyal', side: 'good' as const, defaultMatch: 0, ruleMatch: 0 };

function vote(human: 'approve' | 'reject', agent: 'approve' | 'reject', onTeam: boolean, extra: Partial<DecisionOutcome> = {}): DecisionOutcome {
  const h = human === 'approve';
  const a = agent === 'approve';
  return {
    ...base, type: 'vote', round: 3, attempt: 1, human, agent, match: h === a,
    humanNonDefault: h !== onTeam, agentNonDefault: a !== onTeam,
    situation: 'vote R3+ good on-team, clean team', divergence: h === a ? 'match' : `human ${human} / agent ${agent}`, ...extra,
  };
}

describe('spotFromOutcome / metricsOf — abnormal votes', () => {
  it('classifies 內黑 / 外白 for both the player and the bot', () => {
    const s = spotFromOutcome(vote('reject', 'approve', true), '測試甲', 'human', 'avgHuman');
    expect(s.humanVote).toBe('內黑');
    expect(s.agentVote).toBe('normal');
    expect(metricsOf(s)).toEqual(['abn_player', 'abn_player_內黑']);

    const t = spotFromOutcome(vote('reject', 'approve', false), '測試甲', 'human', 'avgHuman');
    expect(t.humanVote).toBe('normal');
    expect(t.agentVote).toBe('外白');
    expect(metricsOf(t)).toEqual(['abn_bot', 'abn_bot_外白']);
  });

  it('normal votes on both sides count nowhere', () => {
    const s = spotFromOutcome(vote('approve', 'approve', true), '測試甲', 'ai', 'ai');
    expect(metricsOf(s)).toEqual([]);
  });

  it('a shared abnormal vote counts in both directions as the same', () => {
    const s = spotFromOutcome(vote('approve', 'approve', false), '測試甲', 'ai', 'ai');
    expect(metricsOf(s)).toEqual(['abn_player', 'abn_player_外白', 'abn_bot', 'abn_bot_外白']);
    const r = aggregateSpots([s]);
    expect(r.all.abn_player).toMatchObject({ n: 1, same: 1, samePct: 100 });
    expect(r.all.abn_bot).toMatchObject({ n: 1, same: 1, samePct: 100 });
  });
});

describe('metricsOf — other decisions', () => {
  it('only red quest cards, lake claims split by side', () => {
    const q = spotFromOutcome({ ...base, role: 'morgana', side: 'evil', type: 'quest', round: 2, human: 'fail', agent: 'success', match: false, situation: '', divergence: 'human fail / agent success' }, '乙', 'human', 'avgHuman');
    expect(metricsOf(q)).toEqual(['quest_red']);
    const blue = { ...q, side: 'good' as const };
    expect(metricsOf(blue)).toEqual([]);
    const claim = spotFromOutcome({ ...base, type: 'lakeClaim', round: 2, human: 'good', agent: 'good', match: true, situation: 'lakeClaim good target good (truth good)', divergence: 'match' }, '乙', 'human', 'avgHuman');
    expect(metricsOf(claim)).toEqual(['lakeClaim_blue']);
  });

  it('teammate assassination is booked on the player seat and role', () => {
    const o: DecisionOutcome = { ...base, seat: 7, role: 'assassin', side: 'evil', type: 'assassinate', round: 5, human: '2', agent: '4', match: false, situation: 'assassinate', divergence: 'human hit / agent miss' };
    const s = assassinationForTeammate(o, 3, 'oberon', '丙', 'human', 'strongHuman');
    expect(s).toMatchObject({ seat: 3, role: 'oberon', actorSeat: 7, viaTeammate: true, side: 'evil' });
    expect(metricsOf(s)).toEqual(['assassinate']);
    expect(disagreementKind(s)).toBe('刺殺：實際刺中梅林，AI 沒刺中');
  });
});

describe('aggregateSpots', () => {
  it('counts same / diff / % and team Jaccard per role and seat', () => {
    const team = (match: boolean, jaccard: number, seat: number): DecisionOutcome => ({
      ...base, seat, type: 'team', round: 3, attempt: 1, human: '1,2,3,4', agent: match ? '1,2,3,4' : '1,2,3,5', match, jaccard,
      situation: 'team R3+ good', divergence: match ? 'match' : 'differs by 1 member(s)',
    });
    const spots = [team(true, 1, 3), team(false, 0.6, 3), team(false, 0.6, 5)].map((o) => spotFromOutcome(o, '丁', 'human', 'avgHuman'));
    const r = aggregateSpots(spots);
    expect(r.all.team).toEqual({ n: 3, same: 1, diff: 2, samePct: 33.3, jaccardMean: 0.733 });
    expect(r.bySeat['3'].team).toMatchObject({ n: 2, same: 1 });
    expect(r.byRole.loyal.team?.n).toBe(3);
    expect(r.byRoleSeat.loyal['5'].team).toMatchObject({ n: 1, same: 0 });
    expect(r.byTier.avgHuman.team?.n).toBe(3);
  });
});

describe('disagreementKind / topDisagreements', () => {
  it('names the kind in Chinese and groups by it', () => {
    const a = spotFromOutcome(vote('approve', 'reject', true, { gameId: '5' }), '戊', 'human', 'avgHuman');
    const b = spotFromOutcome(vote('approve', 'reject', true, { gameId: '12' }), '戊', 'human', 'avgHuman');
    const c = spotFromOutcome(vote('reject', 'approve', true, { gameId: '7' }), '戊', 'human', 'avgHuman');
    const same = spotFromOutcome(vote('approve', 'approve', true), '戊', 'human', 'avgHuman');
    expect(disagreementKind(a)).toBe('投票・藍方・R3+：玩家正常票（贊成），AI 內黑（反對）');
    expect(disagreementKind(same)).toBeNull();
    const top = topDisagreements([a, b, c, same], 5, 2);
    expect(top.map((t) => t.count)).toEqual([2, 1]);
    expect(top[0].share).toBe(66.7);
    expect(top[0].examples.map((e) => e.gameId)).toEqual(['5', '12']);
    expect(topDisagreementsByType([a, b, c, same])).toEqual({ vote: [{ kind: disagreementKind(a), count: 2, ofType: 3 }] });
  });
});

describe('excludedDatasetKeys', () => {
  it('maps sheet / Discord-import ids and drops error, duplicate, superseded and second copies', () => {
    expect(datasetKeyOfSource('sheet', 'S12')).toBe('0|12');
    expect(datasetKeyOfSource('dc_import', 'Dabc')).toBe('1|Dabc');
    expect(datasetKeyOfSource('discord', '123')).toBeNull();
    const rows: GameDbRow[] = [
      { id: 'S1', kind: 'real', status: 'error', sources: [{ src: 'sheet', id: 'S1' }], checks: [{ rule: 'FAILS_GT_RED', level: 'error' }] },
      { id: 'S2', kind: 'real', status: 'warn', sources: [{ src: 'sheet', id: 'S2' }], checks: [{ rule: 'NEAR_DUP', level: 'warn' }] },
      { id: '99', kind: 'real', status: 'warn', sources: [{ src: 'discord', id: '99' }, { src: 'sheet', id: 'S3' }, { src: 'dc_import', id: 'Dx' }], checks: [{ rule: 'SUPERSEDED', level: 'warn', msg: '試算表（S3）記錯' }] },
      { id: '98', kind: 'real', status: 'ok', sources: [{ src: 'sheet', id: 'S4' }, { src: 'dc_import', id: 'Dy' }], checks: [] },
      { id: 'S5', kind: 'real', status: 'ok', sources: [{ src: 'sheet', id: 'S5' }], checks: [] },
      { id: 'M1', kind: 'sim', status: 'error', sources: [{ src: 'sim_sheet', id: 'M1' }], checks: [] },
    ];
    const ex = excludedDatasetKeys(rows, { S6: { exclude: ['OWNER_EXCLUDE'] } });
    expect(ex.has('0|1')).toBe(true);
    expect(ex.has('0|2')).toBe(true);
    expect(ex.has('0|3')).toBe(true);
    expect(ex.has('1|Dx')).toBe(false);
    expect(ex.has('0|4')).toBe(false);
    expect(ex.has('1|Dy')).toBe(true);
    expect(ex.has('0|5')).toBe(false);
    expect(ex.get('0|6')).toContain('OWNER_EXCLUDE');
  });
});

describe('isInside', () => {
  it('refuses outputs inside the repo', () => {
    expect(isInside('/r/repo/out', '/r/repo')).toBe(true);
    expect(isInside('/r/repo', '/r/repo')).toBe(true);
    expect(isInside('/r/repo-out', '/r/repo')).toBe(false);
  });
});
