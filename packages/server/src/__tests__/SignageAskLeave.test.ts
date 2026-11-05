import { describe, expect, it } from 'vitest';
import { leaveIntent, newHumanChats } from '../../scripts/signagePlayer';

describe('百科AI 問「需要我離開嗎？」（Edward 2026-11-04）', () => {
  it('讀回覆：留下優先，「不用離開」不算要它走', () => {
    expect(leaveIntent('離開')).toBe('leave');
    expect(leaveIntent('你可以走吧')).toBe('leave');
    expect(leaveIntent('掰掰')).toBe('leave');
    expect(leaveIntent('留下')).toBe('stay');
    expect(leaveIntent('不用離開')).toBe('stay');
    expect(leaveIntent('繼續打')).toBe('stay');
    expect(leaveIntent('等一下')).toBeNull();
    expect(leaveIntent('')).toBeNull();
  });
  it('只看問之後的新訊息，不算百科AI自己說的', () => {
    const before = [{ set: 1, name: '甲', msg: '離開' }];
    const now = [...before, { set: 10, name: '百科AI_0', msg: '百科AI：需要我離開嗎？' }, { set: 2, name: '乙', msg: '留下' }];
    expect(newHumanChats(before, now)).toEqual([{ set: 2, name: '乙', msg: '留下' }]);
  });
});

describe('私房密碼沒給時試今天日期 MMDD（Edward 2026-11-05）', () => {
  it('台灣日期；凌晨 6 點前也試昨天；有給密碼就只用它', async () => {
    const { passwordCandidatesAt, taipeiMMDD } = await import('../../scripts/signagePlayer');
    const noonTW = Date.UTC(2026, 10, 5, 4, 0, 0); // 台灣 11/05 12:00
    expect(taipeiMMDD(noonTW)).toBe('1105');
    expect(passwordCandidatesAt(noonTW, '')).toEqual(['1105']);
    const lateTW = Date.UTC(2026, 10, 5, 17, 30, 0); // 台灣 11/06 01:30
    expect(passwordCandidatesAt(lateTW, '')).toEqual(['1106', '1105']);
    expect(passwordCandidatesAt(lateTW, '9999')).toEqual(['9999']);
  });
});
