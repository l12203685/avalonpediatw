/**
 * Phase C simplified auth store (2026-04-23 Edward 原話「帳號 = email，註冊的時候設定
 * 新密碼，不用再特別有個建立新帳號的頁面；直接在帳號登入那邊就備註 登入 or 註冊；
 * 不存在的 email 就等同註冊，存在的 email 就是登入」)。
 *
 * 本檔責任：所有 auth_users 列的 email / password / session 讀寫，以 email 作為
 * 單一帳號識別。accountName 欄位仍保留在 row 上當 display 預設值（email local-part），
 * 但不再用於登入、查詢或唯一性檢查 — 全部走 emailsLower。
 *
 * Firestore schema on `auth_users/{userId}`（精簡後）：
 *   .provider               'password'
 *   .passwordHash           string   scrypt$...
 *   .emails                 string[] 所有關聯 email（小寫正規化後就是 key）
 *   .emailsLower            string[] lower-case mirror for array-contains
 *   .primaryEmail           string   主要 email（由 getPrimaryEmail 計算，優先序 google > discord > emailOnly）
 *   .primaryEmailLower      string
 *   .emailsVerified         string[] 已通過驗證的 email（驗證流程 Phase B 已實作）
 *   .googleEmail            string | null  2026-04-24 UX Phase 1：Google provider 提供的 email（primary 優先 1）
 *   .discordEmail           string | null  Discord provider 提供的 email（primary 優先 2）
 *   .lineEmail              string | null  LINE provider 提供的 email（通常 null，非 primary fallback）
 *   .emailOnly              string | null  純 email 綁定的退路 email（primary 優先 3；OAuth 都沒綁才用）
 *   .accountName            string   display 預設（email local-part，可之後改）
 *   .accountNameLower       string   僅 display 用，不再唯一
 *   .display_name           string   ELO 頁/大廳使用
 *   .createdAtPw / .passwordUpdatedAt   timestamps
 *
 * Collections 不變：password_reset_sessions, email_verifications。
 */

import type { Firestore } from 'firebase-admin/firestore';
import { randomBytes } from 'crypto';
import { isFirebaseAdminReady, getAdminFirestore } from './firebase';
import {
  hashPassword,
  verifyPassword,
  normalizeEmail,
} from './passwordHash';
import { assignShortCodeToAuthUser } from './shortCodeFirestore';

/**
 * Best-effort 為剛註冊的 auth_users row backfill 短碼到 Firestore `shortCodeIndex`。
 *
 * 設計原則：
 *   - 僅在 signup 路徑（建 row）完成後呼叫
 *   - 失敗**不阻擋**註冊（短碼只是「加好友精準配對」用，空值不是致命）
 *   - 同步 log error，方便日後追蹤
 *
 * 為何用 `assignShortCodeToAuthUser` 而非 `ensureUserShortCode`：
 *   - 前者針對 `auth_users/{uid}` collection（password / OAuth signup 實際寫入）
 *   - 後者寫入 `users/{uid}`（legacy Supabase mirror），新帳號那邊沒 doc
 */
async function backfillShortCodeBestEffort(userId: string, db: Firestore): Promise<void> {
  try {
    await assignShortCodeToAuthUser(userId, db);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] backfill shortCode failed (non-fatal):', err);
  }
}

type OAuthProvider = 'discord' | 'line' | 'google';

/** OAuth provider 對應 auth_users row 上的 id 欄位。 */
function oauthProviderColumn(provider: OAuthProvider): 'discord_id' | 'line_id' | 'firebase_uid' {
  if (provider === 'discord') return 'discord_id';
  if (provider === 'line')    return 'line_id';
  return 'firebase_uid';
}

/**
 * OAuth provider 對應 auth_users row 上的 per-provider email 欄位（2026-04-24
 * UX Phase 1 新增）。
 *
 *   google  → `googleEmail`
 *   discord → `discordEmail`
 *   line    → `lineEmail`
 *
 * 綁定時這些欄位記錄該 provider 當下提供的 email。`getPrimaryEmail` 依
 * Google > Discord > emailOnly 的優先序挑出 `primaryEmail`（LINE 不作 fallback）。
 */
export type ProviderEmailField = 'googleEmail' | 'discordEmail' | 'lineEmail';

export function providerEmailColumn(provider: OAuthProvider): ProviderEmailField {
  if (provider === 'discord') return 'discordEmail';
  if (provider === 'line')    return 'lineEmail';
  return 'googleEmail';
}

const AUTH_USERS                = 'auth_users';
const PASSWORD_RESET_SESSIONS   = 'password_reset_sessions';
const EMAIL_VERIFICATIONS       = 'email_verifications';

// Token TTLs
export const PASSWORD_RESET_TTL_MS      = 30 * 60 * 1000;       // 30 min
export const EMAIL_VERIFICATION_TTL_MS  = 24 * 60 * 60 * 1000;  // 24 h

export interface AccountRecord {
  userId:             string;
  accountName:        string;
  primaryEmail:       string;
  emails:             string[];
  emailsVerified:     string[];
  displayName:        string;
}

/**
 * Primary-email 計算的輸入形狀。接收 `auth_users` row data（可能缺欄位），
 * 回傳單一 `primaryEmail` 字串，優先序：
 *
 *   1. googleEmail（Google OAuth 拿到的 gmail）
 *   2. discordEmail（Discord OAuth 提供的 email）
 *   3. emailOnly（純 email 綁定的退路）
 *
 * 不使用 lineEmail 作 fallback — LINE 的 OpenID email 在多數情況為 null，
 * 除非使用者主動開啟 email scope；實務上不可靠，設計文件明列不作 primary 候選。
 *
 * 若三者皆空 → 回 null（理論不應發生，前端已硬鎖至少綁一個）。
 */
export interface PrimaryEmailInput {
  googleEmail?:  string | null;
  discordEmail?: string | null;
  lineEmail?:    string | null;
  emailOnly?:    string | null;
}

/**
 * 計算 primary email — UX Phase 1 最終規則（2026-04-24 Edward 10:09）。
 *
 * 優先順序：Google > Discord > Email 退路（emailOnly）。LINE 刻意不作 fallback。
 *
 * 本函式是 pure — 只讀輸入回字串；寫回 `auth_users.primaryEmail` 的責任在
 * OAuth callback / bind 路徑，由 `recomputePrimaryEmail` 處理。
 */
export function getPrimaryEmail(user: PrimaryEmailInput): string | null {
  const pick = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  return pick(user.googleEmail)
      ?? pick(user.discordEmail)
      ?? pick(user.emailOnly)
      ?? null;
}

/**
 * Common result envelope. `ok=false` carries `code` + human-readable reason.
 */
export interface AccountOpResult<T = void> {
  ok:     boolean;
  code?:  string;
  reason?: string;
  data?:  T;
}

function getFs(): Firestore | null {
  if (!isFirebaseAdminReady()) return null;
  try { return getAdminFirestore(); } catch { return null; }
}

function randomToken(): string {
  return randomBytes(32).toString('hex');
}

function emailLocalPart(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

async function findUserByEmail(db: Firestore, emailLower: string):
  Promise<{ id: string; data: Record<string, unknown> } | null>
{
  const snap = await db.collection(AUTH_USERS)
    .where('emailsLower', 'array-contains', emailLower)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() as Record<string, unknown> };
}

/**
 * Login-or-register in one call (Edward 架構簡化).
 *
 *   - email 不存在 → 建新帳號 + 回 { userId, created: true }
 *   - email 存在 + 密碼正確 → 回 { userId, created: false }
 *   - email 存在 + 密碼錯 → { ok: false, code: 'bad_credentials' }
 *
 * Caller 要先驗 email 格式 + 密碼強度 — 本函式只負責 store 層。
 */
export async function loginOrRegister(params: {
  email:    string;
  password: string;
}): Promise<AccountOpResult<{
  userId:       string;
  accountName:  string;
  primaryEmail: string;
  displayName:  string;
  created:      boolean;
}>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const emailLower = normalizeEmail(params.email);
  const emailTrim  = params.email.trim();

  try {
    const existing = await findUserByEmail(db, emailLower);

    // Path A — 登入既有帳號
    if (existing) {
      const data = existing.data as {
        passwordHash?: string;
        accountName?:  string;
        primaryEmail?: string;
        display_name?: string;
      };
      const ok = await verifyPassword(params.password, data.passwordHash ?? '');
      if (!ok) return { ok: false, code: 'bad_credentials', reason: '密碼錯誤' };
      return {
        ok: true,
        data: {
          userId:       existing.id,
          accountName:  data.accountName ?? emailLocalPart(emailTrim),
          primaryEmail: data.primaryEmail ?? emailTrim,
          displayName:  data.display_name ?? data.accountName ?? emailLocalPart(emailTrim),
          created:      false,
        },
      };
    }

    // Path B — 新帳號（email 沒被用過即註冊）
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(params.password);
    } catch {
      // 密碼強度不合格 — caller 之前應驗過，這裡當 defensive 再擋一次
      return { ok: false, code: 'hash_failed', reason: '密碼處理失敗' };
    }

    const userId  = randomBytes(16).toString('hex');
    const display = emailLocalPart(emailTrim);
    const now     = Date.now();

    const userRef = db.collection(AUTH_USERS).doc(userId);
    await db.runTransaction(async (tx) => {
      // 最後一道 race check — 進 transaction 再看一次有沒有人搶先註冊。
      const emailSnap = await tx.get(
        db.collection(AUTH_USERS).where('emailsLower', 'array-contains', emailLower).limit(1),
      );
      if (!emailSnap.empty) {
        throw new Error('EMAIL_TAKEN');
      }
      tx.set(userRef, {
        provider:           'password',
        accountName:        display,
        accountNameLower:   display.toLowerCase(),
        passwordHash,
        primaryEmail:       emailTrim,
        primaryEmailLower:  emailLower,
        emails:             [emailTrim],
        emailsLower:        [emailLower],
        emailsVerified:     [],
        // 2026-04-24 UX Phase 1：password signup = Email 退路路徑。
        // primaryEmail = emailOnly（Google/DC 都沒綁 → 自填 Email 為主）。
        googleEmail:        null,
        discordEmail:       null,
        lineEmail:          null,
        emailOnly:          emailTrim,
        display_name:       display,
        elo_rating:         1000,
        total_games:        0,
        games_won:          0,
        games_lost:         0,
        badges:             [],
        createdAt:          now,
        updatedAt:          now,
        createdAtPw:        now,
        passwordUpdatedAt:  now,
      });
    });

    // 2026-04-24 #48 修復：新帳號建好後 backfill 玩家短碼到 Firestore `shortCodeIndex`，
    // 這樣朋友輸入短碼加好友才查得到（原僅寫 Supabase，導致 `/add-by-code` 一律 404）。
    // Best-effort：寫入失敗不阻擋註冊。
    await backfillShortCodeBestEffort(userId, db);

    return {
      ok: true,
      data: {
        userId,
        accountName:  display,
        primaryEmail: emailTrim,
        displayName:  display,
        created:      true,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'EMAIL_TAKEN') {
      // Race: another concurrent request just created this email. Treat as login.
      // 再查一次拿密碼驗。
      try {
        const existing = await findUserByEmail(db, emailLower);
        if (existing) {
          const data = existing.data as { passwordHash?: string };
          const ok = await verifyPassword(params.password, data.passwordHash ?? '');
          if (!ok) return { ok: false, code: 'bad_credentials', reason: '密碼錯誤' };
          return {
            ok: true,
            data: {
              userId:       existing.id,
              accountName:  (existing.data as { accountName?: string }).accountName ?? emailLocalPart(emailTrim),
              primaryEmail: (existing.data as { primaryEmail?: string }).primaryEmail ?? emailTrim,
              displayName:  (existing.data as { display_name?: string }).display_name ?? emailLocalPart(emailTrim),
              created:      false,
            },
          };
        }
      } catch {
        // fallthrough
      }
    }
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] loginOrRegister error:', err);
    return { ok: false, code: 'error', reason: '登入/註冊失敗' };
  }
}

/**
 * Find an account by email — for forgot-password flow. Returns null if email
 * not bound to any account.
 */
export async function findAccountByEmail(email: string): Promise<AccountRecord | null> {
  const db = getFs();
  if (!db) return null;

  const emailLower = normalizeEmail(email);
  try {
    const existing = await findUserByEmail(db, emailLower);
    if (!existing) return null;
    const data = existing.data as {
      accountName?: string;
      primaryEmail?: string;
      emails?: string[];
      emailsVerified?: string[];
      display_name?: string;
    };
    return {
      userId:         existing.id,
      accountName:    data.accountName ?? emailLocalPart(email),
      primaryEmail:   data.primaryEmail ?? email,
      emails:         Array.isArray(data.emails) ? data.emails : [],
      emailsVerified: Array.isArray(data.emailsVerified) ? data.emailsVerified : [],
      displayName:    data.display_name ?? data.accountName ?? emailLocalPart(email),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] findAccountByEmail error:', err);
    return null;
  }
}

/**
 * Create a one-time password-reset token. Caller sends the email using the
 * returned token URL.
 */
export async function createPasswordResetSession(params: {
  userId:      string;
  accountName: string;
  email:       string;
}): Promise<AccountOpResult<{ token: string; expiresAt: number }>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + PASSWORD_RESET_TTL_MS;
  try {
    await db.collection(PASSWORD_RESET_SESSIONS).doc(token).set({
      userId:      params.userId,
      accountName: params.accountName,
      email:       normalizeEmail(params.email),
      expiresAt,
      createdAt:   now,
    });
    return { ok: true, data: { token, expiresAt } };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] createPasswordResetSession error:', err);
    return { ok: false, code: 'error', reason: '產生重設連結失敗' };
  }
}

/**
 * Consume a password-reset token + set the new password. Atomic via a
 * Firestore transaction.
 */
export async function consumePasswordResetAndSet(params: {
  token:       string;
  newPassword: string;
}): Promise<AccountOpResult<{ userId: string }>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  let newHash: string;
  try {
    newHash = await hashPassword(params.newPassword);
  } catch {
    return { ok: false, code: 'hash_failed', reason: '密碼處理失敗' };
  }

  const tokenRef = db.collection(PASSWORD_RESET_SESSIONS).doc(params.token);
  try {
    const userId = await db.runTransaction(async (tx) => {
      const snap = await tx.get(tokenRef);
      if (!snap.exists) throw new Error('TOKEN_NOT_FOUND');
      const data = snap.data() as { userId?: string; expiresAt?: number; consumedAt?: number };
      if (data.consumedAt) throw new Error('TOKEN_USED');
      if ((data.expiresAt ?? 0) < Date.now()) throw new Error('TOKEN_EXPIRED');
      if (!data.userId) throw new Error('TOKEN_BROKEN');
      const userRef = db.collection(AUTH_USERS).doc(data.userId);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('USER_NOT_FOUND');
      tx.update(tokenRef, { consumedAt: Date.now() });
      tx.update(userRef, {
        passwordHash:      newHash,
        passwordUpdatedAt: Date.now(),
        updatedAt:         Date.now(),
      });
      return data.userId;
    });
    return { ok: true, data: { userId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'TOKEN_NOT_FOUND') return { ok: false, code: 'token_invalid', reason: '連結失效' };
    if (msg === 'TOKEN_USED')      return { ok: false, code: 'token_used',    reason: '連結已使用過' };
    if (msg === 'TOKEN_EXPIRED')   return { ok: false, code: 'token_expired', reason: '連結已過期' };
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] consumePasswordResetAndSet error:', err);
    return { ok: false, code: 'error', reason: '重設失敗' };
  }
}

/**
 * Change password for an already-logged-in user.
 */
export async function changePassword(params: {
  userId:        string;
  oldPassword?:  string;
  newPassword:   string;
  bypassOldCheck?: boolean;
}): Promise<AccountOpResult> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  try {
    const ref = db.collection(AUTH_USERS).doc(params.userId);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, code: 'not_found', reason: '找不到帳號' };

    const data = snap.data() as { passwordHash?: string };
    const currentHash = data.passwordHash ?? '';
    if (!params.bypassOldCheck) {
      if (typeof params.oldPassword !== 'string') {
        return { ok: false, code: 'missing_old', reason: '請輸入原密碼' };
      }
      const ok = await verifyPassword(params.oldPassword, currentHash);
      if (!ok) return { ok: false, code: 'bad_credentials', reason: '原密碼錯誤' };
    }

    const newHash = await hashPassword(params.newPassword);
    await ref.update({
      passwordHash:      newHash,
      passwordUpdatedAt: Date.now(),
      updatedAt:         Date.now(),
    });
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] changePassword error:', err);
    return { ok: false, code: 'error', reason: '變更密碼失敗' };
  }
}

/**
 * Claim a historical uuid account by proving knowledge of (uuid + email + password).
 * Kept for backward compat with /api/user/claim-history — uses email as
 * secondary key on the legacy row.
 */
export async function findAccountByUuidEmailPassword(
  legacyUuid: string,
  email:      string,
  password:   string,
): Promise<AccountOpResult<{ matched: boolean; legacyUserId: string }>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  try {
    const ref = db.collection(AUTH_USERS).doc(legacyUuid);
    const snap = await ref.get();
    if (!snap.exists) {
      await verifyPassword(password, 'scrypt$16384$8$1$64$AAAA$AAAA');
      return { ok: false, code: 'no_match', reason: '找不到符合的舊帳號' };
    }
    const data = snap.data() as { passwordHash?: string; emailsLower?: string[] };
    const emailLower = normalizeEmail(email);
    const emails = Array.isArray(data.emailsLower) ? data.emailsLower : [];
    if (!emails.includes(emailLower)) {
      await verifyPassword(password, 'scrypt$16384$8$1$64$AAAA$AAAA');
      return { ok: false, code: 'no_match', reason: '找不到符合的舊帳號' };
    }
    const pwOk = await verifyPassword(password, data.passwordHash ?? '');
    if (!pwOk) return { ok: false, code: 'no_match', reason: '找不到符合的舊帳號' };
    return { ok: true, data: { matched: true, legacyUserId: legacyUuid } };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] findAccountByUuidEmailPassword error:', err);
    return { ok: false, code: 'error', reason: '查詢失敗' };
  }
}

/**
 * Create an email-verification token.
 */
export async function createEmailVerificationSession(params: {
  userId: string;
  email:  string;
}): Promise<AccountOpResult<{ token: string; expiresAt: number }>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + EMAIL_VERIFICATION_TTL_MS;
  try {
    await db.collection(EMAIL_VERIFICATIONS).doc(token).set({
      userId:    params.userId,
      email:     normalizeEmail(params.email),
      expiresAt,
      createdAt: now,
    });
    return { ok: true, data: { token, expiresAt } };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] createEmailVerificationSession error:', err);
    return { ok: false, code: 'error', reason: '產生驗證信失敗' };
  }
}

/**
 * Consume a verify token + mark the email verified on the user row. Atomic.
 */
export async function consumeEmailVerification(token: string): Promise<AccountOpResult<{ userId: string; email: string }>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const tokenRef = db.collection(EMAIL_VERIFICATIONS).doc(token);
  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(tokenRef);
      if (!snap.exists) throw new Error('TOKEN_NOT_FOUND');
      const data = snap.data() as {
        userId?: string;
        email?:  string;
        expiresAt?: number;
        consumedAt?: number;
      };
      if (data.consumedAt) throw new Error('TOKEN_USED');
      if ((data.expiresAt ?? 0) < Date.now()) throw new Error('TOKEN_EXPIRED');
      if (!data.userId || !data.email) throw new Error('TOKEN_BROKEN');

      const userRef = db.collection(AUTH_USERS).doc(data.userId);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('USER_NOT_FOUND');
      const userData = userSnap.data() as { emailsVerified?: string[] };
      const verified = Array.isArray(userData.emailsVerified) ? userData.emailsVerified : [];
      const next = verified.includes(data.email) ? verified : [...verified, data.email];

      tx.update(tokenRef, { consumedAt: Date.now() });
      tx.update(userRef, {
        emailsVerified: next,
        updatedAt:      Date.now(),
      });
      return { userId: data.userId, email: data.email };
    });
    return { ok: true, data: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'TOKEN_NOT_FOUND') return { ok: false, code: 'token_invalid', reason: '驗證連結失效' };
    if (msg === 'TOKEN_USED')      return { ok: false, code: 'token_used',    reason: '驗證連結已使用' };
    if (msg === 'TOKEN_EXPIRED')   return { ok: false, code: 'token_expired', reason: '驗證連結已過期' };
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] consumeEmailVerification error:', err);
    return { ok: false, code: 'error', reason: '驗證失敗' };
  }
}

/**
 * OAuth-primary auto-register (2026-04-23 Edward)。
 *
 * Edward 原話：「如果綁google => email 直接填入 gmail 信箱；簡單說 email 綁定是
 * for 同時沒有 google/line/dc 的」。
 *
 * 新語意：OAuth 成為主登入路徑。點 Google/LINE/Discord → 拿該 provider 的 email。
 *   - email 已存在 auth_users → 登入（並把 provider externalId 補綁到該 row）
 *   - email 不存在 → 自動建新帳號：provider、email、display_name 都塞進去，
 *     密碼存成「隨機 scrypt hash」（使用者之後若要走 email 備援路徑 → 忘記密碼流程
 *     重設即可）。
 *
 * 回傳 AccountRecord 方便 caller 直接發 JWT（displayName / primaryEmail 全備）。
 */
export async function ensureAccountByOAuthEmail(params: {
  provider:          OAuthProvider;
  providerExternalId: string;
  email:             string;
  displayName:       string;
}): Promise<AccountOpResult<{
  account: AccountRecord;
  created: boolean;
}>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const emailLower = normalizeEmail(params.email);
  const emailTrim  = params.email.trim();
  const col        = oauthProviderColumn(params.provider);

  try {
    // Path A — 既有 email 帳號 → 登入 + 補綁 provider externalId（idempotent）。
    const existing = await findUserByEmail(db, emailLower);
    if (existing) {
      const data = existing.data as {
        accountName?:   string;
        primaryEmail?:  string;
        emails?:        string[];
        emailsVerified?: string[];
        display_name?:  string;
        email?:         string; // legacy field (firestoreAccounts 讀它算 Google 顯示 label)
      };
      // 2026-04-24 bug fix：Edward 回報 Google 登入後 Settings 仍顯「未綁定」。
      // 原條件 `existingExtId 為空才寫` 在某些路徑下沒把 firebase_uid 寫到 row，
      // 且 legacy `email` 欄位從未補上 → `getLinkedAccounts` 回 linked=false 或
      // display_label 缺 gmail 字串。改為：
      //   (a) col (firebase_uid / discord_id / line_id) 與新 externalId 不符即覆蓋
      //   (b) email 欄位缺或不等於目前 OAuth email 即補寫
      //   (c) 加 log 方便觀察。
      //
      // 2026-04-24 UX Phase 1：同步寫入 per-provider email 欄位（googleEmail /
      // discordEmail / lineEmail），然後呼叫 getPrimaryEmail 重算 primaryEmail。
      // 這樣前端 IdentityBadge 和 linked provider rows 都可以直接讀 row 欄位，
      // 不用每次重算。
      const existingExtId   = (existing.data as Record<string, unknown>)[col];
      const needsExtIdWrite =
        typeof existingExtId !== 'string' ||
        existingExtId.length === 0 ||
        existingExtId !== params.providerExternalId;
      const existingEmail   = typeof data.email === 'string' ? data.email : '';
      const needsEmailWrite = existingEmail !== emailTrim;
      const providerEmailField = providerEmailColumn(params.provider);
      const existingProviderEmail = typeof (existing.data as Record<string, unknown>)[providerEmailField] === 'string'
        ? ((existing.data as Record<string, unknown>)[providerEmailField] as string)
        : '';
      const needsProviderEmailWrite = existingProviderEmail !== emailTrim;

      if (needsExtIdWrite || needsEmailWrite || needsProviderEmailWrite) {
        const patch: Record<string, unknown> = { updatedAt: Date.now() };
        if (needsExtIdWrite)        patch[col] = params.providerExternalId;
        if (needsEmailWrite)        patch.email = emailTrim;
        if (needsProviderEmailWrite) patch[providerEmailField] = emailTrim;

        // 重算 primaryEmail：合併 row 現有值 + patch 的新值再丟 getPrimaryEmail。
        const rowData = existing.data as Record<string, unknown>;
        const merged: PrimaryEmailInput = {
          googleEmail:  rowData.googleEmail as string | null | undefined,
          discordEmail: rowData.discordEmail as string | null | undefined,
          lineEmail:    rowData.lineEmail as string | null | undefined,
          emailOnly:    rowData.emailOnly as string | null | undefined,
          [providerEmailField]: emailTrim,
        };
        const nextPrimary = getPrimaryEmail(merged);
        if (nextPrimary && nextPrimary !== data.primaryEmail) {
          patch.primaryEmail      = nextPrimary;
          patch.primaryEmailLower = normalizeEmail(nextPrimary);
        }
        await db.collection(AUTH_USERS).doc(existing.id).update(patch);
        // eslint-disable-next-line no-console
        console.log('[ensureAccountByOAuthEmail] linked provider to existing row', {
          userId:      existing.id,
          provider:    params.provider,
          col,
          externalId:  params.providerExternalId,
          updatedKeys: Object.keys(patch),
        });
      }
      const account: AccountRecord = {
        userId:         existing.id,
        accountName:    data.accountName ?? emailLocalPart(emailTrim),
        primaryEmail:   data.primaryEmail ?? emailTrim,
        emails:         Array.isArray(data.emails) ? data.emails : [emailTrim],
        emailsVerified: Array.isArray(data.emailsVerified) ? data.emailsVerified : [],
        displayName:    data.display_name ?? data.accountName ?? emailLocalPart(emailTrim),
      };
      return { ok: true, data: { account, created: false } };
    }

    // Path B — 新帳號：OAuth email 當主識別，密碼存隨機 hash（備援路徑才會用）。
    const randomPassword = randomBytes(32).toString('hex');
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(randomPassword);
    } catch {
      return { ok: false, code: 'hash_failed', reason: '密碼處理失敗' };
    }

    const userId  = randomBytes(16).toString('hex');
    const display = params.displayName || emailLocalPart(emailTrim);
    const now     = Date.now();

    const userRef = db.collection(AUTH_USERS).doc(userId);
    await db.runTransaction(async (tx) => {
      // 最後 race check — 進 transaction 再驗一次 email 沒被搶註。
      const emailSnap = await tx.get(
        db.collection(AUTH_USERS).where('emailsLower', 'array-contains', emailLower).limit(1),
      );
      if (!emailSnap.empty) {
        throw new Error('EMAIL_TAKEN');
      }
      tx.set(userRef, {
        provider:           params.provider, // 'discord' | 'line' | 'google'
        [col]:              params.providerExternalId,
        accountName:        display,
        accountNameLower:   display.toLowerCase(),
        passwordHash,
        primaryEmail:       emailTrim,
        primaryEmailLower:  emailLower,
        emails:             [emailTrim],
        emailsLower:        [emailLower],
        emailsVerified:     [emailTrim], // OAuth 提供的 email 視為已驗證
        // legacy `email` 欄位 — firestoreAccounts.getLinkedAccounts 讀它算
        // Google 綁定的 display_label（「已綁定 @xxx@gmail.com」）。
        email:              emailTrim,
        // 2026-04-24 UX Phase 1：per-provider email 欄位 + emailOnly 初始化。
        // 此 row 由 OAuth 建，對應 provider 寫入當下 email；其他 provider 欄位
        // 設 null（之後綁再寫）；emailOnly 設 null（OAuth 已有 email，不需退路）。
        googleEmail:        params.provider === 'google'  ? emailTrim : null,
        discordEmail:       params.provider === 'discord' ? emailTrim : null,
        lineEmail:          params.provider === 'line'    ? emailTrim : null,
        emailOnly:          null,
        display_name:       display,
        elo_rating:         1000,
        total_games:        0,
        games_won:          0,
        games_lost:         0,
        badges:             [],
        createdAt:          now,
        updatedAt:          now,
        createdAtPw:        now,
        passwordUpdatedAt:  now,
        oauthOnly:          true, // 標記：此帳號由 OAuth 自動建立，無實際使用者密碼
      });
    });

    // 2026-04-24 #48 修復：OAuth 自動建帳也要 backfill Firestore 短碼（best-effort）。
    await backfillShortCodeBestEffort(userId, db);

    const account: AccountRecord = {
      userId,
      accountName:    display,
      primaryEmail:   emailTrim,
      emails:         [emailTrim],
      emailsVerified: [emailTrim],
      displayName:    display,
    };
    return { ok: true, data: { account, created: true } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'EMAIL_TAKEN') {
      // Race: concurrent request 搶註同 email。重新 findUserByEmail 當登入處理。
      try {
        const raced = await findUserByEmail(db, emailLower);
        if (raced) {
          const data = raced.data as {
            accountName?:   string;
            primaryEmail?:  string;
            emails?:        string[];
            emailsVerified?: string[];
            display_name?:  string;
          };
          const account: AccountRecord = {
            userId:         raced.id,
            accountName:    data.accountName ?? emailLocalPart(emailTrim),
            primaryEmail:   data.primaryEmail ?? emailTrim,
            emails:         Array.isArray(data.emails) ? data.emails : [emailTrim],
            emailsVerified: Array.isArray(data.emailsVerified) ? data.emailsVerified : [],
            displayName:    data.display_name ?? data.accountName ?? emailLocalPart(emailTrim),
          };
          return { ok: true, data: { account, created: false } };
        }
      } catch {
        // fallthrough
      }
    }
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] ensureAccountByOAuthEmail error:', err);
    return { ok: false, code: 'error', reason: 'OAuth 自動建帳失敗' };
  }
}

/**
 * 重新計算某個 user row 的 primary email 並寫回 Firestore。呼叫時機：
 *   - OAuth bind 成功後（寫入 `<provider>Email` 後）
 *   - Email 退路綁定成功後（寫入 `emailOnly` 後）
 *
 * 內部讀當前 row 的 googleEmail / discordEmail / lineEmail / emailOnly →
 * `getPrimaryEmail` → 更新 `primaryEmail` + `primaryEmailLower` + `updatedAt`。
 *
 * 若 row 不存在 → 回 { ok: false, code: 'not_found' }；
 * 若 primary 不變 → 仍回 ok=true 但 data.updated=false 讓 caller 知道省寫。
 */
export async function recomputePrimaryEmail(userId: string): Promise<AccountOpResult<{
  updated:       boolean;
  primaryEmail:  string | null;
}>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  try {
    const ref = db.collection(AUTH_USERS).doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, code: 'not_found', reason: '找不到帳號' };
    const data = snap.data() as {
      googleEmail?:        string | null;
      discordEmail?:       string | null;
      lineEmail?:          string | null;
      emailOnly?:          string | null;
      primaryEmail?:       string;
      primaryEmailLower?:  string;
    };
    const next = getPrimaryEmail({
      googleEmail:  data.googleEmail,
      discordEmail: data.discordEmail,
      lineEmail:    data.lineEmail,
      emailOnly:    data.emailOnly,
    });
    const current = typeof data.primaryEmail === 'string' ? data.primaryEmail : null;
    if (next === current) {
      return { ok: true, data: { updated: false, primaryEmail: next } };
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (next !== null) {
      patch.primaryEmail      = next;
      patch.primaryEmailLower = normalizeEmail(next);
    }
    await ref.update(patch);
    return { ok: true, data: { updated: true, primaryEmail: next } };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] recomputePrimaryEmail error:', err);
    return { ok: false, code: 'error', reason: '重算主要信箱失敗' };
  }
}

/** Add an email to a user's emails[] (unverified by default). */
export async function addEmailToUser(userId: string, email: string): Promise<AccountOpResult> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const emailLower = normalizeEmail(email);
  try {
    const existing = await findUserByEmail(db, emailLower);
    if (existing && existing.id !== userId) {
      return { ok: false, code: 'email_taken', reason: '信箱已被使用' };
    }
    const ref = db.collection(AUTH_USERS).doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, code: 'not_found', reason: '找不到帳號' };
    const data = snap.data() as { emails?: string[]; emailsLower?: string[] };
    const emails      = Array.isArray(data.emails) ? data.emails : [];
    const emailsLower = Array.isArray(data.emailsLower) ? data.emailsLower : [];
    if (!emailsLower.includes(emailLower)) {
      await ref.update({
        emails:      [...emails, email.trim()],
        emailsLower: [...emailsLower, emailLower],
        updatedAt:   Date.now(),
      });
    }
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] addEmailToUser error:', err);
    return { ok: false, code: 'error', reason: '新增信箱失敗' };
  }
}
