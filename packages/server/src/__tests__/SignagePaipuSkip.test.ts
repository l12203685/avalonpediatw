import { describe, expect, it } from 'vitest';
import {
  BOT_GAME_TAG, BOT_NICK, buildPaipuPost, isPostable, noPostReason, postSkipReason, siteRobotCount, type RecordedGame,
} from '../../scripts/signagePaipu';

const users = (n: number, robot = false) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, is_robot: robot && i === 0 }));
const end = (n: number, robot = false, missions = [[1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]) => ({
  users: users(n, robot),
  meetings: [{ ticks_set: [1, 2, 3] }],
  missionHistorys: missions.map((r) => ({ result: r.map(Boolean) })),
});
const g = (e: unknown, extra: Record<string, unknown> = {}) => ({ end: e, ...extra }) as unknown as RecordedGame;

describe('記錄員不貼 DC 的原因', () => {
  it('人數、機器人、中途加入、不完整', () => {
    expect(postSkipReason(g(end(7)))).toBe('7 人局');
    expect(postSkipReason(g(end(10, true)))).toBe('有機器人');
    expect(postSkipReason(g(end(10), { joinedMidGame: true }))).toBe('中途加入');
    expect(postSkipReason(g(end(10, false, [[1, 1, 1]])))).toMatch(/^牌譜不完整/);
    expect(postSkipReason(g(undefined))).toBe('0 人局');
  });
  it('完整 10 人真人局可以貼', () => {
    expect(postSkipReason(g(end(10)))).toBeNull();
    expect(isPostable(g(end(10)))).toBe(true);
  });
});

// Edward 2026-11-03「有百科AI的另外算 我們不會用伺服器內建的強化機器人」
describe('有練習台內建機器人的局整局不貼 DC', () => {
  const robots = (n: number, total = 10) => Array.from({ length: total }, (_, i) => ({ set: i + 1, name: `p${i}`, is_robot: i < n }));
  it('不貼的原因只有個數（不含暱稱）', () => {
    expect(siteRobotCount(g({ ...end(10), users: robots(3) }))).toBe(3);
    expect(noPostReason(g({ ...end(10), users: robots(3) }))).toBe('有練習台內建機器人（3 個）');
    expect(noPostReason(g({ ...end(7), users: robots(1, 7) }))).toBe('有練習台內建機器人（1 個）'); // 不到 10 人也不貼
    expect(noPostReason(g(end(10, true)))).not.toMatch(/p0/);
  });
  it('局末快照沒抓到時看最後一張快照', () => {
    expect(noPostReason(g(null, { timeline: [{ s: { users: robots(0) } }, { s: { users: robots(2) } }] }))).toBe('有練習台內建機器人（2 個）');
    expect(noPostReason(g(null, { timeline: [] }))).toBeNull();
    expect(noPostReason(g(undefined))).toBeNull();
  });
  it('真人局照常貼；有百科AI 的局由百科AI 自己貼，記錄員不重複貼（2026-11-09）', () => {
    expect(noPostReason(g(end(10)))).toBeNull();
    const withPedia = { ...end(10), users: users(10).map((u, i) => ({ ...u, set: i + 1, name: i === 0 ? BOT_NICK : u.name })) };
    expect(noPostReason(g(withPedia))).toBe('有百科AI（1 個，由百科AI 自己貼）');
    const p = buildPaipuPost({ ...g(withPedia), room: 'Room-1' });
    expect(p.verified).toBe(false);
    expect(p.tags).toContain(BOT_GAME_TAG);
    // 百科AI 和內建機器人同桌：內建機器人優先，不貼
    const both = { ...withPedia, users: withPedia.users.map((u, i) => (i === 1 ? { ...u, is_robot: true } : u)) };
    expect(noPostReason(g(both))).toBe('有練習台內建機器人（1 個）');
  });
});
