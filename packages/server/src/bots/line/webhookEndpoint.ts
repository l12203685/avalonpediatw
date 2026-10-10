/**
 * LINE webhook endpoint — code is the single source of truth (Layer 1).
 *
 * Background (tree_registry/architecture/avalon_line_sync.md, 2026-04-26, and
 * the 2026-09-07 post-mortem): the LINE ↔ Discord sync has broken five times,
 * and every time the proximate cause was the same — the backend moved host
 * (Render → ngrok → Cloudflare quick tunnel → Cloud Run → Render) and the
 * webhook URL registered in the LINE Developers Console became an orphan.
 * Nobody noticed until a human opened the console.
 *
 * This module closes that loop:
 *   1. The expected URL is derived from env, never from the console:
 *        LINE_WEBHOOK_URL            explicit full URL (wins), else
 *        PUBLIC_BASE_URL             + '/webhook/line', else
 *        RENDER_EXTERNAL_URL         + '/webhook/line' (Render injects this).
 *   2. On boot (and every LINE_WEBHOOK_RECHECK_MIN minutes) the server reads
 *      what LINE currently has, and if it differs — and autoset is on — PUTs
 *      the expected URL back. Then it asks LINE to test-call the endpoint.
 *   3. The result is kept in memory and exposed at /api/bots/status so a CI
 *      probe (.github/workflows/verify-line-webhook.yml) can assert it without
 *      holding any LINE credential.
 *
 * Single-owner rule: one LINE channel has exactly one webhook URL. Run
 * autoset on ONE deployment only; set LINE_WEBHOOK_AUTOSET=false on any other
 * copy (it then reports drift but never writes).
 *
 * LINE Messaging API reference:
 *   GET  /v2/bot/channel/webhook/endpoint  → { endpoint, active }
 *   PUT  /v2/bot/channel/webhook/endpoint  { endpoint }
 *   POST /v2/bot/channel/webhook/test      { endpoint } → { success, reason, detail, ... }
 */

export const LINE_WEBHOOK_PATH = '/webhook/line';
const LINE_API_BASE = 'https://api.line.me';
const REQUEST_TIMEOUT_MS = 8000;

export type LineWebhookAction =
  | 'skipped'      // no token / no expected URL — nothing attempted
  | 'noop'         // LINE already has the expected URL
  | 'updated'      // drift detected and PUT succeeded
  | 'report-only'  // drift detected, autoset disabled, not changed
  | 'failed';      // an API call failed (see lastError)

export interface LineWebhookState {
  /** URL this deployment believes is canonical (from env). */
  expected: string | null;
  /** URL LINE currently has registered (from GET). */
  actual: string | null;
  /** LINE console "Use webhook" switch. Cannot be toggled via API. */
  active: boolean | null;
  autoset: boolean;
  action: LineWebhookAction;
  /** Result of LINE's test call to the endpoint; null when not attempted. */
  verified: boolean | null;
  lastCheckedAt: number | null;
  lastError: string | null;
}

export interface EnsureOptions {
  token: string;
  expected: string | null;
  autoset: boolean;
  /** Ask LINE to test-call the endpoint after it is confirmed/updated. */
  test?: boolean;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };
}

type EnvLike = Record<string, string | undefined>;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Derive the canonical webhook URL from env. Returns null when no base is
 * available (local dev without a tunnel) or the value is not https.
 */
export function resolveExpectedWebhookUrl(env: EnvLike = process.env): string | null {
  const explicit = (env.LINE_WEBHOOK_URL || '').trim();
  if (explicit) {
    return /^https:\/\//i.test(explicit) ? stripTrailingSlash(explicit) : null;
  }
  const base =
    (env.PUBLIC_BASE_URL || '').trim() ||
    (env.RENDER_EXTERNAL_URL || '').trim();
  if (!base) return null;
  if (!/^https:\/\//i.test(base)) return null;
  return `${stripTrailingSlash(base)}${LINE_WEBHOOK_PATH}`;
}

/** LINE_WEBHOOK_AUTOSET: default ON; only the literal "false"/"0"/"off" disables. */
export function isAutosetEnabled(env: EnvLike = process.env): boolean {
  const raw = (env.LINE_WEBHOOK_AUTOSET || '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
}

/** LINE_WEBHOOK_RECHECK_MIN: default 360 (6h); 0 disables periodic re-check. */
export function recheckIntervalMs(env: EnvLike = process.env): number {
  const raw = (env.LINE_WEBHOOK_RECHECK_MIN || '').trim();
  if (raw === '') return 360 * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 60_000);
}

// ─── State singleton ─────────────────────────────────────────────────────

function initialState(autoset: boolean): LineWebhookState {
  return {
    expected: null,
    actual: null,
    active: null,
    autoset,
    action: 'skipped',
    verified: null,
    lastCheckedAt: null,
    lastError: null,
  };
}

let state: LineWebhookState = initialState(true);

export function getLineWebhookState(): LineWebhookState {
  return { ...state };
}

export function __resetLineWebhookStateForTests(): void {
  state = initialState(true);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────

async function lineRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { ok: resp.ok, status: resp.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(step: string, r: { status: number; text: string }): string {
  const snippet = r.text ? r.text.slice(0, 200) : '';
  return `${step} HTTP ${r.status}${snippet ? `: ${snippet}` : ''}`;
}

// ─── Core ────────────────────────────────────────────────────────────────

/**
 * Compare LINE's registered webhook URL with the expected one and reconcile.
 * Never throws; every outcome is recorded in the state and returned.
 */
export async function ensureLineWebhookEndpoint(opts: EnsureOptions): Promise<LineWebhookState> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = stripTrailingSlash(opts.apiBase ?? LINE_API_BASE);
  const log = opts.logger ?? {
    info: (m: string): void => console.log(`[LINE webhook] ${m}`),
    warn: (m: string): void => console.warn(`[LINE webhook] ${m}`),
    error: (m: string, err?: unknown): void => console.error(`[LINE webhook] ${m}`, err ?? ''),
  };

  const next: LineWebhookState = {
    ...initialState(opts.autoset),
    expected: opts.expected,
    lastCheckedAt: Date.now(),
  };

  if (!opts.token) {
    next.action = 'skipped';
    next.lastError = 'LINE channel access token not configured';
    state = next;
    return getLineWebhookState();
  }
  if (!opts.expected) {
    next.action = 'skipped';
    next.lastError =
      'no expected URL — set LINE_WEBHOOK_URL, or PUBLIC_BASE_URL / RENDER_EXTERNAL_URL (https only)';
    log.warn(next.lastError);
    state = next;
    return getLineWebhookState();
  }

  const headers = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
  };
  const endpointUrl = `${apiBase}/v2/bot/channel/webhook/endpoint`;

  // 1. Read what LINE has now.
  try {
    const r = await lineRequest(fetchImpl, endpointUrl, { method: 'GET', headers });
    if (!r.ok) {
      next.action = 'failed';
      next.lastError = describeFailure('GET webhook endpoint', r);
      log.error(next.lastError);
      state = next;
      return getLineWebhookState();
    }
    const body = (r.body ?? {}) as { endpoint?: unknown; active?: unknown };
    next.actual = typeof body.endpoint === 'string' ? body.endpoint : null;
    next.active = typeof body.active === 'boolean' ? body.active : null;
  } catch (err) {
    next.action = 'failed';
    next.lastError = `GET webhook endpoint threw: ${err instanceof Error ? err.message : String(err)}`;
    log.error(next.lastError);
    state = next;
    return getLineWebhookState();
  }

  // 2. Reconcile.
  if (next.actual === opts.expected) {
    next.action = 'noop';
    log.info(`endpoint already ${opts.expected}`);
  } else if (!opts.autoset) {
    next.action = 'report-only';
    log.warn(
      `DRIFT: LINE has ${next.actual ?? '(none)'} but expected ${opts.expected} — autoset disabled, not changing`,
    );
  } else {
    try {
      const r = await lineRequest(fetchImpl, endpointUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ endpoint: opts.expected }),
      });
      if (!r.ok) {
        next.action = 'failed';
        next.lastError = describeFailure('PUT webhook endpoint', r);
        log.error(next.lastError);
        state = next;
        return getLineWebhookState();
      }
      next.action = 'updated';
      log.warn(`endpoint changed ${next.actual ?? '(none)'} → ${opts.expected}`);
      next.actual = opts.expected;
    } catch (err) {
      next.action = 'failed';
      next.lastError = `PUT webhook endpoint threw: ${err instanceof Error ? err.message : String(err)}`;
      log.error(next.lastError);
      state = next;
      return getLineWebhookState();
    }
  }

  if (next.active === false) {
    // No API can flip this; the human must open the console. Say it loudly.
    log.warn('LINE console "Use webhook" is OFF — inbound LINE → lobby/Discord is dead until it is switched on');
  }

  // 3. Optional end-to-end test (LINE calls our endpoint).
  if (opts.test && (next.action === 'noop' || next.action === 'updated')) {
    try {
      const r = await lineRequest(fetchImpl, `${apiBase}/v2/bot/channel/webhook/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ endpoint: opts.expected }),
      });
      const body = (r.body ?? {}) as { success?: unknown; reason?: unknown; detail?: unknown; statusCode?: unknown };
      if (r.ok && typeof body.success === 'boolean') {
        next.verified = body.success;
        if (!body.success) {
          next.lastError = `webhook test failed: ${String(body.reason ?? '')} ${String(body.detail ?? '')} (status ${String(body.statusCode ?? '?')})`.trim();
          log.warn(next.lastError);
        } else {
          log.info('webhook test OK');
        }
      } else {
        next.verified = null;
        next.lastError = describeFailure('POST webhook test', r);
        log.warn(next.lastError);
      }
    } catch (err) {
      next.verified = null;
      next.lastError = `POST webhook test threw: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(next.lastError);
    }
  }

  state = next;
  return getLineWebhookState();
}

/**
 * Render deploys without downtime: the new instance runs its first sync while
 * public traffic still reaches the previous instance, so LINE's test call can
 * 404 there (seen 2026-10-10 on the deploy that first added the LINE token).
 * Re-run the sync (with its test) until LINE verifies the endpoint or the
 * attempts run out. Only `verified === false` retries — a failed GET/PUT is not
 * a cutover race.
 */
export async function retryUntilVerified(
  sync: () => Promise<LineWebhookState | null>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LineWebhookState | null> {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 90_000;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }));
  let result = await sync();
  for (let i = 1; i < attempts && result?.verified === false; i++) {
    await sleep(delayMs);
    result = await sync();
  }
  return result;
}
