/**
 * GitHub-backed 帳號庫 (Edward 2026-06-26「全改 GitHub-only」)。
 *
 * 取代 firestoreAuthAccounts —— email/password 帳號改存一個 **private** GitHub
 * repo，讓整個架構只依賴 GitHub，不再需要 Firebase/Firestore。本檔導出的符號與
 * 簽名刻意與 firestoreAuthAccounts 對齊，是 routes/auth.ts 的 drop-in。
 *
 * 儲存模型（為什麼這樣設計）：
 *   - 一帳號一檔 `accounts/{sha256(emailLower)}.json`。用 email 的 sha256 當檔名 →
 *     固定長度、路徑安全、檔名本身不外洩 email；email 明文存在檔案內。查帳號 =
 *     算 hash 直接 GET 該路徑，O(1)，不需列目錄。
 *   - 註冊用 GitHub Contents API 的「建檔」語意做樂觀鎖：對已存在的路徑做無 sha
 *     的 PUT 會回 422 → 代表 email 已被註冊（或同時有人搶註冊），據此走登入。
 *   - 密碼用既有 scrypt hash（passwordHash.ts），**絕不存明文**。因為含密碼雜湊，
 *     這個 repo 必須是 private。
 *
 * 啟用（未設則回 no_store，行為等同 Firestore 未配置時）：
 *   GITHUB_ACCOUNTS_TOKEN   對該 repo 有 contents:write 的 fine-grained PAT
 *   GITHUB_ACCOUNTS_REPO    "owner/repo"，**務必 private**
 *   GITHUB_ACCOUNTS_BRANCH  預設 main
 *   GITHUB_API_BASE         預設 https://api.github.com
 *
 * 取捨：登入要打 1 次 GitHub API(~0.3-1s)、註冊 2 次(~1-2s)，比 Firestore 慢，但
 * 對休閒桌遊可接受，且換來「零 Firebase 依賴」。並非為高併發/高頻登入設計。
 */

import { createHash, randomBytes } from 'crypto';
import { hashPassword, verifyPassword, normalizeEmail } from './passwordHash';

// ── 設定 ────────────────────────────────────────────────────
const TOKEN  = process.env.GITHUB_ACCOUNTS_TOKEN  || '';
const REPO   = process.env.GITHUB_ACCOUNTS_REPO   || '';
const BRANCH = process.env.GITHUB_ACCOUNTS_BRANCH || 'main';
const API    = process.env.GITHUB_API_BASE        || 'https://api.github.com';

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 min（對齊 firestore 版）

/** True iff token + "owner/repo" 都設定好，帳號庫才會實際運作。 */
export function isGitHubAccountsConfigured(): boolean {
  return TOKEN.length > 0 && /^[^/\s]+\/[^/\s]+$/.test(REPO);
}

// ── 型別（與 firestoreAuthAccounts 對齊）────────────────────
interface AccountOpResult<T> {
  ok:      boolean;
  code?:   string;
  reason?: string;
  data?:   T;
}

export interface AccountRecord {
  userId:         string;
  accountName:    string;
  primaryEmail:   string;
  emails:         string[];
  emailsVerified: string[];
  displayName:    string;
}

/** repo 內持久化的帳號形狀（比 AccountRecord 多 passwordHash / timestamps）。 */
interface StoredAccount {
  userId:         string;
  emailLower:     string;
  primaryEmail:   string;
  accountName:    string;
  displayName:    string;
  passwordHash:   string;
  emails:         string[];
  emailsVerified: string[];
  createdAt:      number;
  updatedAt:      number;
}

interface StoredResetSession {
  userId:      string;
  emailLower:  string;
  accountName: string;
  expiresAt:   number;
  consumedAt?: number;
}

// ── GitHub Contents API helpers ─────────────────────────────
function ghHeaders(): Record<string, string> {
  return {
    Authorization:          `Bearer ${TOKEN}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent':           'avalonpediatw-accounts',
  };
}

function emailLocalPart(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

function accountPath(emailLower: string): string {
  const h = createHash('sha256').update(emailLower).digest('hex');
  return `accounts/${h}.json`;
}

function resetPath(token: string): string {
  return `reset_sessions/${token}.json`;
}

/** GET 一個 JSON 檔 → { data, sha }；404 → null；其他錯誤 → throw。 */
async function ghGetJson<T>(path: string): Promise<{ data: T; sha: string } | null> {
  const url = `${API}/repos/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  const body = (await res.json()) as { content?: string; sha: string };
  const json = Buffer.from(body.content ?? '', 'base64').toString('utf8');
  return { data: JSON.parse(json) as T, sha: body.sha };
}

/**
 * PUT 一個 JSON 檔。建檔不帶 sha；更新帶 sha。
 * 回傳 status；caller 自行處理 422（建檔撞已存在）。
 */
async function ghPutJson(path: string, obj: unknown, message: string, sha?: string): Promise<number> {
  const url = `${API}/repos/${REPO}/contents/${encodeURI(path)}`;
  const content = Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64');
  const body: Record<string, unknown> = { message, content, branch: BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method:  'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.status;
}

function toAccountRecord(a: StoredAccount): AccountRecord {
  return {
    userId:         a.userId,
    accountName:    a.accountName,
    primaryEmail:   a.primaryEmail,
    emails:         Array.isArray(a.emails) ? a.emails : [],
    emailsVerified: Array.isArray(a.emailsVerified) ? a.emailsVerified : [],
    displayName:    a.displayName,
  };
}

// ── 公開 API（drop-in for firestoreAuthAccounts）────────────

/**
 * 登入或註冊（email 不存在→建帳號；存在+密碼對→登入；存在+密碼錯→bad_credentials）。
 * Caller 須先驗 email 格式 + 密碼強度。
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
  if (!isGitHubAccountsConfigured()) {
    return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };
  }

  const emailTrim  = params.email.trim();
  const emailLower = normalizeEmail(params.email);
  const path       = accountPath(emailLower);

  try {
    const existing = await ghGetJson<StoredAccount>(path);

    // Path A — 登入既有帳號
    if (existing) {
      const ok = await verifyPassword(params.password, existing.data.passwordHash ?? '');
      if (!ok) return { ok: false, code: 'bad_credentials', reason: '密碼錯誤' };
      return {
        ok: true,
        data: {
          userId:       existing.data.userId,
          accountName:  existing.data.accountName ?? emailLocalPart(emailTrim),
          primaryEmail: existing.data.primaryEmail ?? emailTrim,
          displayName:  existing.data.displayName ?? emailLocalPart(emailTrim),
          created:      false,
        },
      };
    }

    // Path B — 新帳號
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(params.password);
    } catch {
      return { ok: false, code: 'hash_failed', reason: '密碼處理失敗' };
    }

    const userId  = randomBytes(16).toString('hex');
    const display = emailLocalPart(emailTrim);
    const now     = Date.now();
    const record: StoredAccount = {
      userId,
      emailLower,
      primaryEmail:   emailTrim,
      accountName:    display,
      displayName:    display,
      passwordHash,
      emails:         [emailTrim],
      emailsVerified: [],
      createdAt:      now,
      updatedAt:      now,
    };

    const status = await ghPutJson(path, record, `account: register ${userId}`);

    // 422 = 路徑已存在（GET 與 PUT 之間有人搶先註冊同 email）→ 退化成登入。
    if (status === 422) {
      const racer = await ghGetJson<StoredAccount>(path);
      if (racer) {
        const ok = await verifyPassword(params.password, racer.data.passwordHash ?? '');
        if (!ok) return { ok: false, code: 'bad_credentials', reason: '密碼錯誤' };
        return {
          ok: true,
          data: {
            userId:       racer.data.userId,
            accountName:  racer.data.accountName,
            primaryEmail: racer.data.primaryEmail,
            displayName:  racer.data.displayName,
            created:      false,
          },
        };
      }
    }
    if (status !== 200 && status !== 201) {
      return { ok: false, code: 'write_failed', reason: `帳號寫入失敗 (${status})` };
    }

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
    console.error('[githubAuthAccounts] loginOrRegister error:', err instanceof Error ? err.message : err);
    return { ok: false, code: 'store_error', reason: '帳戶資料庫錯誤' };
  }
}

/** 用 email 查帳號；找不到或未配置 → null。 */
export async function findAccountByEmail(email: string): Promise<AccountRecord | null> {
  if (!isGitHubAccountsConfigured()) return null;
  try {
    const found = await ghGetJson<StoredAccount>(accountPath(normalizeEmail(email)));
    return found ? toAccountRecord(found.data) : null;
  } catch (err) {
    console.error('[githubAuthAccounts] findAccountByEmail error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** 建立一次性密碼重設 token（caller 負責把 token 連結寄出）。 */
export async function createPasswordResetSession(params: {
  userId:      string;
  accountName: string;
  email:       string;
}): Promise<AccountOpResult<{ token: string; expiresAt: number }>> {
  if (!isGitHubAccountsConfigured()) {
    return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };
  }
  const token     = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + PASSWORD_RESET_TTL_MS;
  const session: StoredResetSession = {
    userId:      params.userId,
    emailLower:  normalizeEmail(params.email),
    accountName: params.accountName,
    expiresAt,
  };
  try {
    const status = await ghPutJson(resetPath(token), session, `reset: create ${params.userId}`);
    if (status !== 200 && status !== 201) {
      return { ok: false, code: 'write_failed', reason: `重設 session 寫入失敗 (${status})` };
    }
    return { ok: true, data: { token, expiresAt } };
  } catch (err) {
    console.error('[githubAuthAccounts] createPasswordResetSession error:', err instanceof Error ? err.message : err);
    return { ok: false, code: 'store_error', reason: '帳戶資料庫錯誤' };
  }
}

/** 消耗重設 token 並改密碼。 */
export async function consumePasswordResetAndSet(params: {
  token:       string;
  newPassword: string;
}): Promise<AccountOpResult<{ userId: string }>> {
  if (!isGitHubAccountsConfigured()) {
    return { ok: false, code: 'no_store', reason: '帳戶資料庫未配置' };
  }

  let newHash: string;
  try {
    newHash = await hashPassword(params.newPassword);
  } catch {
    return { ok: false, code: 'hash_failed', reason: '密碼處理失敗' };
  }

  try {
    const sess = await ghGetJson<StoredResetSession>(resetPath(params.token));
    if (!sess) return { ok: false, code: 'TOKEN_NOT_FOUND', reason: 'token 不存在' };
    if (sess.data.consumedAt) return { ok: false, code: 'TOKEN_USED', reason: 'token 已使用' };
    if ((sess.data.expiresAt ?? 0) < Date.now()) {
      return { ok: false, code: 'TOKEN_EXPIRED', reason: 'token 已過期' };
    }

    const acctPath = accountPath(sess.data.emailLower);
    const acct = await ghGetJson<StoredAccount>(acctPath);
    if (!acct) return { ok: false, code: 'USER_NOT_FOUND', reason: '帳號不存在' };

    const updated: StoredAccount = { ...acct.data, passwordHash: newHash, updatedAt: Date.now() };
    const s1 = await ghPutJson(acctPath, updated, `account: reset password ${acct.data.userId}`, acct.sha);
    if (s1 !== 200 && s1 !== 201) {
      return { ok: false, code: 'write_failed', reason: `改密碼失敗 (${s1})` };
    }

    // 標記 session 已消耗（best-effort；改密碼已成功，標記失敗不影響結果）。
    await ghPutJson(
      resetPath(params.token),
      { ...sess.data, consumedAt: Date.now() },
      `reset: consume ${acct.data.userId}`,
      sess.sha,
    ).catch(() => undefined);

    return { ok: true, data: { userId: acct.data.userId } };
  } catch (err) {
    console.error('[githubAuthAccounts] consumePasswordResetAndSet error:', err instanceof Error ? err.message : err);
    return { ok: false, code: 'store_error', reason: '帳戶資料庫錯誤' };
  }
}

/**
 * OAuth 自動建帳 — GitHub-only 架構下 OAuth 已停用（無 UI 入口）。保留簽名讓
 * routes/auth.ts 的 OAuth handler 仍可編譯，呼叫一律回 no_store（優雅失敗）。
 */
export async function ensureAccountByOAuthEmail(_params: {
  provider:           'discord' | 'line' | 'google';
  providerExternalId: string;
  email:              string;
  displayName:        string;
}): Promise<AccountOpResult<{ account: AccountRecord; created: boolean }>> {
  return { ok: false, code: 'no_store', reason: 'OAuth 已停用（GitHub-only）' };
}
