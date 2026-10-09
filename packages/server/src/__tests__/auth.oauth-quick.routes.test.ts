/**
 * HTTP-level tests for the OAuth quick-login endpoints.
 *
 * 語意演變：
 *   - 2026-04-23 Edward：OAuth 為主登入路徑，email 不在庫 → 自動建帳（Firestore）。
 *   - 2026-06-25 Edward（027db19）：「註冊登入不用留 Line/DC/gmail，純粹以信箱+密碼
 *     （註冊 or 登入）即可」— LoginPage 移除 OAuth 入口。
 *   - 2026-06-26 Edward（9c2ba13）：「全改 GitHub-only」— routes/auth.ts 帳號庫改為
 *     githubAuthAccounts，其 ensureAccountByOAuthEmail 刻意一律回 no_store
 *     （「OAuth 已停用（GitHub-only）」）；1327048 的 auth.routes.test mock 亦同。
 *
 * 現行語意（本檔驗證的對象）：OAuth quick-login 不登入、也不自動建帳。不論 email
 * 是否已註冊，provider 驗證通過後一律失敗 — Google 回 500 `oauth_autoregister_failed`、
 * Discord / LINE callback 導回 `auth_error=oauth_autoregister_failed`；不發 JWT、
 * 不建立也不改寫任何帳號（GitHub 帳號庫與舊 Firestore auth_users 皆然）。
 * 輸入錯誤（missing_fields / bad_id_token / provider_no_email）與 quickLogin state
 * 建立維持原行為。
 *
 * 覆蓋：
 *   - POST /auth/oauth/login/google 500 oauth_autoregister_failed（email 已註冊 / 未註冊）
 *   - POST /auth/oauth/login/google 400 provider_no_email / bad_id_token / missing_fields
 *   - GET  /auth/oauth/login/discord 302 到 Discord OAuth（state mode=quickLogin）
 *   - GET  /auth/discord/callback quickLogin → auth_error=oauth_autoregister_failed（已註冊 / 未註冊）
 *   - GET  /auth/discord/callback quickLogin 無 email → auth_error=provider_no_email
 *   - GET  /auth/line/callback quickLogin → auth_error=oauth_autoregister_failed（已註冊 / 未註冊）
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── Shared in-memory Firestore stub (cloned from auth.routes.test) ─

type Row = Record<string, unknown>;
type Collections = Record<string, Map<string, Row>>;
let store: Collections = {
  auth_users:              new Map(),
  oauth_sessions:          new Map(),
  password_reset_sessions: new Map(),
  email_verifications:     new Map(),
};

interface WhereClause { col: string; op: string; val: unknown }

function makeQuery(col: Map<string, Row>, clauses: WhereClause[] = []) {
  const matches = (row: Row): boolean =>
    clauses.every((c) => {
      const fieldVal = row[c.col];
      if (c.op === 'array-contains') return Array.isArray(fieldVal) && fieldVal.includes(c.val);
      return fieldVal === c.val;
    });
  return {
    where(col2: string, op: string, val: unknown) {
      return makeQuery(col, [...clauses, { col: col2, op, val }]);
    },
    limit(_n: number) { return this; },
    async get() {
      const entries = Array.from(col.entries()).filter(([, row]) => matches(row));
      return {
        empty: entries.length === 0,
        docs: entries.map(([id, row]) => ({ id, ref: makeDocRef(col, id), data: () => row })),
      };
    },
  };
}
function makeDocRef(col: Map<string, Row>, id: string) {
  return {
    async get() { const row = col.get(id); return { exists: row !== undefined, data: () => row }; },
    async set(patch: Row) { col.set(id, { ...patch }); },
    async update(patch: Row) { const cur = col.get(id) ?? {}; col.set(id, { ...cur, ...patch }); },
    async delete() { col.delete(id); },
  };
}
function makeCollectionRef(name: string) {
  const col = store[name] ?? (store[name] = new Map<string, Row>());
  return {
    doc(id: string) { return makeDocRef(col, id); },
    where(c: string, op: string, val: unknown) { return makeQuery(col, [{ col: c, op, val }]); },
  };
}
function makeFirestoreStub() {
  return {
    collection: (name: string) => makeCollectionRef(name),
    async runTransaction<T>(fn: (tx: {
      get: (target: unknown) => Promise<unknown>;
      set:    (ref: { set:    (p: Row) => Promise<void> }, patch: Row) => void;
      update: (ref: { update: (p: Row) => Promise<void> }, patch: Row) => void;
      delete: (ref: { delete: () => Promise<void> }) => void;
    }) => Promise<T>): Promise<T> {
      const ops: Array<() => Promise<void>> = [];
      const tx = {
        get: async (target: unknown) => {
          if (target && typeof (target as { get: () => Promise<unknown> }).get === 'function') {
            return (target as { get: () => Promise<unknown> }).get();
          }
          return { empty: true, docs: [] };
        },
        set:    (ref: { set:    (p: Row) => Promise<void> }, patch: Row) => { ops.push(() => ref.set(patch)); },
        update: (ref: { update: (p: Row) => Promise<void> }, patch: Row) => { ops.push(() => ref.update(patch)); },
        delete: (ref: { delete: () => Promise<void> }) => { ops.push(() => ref.delete()); },
      };
      const result = await fn(tx);
      for (const op of ops) await op();
      return result;
    },
  };
}

// ── Module mocks ────────────────────────────────────────────────

process.env.JWT_SECRET          = process.env.JWT_SECRET          || 'test-secret-for-oauth-quick';
process.env.DISCORD_CLIENT_ID   = 'test-discord-client';
process.env.DISCORD_CLIENT_SECRET = 'test-discord-secret';
process.env.DISCORD_REDIRECT_URI  = 'http://localhost:3001/auth/discord/callback';
process.env.LINE_CHANNEL_ID     = 'test-line-client';
process.env.LINE_CHANNEL_SECRET = 'test-line-secret';
process.env.LINE_REDIRECT_URI   = 'http://localhost:3001/auth/line/callback';
process.env.FRONTEND_URL        = 'https://test-frontend.example.com';

// GitHub 帳號庫（githubAuthAccounts 在 import 時讀取）。API base 指向不可解析的
// 測試網域，請求一律由下方 fetch mock 的假 Contents API 接走，不會打到真 GitHub。
const GH_API  = 'https://api.github.test';
const GH_REPO = 'test-owner/test-accounts';
process.env.GITHUB_ACCOUNTS_TOKEN  = 'test-gh-token';
process.env.GITHUB_ACCOUNTS_REPO   = GH_REPO;
process.env.GITHUB_ACCOUNTS_BRANCH = 'main';
process.env.GITHUB_API_BASE        = GH_API;

const verifyIdTokenMock = vi.fn();

vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => true,
  getAdminFirestore:    () => makeFirestoreStub(),
  verifyIdToken:        verifyIdTokenMock,
  initializeFirebase:   vi.fn(),
}));

// Provide a minimal supabase mock with the real OAuth session API signatures
// (firestoreAccounts is used primarily since isFirestoreReady=true).
vi.mock('../services/supabase', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/firestoreAccounts');
  return {
    upsertUser:                     vi.fn().mockResolvedValue('stub-id'),
    createOAuthSession:             (actual as { createOAuthSession: unknown }).createOAuthSession,
    consumeOAuthSession:            (actual as { consumeOAuthSession: unknown }).consumeOAuthSession,
    findUserIdByProviderIdentity:   vi.fn().mockResolvedValue(null),
    linkProviderIdentity:           vi.fn().mockResolvedValue(false),
    mergeUserAccounts:              vi.fn().mockResolvedValue(false),
    absorbGuestIntoUser:            vi.fn().mockResolvedValue(false),
    ensureUserForProviderIdentity:  vi.fn().mockResolvedValue(null),
    ensureSupabaseUserForFirebase:  vi.fn().mockResolvedValue(null),
    isSupabaseReady:                () => false,
  };
});

vi.mock('../services/mailer', () => ({
  sendPasswordResetEmail:    vi.fn(async () => ({ ok: true, messageId: 'stub' })),
  sendEmailVerificationEmail: vi.fn(),
  sendMail:                   vi.fn(),
  isMailerReady:              vi.fn().mockResolvedValue(true),
  __setMailerForTest:         vi.fn(),
}));

// ── Global fetch mock for provider APIs ────────────────────────

// Discord: one happy path + knob to change email / missing email
let discordEmail: string | undefined = 'mapped@example.com';

// GitHub Contents API 假 repo：path → { base64 content, sha }。githubAuthAccounts
// 全程跑正式實作（含 ensureAccountByOAuthEmail），只有網路層換成這個。
let ghRepo = new Map<string, { content: string; sha: string }>();
let ghShaSeq = 0;
const GH_CONTENTS_PREFIX = `${GH_API}/repos/${GH_REPO}/contents/`;

function fakeGitHubContents(url: string, opts?: { method?: string; body?: string }): Response {
  const path = decodeURI(url.slice(GH_CONTENTS_PREFIX.length).split('?')[0]);
  const file = ghRepo.get(path);
  if ((opts?.method ?? 'GET') === 'GET') {
    return file
      ? { ok: true,  status: 200, json: async () => ({ content: file.content, sha: file.sha }) } as Response
      : { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) } as Response;
  }
  // PUT：對齊 GitHub — 建檔撞既有路徑（沒帶 sha）回 422、sha 不符回 409。
  const body = JSON.parse(opts?.body ?? '{}') as { content: string; sha?: string };
  if (file && !body.sha)             return { ok: false, status: 422, json: async () => ({}) } as Response;
  if (file && body.sha !== file.sha) return { ok: false, status: 409, json: async () => ({}) } as Response;
  ghRepo.set(path, { content: body.content, sha: `sha-${++ghShaSeq}` });
  return { ok: true, status: file ? 200 : 201, json: async () => ({}) } as Response;
}

/** 假 repo 每個檔案的 sha；前後比對 = 證明沒有任何帳號檔被建立或改寫。 */
function ghRepoShas(): Record<string, string> {
  return Object.fromEntries(Array.from(ghRepo.entries(), ([path, file]) => [path, file.sha]));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const realFetch = global.fetch as any;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = vi.fn(async (url: string, opts?: unknown) => {
    if (url.startsWith(GH_CONTENTS_PREFIX)) {
      return fakeGitHubContents(url, opts as { method?: string; body?: string } | undefined);
    }
    if (url === 'https://discord.com/api/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'fake-access' }) } as Response;
    }
    if (url === 'https://discord.com/api/users/@me') {
      return {
        ok: true,
        json: async () => ({
          id:          '123456789',
          username:    'discord_user',
          global_name: 'Discord User',
          email:       discordEmail,
        }),
      } as Response;
    }
    if (url === 'https://api.line.me/oauth2/v2.1/token') {
      return {
        ok: true,
        json: async () => ({
          access_token: 'fake-line-access',
          // id_token 是 base64 payload：header.payload.signature
          id_token:     [
            'eyJhbGciOiJIUzI1NiJ9',
            Buffer.from(JSON.stringify({ email: 'line-mapped@example.com' })).toString('base64'),
            'sig',
          ].join('.'),
        }),
      } as Response;
    }
    if (url === 'https://api.line.me/v2/profile') {
      return {
        ok: true,
        json: async () => ({ userId: 'LINE-UID-789', displayName: 'Line User' }),
      } as Response;
    }
    return realFetch ? realFetch(url) : { ok: false, json: async () => ({}) } as Response;
  });
});

// ── App factory ─────────────────────────────────────────────────

let app: Express;
let loginOrRegister: (params: { email: string; password: string }) => Promise<{ ok: boolean }>;

beforeAll(async () => {
  const { authRouter } = await import('../routes/auth');
  app = express();
  app.use(express.json());
  app.use('/auth', authRouter);

  // 「已註冊」前置條件走 /auth/login 現行使用的帳號庫（9c2ba13 起為 githubAuthAccounts）。
  const ga = await import('../services/githubAuthAccounts');
  loginOrRegister = ga.loginOrRegister;
});

function resetStore(): void {
  store = {
    auth_users:              new Map(),
    oauth_sessions:          new Map(),
    password_reset_sessions: new Map(),
    email_verifications:     new Map(),
  };
  ghRepo = new Map();
}

describe('POST /auth/oauth/login/google — quick-login', () => {
  beforeEach(() => {
    resetStore();
    verifyIdTokenMock.mockReset();
  });

  it('returns 500 oauth_autoregister_failed with no JWT even when the Google email is already registered (OAuth disabled under GitHub-only)', async () => {
    // 1. 前置：email+密碼註冊一顆帳號（落在 GitHub 帳號庫）
    const reg = await loginOrRegister({ email: 'mapped@example.com', password: 'Abc12345' });
    expect(reg.ok).toBe(true);
    const shasBefore = ghRepoShas();
    expect(Object.keys(shasBefore).length).toBeGreaterThan(0);

    // 2. server 驗 idToken 會拿到 email='mapped@example.com'
    verifyIdTokenMock.mockResolvedValueOnce({ uid: 'g-uid', email: 'mapped@example.com' });

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'fake-firebase-id-token' });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('oauth_autoregister_failed');
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    // 既有帳號沒被登入、也沒被改寫；舊 Firestore auth_users 也沒被寫入
    expect(ghRepoShas()).toEqual(shasBefore);
    expect(store.auth_users.size).toBe(0);
  });

  it('returns 500 oauth_autoregister_failed and creates no account when the Google email has never registered (OAuth disabled under GitHub-only)', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      uid:   'g-uid-new',
      email: 'brand-new@example.com',
      name:  'Brand New',
    });

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'fake-firebase-id-token' });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('oauth_autoregister_failed');
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    // 不自動建帳：GitHub 帳號庫與舊 Firestore auth_users 都沒多出帳號
    expect(ghRepo.size).toBe(0);
    expect(store.auth_users.size).toBe(0);
  });

  it('returns 400 provider_no_email when Firebase id_token has no email claim', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({ uid: 'g-uid', email: undefined });

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'fake-firebase-id-token' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('provider_no_email');
  });

  it('returns 400 bad_id_token when verifyIdToken throws', async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error('invalid'));

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'bogus' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_id_token');
  });

  it('returns 400 missing_fields when idToken absent', async () => {
    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_fields');
  });
});

describe('GET /auth/oauth/login/discord — quick-login redirect', () => {
  beforeEach(() => {
    resetStore();
  });

  it('redirects to Discord OAuth authorize with state stored as quickLogin mode', async () => {
    const res = await request(app).get('/auth/oauth/login/discord').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://discord.com/api/oauth2/authorize');
    // state 寫入 Firestore stub，mode=quickLogin
    expect(store.oauth_sessions.size).toBe(1);
    const entry = Array.from(store.oauth_sessions.values())[0];
    expect(entry.mode).toBe('quickLogin');
    expect(entry.provider).toBe('discord');
  });
});

describe('GET /auth/discord/callback — quick-login branch', () => {
  beforeEach(() => {
    resetStore();
    discordEmail = 'mapped@example.com';
  });

  it('redirects with auth_error=oauth_autoregister_failed and no oauth_token even when the Discord email is already registered', async () => {
    // Arrange：email 先註冊（GitHub 帳號庫）
    const reg = await loginOrRegister({ email: 'mapped@example.com', password: 'Abc12345' });
    expect(reg.ok).toBe(true);
    const shasBefore = ghRepoShas();

    // 建 quickLogin state
    const initRes = await request(app).get('/auth/oauth/login/discord').redirects(0);
    const url = new URL(initRes.headers.location);
    const state = url.searchParams.get('state') as string;

    // callback 回來
    const cbRes = await request(app)
      .get(`/auth/discord/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://test-frontend.example.com/');
    expect(loc.searchParams.get('auth_error')).toBe('oauth_autoregister_failed');
    expect(loc.searchParams.get('provider')).toBe('discord');
    expect(loc.searchParams.get('oauth_token')).toBeNull();
    expect(loc.searchParams.get('quick_login')).toBeNull();
    // 既有帳號沒被登入、也沒補綁 discord_id；舊 Firestore auth_users 也沒被寫入
    expect(ghRepoShas()).toEqual(shasBefore);
    expect(store.auth_users.size).toBe(0);
  });

  it('redirects with auth_error=oauth_autoregister_failed and creates no account when the Discord email is unregistered', async () => {
    discordEmail = 'unknown-on-site@example.com';

    const initRes = await request(app).get('/auth/oauth/login/discord').redirects(0);
    const url = new URL(initRes.headers.location);
    const state = url.searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/discord/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://test-frontend.example.com/');
    expect(loc.searchParams.get('auth_error')).toBe('oauth_autoregister_failed');
    expect(loc.searchParams.get('provider')).toBe('discord');
    expect(loc.searchParams.get('oauth_token')).toBeNull();
    expect(loc.searchParams.get('quick_login')).toBeNull();
    expect(loc.searchParams.get('oauth_created')).toBeNull();
    // 不自動建帳
    expect(ghRepo.size).toBe(0);
    expect(store.auth_users.size).toBe(0);
  });

  it('redirects with auth_error=provider_no_email when Discord OAuth returns no email', async () => {
    discordEmail = undefined;

    const initRes = await request(app).get('/auth/oauth/login/discord').redirects(0);
    const url = new URL(initRes.headers.location);
    const state = url.searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/discord/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.searchParams.get('auth_error')).toBe('provider_no_email');
    expect(loc.searchParams.get('provider')).toBe('discord');
  });
});

describe('GET /auth/line/callback — quick-login branch', () => {
  beforeEach(() => {
    resetStore();
  });

  it('redirects with auth_error=oauth_autoregister_failed and no oauth_token even when the LINE id_token email is already registered', async () => {
    const reg = await loginOrRegister({ email: 'line-mapped@example.com', password: 'Abc12345' });
    expect(reg.ok).toBe(true);
    const shasBefore = ghRepoShas();

    const initRes = await request(app).get('/auth/oauth/login/line').redirects(0);
    const state = new URL(initRes.headers.location).searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/line/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://test-frontend.example.com/');
    expect(loc.searchParams.get('auth_error')).toBe('oauth_autoregister_failed');
    expect(loc.searchParams.get('provider')).toBe('line');
    expect(loc.searchParams.get('oauth_token')).toBeNull();
    expect(loc.searchParams.get('quick_login')).toBeNull();
    // 既有帳號沒被登入、也沒補綁 line_id；舊 Firestore auth_users 也沒被寫入
    expect(ghRepoShas()).toEqual(shasBefore);
    expect(store.auth_users.size).toBe(0);
  });

  it('redirects with auth_error=oauth_autoregister_failed and creates no account when the LINE email is unregistered', async () => {
    // 沒 loginOrRegister → email 不存在；GitHub-only 下也不自動建帳
    const initRes = await request(app).get('/auth/oauth/login/line').redirects(0);
    const state = new URL(initRes.headers.location).searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/line/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://test-frontend.example.com/');
    expect(loc.searchParams.get('auth_error')).toBe('oauth_autoregister_failed');
    expect(loc.searchParams.get('provider')).toBe('line');
    expect(loc.searchParams.get('oauth_token')).toBeNull();
    expect(loc.searchParams.get('quick_login')).toBeNull();
    expect(loc.searchParams.get('oauth_created')).toBeNull();
    // 不自動建帳
    expect(ghRepo.size).toBe(0);
    expect(store.auth_users.size).toBe(0);
  });
});
