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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-phase-c';

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

// routes/auth.ts now reads/writes accounts via githubAuthAccounts (GitHub-only
// architecture), not firestoreAuthAccounts — mock an in-memory equivalent so
// these HTTP-level tests don't need a real GitHub token/repo. vi.hoisted lets
// the test body below reach the same store the mock factory closes over.
const ghAccounts = vi.hoisted(() => {
  interface MockAccount {
    userId:       string;
    accountName:  string;
    primaryEmail: string;
    displayName:  string;
    passwordHash: string;
    emails:       string[];
  }
  interface MockResetSession {
    emailLower: string;
    expiresAt:  number;
    consumedAt?: number;
  }

  let accounts: Map<string, MockAccount> = new Map();
  let resetSessions: Map<string, MockResetSession> = new Map();
  let nextId = 1;

  const normalizeEmail = (email: string) => email.trim().toLowerCase();
  const toRecord = (a: MockAccount) => ({
    userId:       a.userId,
    accountName:  a.accountName,
    primaryEmail: a.primaryEmail,
    emails:       a.emails,
    emailsVerified: [] as string[],
    displayName:  a.displayName,
    photoUrl:     null as string | null,
  });

  return {
    PASSWORD_RESET_TTL_MS: 30 * 60 * 1000,
    reset() {
      accounts = new Map();
      resetSessions = new Map();
      nextId = 1;
    },
    async loginOrRegister(params: { email: string; password: string }) {
      const emailLower = normalizeEmail(params.email);
      const existing = accounts.get(emailLower);
      if (existing) {
        if (existing.passwordHash !== params.password) {
          return { ok: false, code: 'bad_credentials', reason: '密碼錯誤' };
        }
        return {
          ok: true,
          data: { userId: existing.userId, accountName: existing.accountName, primaryEmail: existing.primaryEmail, displayName: existing.displayName, created: false },
        };
      }
      const userId  = `mock-user-${nextId++}`;
      const display = params.email.split('@')[0];
      accounts.set(emailLower, {
        userId, accountName: display, primaryEmail: params.email.trim(), displayName: display,
        passwordHash: params.password, emails: [params.email.trim()],
      });
      return {
        ok: true,
        data: { userId, accountName: display, primaryEmail: params.email.trim(), displayName: display, created: true },
      };
    },
    async findAccountByEmail(email: string) {
      const found = accounts.get(normalizeEmail(email));
      return found ? toRecord(found) : null;
    },
    async ensureAccountByOAuthEmail() {
      return { ok: false, code: 'no_store', reason: 'OAuth 已停用（GitHub-only）' };
    },
    async createPasswordResetSession(params: { userId: string; accountName: string; email: string }) {
      const token     = `mock-token-${nextId++}-${Math.random().toString(36).slice(2)}`;
      const expiresAt = Date.now() + 30 * 60 * 1000;
      resetSessions.set(token, { emailLower: normalizeEmail(params.email), expiresAt });
      return { ok: true, data: { token, expiresAt } };
    },
    async consumePasswordResetAndSet(params: { token: string; newPassword: string }) {
      const sess = resetSessions.get(params.token);
      if (!sess) return { ok: false, code: 'token_invalid', reason: '連結失效' };
      if (sess.consumedAt) return { ok: false, code: 'token_used', reason: '連結已使用過' };
      if (sess.expiresAt < Date.now()) return { ok: false, code: 'token_expired', reason: '連結已過期' };
      const acct = accounts.get(sess.emailLower);
      if (!acct) return { ok: false, code: 'error', reason: '帳號不存在' };
      acct.passwordHash = params.newPassword;
      sess.consumedAt = Date.now();
      return { ok: true, data: { userId: acct.userId } };
    },
  };
});

vi.mock('../services/githubAuthAccounts', () => ghAccounts);

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
    ghAccounts.reset();
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
    expect(await ghAccounts.findAccountByEmail('new@test.com')).toBeTruthy();
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
    ghAccounts.reset();
    // Pre-seed a Bob account via the (mocked) GitHub accounts store.
    await ghAccounts.loginOrRegister({ email: 'bob@ex.com', password: 'InitialPw01' });
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
    expect(sentMails.length).toBe(1);
    const token = new URL(sentMails[0].text).searchParams.get('token');
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
