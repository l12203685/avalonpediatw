/**
 * HTTP-level tests for the `/auth/link/discord` + `/auth/link/line` endpoints
 * that gate account-binding. Covers the two token paths through `parseBearerUserId`:
 *
 *   Path 1 — custom JWT (password / Discord / LINE JWT issued by this server)
 *   Path 2 — Firebase ID token (Google users — stored token becomes a Firebase
 *            ID token on socket reconnect; see `packages/web/src/services/socket.ts`)
 *
 * Before 2026-04-24, `parseBearerUserId` was sync + JWT-only, so Google users
 * binding Discord/LINE hit 401 Unauthorized. This test suite is the regression
 * guard for that fix.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { sign } from 'jsonwebtoken';

// ── Shared in-memory Firestore stub (cloned from auth.oauth-quick.routes.test) ─

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

process.env.JWT_SECRET            = process.env.JWT_SECRET || 'test-secret-for-link-endpoints';
process.env.DISCORD_CLIENT_ID     = 'test-discord-client';
process.env.DISCORD_CLIENT_SECRET = 'test-discord-secret';
process.env.DISCORD_REDIRECT_URI  = 'http://localhost:3001/auth/discord/callback';
process.env.LINE_CHANNEL_ID       = 'test-line-client';
process.env.LINE_CHANNEL_SECRET   = 'test-line-secret';
process.env.LINE_REDIRECT_URI     = 'http://localhost:3001/auth/line/callback';
process.env.FRONTEND_URL          = 'https://test-frontend.example.com';

const verifyIdTokenMock = vi.fn();

vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => true,
  getAdminFirestore:    () => makeFirestoreStub(),
  verifyIdToken:        verifyIdTokenMock,
  initializeFirebase:   vi.fn(),
}));

// Delegate createOAuthSession / findUserIdByProviderIdentity to the real
// firestoreAccounts module so the Firestore stub is the single source of truth.
vi.mock('../services/supabase', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/firestoreAccounts');
  return {
    upsertUser:                     vi.fn().mockResolvedValue('stub-id'),
    createOAuthSession:             (actual as { createOAuthSession: unknown }).createOAuthSession,
    consumeOAuthSession:            (actual as { consumeOAuthSession: unknown }).consumeOAuthSession,
    findUserIdByProviderIdentity:   (actual as { findUserIdByProviderIdentity: unknown }).findUserIdByProviderIdentity,
    linkProviderIdentity:           (actual as { linkProviderIdentity: unknown }).linkProviderIdentity,
    mergeUserAccounts:              vi.fn().mockResolvedValue(false),
    absorbGuestIntoUser:            vi.fn().mockResolvedValue(false),
    ensureUserForProviderIdentity:  vi.fn().mockResolvedValue(null),
    ensureSupabaseUserForFirebase:  vi.fn().mockResolvedValue(null),
    isSupabaseReady:                () => false,
  };
});

vi.mock('../services/mailer', () => ({
  sendPasswordResetEmail:     vi.fn(async () => ({ ok: true, messageId: 'stub' })),
  sendEmailVerificationEmail: vi.fn(),
  sendMail:                   vi.fn(),
  isMailerReady:              vi.fn().mockResolvedValue(true),
  __setMailerForTest:         vi.fn(),
}));

// ── App factory ─────────────────────────────────────────────────

let app: Express;
let loginOrRegister: (params: { email: string; password: string }) => Promise<{
  ok: boolean;
  data?: { userId: string };
}>;

beforeAll(async () => {
  const { authRouter } = await import('../routes/auth');
  app = express();
  app.use(express.json());
  app.use('/auth', authRouter);

  const fa = await import('../services/firestoreAuthAccounts');
  loginOrRegister = fa.loginOrRegister as unknown as typeof loginOrRegister;
});

function resetStore(): void {
  store = {
    auth_users:              new Map(),
    oauth_sessions:          new Map(),
    password_reset_sessions: new Map(),
    email_verifications:     new Map(),
  };
}

function makeCustomJwt(params: { sub: string; provider?: string }): string {
  return sign(
    { sub: params.sub, displayName: 'Test User', provider: params.provider ?? 'password' },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );
}

// ── Tests ───────────────────────────────────────────────────────

describe('GET /auth/link/discord — parseBearerUserId paths', () => {
  beforeEach(() => {
    resetStore();
    verifyIdTokenMock.mockReset();
  });

  it('Path 1: accepts a custom JWT in Authorization header and redirects to Discord', async () => {
    const reg = await loginOrRegister({ email: 'user@example.com', password: 'Abc12345' });
    expect(reg.ok).toBe(true);
    const userId = reg.data!.userId;

    const jwt = makeCustomJwt({ sub: userId, provider: 'password' });
    const res = await request(app)
      .get('/auth/link/discord')
      .set('Authorization', `Bearer ${jwt}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://discord.com/api/oauth2/authorize');
    // OAuth session recorded with bind target = the user's auth_users doc id
    expect(store.oauth_sessions.size).toBe(1);
    const session = Array.from(store.oauth_sessions.values())[0];
    expect(session.linkUserId).toBe(userId);
    expect(session.provider).toBe('discord');
  });

  it('Path 1: accepts a custom JWT passed via ?token=... query param', async () => {
    const reg = await loginOrRegister({ email: 'user2@example.com', password: 'Abc12345' });
    const userId = reg.data!.userId;

    const jwt = makeCustomJwt({ sub: userId, provider: 'password' });
    const res = await request(app)
      .get(`/auth/link/discord?token=${encodeURIComponent(jwt)}`)
      .redirects(0);

    expect(res.status).toBe(302);
    const session = Array.from(store.oauth_sessions.values())[0];
    expect(session.linkUserId).toBe(userId);
  });

  it('Path 2 (happy path): Firebase ID token → existing row linked by firebase_uid', async () => {
    // Seed an auth_users row that is already linked by firebase_uid=google-uid-xyz
    const seedId = 'seed-user-id';
    store.auth_users.set(seedId, {
      provider:         'google',
      firebase_uid:     'google-uid-xyz',
      accountName:      'seeded',
      accountNameLower: 'seeded',
      primaryEmail:     'seeded@example.com',
      primaryEmailLower:'seeded@example.com',
      emails:           ['seeded@example.com'],
      emailsLower:      ['seeded@example.com'],
      emailsVerified:   ['seeded@example.com'],
      display_name:     'Seeded User',
      passwordHash:     'scrypt$x',
      createdAt:        Date.now(),
      updatedAt:        Date.now(),
    });

    verifyIdTokenMock.mockResolvedValueOnce({
      uid:   'google-uid-xyz',
      email: 'seeded@example.com',
      name:  'Seeded User',
    });

    const threeSegmentToken = 'header.payload.sig';
    const res = await request(app)
      .get('/auth/link/discord')
      .set('Authorization', `Bearer ${threeSegmentToken}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://discord.com/api/oauth2/authorize');
    expect(store.oauth_sessions.size).toBe(1);
    const session = Array.from(store.oauth_sessions.values())[0];
    // The key assertion: linkUserId resolved to the auth_users doc id
    // (= seedId), NOT the raw Firebase uid.
    expect(session.linkUserId).toBe(seedId);
    expect(session.provider).toBe('discord');
  });

  it('Path 2 (auto-register): Firebase ID token for new email → ensureAccountByOAuthEmail creates row + binds', async () => {
    // No pre-seeded row. Firebase token carries an email we have never seen.
    verifyIdTokenMock.mockResolvedValueOnce({
      uid:   'google-uid-new',
      email: 'brand-new@example.com',
      name:  'Brand New',
    });

    const threeSegmentToken = 'header.payload.sig';
    const res = await request(app)
      .get('/auth/link/discord')
      .set('Authorization', `Bearer ${threeSegmentToken}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://discord.com/api/oauth2/authorize');

    // ensureAccountByOAuthEmail should have created a fresh auth_users row.
    expect(store.auth_users.size).toBe(1);
    const [rowId, row] = Array.from(store.auth_users.entries())[0];
    expect((row as { primaryEmail: string }).primaryEmail).toBe('brand-new@example.com');
    expect((row as { firebase_uid: string }).firebase_uid).toBe('google-uid-new');

    const session = Array.from(store.oauth_sessions.values())[0];
    expect(session.linkUserId).toBe(rowId);
  });

  it('401 when neither JWT nor Firebase token verifies', async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error('bad token'));

    const res = await request(app)
      .get('/auth/link/discord')
      .set('Authorization', 'Bearer totally.invalid.token')
      .redirects(0);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('401 when no Authorization header and no ?token= query param', async () => {
    const res = await request(app).get('/auth/link/discord').redirects(0);
    expect(res.status).toBe(401);
  });
});

describe('GET /auth/link/line — parseBearerUserId paths', () => {
  beforeEach(() => {
    resetStore();
    verifyIdTokenMock.mockReset();
  });

  it('Path 1: accepts a custom JWT and redirects to LINE', async () => {
    const reg = await loginOrRegister({ email: 'line-user@example.com', password: 'Abc12345' });
    const userId = reg.data!.userId;

    const jwt = makeCustomJwt({ sub: userId, provider: 'password' });
    const res = await request(app)
      .get('/auth/link/line')
      .set('Authorization', `Bearer ${jwt}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://access.line.me/oauth2/v2.1/authorize');
    const session = Array.from(store.oauth_sessions.values())[0];
    expect(session.linkUserId).toBe(userId);
    expect(session.provider).toBe('line');
  });

  it('Path 2: Firebase ID token → auth_users doc id → redirects to LINE', async () => {
    const seedId = 'line-seed-user-id';
    store.auth_users.set(seedId, {
      provider:         'google',
      firebase_uid:     'google-uid-line-bind',
      accountName:      'lineseeded',
      accountNameLower: 'lineseeded',
      primaryEmail:     'line-seeded@example.com',
      primaryEmailLower:'line-seeded@example.com',
      emails:           ['line-seeded@example.com'],
      emailsLower:      ['line-seeded@example.com'],
      emailsVerified:   ['line-seeded@example.com'],
      display_name:     'Line Seeded',
      passwordHash:     'scrypt$x',
      createdAt:        Date.now(),
      updatedAt:        Date.now(),
    });

    verifyIdTokenMock.mockResolvedValueOnce({
      uid:   'google-uid-line-bind',
      email: 'line-seeded@example.com',
      name:  'Line Seeded',
    });

    const threeSegmentToken = 'header.payload.sig';
    const res = await request(app)
      .get('/auth/link/line')
      .set('Authorization', `Bearer ${threeSegmentToken}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://access.line.me/oauth2/v2.1/authorize');
    const session = Array.from(store.oauth_sessions.values())[0];
    expect(session.linkUserId).toBe(seedId);
  });
});
