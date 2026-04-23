/**
 * Phase A new-login account store — account + password + email columns on
 * top of `auth_users` (which the Ticket #42 rewrite already uses for OAuth
 * binding).
 *
 * Why a separate file:
 *   `firestoreAccounts.ts` is the multi-account-binding surface (OAuth,
 *   merge/absorb). This module owns the account-name/password/email columns
 *   added in Phase A. Keeping them apart lets `auth.ts` import only what it
 *   needs and keeps file sizes <800 lines (see CLAUDE.md coding-style).
 *
 * Firestore additions to `auth_users/{userId}`:
 *   .accountName            string   canonical display (e.g. "Edward_Lin")
 *   .accountNameLower       string   lowercased for uniqueness query
 *   .passwordHash           string   scrypt$... (see services/passwordHash.ts)
 *   .emails                 string[] all emails the user has added
 *   .emailsLower            string[] lowercased mirror for uniqueness query
 *   .primaryEmail           string   the main email (for reset flow)
 *   .primaryEmailLower      string   lowercased mirror
 *   .emailsVerified         string[] subset of emails that passed verify
 *   .createdAtPw            number   timestamp of password-set (audit)
 *   .passwordUpdatedAt      number   timestamp of last password change (audit)
 *
 * New collections:
 *   password_reset_sessions/{token}
 *     .userId         string
 *     .accountName    string   snapshotted (audit)
 *     .email          string   snapshotted (audit)
 *     .expiresAt      number
 *     .createdAt      number
 *     .consumedAt?    number   set on successful reset; row kept for audit
 *
 *   email_verifications/{token}
 *     .userId         string
 *     .email          string   (normalised lowercase)
 *     .expiresAt      number
 *     .createdAt      number
 *     .consumedAt?    number
 */

import type { Firestore } from 'firebase-admin/firestore';
import { randomBytes } from 'crypto';
import { isFirebaseAdminReady, getAdminFirestore } from './firebase';
import {
  hashPassword,
  verifyPassword,
  normalizeAccountName,
  normalizeEmail,
} from './passwordHash';

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
 * Common result envelope for account ops. `ok=false` carries `code` +
 * human-readable reason so routes can surface Chinese error messages
 * verbatim.
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

/**
 * Check uniqueness: accountName + primaryEmail must not collide with any
 * existing auth_users row. Lowercased columns make this an O(1) lookup.
 */
async function isAccountNameTaken(db: Firestore, accountNameLower: string): Promise<boolean> {
  const snap = await db.collection(AUTH_USERS)
    .where('accountNameLower', '==', accountNameLower)
    .limit(1)
    .get();
  return !snap.empty;
}

async function isEmailTaken(db: Firestore, emailLower: string): Promise<boolean> {
  const snap = await db.collection(AUTH_USERS)
    .where('emailsLower', 'array-contains', emailLower)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Register a new account. Creates an auth_users row with accountName +
 * passwordHash + primaryEmail (unverified). Returns the new userId.
 *
 * Caller is responsible for input validation (see validateAccountName /
 * validatePasswordStrength / validateEmail). This function only checks
 * uniqueness.
 *
 * Concurrency: uses a Firestore transaction so two simultaneous registrations
 * with the same account name can't both succeed.
 */
export async function registerAccount(params: {
  accountName: string;
  password:    string;
  primaryEmail: string;
}): Promise<AccountOpResult<{ userId: string }>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const accountNameLower = normalizeAccountName(params.accountName);
  const emailLower       = normalizeEmail(params.primaryEmail);

  // Uniqueness pre-check (cheap read, catches most races) then transaction.
  if (await isAccountNameTaken(db, accountNameLower)) {
    return { ok: false, code: 'account_taken', reason: '帳號已被使用' };
  }
  if (await isEmailTaken(db, emailLower)) {
    return { ok: false, code: 'email_taken', reason: '信箱已被使用' };
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(params.password);
  } catch (err) {
    return { ok: false, code: 'hash_failed', reason: '密碼處理失敗' };
  }

  const now = Date.now();
  // auth_users docId uses a random 16-byte hex so the user-visible uuid is
  // distinct from accountName (Edward's "帳號=uuid" architecture means the
  // display login is accountName; the real row key is this uuid).
  const userId = randomBytes(16).toString('hex');

  const userRef = db.collection(AUTH_USERS).doc(userId);
  try {
    await db.runTransaction(async (tx) => {
      // Final uniqueness check inside the transaction.
      const nameSnap = await tx.get(
        db.collection(AUTH_USERS).where('accountNameLower', '==', accountNameLower).limit(1),
      );
      if (!nameSnap.empty) {
        throw new Error('ACCOUNT_NAME_TAKEN');
      }
      const emailSnap = await tx.get(
        db.collection(AUTH_USERS).where('emailsLower', 'array-contains', emailLower).limit(1),
      );
      if (!emailSnap.empty) {
        throw new Error('EMAIL_TAKEN');
      }
      tx.set(userRef, {
        provider:           'password',
        accountName:        params.accountName.trim(),
        accountNameLower,
        passwordHash,
        primaryEmail:       params.primaryEmail.trim(),
        primaryEmailLower:  emailLower,
        emails:             [params.primaryEmail.trim()],
        emailsLower:        [emailLower],
        emailsVerified:     [],
        display_name:       params.accountName.trim(),
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'ACCOUNT_NAME_TAKEN') return { ok: false, code: 'account_taken', reason: '帳號已被使用' };
    if (msg === 'EMAIL_TAKEN')        return { ok: false, code: 'email_taken',   reason: '信箱已被使用' };
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] registerAccount error:', err);
    return { ok: false, code: 'error', reason: '註冊失敗' };
  }

  return { ok: true, data: { userId } };
}

/**
 * Verify credentials. Returns the row's userId when password matches, else
 * null. Always performs a hash comparison (even when the account doesn't
 * exist) to keep timing uniform — prevents user enumeration.
 */
export async function verifyCredentials(
  accountName: string,
  password:    string,
): Promise<AccountOpResult<{ userId: string; accountName: string; primaryEmail: string; displayName: string }>> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const nameLower = normalizeAccountName(accountName);
  try {
    const snap = await db.collection(AUTH_USERS)
      .where('accountNameLower', '==', nameLower)
      .limit(1)
      .get();
    if (snap.empty) {
      // Still run a dummy hash-compare to equalise timing (S5 uniform-time).
      await verifyPassword(password, 'scrypt$16384$8$1$64$AAAA$AAAA');
      return { ok: false, code: 'bad_credentials', reason: '帳號或密碼錯誤' };
    }
    const doc = snap.docs[0];
    const data = doc.data() as {
      passwordHash?: string;
      accountName?: string;
      primaryEmail?: string;
      display_name?: string;
    };
    const pwHash = typeof data.passwordHash === 'string' ? data.passwordHash : '';
    const ok = await verifyPassword(password, pwHash);
    if (!ok) return { ok: false, code: 'bad_credentials', reason: '帳號或密碼錯誤' };
    return {
      ok: true,
      data: {
        userId:       doc.id,
        accountName:  data.accountName ?? accountName,
        primaryEmail: data.primaryEmail ?? '',
        displayName:  data.display_name ?? data.accountName ?? accountName,
      },
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] verifyCredentials error:', err);
    return { ok: false, code: 'error', reason: '登入失敗' };
  }
}

/**
 * Find an account by accountName + primary email. Returns the userId when the
 * pair matches a single row. Used by forgot-password: we only start the reset
 * flow when the pair matches so someone who knows just the account OR just
 * the email can't trigger unlimited reset emails.
 */
export async function findAccountByNameAndEmail(
  accountName: string,
  email:       string,
): Promise<AccountRecord | null> {
  const db = getFs();
  if (!db) return null;

  const nameLower  = normalizeAccountName(accountName);
  const emailLower = normalizeEmail(email);
  try {
    const snap = await db.collection(AUTH_USERS)
      .where('accountNameLower', '==', nameLower)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const data = doc.data() as {
      accountName?: string;
      primaryEmail?: string;
      emails?: string[];
      emailsLower?: string[];
      emailsVerified?: string[];
      display_name?: string;
    };
    const emails      = Array.isArray(data.emails) ? data.emails : [];
    const emailsLower = Array.isArray(data.emailsLower) ? data.emailsLower : [];
    // Match any of the user's emails, not just primary — user may have added
    // a secondary email and wants to reset via it.
    if (!emailsLower.includes(emailLower)) return null;
    return {
      userId:         doc.id,
      accountName:    data.accountName ?? accountName,
      primaryEmail:   data.primaryEmail ?? '',
      emails,
      emailsVerified: Array.isArray(data.emailsVerified) ? data.emailsVerified : [],
      displayName:    data.display_name ?? data.accountName ?? accountName,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[firestoreAuthAccounts] findAccountByNameAndEmail error:', err);
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
 * Firestore transaction: the token is marked consumed and the user's
 * passwordHash is updated together, so a retry with the same token is
 * rejected.
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
 * Change password for an already-logged-in user. Requires current password
 * unless `bypassOldCheck=true` (used by admin / reset flow internally).
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
 * Claim a historical uuid account's stats by proving knowledge of (uuid +
 * email + password). The legacy `uuid` here is the previous guest uid or
 * OAuth-auth_users doc id; merging uses the same `mergeUserAccounts` /
 * `absorbGuestIntoUser` logic from firestoreAccounts.ts.
 *
 * This thin wrapper just validates the three-way match + delegates to the
 * merge helpers to keep the single point of data-rewrite logic.
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
      // Dummy hash to equalise timing.
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
 * Create an email-verification token. Issued when the user adds a new email
 * during first-login profile setup (Phase B wires the UI). Returns the
 * token the route uses to build the verify URL.
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

/** Add an email to a user's emails[] (unverified by default). */
export async function addEmailToUser(userId: string, email: string): Promise<AccountOpResult> {
  const db = getFs();
  if (!db) return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };

  const emailLower = normalizeEmail(email);
  try {
    if (await isEmailTaken(db, emailLower)) {
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
