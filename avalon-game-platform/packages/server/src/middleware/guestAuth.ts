/**
 * Guest token resolver — Plan v2 R1.0 / S10 impersonation fix.
 *
 * Before: any client could send `{uid: "<victim_uid>", displayName: "..."}`
 * as socket handshake token and impersonate the victim on all 3 auth surfaces
 * (socket middleware, REST /api, claim middleware).
 *
 * Now:
 *  - New format: server-signed JWT with `provider: 'guest'` and `sub = server-minted UUID`.
 *    Clients obtain one from POST /auth/guest. `sub` is trusted because it came from us.
 *  - Legacy format (`JSON.stringify({uid, displayName})`): accepted during a 3-day grace
 *    window (GUEST_LEGACY_CUTOFF env var or default = server boot + 72h). Existing
 *    guests keep their continuity while frontends migrate. After the cutoff, legacy
 *    JSON is rejected and the client must call /auth/guest to obtain a signed token.
 *
 * All 3 callers (socket auth, REST api, claim middleware) funnel through
 * `verifyGuestToken` so there is a single choke point to audit.
 */

import { verify, sign, JwtPayload } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET as string;

/**
 * Resolved guest identity — what callers can trust after verification.
 * `uid` is server-signed (new path) or legacy client-supplied (grace path).
 */
export interface GuestIdentity {
  uid: string;
  displayName: string;
  /** true when the uid came from a server-signed JWT; false during 3-day grace */
  signed: boolean;
}

/**
 * When legacy `JSON.stringify({uid, displayName})` guest tokens stop being accepted.
 * Computed once at module load — 72 hours from server boot by default, or read from
 * `GUEST_LEGACY_CUTOFF` env var (ISO 8601 string) if operators want to extend.
 */
const LEGACY_CUTOFF_MS: number = (() => {
  const override = process.env.GUEST_LEGACY_CUTOFF;
  if (override) {
    const t = Date.parse(override);
    if (!Number.isNaN(t)) return t;
    // eslint-disable-next-line no-console
    console.warn(`[guestAuth] GUEST_LEGACY_CUTOFF="${override}" is not parseable; using default 72h window.`);
  }
  return Date.now() + 72 * 60 * 60 * 1000;
})();

/** Maximum length for a guest display name to prevent XSS / log flooding. */
const MAX_DISPLAY_NAME = 40;

/**
 * Ticket #81：訪客預設暱稱 `Guest_NNN`（3 碼 000-999 random）。
 *
 * Server 端分配取代 client 自己 random（之前 LoginPage 前端做）。這樣讓訪客
 * 不帶名字就 POST /auth/guest 時也能拿到符合規範的預設名字，日後若要做
 * username/name registry dedupe 只需改這支函式一個點。
 *
 * 碰撞處理：純 random，碰撞率 < 0.1% 不處理（訪客不進 users 表，
 * 兩人同時叫 `Guest_123` 對系統沒有副作用，反正 uid 不同）。
 */
export function generateGuestName(): string {
  const n = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `Guest_${n}`;
}

function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return generateGuestName();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return generateGuestName();
  if (trimmed.length > MAX_DISPLAY_NAME) return trimmed.slice(0, MAX_DISPLAY_NAME);
  return trimmed;
}

/**
 * Try to resolve a guest identity from a token string.
 *
 * Returns null if:
 *  - token is neither a server-signed guest JWT nor legacy guest JSON
 *  - legacy JSON is used after the 3-day grace cutoff
 *
 * Callers MUST attempt non-guest verification first (Firebase / Discord-Line JWT)
 * and only fall through to this helper as the last-resort guest path.
 */
export function verifyGuestToken(token: string): GuestIdentity | null {
  // Path A — server-signed guest JWT (new format, trusted).
  const looksLikeJwt = typeof token === 'string' && token.split('.').length === 3;
  if (looksLikeJwt) {
    try {
      const payload = verify(token, JWT_SECRET) as JwtPayload & {
        sub?: string;
        displayName?: string;
        provider?: string;
      };
      if (payload.provider === 'guest' && typeof payload.sub === 'string' && payload.sub.length > 0) {
        return {
          uid: payload.sub,
          displayName: sanitizeDisplayName(payload.displayName),
          signed: true,
        };
      }
    } catch {
      // Not our JWT — fall through to legacy JSON attempt.
    }
  }

  // Path B — legacy `JSON.stringify({uid, displayName})` from old clients.
  //
  // We cannot prove the uid came from us, so this path is only accepted during
  // the 3-day grace window so existing guests (with cached tokens) don't get
  // logged out the moment this code ships.
  if (Date.now() >= LEGACY_CUTOFF_MS) {
    return null;
  }

  try {
    const parsed = JSON.parse(token) as { uid?: unknown; displayName?: unknown };
    if (typeof parsed.uid !== 'string' || parsed.uid.length === 0) return null;
    return {
      uid: parsed.uid,
      displayName: sanitizeDisplayName(parsed.displayName),
      signed: false,
    };
  } catch {
    return null;
  }
}

/**
 * Mint a fresh server-signed guest token. Called by POST /auth/guest.
 *
 * The uid is a freshly generated v4 UUID — the server alone decides who the
 * guest is, so clients cannot request a specific uid (closes S10).
 */
export function mintGuestToken(rawDisplayName: string): { token: string; uid: string; displayName: string } {
  const displayName = sanitizeDisplayName(rawDisplayName);
  const uid = uuidv4();
  const token = sign(
    { sub: uid, displayName, provider: 'guest' },
    JWT_SECRET,
    { expiresIn: '30d' } as object,
  );
  return { token, uid, displayName };
}

/** Exposed for /health debug output and tests — not for runtime gating. */
export function getGuestLegacyCutoffMs(): number {
  return LEGACY_CUTOFF_MS;
}
