// ── Token classification helper (2026-04-24) ────────────────────────────
//
// Problem this exists to solve: Socket.IO reconnect_attempt in
// `packages/web/src/services/socket.ts` previously called `getIdToken()`
// (Firebase ID token refresh) unconditionally whenever `getFirebaseAuth().
// currentUser` was non-null. Firebase persists the Google session to
// localStorage by default, so any browser that ever signed in with Google
// kept a warm `currentUser` — even after the user later switched to a
// Discord / LINE / email / guest session. Result: the site-issued custom
// JWT (or guest JWT) stored in `_storedToken` got silently overwritten
// with a Firebase ID token on every network blip, which then broke
// downstream REST handlers that expected the custom JWT provider claim.
//
// This module provides a SSR-safe, dependency-free classifier so callers
// can decide whether a stored token is safe to refresh via Firebase. We
// intentionally DO NOT verify signatures — the function is only used to
// gate a refresh decision, never to authorise anything. Backend routes
// retain full verification via `verify(token, JWT_SECRET)` and
// `verifyIdToken(token)`.
//
// Classification rules:
//   - `'firebase-id'` — JWT whose `iss` claim starts with
//     `https://securetoken.google.com/` (Firebase Identity Platform).
//   - `'guest'` — custom JWT issued by this server with `provider === 'guest'`.
//   - `'custom-jwt'` — custom JWT issued by this server with any other
//     provider claim (`'password' | 'discord' | 'line' | 'google'` etc.) or
//     a bare `sub` claim that isn't Firebase-shaped.
//   - `'unknown'` — missing, malformed, or non-JWT input. Callers should
//     fall back to their legacy behaviour in this case.

export type TokenType = 'firebase-id' | 'custom-jwt' | 'guest' | 'unknown';

// Ambient references to `atob` (browser) and `Buffer` (Node). We declare
// them locally so this file can live in a package whose tsconfig includes
// only the minimal `ES2020` lib without pulling in `DOM` or `@types/node`.
// At runtime we `typeof`-guard both, so missing environments fall through
// cleanly to `null`.
declare const atob: ((data: string) => string) | undefined;
declare const Buffer: {
  from(input: string, encoding: string): { toString(encoding: string): string };
} | undefined;

/**
 * Decode the payload segment of a JWT without verifying the signature.
 * Returns `null` for anything that doesn't look like `<header>.<payload>.<sig>`
 * with a valid base64url-encoded JSON payload. Safe to call in both browser
 * (uses `atob`) and Node (uses `Buffer`) environments.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const b64url = parts[1];
  if (!b64url) return null;

  // base64url → base64 (restore `+ /` and pad).
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  const padded = pad === 0 ? b64 : b64 + '='.repeat(4 - pad);

  let json: string;
  try {
    if (typeof atob === 'function') {
      // Browser path — atob returns a binary string; decode as UTF-8 by
      // percent-escaping each byte, so non-ASCII displayNames survive.
      const binary = atob(padded);
      let hex = '';
      for (let i = 0; i < binary.length; i += 1) {
        const byte = binary.charCodeAt(i).toString(16).padStart(2, '0');
        hex += '%' + byte;
      }
      json = decodeURIComponent(hex);
    } else if (typeof Buffer !== 'undefined') {
      // Node path.
      json = Buffer.from(padded, 'base64').toString('utf8');
    } else {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Classify a token string by its issuer / provider claim. Signature is NOT
 * verified; callers that rely on authorisation MUST still verify the token
 * server-side. See module docstring for rationale.
 */
export function classifyToken(token: string | null | undefined): TokenType {
  if (!token) return 'unknown';
  const payload = decodeJwtPayload(token);
  if (!payload) return 'unknown';

  const iss = typeof payload.iss === 'string' ? payload.iss : undefined;
  if (iss && iss.startsWith('https://securetoken.google.com/')) {
    return 'firebase-id';
  }

  const provider = typeof payload.provider === 'string' ? payload.provider : undefined;
  if (provider === 'guest') return 'guest';
  if (provider) return 'custom-jwt';

  // Custom JWTs always carry `sub`; fall back to `custom-jwt` when `sub` is
  // present but `provider` was omitted (old tokens). Otherwise unknown.
  if (typeof payload.sub === 'string' && payload.sub.length > 0) {
    return 'custom-jwt';
  }
  return 'unknown';
}

/**
 * Convenience predicate used by the socket reconnect handler: should we
 * skip the Firebase ID token refresh for this token?
 *
 * Returns `true` for site-issued custom JWTs and guest JWTs — these tokens
 * are not backed by Firebase and refreshing via `getIdToken()` would
 * silently swap them for a Firebase ID token, breaking downstream routes
 * that branch on the `provider` claim.
 */
export function shouldSkipFirebaseRefresh(token: string | null | undefined): boolean {
  const kind = classifyToken(token);
  return kind === 'custom-jwt' || kind === 'guest';
}
