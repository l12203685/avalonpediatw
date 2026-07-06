import { describe, it, expect } from 'vitest';
import { classifyToken, shouldSkipFirebaseRefresh } from '@avalon/shared';

// Forge JWT-shaped strings for classifier tests. We intentionally do NOT
// sign them — `classifyToken` never verifies signatures, it only inspects
// the `iss` / `provider` / `sub` claims to decide whether the stored token
// on the client is safe to refresh via Firebase.
function forgeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    'utf8',
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = 'fakesig';
  return `${header}.${body}.${sig}`;
}

describe('classifyToken', () => {
  it('returns "firebase-id" for Firebase Identity Platform issuer', () => {
    const token = forgeJwt({
      iss: 'https://securetoken.google.com/avalonpediatw',
      aud: 'avalonpediatw',
      sub: 'firebase-uid-abc',
      auth_time: Math.floor(Date.now() / 1000),
    });
    expect(classifyToken(token)).toBe('firebase-id');
    expect(shouldSkipFirebaseRefresh(token)).toBe(false);
  });

  it('returns "guest" when provider claim is "guest"', () => {
    const token = forgeJwt({
      sub: 'guest-uuid-123',
      displayName: 'Guest_abc',
      provider: 'guest',
    });
    expect(classifyToken(token)).toBe('guest');
    expect(shouldSkipFirebaseRefresh(token)).toBe(true);
  });

  it('returns "custom-jwt" for site-issued Discord token', () => {
    const token = forgeJwt({
      sub: 'user-uuid-456',
      displayName: 'Edward',
      provider: 'discord',
    });
    expect(classifyToken(token)).toBe('custom-jwt');
    expect(shouldSkipFirebaseRefresh(token)).toBe(true);
  });

  it('returns "custom-jwt" for site-issued LINE token', () => {
    const token = forgeJwt({
      sub: 'user-uuid-789',
      displayName: 'Edward',
      provider: 'line',
    });
    expect(classifyToken(token)).toBe('custom-jwt');
    expect(shouldSkipFirebaseRefresh(token)).toBe(true);
  });

  it('returns "custom-jwt" for site-issued email/password token', () => {
    const token = forgeJwt({
      sub: 'user-uuid-pw',
      displayName: 'edward@example.com',
      provider: 'password',
    });
    expect(classifyToken(token)).toBe('custom-jwt');
    expect(shouldSkipFirebaseRefresh(token)).toBe(true);
  });

  it('returns "custom-jwt" for site-issued google quick-login JWT', () => {
    // Critical: when Google quick-login succeeds, the server mints a site
    // JWT with provider='google'. This is NOT a Firebase ID token and
    // MUST NOT be refreshed via Firebase on reconnect — otherwise the JWT
    // (which carries a Supabase UUID in `sub`) gets clobbered.
    const token = forgeJwt({
      sub: 'user-uuid-google',
      displayName: 'Edward',
      provider: 'google',
    });
    expect(classifyToken(token)).toBe('custom-jwt');
    expect(shouldSkipFirebaseRefresh(token)).toBe(true);
  });

  it('returns "custom-jwt" when only sub is present (legacy token shape)', () => {
    const token = forgeJwt({
      sub: 'user-uuid-legacy',
      displayName: 'Legacy',
    });
    expect(classifyToken(token)).toBe('custom-jwt');
    expect(shouldSkipFirebaseRefresh(token)).toBe(true);
  });

  it('returns "unknown" for null or undefined', () => {
    expect(classifyToken(null)).toBe('unknown');
    expect(classifyToken(undefined)).toBe('unknown');
    expect(shouldSkipFirebaseRefresh(null)).toBe(false);
    expect(shouldSkipFirebaseRefresh(undefined)).toBe(false);
  });

  it('returns "unknown" for empty string', () => {
    expect(classifyToken('')).toBe('unknown');
  });

  it('returns "unknown" for non-JWT string (no dots)', () => {
    expect(classifyToken('not-a-jwt')).toBe('unknown');
  });

  it('returns "unknown" for malformed JWT (bad base64 payload)', () => {
    expect(classifyToken('aaa.@@@bogus@@@.ccc')).toBe('unknown');
  });

  it('returns "unknown" for JWT with non-JSON payload', () => {
    const badPayload = Buffer.from('not json', 'utf8').toString('base64url');
    expect(classifyToken(`aaa.${badPayload}.ccc`)).toBe('unknown');
  });

  it('returns "unknown" for JWT payload that is an array', () => {
    const arrPayload = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString(
      'base64url',
    );
    expect(classifyToken(`aaa.${arrPayload}.ccc`)).toBe('unknown');
  });

  it('returns "unknown" for JWT with neither iss, provider, nor sub', () => {
    const token = forgeJwt({ foo: 'bar' });
    expect(classifyToken(token)).toBe('unknown');
  });

  it('does not misclassify a token whose iss points to another Google service', () => {
    // Only securetoken.google.com = Firebase. accounts.google.com would be
    // e.g. an OpenID Connect id_token — not what our client stores, but
    // guard the narrow prefix match regardless.
    const token = forgeJwt({
      iss: 'https://accounts.google.com',
      sub: 'google-uid',
      provider: 'google',
    });
    expect(classifyToken(token)).toBe('custom-jwt');
  });

  it('ignores signature section (classifier must not verify)', () => {
    // Same payload, different fake signature — classification should be
    // identical. Proves we're not accidentally verifying anywhere.
    const payload = { sub: 'u', provider: 'discord' };
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256' }), 'utf8').toString(
      'base64url',
    );
    const bodyB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const a = `${headerB64}.${bodyB64}.sigA`;
    const b = `${headerB64}.${bodyB64}.sigBBBB`;
    expect(classifyToken(a)).toBe('custom-jwt');
    expect(classifyToken(b)).toBe('custom-jwt');
  });
});
