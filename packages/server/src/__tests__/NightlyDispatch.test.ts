import { describe, expect, it, vi } from 'vitest';
import { NightlyDispatcher, taipeiClock } from '../services/nightlyDispatch';

const logger = { info: vi.fn(), warn: vi.fn() };
const tw = (h: number, m: number) => Date.UTC(2026, 10, 9, h - 8, m, 0); // 台灣 11/09 h:m

describe('每晚觸發記錄員＋每晚補位（伺服器自己觸發）', () => {
  it('台灣 18:35 前不觸發；之後每天各一次；23:00 後不補', async () => {
    const calls: string[] = [];
    const d = new NightlyDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), async (url) => { calls.push(url); return { ok: true, status: 204 }; }, logger);
    expect(await d.tick(tw(18, 34))).toEqual([]);
    expect(await d.tick(tw(18, 35))).toEqual(['signage-recorder.yml', 'signage-player.yml']);
    expect(await d.tick(tw(19, 0))).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(await d.tick(tw(23, 30))).toEqual([]);
    expect(taipeiClock(tw(18, 35))).toEqual({ day: '2026-11-09', minute: 18 * 60 + 35 });
  });
  it('失敗的下一分鐘再試；沒有 token 或關閉時不打 API', async () => {
    let n = 0;
    const d = new NightlyDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), async () => ({ ok: ++n > 2, status: n > 2 ? 204 : 500 }), logger);
    expect(await d.tick(tw(18, 40))).toEqual([]);
    expect(await d.tick(tw(18, 41))).toEqual(['signage-recorder.yml', 'signage-player.yml']);
    const f = vi.fn();
    expect(await new NightlyDispatcher(() => ({}), f, logger).tick(tw(19, 0))).toEqual([]);
    expect(await new NightlyDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't', NIGHTLY_DISPATCH: 'off' }), f, logger).tick(tw(19, 0))).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});
