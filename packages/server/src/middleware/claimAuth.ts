/**
 * HTTP auth middleware for the claim system.
 *
 * Resolves the caller's identity from the `Authorization: Bearer <token>`
 * header. Since 2026-04-24 (#guest-jwt rollout) the supported formats are:
 *   1. Server JWT (HS256, Discord / Line OAuth) — `sub` is the Supabase UUID
 *   2. Firebase ID token (Google / Email) — `uid` is the Firebase UID;
 *      server resolves the mapped Supabase UUID via
 *      `getSupabaseIdByFirebaseUid` before stamping `ClaimAuth.uid`
 *   3. Guest signed JWT (HS256, `provider: 'guest'`) — `sub` is a
 *      server-minted UUID; `verifyGuestToken` accepts this path
 *   3a. Legacy guest JSON `{ uid, displayName }` — 3-day grace window
 *      during #guest-jwt rollout; accepted by `verifyGuestToken` for
 *      tokens signed before the switchover. After the grace expires the
 *      JSON path is removed and only signed JWTs succeed.
 *
 * Email resolution falls back to Supabase lookups when the token itself
 * doesn't carry one (Discord tokens do; Line tokens do not).
 *
 * Two middleware flavors exported:
 *   - `requireClaimAuth`  — requires any signed-in user (incl. guest).
 *   - `requireAdminAuth`  — additionally requires email to be on the
 *                           admin whitelist (config/admins). Returns 403
 *                           otherwise.
 */

import { Request, Response, NextFunction } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import { getUserEmailById } from '../services/supabase';
import { isAdmin } from '../services/AdminService';
import { verifyGuestToken } from './guestAuth';

const JWT_SECRET = process.env.JWT_SECRET as string;

export interface ClaimAuth {
  /** Stable identifier across requests (JWT sub / Firebase uid / guest uuid) */
  uid: string;
  displayName: string;
  email: string | null;
  provider: 'google' | 'discord' | 'line' | 'email' | 'guest';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      claimAuth?: ClaimAuth;
    }
  }
}

async function resolveFromToken(token: string): Promise<ClaimAuth | null> {
  const looksLikeJwt = typeof token === 'string' && token.split('.').length === 3;

  // Path 1: custom JWT (Discord / Line)
  if (looksLikeJwt) {
    try {
      const payload = verify(token, JWT_SECRET) as JwtPayload & {
        sub?: string;
        displayName?: string;
        provider?: string;
        email?: string;
      };
      // Guest JWT 也會 verify 通過但 provider === 'guest'，交給下面的 guest 路徑統一處理。
      if (payload.sub && payload.provider !== 'guest') {
        const provider = (payload.provider as ClaimAuth['provider']) || 'discord';
        // Email may be present (Discord) — otherwise look it up in Supabase.
        let email: string | null = typeof payload.email === 'string' && payload.email
          ? payload.email
          : null;
        if (!email) {
          email = await getUserEmailById(payload.sub);
        }
        return {
          uid: payload.sub,
          displayName: payload.displayName || payload.sub,
          email,
          provider,
        };
      }
    } catch {
      // not our JWT, fall through
    }

    // Path 2: Firebase ID token
    if (isFirebaseAdminReady()) {
      try {
        const decoded = await verifyIdToken(token);
        const provider: ClaimAuth['provider'] = decoded.firebase?.sign_in_provider === 'password'
          ? 'email'
          : 'google';
        return {
          uid: decoded.uid,
          displayName: decoded.name || (decoded.email?.split('@')[0] ?? 'Player'),
          email: decoded.email || null,
          provider,
        };
      } catch {
        // invalid or not a firebase token
      }
    }
  }

  // Path 3: Guest — server-signed JWT (new) or legacy JSON within 3-day grace.
  // See middleware/guestAuth.ts for S10 impersonation fix (Plan v2 R1.0).
  const guest = verifyGuestToken(token);
  if (guest) {
    return {
      uid: guest.uid,
      displayName: guest.displayName,
      email: null,
      provider: 'guest',
    };
  }

  return null;
}

async function resolveFromHeader(authHeader: string | undefined): Promise<ClaimAuth | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  if (!token) return null;
  return resolveFromToken(token);
}

export async function requireClaimAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await resolveFromHeader(req.headers.authorization);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  req.claimAuth = auth;
  next();
}

export async function requireAdminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await resolveFromHeader(req.headers.authorization);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!auth.email) {
    res.status(403).json({ error: 'Admin access requires an email-bound account' });
    return;
  }
  const ok = await isAdmin(auth.email);
  if (!ok) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  req.claimAuth = auth;
  next();
}
