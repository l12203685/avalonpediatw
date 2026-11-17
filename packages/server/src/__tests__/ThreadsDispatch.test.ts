import { describe, expect, it, vi } from 'vitest';
import { ThreadsDispatcher, threadsStartMinute } from '../services/threadsDispatch';

const logger = { info: vi.fn(), warn: vi.fn() };
const tw = (day: number, h: number, m: number) => Date.UTC(2026, 10, day, h - 8, m, 0); // 台灣 11/day h:m

describe('每天觸發 Threads 每日發文（伺服器自己觸發）', () => {
  it('台灣 12:07 前不觸發；之後每天一次；23:00 後不補；隔天再一次', async () => {
    const calls: { url: string; body: string }[] = [];
    const d = new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), async (url, init) => { calls.push({ url, body: init.body }); return { ok: true, status: 204 }; }, logger);
    expect(await d.tick(tw(18, 12, 6))).toBe(false);
    expect(await d.tick(tw(18, 12, 7))).toBe(true);
    expect(await d.tick(tw(18, 15, 0))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/l12203685/avalonpediatw/actions/workflows/threads-publish.yml/dispatches');
    expect(JSON.parse(calls[0].body)).toEqual({ ref: 'main', inputs: { mode: 'auto', date: '' } });
    expect(await d.tick(tw(19, 23, 30))).toBe(false); // 隔天 23:00 後不補
    expect(await d.tick(tw(20, 12, 7))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('THREADS_POST_HOUR 改開始時間；格式不對用 12', () => {
    expect(threadsStartMinute({})).toBe(12 * 60 + 7);
    expect(threadsStartMinute({ THREADS_POST_HOUR: '9' })).toBe(9 * 60 + 7);
    expect(threadsStartMinute({ THREADS_POST_HOUR: '09' })).toBe(9 * 60 + 7);
    expect(threadsStartMinute({ THREADS_POST_HOUR: '23' })).toBe(12 * 60 + 7);
    expect(threadsStartMinute({ THREADS_POST_HOUR: 'noon' })).toBe(12 * 60 + 7);
  });

  it('失敗或沒回應的下一分鐘再試；沒有 token 或關閉時不打 API', async () => {
    let n = 0;
    const d = new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      return { ok: n > 2, status: n > 2 ? 204 : 500 };
    }, logger);
    expect(await d.tick(tw(18, 12, 10))).toBe(false);
    expect(d.state.lastError).toBe('TimeoutError');
    expect(await d.tick(tw(18, 12, 11))).toBe(false);
    expect(d.state.lastError).toBe('status=500');
    expect(await d.tick(tw(18, 12, 12))).toBe(true);
    const f = vi.fn();
    expect(await new ThreadsDispatcher(() => ({}), f, logger).tick(tw(18, 13, 0))).toBe(false);
    expect(await new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't', THREADS_DISPATCH: 'off' }), f, logger).tick(tw(18, 13, 0))).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
