/**
 * Phase A — HTTP-level tests for /auth/register /login /forgot-password
 * /reset-password. Mounts only the authRouter with supertest + an in-memory
 * Firestore stub + stubbed mailer so nothing hits network.
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

// JWT secret must exist BEFORE importing auth route (router computes it at module load).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-phase-a';

vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => true,
  getAdminFirestore:    () => makeFirestoreStub(),
  verifyIdToken:        vi.fn(),
  initializeFirebase:   vi.fn(),
}));

// supabase service — we only need the exports auth.ts imports; stub to no-op.
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

// Capture mailer calls so we can assert on them.
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

describe('POST /auth/register', () => {
  beforeEach(() => {
    store = { auth_users: new Map(), password_reset_sessions: new Map(), email_verifications: new Map() };
    sentMails.length = 0;
  });

  it('creates a new account', async () => {
    const res = await request(app).post('/auth/register').send({
      accountName: 'Edward',
      password:    'Passw0rdAvalon',
      primaryEmail: 'ed@example.com',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.accountName).toBe('Edward');
    expect(res.body.user.provider).toBe('password');
    expect(store.auth_users.size).toBe(1);
  });

  it('rejects weak passwords', async () => {
    const res = await request(app).post('/auth/register').send({
      accountName: 'Edward', password: 'short', primaryEmail: 'e@ex.com',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBeTruthy();
  });

  it('rejects duplicate account names', async () => {
    await request(app).post('/auth/register').send({
      accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'a@ex.com',
    });
    const res = await request(app).post('/auth/register').send({
      accountName: 'EDWARD', password: 'Passw0rdAvalon', primaryEmail: 'b@ex.com',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account_taken');
  });

  it('rejects invalid emails', async () => {
    const res = await request(app).post('/auth/register').send({
      accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'not-an-email',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    store = { auth_users: new Map(), password_reset_sessions: new Map(), email_verifications: new Map() };
    sentMails.length = 0;
    const { registerAccount } = await import('../services/firestoreAuthAccounts');
    await registerAccount({ accountName: 'Alice', password: 'AvalonPw01', primaryEmail: 'alice@ex.com' });
  });

  it('succeeds with correct credentials', async () => {
    const res = await request(app).post('/auth/login').send({
      accountName: 'Alice', password: 'AvalonPw01',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.accountName).toBe('Alice');
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app).post('/auth/login').send({
      accountName: 'Alice', password: 'wrong-password01',
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('bad_credentials');
  });

  it('returns 401 on unknown account (opaque)', async () => {
    const res = await request(app).post('/auth/login').send({
      accountName: 'Nobody', password: 'AvalonPw01',
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('bad_credentials');
  });

  it('returns 400 on missing fields', async () => {
    const res = await request(app).post('/auth/login').send({ accountName: 'Alice' });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/forgot-password + POST /auth/reset-password', () => {
  beforeEach(async () => {
    store = { auth_users: new Map(), password_reset_sessions: new Map(), email_verifications: new Map() };
    sentMails.length = 0;
    const { registerAccount } = await import('../services/firestoreAuthAccounts');
    await registerAccount({ accountName: 'Bob', password: 'InitialPw01', primaryEmail: 'bob@ex.com' });
  });

  it('returns 202 and sends an email on match', async () => {
    const res = await request(app).post('/auth/forgot-password').send({
      accountName: 'Bob', primaryEmail: 'bob@ex.com',
    });
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    // Wait a tick for the fire-and-forget mail promise to run.
    await new Promise(r => setTimeout(r, 10));
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toBe('bob@ex.com');
  });

  it('returns 202 on miss but sends no email (opaque)', async () => {
    const res = await request(app).post('/auth/forgot-password').send({
      accountName: 'Unknown', primaryEmail: 'x@ex.com',
    });
    expect(res.status).toBe(202);
    await new Promise(r => setTimeout(r, 10));
    expect(sentMails.length).toBe(0);
  });

  it('reset-password with valid token changes password', async () => {
    await request(app).post('/auth/forgot-password').send({
      accountName: 'Bob', primaryEmail: 'bob@ex.com',
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
      accountName: 'Bob', password: 'InitialPw01',
    });
    expect(oldRes.status).toBe(401);
    const newRes = await request(app).post('/auth/login').send({
      accountName: 'Bob', password: 'BrandNewPw1',
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
