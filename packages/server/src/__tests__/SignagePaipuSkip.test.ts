import { describe, expect, it } from 'vitest';
import { isPostable, postSkipReason, type RecordedGame } from '../../scripts/signagePaipu';

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
