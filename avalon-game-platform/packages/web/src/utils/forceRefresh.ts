/**
 * forceRefresh — wipe stale client-side caches and hard-reload while
 * preserving auth state so users don't lose their login.
 *
 * Wired up by:
 *   - App.tsx "new version available" banner button
 *   - HomePage lobby 右下角「遇到問題？強制更新」按鈕
 *   - SettingsPage advanced section 「清除本機資料並重新載入」按鈕
 *
 * Behaviour:
 *   1. Snapshot **auth-related** localStorage keys (Firebase session,
 *      one-shot bind-refresh token, player display name).
 *   2. `localStorage.clear()` — wipes pref caches, room state, pending
 *      gate targets, temp suspicion boards, locale cache, etc.
 *   3. Restore the snapshotted keys so user stays logged in.
 *   4. `sessionStorage.clear()` — no auth state lives here, wipe wholesale.
 *   5. Drop Cache Storage API entries (service-worker / fetch cache; we
 *      don't ship a PWA today but be defensive so older installs recover).
 *   6. Hard-reload with a cache-bust query string — index.html itself is
 *      already `no-cache` on Firebase Hosting, but iOS Safari and some
 *      misbehaving proxies occasionally ignore that header; the `?t=`
 *      param makes the URL unique so no intermediate cache can serve a
 *      stale copy.
 *
 * Why preserve tokens: Edward's feedback 2026-04-24「每次要清快取很麻煩」—
 * if the escape-hatch forces re-login every time, it trades one pain for
 * another. Firebase persists its auth session under `firebase:*` keys by
 * default; wiping those logs the user out on every press. We preserve
 * those plus site-issued one-shot tokens so the user lands back in the
 * lobby authenticated on reload.
 *
 * Keys preserved (exact match or `firebase:` prefix):
 *   - `firebase:*`                      Firebase Auth session (Google OAuth etc.)
 *   - `avalon_bind_refresh_token`       One-shot JWT after guest→real account bind
 *   - `avalon_player_name`              Remembered display name
 *
 * Not idempotent in the "safe to call twice" sense — second call after the
 * reload will find the storages already empty of non-auth keys. Callers
 * should expect the page to navigate away immediately.
 */

// Exact keys to preserve across the wipe. Anything matching one of these
// or starting with `firebase:` stays; everything else gets cleared.
const PRESERVED_EXACT_KEYS: readonly string[] = [
  'avalon_bind_refresh_token',
  'avalon_player_name',
];
const PRESERVED_PREFIXES: readonly string[] = ['firebase:'];

function shouldPreserve(key: string): boolean {
  if (PRESERVED_EXACT_KEYS.includes(key)) return true;
  return PRESERVED_PREFIXES.some((p) => key.startsWith(p));
}

export async function forceRefresh(): Promise<void> {
  // 1-3. Snapshot auth keys → wipe localStorage → restore auth keys.
  try {
    const snapshot: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!shouldPreserve(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) snapshot[key] = value;
    }
    localStorage.clear();
    for (const [key, value] of Object.entries(snapshot)) {
      localStorage.setItem(key, value);
    }
  } catch {
    /* private mode / quota-exceeded — best-effort. Worst case the user
       ends up logged out but the reload still lands them on a fresh bundle. */
  }

  // 4. Wipe sessionStorage wholesale — no auth state lives here.
  try {
    sessionStorage.clear();
  } catch {
    /* same */
  }

  // 5. Drop CacheStorage entries (PWA / fetch cache). No-op in browsers
  // without the API; ignore errors from opaque iframes.
  if (typeof caches !== 'undefined' && caches?.keys) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* CacheStorage is spec-locked but some browsers throw on unusual
         contexts (e.g. opaque iframes). Ignore — the reload still helps. */
    }
  }

  // 6. Hard-reload with a cache-bust query param. Firebase Hosting already
  // serves index.html with `no-cache`, but mobile Safari / aggressive
  // proxies occasionally ignore that. The `?t=` param guarantees the URL
  // is unique so no intermediate layer can replay a stale cached response.
  const url = new URL(window.location.href);
  url.searchParams.set('t', Date.now().toString());
  window.location.replace(url.toString());
}
