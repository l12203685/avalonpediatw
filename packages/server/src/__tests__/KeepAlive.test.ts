import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveKeepAliveUrl,
  keepAliveIntervalMs,
  startKeepAlive,
  stopKeepAlive,
  getKeepAliveState,
  pingOnce,
  __resetKeepAliveForTests,
} from '../services/keepAlive';

function okFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return { ok: true, status: 200, text: async () => '{"status":"ok"}' } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

beforeEach(() => {
  __resetKeepAliveForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  __resetKeepAliveForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveKeepAliveUrl', () => {
  it('uses RENDER_EXTERNAL_URL + /health on Render', () => {
    expect(resolveKeepAliveUrl({ RENDER_EXTERNAL_URL: 'https://svc.onrender.com/' })).toBe(
      'https://svc.onrender.com/health',
    );
  });

  it('explicit KEEP_ALIVE_URL wins', () => {
    expect(
      resolveKeepAliveUrl({
        KEEP_ALIVE_URL: 'https://x.example/ping',
        RENDER_EXTERNAL_URL: 'https://svc.onrender.com',
      }),
    ).toBe('https://x.example/ping');
  });

  it('is off locally, when disabled, or for non-https URLs', () => {
    expect(resolveKeepAliveUrl({})).toBeNull();
    expect(resolveKeepAliveUrl({ KEEP_ALIVE: 'false', RENDER_EXTERNAL_URL: 'https://svc.onrender.com' })).toBeNull();
    expect(resolveKeepAliveUrl({ RENDER_EXTERNAL_URL: 'http://svc.onrender.com' })).toBeNull();
    expect(resolveKeepAliveUrl({ KEEP_ALIVE_URL: 'http://plain.example' })).toBeNull();
  });
});

describe('keepAliveIntervalMs', () => {
  it('defaults to 10 minutes and clamps to 1..14 minutes', () => {
    expect(keepAliveIntervalMs({})).toBe(10 * 60_000);
    expect(keepAliveIntervalMs({ KEEP_ALIVE_INTERVAL_MIN: '5' })).toBe(5 * 60_000);
    expect(keepAliveIntervalMs({ KEEP_ALIVE_INTERVAL_MIN: '30' })).toBe(14 * 60_000);
    expect(keepAliveIntervalMs({ KEEP_ALIVE_INTERVAL_MIN: '0' })).toBe(60_000);
    expect(keepAliveIntervalMs({ KEEP_ALIVE_INTERVAL_MIN: 'abc' })).toBe(10 * 60_000);
  });
});

describe('startKeepAlive', () => {
  it('does nothing when there is no URL (local dev / tests)', async () => {
    vi.useFakeTimers();
    const { fetchImpl, urls } = okFetch();
    startKeepAlive({ env: {}, fetchImpl });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(urls).toEqual([]);
    expect(getKeepAliveState().enabled).toBe(false);
  });

  it('pings the public /health URL every interval and records success', async () => {
    vi.useFakeTimers();
    const { fetchImpl, urls } = okFetch();
    startKeepAlive({ env: { RENDER_EXTERNAL_URL: 'https://svc.onrender.com' }, fetchImpl });
    expect(getKeepAliveState()).toMatchObject({
      enabled: true,
      url: 'https://svc.onrender.com/health',
      intervalMs: 10 * 60_000,
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(urls).toEqual(['https://svc.onrender.com/health']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(urls).toHaveLength(2);
    expect(getKeepAliveState().lastOkAt).not.toBeNull();
    expect(getKeepAliveState().consecutiveFailures).toBe(0);
  });

  it('stopKeepAlive stops further pings', async () => {
    vi.useFakeTimers();
    const { fetchImpl, urls } = okFetch();
    startKeepAlive({ env: { RENDER_EXTERNAL_URL: 'https://svc.onrender.com' }, fetchImpl });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stopKeepAlive();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(urls).toHaveLength(1);
  });

  it('calling start twice keeps a single timer', async () => {
    vi.useFakeTimers();
    const { fetchImpl, urls } = okFetch();
    const env = { RENDER_EXTERNAL_URL: 'https://svc.onrender.com' };
    startKeepAlive({ env, fetchImpl });
    startKeepAlive({ env, fetchImpl });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(urls).toHaveLength(1);
  });
});

describe('pingOnce', () => {
  it('counts consecutive failures and resets on success', async () => {
    const failing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const notOk = (async () => ({ ok: false, status: 503, text: async () => '' }) as Response) as unknown as typeof fetch;
    const { fetchImpl: ok } = okFetch();

    expect(await pingOnce('https://a/health', failing)).toBe(false);
    expect(await pingOnce('https://a/health', notOk)).toBe(false);
    expect(getKeepAliveState()).toMatchObject({ consecutiveFailures: 2, lastError: 'HTTP 503' });

    expect(await pingOnce('https://a/health', ok)).toBe(true);
    expect(getKeepAliveState()).toMatchObject({ consecutiveFailures: 0, lastError: null });
  });
});
