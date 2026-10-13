/**
 * Which OAuth sign-ins this deployment can finish (server GET /auth/providers,
 * 2026-10-13). Players took the LINE / Discord buttons — which ended on a raw
 * 503 page because those flows are not configured — for "the stats need a
 * login". The UI shows only the ready ones; viewing stats never needs a login.
 * Google also needs the Firebase web config on this build.
 */
export interface LoginProviders {
  google: boolean;
  discord: boolean;
  line: boolean;
}

export const NO_OAUTH_PROVIDERS: LoginProviders = { google: false, discord: false, line: false };

/** Coerce a /auth/providers body: anything but `true` is "not ready" (an old server has no route → all false). */
export function parseLoginProviders(body: unknown, firebaseConfigured: boolean): LoginProviders {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    google: b.google === true && firebaseConfigured,
    discord: b.discord === true,
    line: b.line === true,
  };
}
