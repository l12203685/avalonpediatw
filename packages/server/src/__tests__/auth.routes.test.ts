/**
 * Phase C — HTTP-level tests for /auth/login (email-only login-or-register)
 * + /auth/register alias + /auth/forgot-password + /auth/reset-password.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── Shared in-memory Firestore stub ─────────────────────────────

type Row = Record<string, unknown>;
type Collections = Record<string, Map<string, Row>>;
let store: Collections = {
  auth_users:              new Map(),
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

process.env.JWT_SECRET           = process.env.JWT_SECRET           || 'test-secret-for-phase-c';
// Bind-auth fix tests need OAuth client envs set before router import.
process.env.DISCORD_CLIENT_ID    = process.env.DISCORD_CLIENT_ID    || 'test-discord-id';
process.env.DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost/auth/discord/callback';
process.env.LINE_CHANNEL_ID      = process.env.LINE_CHANNEL_ID      || 'test-line-id';
process.env.LINE_REDIRECT_URI    = process.env.LINE_REDIRECT_URI    || 'http://localhost/auth/line/callback';

vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => true,
  getAdminFirestore:    () => makeFirestoreStub(),
  verifyIdToken:        vi.fn(),
  initializeFirebase:   vi.fn(),
}));

vi.mock('../services/supabase', () => ({
  upsertUser:                     vi.fn().mockResolvedValue('stub-id'),
  createOAuthSession:             vi.fn(),
  consumeOAuthSession:            vi.fn().mockResolvedValue(null),
  findUserIdByProviderIdentity:   vi.fn().mockResolvedValue(null),
  linkProviderIdentity:           vi.fn().mockResolvedValue(false),
  mergeUserAccounts:              vi.fn().mockResolvedValue(false),
  absorbGuestIntoUser:            vi.fn().mockResolvedValue(false),
  ensureUserForProviderIdentity:  vi.fn().mockResolvedValue(null),
  ensureSupabaseUserForFirebase:  vi.fn().mockResolvedValue(null),
  isSupabaseReady:                () => false,
}));

const sentMails: Array<{ to: string; subject: string; text: string }> = [];
vi.mock('../services/mailer', () => ({
  sendPasswordResetEmail: vi.fn(async (to: string, accountName: string, url: string) => {
    sentMails.push({ to, subject: `reset for ${accountName}`, text: url });
    return { ok: true, messageId: 'stub' };
  }),
  sendEmailVerificationEmail: vi.fn(),
  sendMail:                   vi.fn(),
  isMailerReady:              vi.fn().mockResolvedValue(true),
  __setMailerForTest:         vi.fn(),
}));

// ── App factory ─────────────────────────────────────────────────

let app: Express;

beforeAll(async () => {
  const { authRouter } = await import('../routes/auth');
  app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
});

describe('POST /auth/login — email-only login/register', () => {
  beforeEach(() => {
    store = { auth_users: new Map(), password_reset_sessions: new Map(), email_verifications: new Map() };
    sentMails.length = 0;
  });

  it('creates a new account when email is unknown (201)', async () => {
    const res = await request(app).post('/auth/login').send({
      email: 'new@test.com', password: 'Abc12345',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.primaryEmail).toBe('new@test.com');
    expect(res.body.user.provider).toBe('password');
    expect(res.body.user.isNew).toBe(true);
    expect(store.auth_users.size).toBe(1);
  });

  it('logs in with correct password when email exists (200)', async () => {
    await request(app).post('/auth/login').send({
      email: 'new@test.com', password: 'Abc12345',
    });
    const res = await request(app).post('/auth/login').send({
      email: 'new@test.com', password: 'Abc12345',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.isNew).toBe(false);
  });

  it('returns 401 on wrong password for existing email', async () => {
    await request(app).post('/auth/login').send({
      email: 'new@test.com', password: 'Abc12345',
    });
    const res = await request(app).post('/auth/login').send({
      email: 'new@test.com', password: 'wrongpw1',
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('bad_credentials');
  });

  it('returns 400 on weak password', async () => {
    const res = await request(app).post('/auth/login').send({
      email: 'new@test.com', password: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBeTruthy();
  });

  it('returns 400 on invalid email format', async () => {
    const res = await request(app).post('/auth/login').send({
      email: 'not-an-email', password: 'Abc12345',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on missing fields', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'new@test.com' });
    expect(res.status).toBe(400);
  });

  it('/auth/register alias behaves identically', async () => {
    const res = await request(app).post('/auth/register').send({
      email: 'alias@test.com', password: 'Abc12345',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.isNew).toBe(true);
  });
});

describe('POST /auth/forgot-password + POST /auth/reset-password', () => {
  beforeEach(async () => {
    store = { auth_users: new Map(), password_reset_sessions: new Map(), email_verifications: new Map() };
    sentMails.length = 0;
    // Pre-seed a Bob account via loginOrRegister
    const { loginOrRegister } = await import('../services/firestoreAuthAccounts');
    await loginOrRegister({ email: 'bob@ex.com', password: 'InitialPw01' });
  });

  it('returns 202 and sends an email on match', async () => {
    const res = await request(app).post('/auth/forgot-password').send({
      email: 'bob@ex.com',
    });
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    await new Promise(r => setTimeout(r, 10));
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toBe('bob@ex.com');
  });

  it('returns 202 on miss but sends no email (opaque)', async () => {
    const res = await request(app).post('/auth/forgot-password').send({
      email: 'unknown@ex.com',
    });
    expect(res.status).toBe(202);
    await new Promise(r => setTimeout(r, 10));
    expect(sentMails.length).toBe(0);
  });

  it('reset-password with valid token changes password', async () => {
    await request(app).post('/auth/forgot-password').send({
      email: 'bob@ex.com',
    });
    await new Promise(r => setTimeout(r, 10));
    const token = Array.from(store.password_reset_sessions.keys())[0];
    expect(token).toBeTruthy();

    const res = await request(app).post('/auth/reset-password').send({
      token, newPassword: 'BrandNewPw1',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify new password works for login, old does not.
    const oldRes = await request(app).post('/auth/login').send({
      email: 'bob@ex.com', password: 'InitialPw01',
    });
    expect(oldRes.status).toBe(401);
    const newRes = await request(app).post('/auth/login').send({
      email: 'bob@ex.com', password: 'BrandNewPw1',
    });
    expect(newRes.status).toBe(200);
  });

  it('reset-password rejects invalid token', async () => {
    const res = await request(app).post('/auth/reset-password').send({
      token: 'bogus-token', newPassword: 'AnotherPw1',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('token_invalid');
  });

  it('reset-password rejects weak new password', async () => {
    const res = await request(app).post('/auth/reset-password').send({
      token: 'anything', newPassword: 'short',
    });
    expect(res.status).toBe(400);
  });
});

// ── 2026-04-24 bind-auth fix regression ─────────────────────────
// Previously /auth/link/discord and /auth/link/line only accepted custom backend
// JWT — Firebase ID tokens (from Google login) failed verify(token, JWT_SECRET)
// → 401 "Unauthorized — login first". Edward 原話 2026-04-24 07:25:
// 「discord 綁定後反而變成訪客 / line 綁定依然為 Unauthorized」。
//
// 修復後：parseBearerUserId 試自訂 JWT，失敗 fallback 到 Firebase Admin
// verifyIdToken，然後 ensureAccountByOAuthEmail(google, email) 拿 userId。

describe('GET /auth/link/{discord,line} — Firebase ID token acceptance (bind-auth fix)', () => {
  beforeEach(async () => {
    store = { auth_users: new Map(), password_reset_sessions: new Map(), email_verifications: new Map() };
    const { verifyIdToken } = await import('../services/firebase');
    const { createOAuthSession } = await import('../services/supabase');
    (verifyIdToken as ReturnType<typeof vi.fn>).mockReset();
    (createOAuthSession as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
  });

  it('rejects when no token (401)', async () => {
    const res = await request(app).get('/auth/link/discord');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Unauthorized/);
  });

  it('accepts Firebase ID token and resolves to Supabase userId via email (Discord)', async () => {
    const { verifyIdToken } = await import('../services/firebase');
    (verifyIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      uid:   'firebase-uid-edward',
      email: 'edward@example.com',
      name:  'Edward',
    });

    // Looks like a JWT (3 dot-separated segments) so parseBearerUserId tries verify first → fails → falls to Firebase path.
    const fakeFirebaseToken = 'eyJhbGc.eyJzdWI.signature';
    const res = await request(app).get(`/auth/link/discord?token=${fakeFirebaseToken}`);

    // 302 redirect to Discord OAuth — meaning bind path succeeded
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('discord.com/api/oauth2/authorize');

    // Ensured an auth_users row exists for edward@example.com
    expect(store.auth_users.size).toBe(1);
    const row = Array.from(store.auth_users.values())[0] as Record<string, unknown>;
    expect(row.primaryEmailLower).toBe('edward@example.com');
    expect(row.firebase_uid).toBe('firebase-uid-edward');
  });

  it('accepts Firebase ID token (LINE bind)', async () => {
    const { verifyIdToken } = await import('../services/firebase');
    (verifyIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      uid:   'firebase-uid-edward',
      email: 'edward@example.com',
      name:  'Edward',
    });
    const fakeFirebaseToken = 'eyJhbGc.eyJzdWI.signature';
    const res = await request(app).get(`/auth/link/line?token=${fakeFirebaseToken}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('access.line.me/oauth2');
  });

  it('rejects malformed Firebase token (401)', async () => {
    const { verifyIdToken } = await import('../services/firebase');
    (verifyIdToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('invalid signature'));
    const res = await request(app).get('/auth/link/line?token=bad.token.here');
    expect(res.status).toBe(401);
  });

  it('still accepts custom backend JWT (regression — guest)', async () => {
    const { sign } = await import('jsonwebtoken');
    const guestJwt = sign(
      { sub: 'guest-uuid-123', displayName: 'Guest_001', provider: 'guest' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    const res = await request(app).get(`/auth/link/discord?token=${guestJwt}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('discord.com/api/oauth2/authorize');
  });

  it('still accepts custom backend JWT (regression — discord login)', async () => {
    const { sign } = await import('jsonwebtoken');
    const discordJwt = sign(
      { sub: 'real-uuid-456', displayName: 'Edward', provider: 'discord' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    const res = await request(app).get(`/auth/link/line?token=${discordJwt}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('access.line.me/oauth2');
  });
});
