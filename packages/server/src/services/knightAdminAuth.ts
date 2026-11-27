/**
 * 統一 AI騎士（B2）— 登入與站長身分驗證（站長 2026-11-27 裁決）。
 *
 * 正式機（Render）是 GitHub-only 架構，沒有 Firestore，`AdminService.isAdmin` 會回 false。
 * 因此站長身分改用帳號庫反查 email：
 *   `githubAuthAccounts.findAccountByUserId(uid)` → `primaryEmail`
 *   比對 `AdminService.getSeedAdminEmails()`（不分大小寫）。
 *
 * 訪客（`provider === 'guest'`）不得認領玩家 ID 或調整騎士。
 */

import { verify, type JwtPayload } from 'jsonwebtoken';
import { getSeedAdminEmails } from './AdminService';
import { verifyIdToken, isFirebaseAdminReady } from './firebase';
import { findAccountByUserId, type AccountRecord } from './githubAuthAccounts';

export interface AuthenticatedKnightUser {
  uid: string;
  displayName: string;
  provider: string;
  /** 僅在驗證過的 Firebase token 附帶 email 時填寫；一般 JWT 由帳號庫反查。 */
  verifiedEmail?: string | null;
}

export interface KnightAuthDeps {
  jwtSecret?: string;
  findAccountByUserId?: (uid: string) => Promise<AccountRecord | null>;
  getSeedAdminEmails?: () => ReadonlyArray<string>;
  verifyFirebaseToken?: (token: string) => Promise<{ uid: string; name?: string; email?: string } | null>;
}

function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * 解析 `Authorization: Bearer <token>` 中的正式登入帳號（拒絕訪客）。
 */
export async function resolveAuthenticatedKnightUser(
  authHeader: string | undefined,
  deps: KnightAuthDeps = {},
): Promise<AuthenticatedKnightUser | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token || token.split('.').length !== 3) return null;

  const secret = deps.jwtSecret ?? process.env.JWT_SECRET;
  if (secret) {
    try {
      const payload = verify(token, secret) as JwtPayload & {
        sub?: string;
        displayName?: string;
        provider?: string;
      };
      if (payload.sub && payload.provider !== 'guest') {
        return {
          uid: payload.sub,
          displayName: payload.displayName || payload.sub,
          provider: payload.provider || 'email',
        };
      }
      // 明確拒絕 guest JWT
      if (payload.provider === 'guest') return null;
    } catch {
      // 非自訂 JWT，嘗試 Firebase ID token
    }
  }

  if (deps.verifyFirebaseToken) {
    try {
      const decoded = await deps.verifyFirebaseToken(token);
      if (decoded?.uid) {
        return {
          uid: decoded.uid,
          displayName: decoded.name || (decoded.email?.split('@')[0] ?? decoded.uid),
          provider: 'google',
          verifiedEmail: decoded.email ?? null,
        };
      }
    } catch {
      return null;
    }
  } else if (isFirebaseAdminReady()) {
    try {
      const decoded = await verifyIdToken(token);
      return {
        uid: decoded.uid,
        displayName: decoded.name || (decoded.email?.split('@')[0] ?? decoded.uid),
        provider: 'google',
        verifiedEmail: decoded.email ?? null,
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 檢查是否為站長（不依賴 Firestore）：
 * 1. 先呼叫 `githubAuthAccounts.findAccountByUserId(user.uid)` 取 `primaryEmail`
 * 2. 若帳號庫找不到但 token 已有驗證過的 Firebase email，退回該 email
 * 3. 比對 `AdminService.getSeedAdminEmails()`（不分大小寫）
 */
export async function resolveKnightAdminEmail(
  user: AuthenticatedKnightUser,
  deps: KnightAuthDeps = {},
): Promise<string | null> {
  const lookup = deps.findAccountByUserId ?? findAccountByUserId;
  const seedEmails = (deps.getSeedAdminEmails ?? getSeedAdminEmails)();
  const adminSet = new Set(seedEmails.map(normalizeEmail).filter(Boolean));
  if (adminSet.size === 0) return null;

  let email: string | null = null;
  try {
    const account = await lookup(user.uid);
    if (account?.primaryEmail) {
      email = account.primaryEmail;
    }
  } catch {
    // 帳號庫查詢失敗時不外洩錯誤
  }

  if (!email && user.verifiedEmail) {
    email = user.verifiedEmail;
  }

  const normalized = normalizeEmail(email);
  if (!normalized || !adminSet.has(normalized)) return null;
  return normalized;
}
