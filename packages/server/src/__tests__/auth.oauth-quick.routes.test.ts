/**
 * HTTP-level tests for OAuth quick-login (2026-04-23 Edward #98)
 *
 * Edward 原話：「能不能登入頁面綁 google/line/dc => 有的話就直接登入」。
 *
 * 覆蓋：
 *   - POST /auth/oauth/login/google 200（email 已綁到 email-only auth_users row）
 *   - POST /auth/oauth/login/google 401 `provider_not_linked`（email 沒綁）
 *   - GET  /auth/oauth/login/discord 302 到 Discord OAuth（state mode=quickLogin 寫入）
 *   - GET  /auth/discord/callback 有 quickLogin mode + email 命中 → 302 回前端帶 JWT
 *   - GET  /auth/discord/callback quickLogin mode + email 沒綁 → 302 provider_not_linked
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
  });

  it('returns 401 provider_not_linked when the email has never registered', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({ uid: 'g-uid', email: 'unknown@example.com' });

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'fake-firebase-id-token' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('provider_not_linked');
    // 錯誤訊息含「請先用 email 登入」字樣，前端才能清楚引導
    expect(String(res.body.error)).toMatch(/email/);
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

  // 2026-04-24 regression：quick-login 成功必須把 firebase_uid 綁到 auth_users row
  // 上，否則系統設定頁「綁定 Google」會永遠顯示未綁定（Edward bug report）。
  it('backfills firebase_uid onto auth_users row so linked providers reflect the bind', async () => {
    await loginOrRegister({ email: 'mapped@example.com', password: 'Abc12345' });
    verifyIdTokenMock.mockResolvedValueOnce({ uid: 'firebase-uid-xyz', email: 'mapped@example.com' });

    const supaModule = await import('../services/supabase');
    const linkSpy = supaModule.linkProviderIdentity as unknown as { mock?: { calls: unknown[][] } };
    const findSpy = supaModule.findUserIdByProviderIdentity as unknown as { mockResolvedValueOnce?: (v: string | null) => void };
    findSpy.mockResolvedValueOnce?.(null); // externalId not yet bound

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'fake-firebase-id-token' });

    expect(res.status).toBe(200);
    // linkProviderIdentity 必須帶 provider='google' + firebaseUid 被呼叫
    const calls = linkSpy.mock?.calls ?? [];
    const googleCall = calls.find((c) => c[1] === 'google' && c[2] === 'firebase-uid-xyz');
    expect(googleCall).toBeDefined();
  });

  it('does not overwrite provider binding when firebase_uid is already owned by a different user', async () => {
    await loginOrRegister({ email: 'mapped@example.com', password: 'Abc12345' });
    verifyIdTokenMock.mockResolvedValueOnce({ uid: 'firebase-uid-already-bound', email: 'mapped@example.com' });

    const supaModule = await import('../services/supabase');
    const linkSpy = supaModule.linkProviderIdentity as unknown as { mock?: { calls: unknown[][] } };
    const findSpy = supaModule.findUserIdByProviderIdentity as unknown as { mockResolvedValueOnce?: (v: string | null) => void };
    // firebase-uid-already-bound 已屬於另一顆 row
    findSpy.mockResolvedValueOnce?.('some-other-user-id');

    const initialCallsCount = linkSpy.mock?.calls.filter((c) => c[1] === 'google' && c[2] === 'firebase-uid-already-bound').length ?? 0;

    const res = await request(app)
      .post('/auth/oauth/login/google')
      .send({ idToken: 'fake-firebase-id-token' });

    // quick-login 仍成功（email 對上就是本人），但 linkProviderIdentity 不被叫來覆寫別人
    expect(res.status).toBe(200);
    const afterCallsCount = linkSpy.mock?.calls.filter((c) => c[1] === 'google' && c[2] === 'firebase-uid-already-bound').length ?? 0;
    expect(afterCallsCount).toBe(initialCallsCount);
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

  it('redirects with auth_error=provider_not_linked when Discord email is unregistered', async () => {
    discordEmail = 'unknown-on-site@example.com';

    const initRes = await request(app).get('/auth/oauth/login/discord').redirects(0);
    const url = new URL(initRes.headers.location);
    const state = url.searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/discord/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.searchParams.get('auth_error')).toBe('provider_not_linked');
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

  it('redirects with provider_not_linked when LINE email is unregistered', async () => {
    // 沒 loginOrRegister → email 不存在
    const initRes = await request(app).get('/auth/oauth/login/line').redirects(0);
    const state = new URL(initRes.headers.location).searchParams.get('state') as string;

    const cbRes = await request(app)
      .get(`/auth/line/callback?code=fake-code&state=${state}`)
      .redirects(0);

    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.location);
    expect(loc.searchParams.get('auth_error')).toBe('provider_not_linked');
    expect(loc.searchParams.get('provider')).toBe('line');
  });
});
