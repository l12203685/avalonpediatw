/**
 * forceRefresh — wipe client-side caches and hard-reload.
 *
 * Wired up by:
 *   - App.tsx "new version available" banner button
 *   - SettingsPage advanced section "clear local & reload" button
 *
 * Behaviour:
 *   1. Drop `localStorage` (auth token, pref, cached room state, etc.)
 *   2. Drop `sessionStorage`
 *   3. Drop Cache Storage API entries (service-worker / fetch cache; we
 *      don't ship a PWA today but be defensive so older installs recover)
 *   4. `window.location.reload()` — browser re-requests index.html, which
 *      Firebase Hosting serves `no-cache` so the newest bundle lands.
 *
 * Not idempotent in the "safe to call twice" sense — second call after the
 * reload will find the storages already empty. Callers should expect the
 * page to navigate away immediately.
 */
export async function forceRefresh(): Promise<void> {
  try {
    localStorage.clear();
  } catch {
    /* private mode / quota-exceeded — best-effort */
  }

  try {
    sessionStorage.clear();
  } catch {
    /* same */
  }

  if (typeof caches !== 'undefined' && caches?.keys) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* CacheStorage is spec-locked but some browsers throw on unusual
         contexts (e.g. opaque iframes). Ignore — the reload still helps. */
    }
  }

  window.location.reload();
}
