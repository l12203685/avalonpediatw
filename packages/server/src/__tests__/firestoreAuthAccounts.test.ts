/**
 * Phase A — firestoreAuthAccounts unit tests.
 *
 * Uses the same in-memory Firestore stub pattern as firestoreAccounts.test.ts
 * so we cover register / verify / reset / email-verify / claim-history paths
 * without a live Firestore project.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Shared in-memory Firestore stub ─────────────────────────────────

type Row = Record<string, unknown>;
type Collections = Record<string, Map<string, Row>>;

let store: Collections;

interface WhereClause { col: string; op: string; val: unknown }

function makeQuery(col: Map<string, Row>, clauses: WhereClause[] = []) {
  const matches = (row: Row): boolean =>
    clauses.every((c) => {
      const fieldVal = row[c.col];
      if (c.op === 'array-contains') {
        return Array.isArray(fieldVal) && fieldVal.includes(c.val);
      }
      return fieldVal === c.val;
    });

  return {
    where(col2: string, op: string, val: unknown) {
      return makeQuery(col, [...clauses, { col: col2, op, val }]);
    },
    limit(_n: number) { return this; },
    orderBy() { return this; },
    async get() {
      const entries = Array.from(col.entries()).filter(([, row]) => matches(row));
      return {
        empty: entries.length === 0,
        docs: entries.map(([id, row]) => ({
          id,
          ref: makeDocRef(col, id),
          data: () => row,
        })),
      };
    },
  };
}

function makeDocRef(col: Map<string, Row>, id: string) {
  return {
    async get() {
      const row = col.get(id);
      return { exists: row !== undefined, data: () => row };
    },
    async set(patch: Row) { col.set(id, { ...patch }); },
    async update(patch: Row) {
      const cur = col.get(id) ?? {};
      col.set(id, { ...cur, ...patch });
    },
    async delete() { col.delete(id); },
  };
}

function makeCollectionRef(name: string) {
  const col = store[name] ?? (store[name] = new Map<string, Row>());
  return {
    doc(id: string) { return makeDocRef(col, id); },
    where(c: string, op: string, val: unknown) { return makeQuery(col, [{ col: c, op, val }]); },
    async get() {
      const entries = Array.from(col.entries());
      return {
        empty: entries.length === 0,
        docs: entries.map(([id, row]) => ({ id, ref: makeDocRef(col, id), data: () => row })),
      };
    },
    orderBy() { return this; },
    limit() { return this; },
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
        set: (ref: { set: (p: Row) => Promise<void> }, patch: Row) => {
          ops.push(() => ref.set(patch));
        },
        update: (ref: { update: (p: Row) => Promise<void> }, patch: Row) => {
          ops.push(() => ref.update(patch));
        },
        delete: (ref: { delete: () => Promise<void> }) => { ops.push(() => ref.delete()); },
      };
      const result = await fn(tx);
      for (const op of ops) await op();
      return result;
    },
  };
}

vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => true,
  getAdminFirestore:    () => makeFirestoreStub(),
}));

type Module = typeof import('../services/firestoreAuthAccounts');
let mod: Module;

describe('firestoreAuthAccounts — Phase A new-login', () => {
  beforeEach(async () => {
    store = {
      auth_users:                new Map(),
      password_reset_sessions:   new Map(),
      email_verifications:       new Map(),
    };
    mod = await import('../services/firestoreAuthAccounts');
  });

  describe('registerAccount', () => {
    it('creates a user + writes account/password/email columns', async () => {
      const r = await mod.registerAccount({
        accountName:  'Edward',
        password:     'Passw0rdAvalon',
        primaryEmail: 'ed@example.com',
      });
      expect(r.ok).toBe(true);
      expect(r.data?.userId).toBeTruthy();

      const row = store.auth_users.get(r.data!.userId)!;
      expect(row.accountName).toBe('Edward');
      expect(row.accountNameLower).toBe('edward');
      expect(row.primaryEmail).toBe('ed@example.com');
      expect(row.primaryEmailLower).toBe('ed@example.com');
      expect(Array.isArray(row.emailsLower)).toBe(true);
      expect((row.emailsLower as string[]).includes('ed@example.com')).toBe(true);
      expect(String(row.passwordHash).startsWith('scrypt$')).toBe(true);
      expect(row.emailsVerified).toEqual([]);
      expect(row.provider).toBe('password');
    });

    it('rejects duplicate account names (case-insensitive)', async () => {
      await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'a@ex.com' });
      const r = await mod.registerAccount({ accountName: 'EDWARD', password: 'Passw0rdAvalon', primaryEmail: 'b@ex.com' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('account_taken');
    });

    it('rejects duplicate emails', async () => {
      await mod.registerAccount({ accountName: 'a1', password: 'Passw0rdAvalon', primaryEmail: 'dup@ex.com' });
      const r = await mod.registerAccount({ accountName: 'a2', password: 'Passw0rdAvalon', primaryEmail: 'DUP@ex.com' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('email_taken');
    });

    it('rejects weak password (bubble up hash_failed)', async () => {
      const r = await mod.registerAccount({ accountName: 'abc', password: 'short', primaryEmail: 'x@ex.com' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('hash_failed');
    });
  });

  describe('verifyCredentials', () => {
    it('returns userId when password matches', async () => {
      const reg = await mod.registerAccount({ accountName: 'Alice', password: 'AvalonPw01', primaryEmail: 'a@ex.com' });
      const r   = await mod.verifyCredentials('Alice', 'AvalonPw01');
      expect(r.ok).toBe(true);
      expect(r.data?.userId).toBe(reg.data!.userId);
      expect(r.data?.accountName).toBe('Alice');
      expect(r.data?.primaryEmail).toBe('a@ex.com');
    });

    it('returns bad_credentials on wrong password', async () => {
      await mod.registerAccount({ accountName: 'Alice', password: 'AvalonPw01', primaryEmail: 'a@ex.com' });
      const r = await mod.verifyCredentials('Alice', 'wrong01xx');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('bad_credentials');
    });

    it('returns bad_credentials on unknown account (no enumeration)', async () => {
      const r = await mod.verifyCredentials('Nobody', 'anyPass01');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('bad_credentials');
    });

    it('is case-insensitive on account name', async () => {
      await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'a@ex.com' });
      const r = await mod.verifyCredentials('EDWARD', 'Passw0rdAvalon');
      expect(r.ok).toBe(true);
    });
  });

  describe('findAccountByNameAndEmail', () => {
    it('matches when account + email pair align', async () => {
      await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const r = await mod.findAccountByNameAndEmail('edward', 'ED@ex.com');
      expect(r).not.toBeNull();
      expect(r?.accountName).toBe('Edward');
    });

    it('returns null when email does not belong to the account', async () => {
      await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const r = await mod.findAccountByNameAndEmail('Edward', 'different@ex.com');
      expect(r).toBeNull();
    });
  });

  describe('password reset flow', () => {
    it('createPasswordResetSession + consumePasswordResetAndSet round-trip', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const sess = await mod.createPasswordResetSession({
        userId:      reg.data!.userId,
        accountName: 'Edward',
        email:       'ed@ex.com',
      });
      expect(sess.ok).toBe(true);
      const token = sess.data!.token;
      expect(store.password_reset_sessions.get(token)).toBeTruthy();

      const result = await mod.consumePasswordResetAndSet({ token, newPassword: 'NewPassw0rd' });
      expect(result.ok).toBe(true);

      // Old password no longer works; new one does.
      const oldVerify = await mod.verifyCredentials('Edward', 'Passw0rdAvalon');
      expect(oldVerify.ok).toBe(false);
      const newVerify = await mod.verifyCredentials('Edward', 'NewPassw0rd');
      expect(newVerify.ok).toBe(true);
    });

    it('rejects a reused reset token', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const sess = await mod.createPasswordResetSession({
        userId: reg.data!.userId, accountName: 'Edward', email: 'ed@ex.com',
      });
      const token = sess.data!.token;
      await mod.consumePasswordResetAndSet({ token, newPassword: 'NewPassw0rd' });
      const again = await mod.consumePasswordResetAndSet({ token, newPassword: 'AnotherPw1' });
      expect(again.ok).toBe(false);
      expect(again.code).toBe('token_used');
    });

    it('rejects an expired token', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const sess = await mod.createPasswordResetSession({
        userId: reg.data!.userId, accountName: 'Edward', email: 'ed@ex.com',
      });
      const token = sess.data!.token;
      // Fake expiry by mutating store directly.
      const row = store.password_reset_sessions.get(token)!;
      store.password_reset_sessions.set(token, { ...row, expiresAt: Date.now() - 1000 });
      const r = await mod.consumePasswordResetAndSet({ token, newPassword: 'NewPassw0rd' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('token_expired');
    });

    it('rejects a non-existent token', async () => {
      const r = await mod.consumePasswordResetAndSet({ token: 'nonexistent', newPassword: 'NewPassw0rd' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('token_invalid');
    });
  });

  describe('changePassword', () => {
    it('requires old password match', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const bad = await mod.changePassword({
        userId:      reg.data!.userId,
        oldPassword: 'wrong-pass-ab',
        newPassword: 'NewPassw0rd',
      });
      expect(bad.ok).toBe(false);
      expect(bad.code).toBe('bad_credentials');
    });

    it('succeeds when old password matches', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const ok = await mod.changePassword({
        userId:      reg.data!.userId,
        oldPassword: 'Passw0rdAvalon',
        newPassword: 'BrandNewPw1',
      });
      expect(ok.ok).toBe(true);
      expect((await mod.verifyCredentials('Edward', 'BrandNewPw1')).ok).toBe(true);
      expect((await mod.verifyCredentials('Edward', 'Passw0rdAvalon')).ok).toBe(false);
    });
  });

  describe('email verification flow', () => {
    it('createEmailVerificationSession + consumeEmailVerification round-trip', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const sess = await mod.createEmailVerificationSession({
        userId: reg.data!.userId, email: 'ed@ex.com',
      });
      expect(sess.ok).toBe(true);
      const token = sess.data!.token;

      const result = await mod.consumeEmailVerification(token);
      expect(result.ok).toBe(true);
      expect(result.data?.email).toBe('ed@ex.com');

      const row = store.auth_users.get(reg.data!.userId)!;
      expect((row.emailsVerified as string[]).includes('ed@ex.com')).toBe(true);
    });

    it('rejects reused verification token', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const sess = await mod.createEmailVerificationSession({ userId: reg.data!.userId, email: 'ed@ex.com' });
      await mod.consumeEmailVerification(sess.data!.token);
      const again = await mod.consumeEmailVerification(sess.data!.token);
      expect(again.ok).toBe(false);
      expect(again.code).toBe('token_used');
    });
  });

  describe('findAccountByUuidEmailPassword (claim-history)', () => {
    it('returns matched when 3 inputs align', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const r = await mod.findAccountByUuidEmailPassword(reg.data!.userId, 'ed@ex.com', 'Passw0rdAvalon');
      expect(r.ok).toBe(true);
      expect(r.data?.matched).toBe(true);
      expect(r.data?.legacyUserId).toBe(reg.data!.userId);
    });

    it('returns no_match when password wrong', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const r = await mod.findAccountByUuidEmailPassword(reg.data!.userId, 'ed@ex.com', 'wrong-pass-01');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('no_match');
    });

    it('returns no_match when email wrong', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const r = await mod.findAccountByUuidEmailPassword(reg.data!.userId, 'diff@ex.com', 'Passw0rdAvalon');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('no_match');
    });

    it('returns no_match when uuid does not exist', async () => {
      const r = await mod.findAccountByUuidEmailPassword('ghost-id', 'x@ex.com', 'whatever01');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('no_match');
    });
  });

  describe('addEmailToUser', () => {
    it('appends an email to the user row', async () => {
      const reg = await mod.registerAccount({ accountName: 'Edward', password: 'Passw0rdAvalon', primaryEmail: 'ed@ex.com' });
      const r = await mod.addEmailToUser(reg.data!.userId, 'alt@ex.com');
      expect(r.ok).toBe(true);
      const row = store.auth_users.get(reg.data!.userId)!;
      expect((row.emails as string[])).toContain('alt@ex.com');
      expect((row.emailsLower as string[])).toContain('alt@ex.com');
    });

    it('refuses when email already taken', async () => {
      const reg1 = await mod.registerAccount({ accountName: 'A', password: 'Passw0rdAvalon', primaryEmail: 'a@ex.com' });
      await mod.registerAccount({ accountName: 'B', password: 'Passw0rdAvalon', primaryEmail: 'b@ex.com' });
      const r = await mod.addEmailToUser(reg1.data!.userId, 'b@ex.com');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('email_taken');
    });
  });
});
