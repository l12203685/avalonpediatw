/**
 * 模擬瓦（2026-10-14）— 指令解析：每一種寫法（全形斜線、全形數字、沒有空白、別名、0 / 10 = 第 10 家、
 * 人數與重複、區間重疊、百科的 * 寫法），以及 `/派西 2` 不是 /派、`/結束了` 不是 /結束。
 */
import { describe, expect, it } from 'vitest';
import {
  SIM_COMMAND_RE,
  formatIntervalGroup,
  isSimCommandText,
  normalizeExerciseId,
  parseInterval,
  parseRoleChoice,
  parseSeatDigits,
  parseSimCommand,
  parseTeam,
} from '../bots/simulation/commands';
import { isTypedCommand } from '../bots/chatExport/rows';
import { SIM_REPLY_MAX_CHARS } from '../bots/simulation/config';
import { STATS_REPLY_MAX_CHARS } from '../bots/stats/statsReplies';

describe('/模擬', () => {
  it.each([
    ['/模擬', { kind: 'start' }],
    ['／模擬', { kind: 'start' }],
    [' /模擬 ', { kind: 'start' }],
    ['/模擬瓦', { kind: 'start' }],
    ['/模擬 派西 2', { kind: 'start', role: 'percival', seat: 2 }],
    ['/模擬派西2', { kind: 'start', role: 'percival', seat: 2 }],
    ['/模擬 2 派西', { kind: 'start', role: 'percival', seat: 2 }],
    ['/模擬 派西維爾　２', { kind: 'start', role: 'percival', seat: 2 }],
    ['/模擬 梅林', { kind: 'start', role: 'merlin' }],
    ['/模擬 梅', { kind: 'start', role: 'merlin' }],
    ['/模擬 忠臣 4', { kind: 'start', role: 'loyal', seat: 4 }],
    ['/模擬 雜魚 4家', { kind: 'start', role: 'loyal', seat: 4 }],
    ['/模擬 7', { kind: 'start', seat: 7 }],
    ['/模擬 0', { kind: 'start', seat: 10 }],
    ['/模擬 10', { kind: 'start', seat: 10 }],
    ['/模擬 紅', { kind: 'start', role: 'red' }],
    ['/模擬 壞人 3', { kind: 'start', role: 'red', seat: 3 }],
    ['/模擬 藍', { kind: 'start', role: 'blue' }],
    ['/模擬 好人', { kind: 'start', role: 'blue' }],
    ['/模擬 刺', { kind: 'start', role: 'assassin' }],
    ['/模擬 魔甘娜 5', { kind: 'start', role: 'morgana', seat: 5 }],
    ['/模擬 莫德 3', { kind: 'start', role: 'mordred', seat: 3 }],
    ['/模擬 默德', { kind: 'start', role: 'mordred' }],
    ['/模擬 莫德雷德', { kind: 'start', role: 'mordred' }],
    ['/模擬 奧柏倫 9', { kind: 'start', role: 'oberon', seat: 9 }],
    ['/模擬 題 K7Q2M-4', { kind: 'start', exerciseId: 'K7Q2M-4' }],
    ['/模擬 題 k7q2m-4', { kind: 'start', exerciseId: 'K7Q2M-4' }],
    ['/模擬 題號 K7Q2M-0', { kind: 'start', exerciseId: 'K7Q2M-0' }],
    ['/模擬 K7Q2M-4', { kind: 'start', exerciseId: 'K7Q2M-4' }],
    ['/模擬 題 KIQ2O-4', { kind: 'start', exerciseId: 'K1Q20-4' }],
  ])('%s', (text, expected) => {
    expect(parseSimCommand(text)).toEqual(expected);
  });

  it.each(['/模擬 xyz', '/模擬 派西 2 3', '/模擬 11', '/模擬 題 ???'])('usage for %s', (text) => {
    expect(parseSimCommand(text)).toMatchObject({ kind: 'usage', command: 'start' });
  });
});

describe('/派', () => {
  it.each([
    ['/派 469', [4, 6, 9]],
    ['/派469', [4, 6, 9]],
    ['／派 ４６９', [4, 6, 9]],
    ['/派 4 6 9', [4, 6, 9]],
    ['/派 4,6,9', [4, 6, 9]],
    ['/派 4、6、9', [4, 6, 9]],
    ['/派 960', [6, 9, 10]],
    ['/派 4 6 10', [4, 6, 10]],
    ['/派 12345', [1, 2, 3, 4, 5]],
  ])('%s', (text, team) => {
    expect(parseSimCommand(text)).toEqual({ kind: 'propose', team });
  });

  it('duplicate seats are a usage problem', () => {
    expect(parseSimCommand('/派 446')).toMatchObject({ kind: 'usage', command: 'propose', problem: expect.stringContaining('兩次') });
    expect(parseSimCommand('/派 4 10 0')).toMatchObject({ kind: 'usage', command: 'propose' });
  });

  it('/派西 2 is not /派 with a team (usage → silent without a session)', () => {
    expect(parseSimCommand('/派西 2')).toMatchObject({ kind: 'usage', command: 'propose' });
    expect(parseSimCommand('/派')).toMatchObject({ kind: 'usage', command: 'propose' });
  });

  it('parseTeam sorts, seat 10 last', () => {
    expect(parseTeam('096')).toEqual({ team: [6, 9, 10] });
    expect(parseSeatDigits('4 6 10')).toEqual([4, 6, 10]);
    expect(parseSeatDigits('abc')).toBeNull();
  });
});

describe('/區間', () => {
  it('both notations', () => {
    expect(parseSimCommand('/區間 789=2 460=1')).toEqual({
      kind: 'interval',
      groups: [{ seats: [7, 8, 9], min: 2, max: 2 }, { seats: [4, 6, 10], min: 1, max: 1 }],
    });
    expect(parseSimCommand('/區間 7 8 9 *2 4 6 0 *1')).toEqual(parseSimCommand('/區間 789=2 460=1'));
    expect(parseSimCommand('／區間　７８９＝２')).toEqual({ kind: 'interval', groups: [{ seats: [7, 8, 9], min: 2, max: 2 }] });
  });

  it('ranges, 紅 and 好', () => {
    expect(parseInterval('12=1-2 3=紅 5=好')).toEqual({
      groups: [{ seats: [1, 2], min: 1, max: 2 }, { seats: [3], min: 1, max: 1 }, { seats: [5], min: 0, max: 0 }],
    });
    expect(parseInterval('12 *1-2')).toEqual({ groups: [{ seats: [1, 2], min: 1, max: 2 }] });
    expect(parseInterval('3=壞')).toEqual({ groups: [{ seats: [3], min: 1, max: 1 }] });
  });

  it.each([
    ['789=2 7=1', '兩組'],
    ['789=4', '只有 3 人'],
    ['12345=5', '只有 4 紅'],
    ['abc', '看不懂'],
    ['789=2 然後', '看不懂'],
    ['', '請寫區間'],
  ])('rejects %j', (raw, problem) => {
    const r = parseInterval(raw);
    expect('problem' in r && r.problem).toContain(problem);
  });

  it('formats groups back in the same notation', () => {
    expect(formatIntervalGroup({ seats: [7, 8, 9], min: 2, max: 2 })).toBe('789=2');
    expect(formatIntervalGroup({ seats: [1, 2], min: 1, max: 2 })).toBe('12=1-2');
    expect(formatIntervalGroup({ seats: [4, 6, 10], min: 1, max: 1 })).toBe('460=1');
    expect(formatIntervalGroup({ seats: [5], min: 0, max: 0 })).toBe('5=好');
    expect(formatIntervalGroup({ seats: [3], min: 1, max: 1 })).toBe('3=紅');
  });
});

describe('the other commands and plain chat', () => {
  it.each([
    ['/下一步', { kind: 'next' }],
    ['/公布', { kind: 'reveal' }],
    ['/解答', { kind: 'reveal' }],
    ['/結束', { kind: 'end' }],
    ['／結束 ', { kind: 'end' }],
  ])('%s', (text, expected) => {
    expect(parseSimCommand(text)).toEqual(expected);
  });

  it.each(['/結束了嗎', '/公布欄', '/下一步吧', 'hello', '派 469', '模擬', '469', '/戰績 某人', '/意見 想要模擬', '/help', ''])(
    'not a 模擬 command: %j',
    (text) => {
      expect(parseSimCommand(text)).toBeNull();
      expect(isSimCommandText(text)).toBe(false);
    },
  );

  it('chat export skips typed 模擬 commands, even "/ 派 469"', () => {
    expect(isTypedCommand('/ 派 469')).toBe(true);
    expect(isTypedCommand('／ 模擬')).toBe(true);
    expect(SIM_COMMAND_RE.test('/ 區間 789=2')).toBe(true);
  });

  it('role words and exercise ids', () => {
    expect(parseRoleChoice('派西維爾')).toBe('percival');
    expect(parseRoleChoice('奧伯倫')).toBe('oberon');
    expect(parseRoleChoice('路人')).toBeNull();
    expect(normalizeExerciseId('n35hj-0')).toBe('N35HJ-0');
    expect(normalizeExerciseId('N35HJ')).toBeNull();
  });

  it('the reply budget is the stats one (1800, under Discord 2000 and LINE 5000)', () => {
    expect(SIM_REPLY_MAX_CHARS).toBe(STATS_REPLY_MAX_CHARS);
  });
});
