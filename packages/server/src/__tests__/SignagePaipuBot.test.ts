import { describe, expect, it } from 'vitest';
import {
  BOT_GAME_TAG, BOT_NICK, UNVERIFIED_PREFIX, botSeats, buildPaipuPost, isPediaBotName, isPostable, postSkipReason, type RecordedGame,
} from '../../scripts/signagePaipu';

// 虛構的 10 人完整局（暱稱都是編的），第 10 家是百科補位機器人。
const ROLES: Record<number, string> = { 9: '刺客', 3: '莫甘娜', 6: '莫德雷德', 7: '奧伯倫', 5: '派西維爾', 8: '梅林' };
const rounds: [number[], boolean[], number][] = [
  [[1, 4, 7], [true, true, true], 1],
  [[5, 6, 8, 10], [true, true, true, false], 2],
  [[1, 3, 6, 9], [true, true, true, true], 3],
  [[1, 4, 5, 8, 10], [true, true, true, true, true], 4],
];
const game = (botSeat: number | null): RecordedGame => ({
  room: 'Room-1417', startedAt: '2026-11-03T12:00:00.000Z', endedAt: '2026-11-03T12:40:00.000Z',
  end: {
    users: Array.from({ length: 10 }, (_, i) => ({ set: i + 1, name: i + 1 === botSeat ? BOT_NICK : `測試${i + 1}`, role: ROLES[i + 1] ?? '雜魚' })),
    meetings: rounds.map(([team, , cap]) => ({ ticks_set: team, white_ball_set: team, captain_set: cap })),
    missionHistorys: rounds.map(([team, result, cap]) => ({ member: team, result, crown_set: cap })),
    lake: [{ from: 10, to: 8, result: true }, { from: 8, to: 4, result: true }],
    logs: [{ msg: '刺客背刺 8家 梅林' }, { msg: '壞人獲勝' }],
  },
}) as unknown as RecordedGame;

describe('有百科機器人的局不當真人紀錄', () => {
  it('認得機器人暱稱（補位與模擬戰）', () => {
    expect(isPediaBotName(BOT_NICK)).toBe(true);
    expect(isPediaBotName('百科機器人A')).toBe(true);
    expect(isPediaBotName('阿瓦隆百科')).toBe(false);
    expect(isPediaBotName('測試3')).toBe(false);
  });
  it('沒有機器人的完整局照常通過', () => {
    expect(botSeats(game(null))).toEqual([]);
    expect(isPostable(game(null))).toBe(true);
  });
  it('有機器人：待檢視、原因寫座位（10 家寫 0）、標題標出、加「模擬」標籤、不掛結果標籤', () => {
    const g = game(10);
    expect(botSeats(g)).toEqual([10]);
    expect(isPostable(g)).toBe(false);
    expect(postSkipReason(g)).toBe('百科機器人參與（坐 0 家），不是真人紀錄');
    const p = buildPaipuPost(g, 3);
    expect(p.verified).toBe(false);
    expect(p.name.startsWith(`${UNVERIFIED_PREFIX}含百科機器人_20261103_2000_Room-1417`)).toBe(true);
    expect(p.tags).toEqual(['線瓦', BOT_GAME_TAG]);
    expect(p.content.split('\n')[0]).toBe('待檢視原因：百科機器人參與（坐 0 家），不是真人紀錄');
    expect(p.content).toContain('刺客刺殺:8');
  });
});
