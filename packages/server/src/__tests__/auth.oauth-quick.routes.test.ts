/**
 * HTTP-level tests for OAuth-primary login + auto-register (2026-04-23 Edward)
 *
 * Edward 原話（2026-04-23 23:00）：
 *   「如果綁 google => email 直接填入 gmail 信箱。
 *    簡單說 email 綁定是 for 同時沒有 google/line/dc 的」。
 *
 * 新語意：OAuth 成為主登入路徑。不在庫的 email → 自動建新帳號；已在庫 → 登入 +
 * 補綁 provider externalId。舊 `provider_not_linked` 分支改成 auto-register；僅在
 * provider 沒給 email 時回 `provider_no_email` / 後端 store 失敗時 `oauth_autoregister_failed`。
 *
 * 覆蓋：
 *   - POST /auth/oauth/login/google 200（email 已在庫 → 登入）
 *   - POST /auth/oauth/login/google 201（email 不在庫 → 自動建帳）
 *   - POST /auth/oauth/login/google 400 provider_no_email（id_token 沒帶 email）
 *   - GET  /auth/oauth/login/discord 302 到 Discord OAuth（state mode=quickLogin）
 *   - GET  /auth/discord/callback quickLogin + email 已在庫 → JWT + created=0
 *   - GET  /auth/discord/callback quickLogin + email 不在庫 → JWT + oauth_created=1
 *   - GET  /auth/line/callback quickLogin + email 已在庫 → JWT
 *   - GET  /auth/line/callback quickLogin + email 不在庫 → JWT + oauth_created=1
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const realFetch = global.fetch as any;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = vi.fn(async (url: string, _opts?: unknown) => {
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
let loginOrRegister: (params: { email: string; password: string }) => Promise<unknown>;

beforeAll(async () => {
  const { authRouter } = await import('../routes/auth');
  app = express();
  app.use(express.json());
  app.use('/auth', authRouter);

  const fa = await import('../services/firestoreAuthAccounts');
  loginOrRegister = fa.loginOrRegister;
});

function resetStore(): void {
  store = {
    auth_users:              new Map(),
    oauth_sessions:          new Map(),
    password_reset_sessions: new Map(),
    email_verifications:     new Map(),
  };
}

describe('POST /auth/oauth/login/google — quick-login', () => {
  beforeEach(() => {
    resetStore();
    verifyIdTokenMock.mockReset();
  });

  it('returns 200 + JWT when the Firebase-verified email is already registered', async () => {
    // 1. 前置：email-only 註冊一顆帳號
    await loginOrRegister({ email: 'mapped@example.com', password: 'Abc12345' });
    expect(store.auth_users.size).toBe(1);

    // 2. server 驗 idToken 會拿到 email='mapped@example.com'
    verifyIdTokenMock.mockResolvedValueOnce({ uid: 'g-uid', email: 'mapped@example.com' });

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'fake-firebase-id-token' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.provider).toBe('google');
    expect(res.body.user.primaryEmail).toBe('mapped@example.com');
    expect(res.body.user.isNew).toBe(false);
    // 既有 row 沒多開新 doc
    expect(store.auth_users.size).toBe(1);
  });

  it('returns 201 + JWT and auto-registers when the Google email has never registered', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({
      uid:   'g-uid-new',
      email: 'brand-new@example.com',
      name:  'Brand New',
    });

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'fake-firebase-id-token' });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.provider).toBe('google');
    expect(res.body.user.primaryEmail).toBe('brand-new@example.com');
    expect(res.body.user.isNew).toBe(true);
    // Firestore 多了一顆新帳號
    expect(store.auth_users.size).toBe(1);
    const row = Array.from(store.auth_users.values())[0] as Record<string, unknown>;
    expect(row.primaryEmail).toBe('brand-new@example.com');
    expect(row.firebase_uid).toBe('g-uid-new');
    expect(row.oauthOnly).toBe(true);
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

  it('redirects back with oauth_token when Discord email matches a registered auth_user', async () => {
    // Arrange：email 先註冊
    await loginOrRegister({ email: 'mapped@example.com', password: 'Abc12345' });

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
    expect(loc.searchParams.get('oauth_token')).toBeTruthy();
    expect(loc.searchParams.get('provider')).toBe('discord');
    expect(loc.searchParams.get('quick_login')).toBe('1');
  });

  it('auto-registers + redirects with oauth_token when Discord email is unregistered', async () => {
    discordEmail = 'unknown-on-site@example.com';

    const initRes = await request(app).get('/auth/oauth/login/discord').redirects(0);
    const url = new URL(initRes.headers.location);
    const state = url.searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/discord/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    // 不再回 provider_not_linked — 改成 auto-register + 發 JWT
    expect(loc.searchParams.get('auth_error')).toBeNull();
    expect(loc.searchParams.get('oauth_token')).toBeTruthy();
    expect(loc.searchParams.get('provider')).toBe('discord');
    expect(loc.searchParams.get('quick_login')).toBe('1');
    expect(loc.searchParams.get('oauth_created')).toBe('1');
    // Firestore 多了一顆新帳號
    expect(store.auth_users.size).toBe(1);
    const row = Array.from(store.auth_users.values())[0] as Record<string, unknown>;
    expect(row.primaryEmail).toBe('unknown-on-site@example.com');
    expect(row.discord_id).toBe('123456789');
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

  it('redirects with oauth_token when LINE id_token email matches a registered auth_user', async () => {
    await loginOrRegister({ email: 'line-mapped@example.com', password: 'Abc12345' });

    const initRes = await request(app).get('/auth/oauth/login/line').redirects(0);
    const state = new URL(initRes.headers.location).searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/line/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.searchParams.get('oauth_token')).toBeTruthy();
    expect(loc.searchParams.get('provider')).toBe('line');
    expect(loc.searchParams.get('quick_login')).toBe('1');
  });

  it('auto-registers + redirects with oauth_token when LINE email is unregistered', async () => {
    // 沒 loginOrRegister → email 不存在 → auto-register
    const initRes = await request(app).get('/auth/oauth/login/line').redirects(0);
    const state = new URL(initRes.headers.location).searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/line/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.searchParams.get('auth_error')).toBeNull();
    expect(loc.searchParams.get('oauth_token')).toBeTruthy();
    expect(loc.searchParams.get('provider')).toBe('line');
    expect(loc.searchParams.get('quick_login')).toBe('1');
    expect(loc.searchParams.get('oauth_created')).toBe('1');
    // 新 auth_users row 有 email + line_id
    expect(store.auth_users.size).toBe(1);
    const row = Array.from(store.auth_users.values())[0] as Record<string, unknown>;
    expect(row.primaryEmail).toBe('line-mapped@example.com');
    expect(row.line_id).toBe('LINE-UID-789');
  });
});
