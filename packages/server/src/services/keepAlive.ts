/**
 * Keep-alive for Render Free (2026-10-09).
 *
 * Render spins a Free web service down after 15 minutes without inbound HTTP
 * traffic. While asleep:
 *   - the Discord gateway is disconnected, so Discord → lobby / LINE goes dark
 *     and messages sent meanwhile are never seen (Discord does not replay them);
 *   - the in-memory LINE reply queue, lobby chat and live games are wiped;
 *   - the first LINE webhook after a nap times out (redelivery may rescue it).
 * Pinging our own PUBLIC url goes through Render's edge, which counts as
 * inbound traffic, so the instance stays up. Free, no external service.
 *
 * Budget: one always-on service uses at most 31 × 24 = 744 of the 750 free
 * instance-hours Render gives a workspace per month. A second always-on Free
 * service in the same workspace would exhaust that pool.
 *
 *   KEEP_ALIVE_URL           explicit https URL to ping (wins)
 *   RENDER_EXTERNAL_URL      injected by Render → <url>/health
 *   KEEP_ALIVE=false         disable
 *   KEEP_ALIVE_INTERVAL_MIN  default 10, clamped to 1..14 (15+ lets it sleep)
 */

export interface KeepAliveState {
  enabled: boolean;
  url: string | null;
  intervalMs: number;
  lastOkAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_INTERVAL_MIN = 10;
const MAX_INTERVAL_MIN = 14;
const REQUEST_TIMEOUT_MS = 10_000;

function offFlag(raw: string | undefined): boolean {
  return ['false', '0', 'off', 'no'].includes((raw || '').trim().toLowerCase());
}

/** URL to ping, or null when keep-alive should not run (local dev, tests, disabled). */
export function resolveKeepAliveUrl(env: EnvLike = process.env): string | null {
  if (offFlag(env.KEEP_ALIVE)) return null;
  const explicit = (env.KEEP_ALIVE_URL || '').trim();
  if (explicit) return /^https:\/\//i.test(explicit) ? explicit : null;
  const base = (env.RENDER_EXTERNAL_URL || '').trim();
  if (!base || !/^https:\/\//i.test(base)) return null;
  return `${base.replace(/\/+$/, '')}/health`;
}

export function keepAliveIntervalMs(env: EnvLike = process.env): number {
  const raw = (env.KEEP_ALIVE_INTERVAL_MIN || '').trim();
  const n = raw === '' ? DEFAULT_INTERVAL_MIN : Number(raw);
  const minutes = Number.isFinite(n)
    ? Math.min(Math.max(n, 1), MAX_INTERVAL_MIN)
    : DEFAULT_INTERVAL_MIN;
  return Math.round(minutes * 60_000);
}

function emptyState(): KeepAliveState {
  return {
    enabled: false,
    url: null,
    intervalMs: 0,
    lastOkAt: null,
    lastError: null,
    consecutiveFailures: 0,
  };
}

let state: KeepAliveState = emptyState();
let timer: ReturnType<typeof setInterval> | null = null;

export function getKeepAliveState(): KeepAliveState {
  return { ...state };
}

/** One ping. Never throws; the outcome is recorded in the state. */
export async function pingOnce(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'avalon-keep-alive' },
    });
    await resp.text().catch(() => '');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state = { ...state, lastOkAt: Date.now(), lastError: null, consecutiveFailures: 0 };
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failures = state.consecutiveFailures + 1;
    state = { ...state, lastError: msg, consecutiveFailures: failures };
    // First failure, then about hourly at the default interval — no log spam.
    if (failures === 1 || failures % 6 === 0) {
      console.warn(`[keep-alive] ping ${url} failed (${failures}x in a row): ${msg}`);
    }
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function stopKeepAlive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Start the periodic self-ping. Safe to call more than once. Returns a stop fn. */
export function startKeepAlive(
  opts: { env?: EnvLike; fetchImpl?: typeof fetch } = {},
): () => void {
  const env = opts.env ?? process.env;
  stopKeepAlive();
  const url = resolveKeepAliveUrl(env);
  const intervalMs = keepAliveIntervalMs(env);
  state = { ...emptyState(), enabled: !!url, url, intervalMs: url ? intervalMs : 0 };
  if (!url) return stopKeepAlive;

  const fetchImpl = opts.fetchImpl ?? fetch;
  timer = setInterval(() => {
    void pingOnce(url, fetchImpl);
  }, intervalMs);
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
  console.log(`[keep-alive] pinging ${url} every ${Math.round(intervalMs / 60_000)} min`);
  return stopKeepAlive;
}

/** Test-only. */
export function __resetKeepAliveForTests(): void {
  stopKeepAlive();
  state = emptyState();
}
