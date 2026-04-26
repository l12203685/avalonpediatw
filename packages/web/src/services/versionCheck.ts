/**
 * versionCheck.ts — Poll /api/version and notify on new deploy.
 *
 * Background: guests occasionally see `xhr poll error` / `websocket error`
 * toasts when a fresh server deploy ships and their cached JS bundle calls
 * into socket handlers that the new server rejected. The PWA service worker
 * (absent today but planned) would compound this by pinning the old bundle.
 *
 * This lightweight poller fetches `/api/version` every minute. When it sees
 * a different build identifier than the one captured on first successful
 * call, it invokes the onMismatch callback so UI can show a "new version
 * available, please refresh" toast. First-load failures are silent (dev
 * servers, transient 502s) — we only care about the *transition* from a
 * known baseline to a new value.
 *
 * Exposed as a singleton so multiple React mounts don't create parallel
 * pollers. Uses `setInterval` + `AbortController` so hot reload doesn't
 * leak timers.
 */
// Kept in sync with packages/web/src/services/api.ts and socket.ts — same env
// var, same fallback. Centralising it later is a separate cleanup.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

const POLL_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

interface VersionResponse {
  version: string;
  builtAt?: string;
  bootAt?: string;
}

type MismatchHandler = (current: string, latest: string) => void;

let baselineVersion: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let onMismatchCb: MismatchHandler | null = null;
let notifiedForVersion: string | null = null; // prevent duplicate toasts per mismatch

async function fetchVersionOnce(signal: AbortSignal): Promise<VersionResponse | null> {
  try {
    const res = await fetch(`${SERVER_URL}/api/version`, {
      method: 'GET',
      signal,
      // Bypass every layer of caching: the whole point is to detect deploys.
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as VersionResponse;
    if (!data || typeof data.version !== 'string' || data.version.length === 0) return null;
    return data;
  } catch {
    // Network hiccup, aborted timeout, JSON parse failure — all non-fatal.
    return null;
  }
}

async function tick(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const v = await fetchVersionOnce(controller.signal);
    if (!v) return;
    if (!baselineVersion) {
      // First successful read defines the client's "current" build identity.
      // Any future read that differs means the server has been redeployed.
      baselineVersion = v.version;
      return;
    }
    if (v.version !== baselineVersion && v.version !== notifiedForVersion) {
      notifiedForVersion = v.version;
      if (onMismatchCb) onMismatchCb(baselineVersion, v.version);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Start polling /api/version every minute. Idempotent: calling this twice
 * is a no-op (subsequent calls just update the mismatch callback).
 */
export function startVersionCheck(onMismatch: MismatchHandler): void {
  onMismatchCb = onMismatch;
  if (pollTimer) return;
  // Fire once immediately to capture baseline, then interval.
  void tick();
  pollTimer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}

/** Stop polling — for test teardown or an explicit "disable" user action. */
export function stopVersionCheck(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  baselineVersion = null;
  notifiedForVersion = null;
  onMismatchCb = null;
}

/** Exposed for tests / debugging dashboards. */
export function getBaselineVersion(): string | null {
  return baselineVersion;
}
