import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureLineWebhookEndpoint,
  getLineWebhookState,
  isAutosetEnabled,
  recheckIntervalMs,
  resolveExpectedWebhookUrl,
  retryUntilVerified,
  __resetLineWebhookStateForTests,
  type LineWebhookState,
} from '../bots/line/webhookEndpoint';

type Call = { url: string; method: string; body: unknown };

/**
 * Minimal fetch stub. `routes` maps "METHOD path" → handler returning
 * { status, json }. Records every call so tests can assert what was written.
 */
function fakeFetch(
  routes: Record<string, (body: unknown) => { status: number; json?: unknown }>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const path = new URL(url).pathname;
    const handler = routes[`${method} ${path}`];
    if (!handler) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route' }) } as Response;
    }
    const r = handler(body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const ENDPOINT = '/v2/bot/channel/webhook/endpoint';
const TEST = '/v2/bot/channel/webhook/test';

beforeEach(() => {
  __resetLineWebhookStateForTests();
});

describe('resolveExpectedWebhookUrl', () => {
  it('prefers LINE_WEBHOOK_URL verbatim (trailing slash stripped)', () => {
    expect(
      resolveExpectedWebhookUrl({
        LINE_WEBHOOK_URL: 'https://x.example/line/webhook/avalon/',
        RENDER_EXTERNAL_URL: 'https://y.onrender.com',
      }),
    ).toBe('https://x.example/line/webhook/avalon');
  });

  it('falls back to PUBLIC_BASE_URL + /webhook/line', () => {
    expect(resolveExpectedWebhookUrl({ PUBLIC_BASE_URL: 'https://a.example/' })).toBe(
      'https://a.example/webhook/line',
    );
  });

  it('falls back to RENDER_EXTERNAL_URL + /webhook/line', () => {
    expect(resolveExpectedWebhookUrl({ RENDER_EXTERNAL_URL: 'https://svc.onrender.com' })).toBe(
      'https://svc.onrender.com/webhook/line',
    );
  });

  it('returns null when nothing is set or the scheme is not https', () => {
    expect(resolveExpectedWebhookUrl({})).toBeNull();
    expect(resolveExpectedWebhookUrl({ PUBLIC_BASE_URL: 'http://localhost:3001' })).toBeNull();
    expect(resolveExpectedWebhookUrl({ LINE_WEBHOOK_URL: 'http://plain.example/webhook/line' })).toBeNull();
  });
});

describe('env flags', () => {
  it('autoset defaults ON and only an explicit false-ish turns it off', () => {
    expect(isAutosetEnabled({})).toBe(true);
    expect(isAutosetEnabled({ LINE_WEBHOOK_AUTOSET: 'true' })).toBe(true);
    expect(isAutosetEnabled({ LINE_WEBHOOK_AUTOSET: 'false' })).toBe(false);
    expect(isAutosetEnabled({ LINE_WEBHOOK_AUTOSET: '0' })).toBe(false);
  });

  it('recheck interval defaults to 6h, 0 disables, garbage disables', () => {
    expect(recheckIntervalMs({})).toBe(360 * 60_000);
    expect(recheckIntervalMs({ LINE_WEBHOOK_RECHECK_MIN: '15' })).toBe(15 * 60_000);
    expect(recheckIntervalMs({ LINE_WEBHOOK_RECHECK_MIN: '0' })).toBe(0);
    expect(recheckIntervalMs({ LINE_WEBHOOK_RECHECK_MIN: 'abc' })).toBe(0);
  });
});

describe('ensureLineWebhookEndpoint', () => {
  it('skips without a token and records why', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const s = await ensureLineWebhookEndpoint({
      token: '',
      expected: 'https://a/webhook/line',
      autoset: true,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('skipped');
    expect(s.lastError).toMatch(/token/);
    expect(calls).toEqual([]);
  });

  it('skips without an expected URL and never calls LINE', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const s = await ensureLineWebhookEndpoint({
      token: 't',
      expected: null,
      autoset: true,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('noop when LINE already has the expected URL (no PUT)', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET ${ENDPOINT}`]: () => ({ status: 200, json: { endpoint: 'https://a/webhook/line', active: true } }),
    });
    const s = await ensureLineWebhookEndpoint({
      token: 't',
      expected: 'https://a/webhook/line',
      autoset: true,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('noop');
    expect(s.actual).toBe('https://a/webhook/line');
    expect(s.active).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(calls[0].url).toBe(`https://api.line.me${ENDPOINT}`);
  });

  it('drift + autoset → PUT expected URL, action=updated', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET ${ENDPOINT}`]: () => ({
        status: 200,
        json: { endpoint: 'https://edward-listen-bot.onrender.com/line/webhook/avalon', active: true },
      }),
      [`PUT ${ENDPOINT}`]: () => ({ status: 200, json: {} }),
    });
    const s = await ensureLineWebhookEndpoint({
      token: 't',
      expected: 'https://svc.onrender.com/webhook/line',
      autoset: true,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('updated');
    expect(s.actual).toBe('https://svc.onrender.com/webhook/line');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ endpoint: 'https://svc.onrender.com/webhook/line' });
  });

  it('drift + autoset OFF → report-only, no PUT', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET ${ENDPOINT}`]: () => ({ status: 200, json: { endpoint: 'https://old/webhook/line', active: false } }),
    });
    const s = await ensureLineWebhookEndpoint({
      token: 't',
      expected: 'https://new/webhook/line',
      autoset: false,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('report-only');
    expect(s.actual).toBe('https://old/webhook/line');
    expect(s.active).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('GET failure (bad token) → failed with HTTP status in lastError', async () => {
    const { fetchImpl } = fakeFetch({
      [`GET ${ENDPOINT}`]: () => ({ status: 401, json: { message: 'Authentication failed' } }),
    });
    const s = await ensureLineWebhookEndpoint({
      token: 'bad',
      expected: 'https://a/webhook/line',
      autoset: true,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('failed');
    expect(s.lastError).toMatch(/GET webhook endpoint HTTP 401/);
  });

  it('PUT failure → failed, actual left as LINE had it', async () => {
    const { fetchImpl } = fakeFetch({
      [`GET ${ENDPOINT}`]: () => ({ status: 200, json: { endpoint: 'https://old/webhook/line', active: true } }),
      [`PUT ${ENDPOINT}`]: () => ({ status: 400, json: { message: 'Invalid webhook endpoint URL' } }),
    });
    const s = await ensureLineWebhookEndpoint({
      token: 't',
      expected: 'https://new/webhook/line',
      autoset: true,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('failed');
    expect(s.actual).toBe('https://old/webhook/line');
    expect(s.lastError).toMatch(/PUT webhook endpoint HTTP 400/);
  });

  it('test=true records LINE\'s end-to-end verdict', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET ${ENDPOINT}`]: () => ({ status: 200, json: { endpoint: 'https://a/webhook/line', active: true } }),
      [`POST ${TEST}`]: () => ({
        status: 200,
        json: { success: false, timestamp: 1, statusCode: 502, reason: 'ERROR_STATUS_CODE', detail: '502' },
      }),
    });
    const s = await ensureLineWebhookEndpoint({
      token: 't',
      expected: 'https://a/webhook/line',
      autoset: true,
      test: true,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('noop');
    expect(s.verified).toBe(false);
    expect(s.lastError).toMatch(/ERROR_STATUS_CODE/);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ endpoint: 'https://a/webhook/line' });
  });

  it('state singleton reflects the last run', async () => {
    const { fetchImpl } = fakeFetch({
      [`GET ${ENDPOINT}`]: () => ({ status: 200, json: { endpoint: 'https://a/webhook/line', active: true } }),
    });
    await ensureLineWebhookEndpoint({
      token: 't',
      expected: 'https://a/webhook/line',
      autoset: true,
      fetchImpl,
      logger: silent,
    });
    const s = getLineWebhookState();
    expect(s.action).toBe('noop');
    expect(s.lastCheckedAt).not.toBeNull();
  });

  it('a thrown fetch (network down) is captured, not propagated', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const s = await ensureLineWebhookEndpoint({
      token: 't',
      expected: 'https://a/webhook/line',
      autoset: true,
      fetchImpl,
      logger: silent,
    });
    expect(s.action).toBe('failed');
    expect(s.lastError).toMatch(/ECONNRESET/);
  });
});

describe('retryUntilVerified', () => {
  const st = (verified: boolean | null): LineWebhookState =>
    ({ ...getLineWebhookState(), action: 'updated', verified }) as LineWebhookState;

  it('re-tests after a failed LINE test call until it passes (deploy cutover race)', async () => {
    const results = [st(false), st(false), st(true)];
    const sleeps: number[] = [];
    let calls = 0;
    const out = await retryUntilVerified(async () => results[calls++], {
      delayMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([5, 5]);
    expect(out?.verified).toBe(true);
  });

  it('stops after the attempt limit', async () => {
    let calls = 0;
    const out = await retryUntilVerified(async () => (calls++, st(false)), { attempts: 3, sleep: async () => {} });
    expect(calls).toBe(3);
    expect(out?.verified).toBe(false);
  });

  it('does not retry when verified is true or unknown, or the leg is disabled', async () => {
    for (const first of [st(true), st(null), null]) {
      let calls = 0;
      await retryUntilVerified(async () => (calls++, first), { sleep: async () => {} });
      expect(calls).toBe(1);
    }
  });
});
