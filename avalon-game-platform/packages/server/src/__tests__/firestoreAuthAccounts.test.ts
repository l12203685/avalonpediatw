/**
 * Phase C — firestoreAuthAccounts unit tests (email-only architecture).
 *
 * Uses the same in-memory Firestore stub pattern as firestoreAccounts.test.ts.
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

describe('firestoreAuthAccounts — Phase C email-only', () => {
  beforeEach(async () => {
    store = {
      auth_users:                new Map(),
      password_reset_sessions:   new Map(),
      email_verifications:       new Map(),
    };
    mod = await import('../services/firestoreAuthAccounts');
  });

  describe('loginOrRegister', () => {
    it('creates a user when email is new', async () => {
      const r = await mod.loginOrRegister({
        email:    'ed@example.com',
        password: 'Passw0rdAvalon',
      });
      expect(r.ok).toBe(true);
      expect(r.data?.created).toBe(true);
      expect(r.data?.userId).toBeTruthy();

      const row = store.auth_users.get(r.data!.userId)!;
      expect(row.primaryEmail).toBe('ed@example.com');
      expect(row.primaryEmailLower).toBe('ed@example.com');
      expect(Array.isArray(row.emailsLower)).toBe(true);
      expect((row.emailsLower as string[]).includes('ed@example.com')).toBe(true);
      expect(String(row.passwordHash).startsWith('scrypt$')).toBe(true);
      expect(row.provider).toBe('password');
      expect(row.accountName).toBe('ed');  // local-part as default display
    });

    it('logs in with correct password when email exists', async () => {
      const reg = await mod.loginOrRegister({ email: 'alice@ex.com', password: 'AvalonPw01' });
      const login = await mod.loginOrRegister({ email: 'alice@ex.com', password: 'AvalonPw01' });
      expect(login.ok).toBe(true);
      expect(login.data?.created).toBe(false);
      expect(login.data?.userId).toBe(reg.data!.userId);
    });

    it('case-insensitive on email', async () => {
      await mod.loginOrRegister({ email: 'Alice@ex.com', password: 'AvalonPw01' });
      const login = await mod.loginOrRegister({ email: 'ALICE@EX.COM', password: 'AvalonPw01' });
      expect(login.ok).toBe(true);
      expect(login.data?.created).toBe(false);
    });

    it('returns bad_credentials on wrong password for existing email', async () => {
      await mod.loginOrRegister({ email: 'alice@ex.com', password: 'AvalonPw01' });
      const r = await mod.loginOrRegister({ email: 'alice@ex.com', password: 'WrongPw01x' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('bad_credentials');
    });

    it('rejects weak password with hash_failed on new account', async () => {
      const r = await mod.loginOrRegister({ email: 'x@ex.com', password: 'short' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('hash_failed');
    });
  });

  describe('findAccountByEmail', () => {
    it('returns account when email exists', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const r = await mod.findAccountByEmail('ED@EX.COM');
      expect(r).not.toBeNull();
      expect(r?.userId).toBe(reg.data!.userId);
      expect(r?.primaryEmail).toBe('ed@ex.com');
    });

    it('returns null when email not found', async () => {
      const r = await mod.findAccountByEmail('nobody@ex.com');
      expect(r).toBeNull();
    });
  });

  describe('password reset flow', () => {
    it('createPasswordResetSession + consumePasswordResetAndSet round-trip', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const sess = await mod.createPasswordResetSession({
        userId:      reg.data!.userId,
        accountName: 'ed',
        email:       'ed@ex.com',
      });
      expect(sess.ok).toBe(true);
      const token = sess.data!.token;
      expect(store.password_reset_sessions.get(token)).toBeTruthy();

      const result = await mod.consumePasswordResetAndSet({ token, newPassword: 'NewPassw0rd' });
      expect(result.ok).toBe(true);

      // Old password no longer works; new one does.
      const oldLogin = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      expect(oldLogin.ok).toBe(false);
      const newLogin = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'NewPassw0rd' });
      expect(newLogin.ok).toBe(true);
      expect(newLogin.data?.created).toBe(false);
    });

    it('rejects a reused reset token', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const sess = await mod.createPasswordResetSession({
        userId: reg.data!.userId, accountName: 'ed', email: 'ed@ex.com',
      });
      const token = sess.data!.token;
      await mod.consumePasswordResetAndSet({ token, newPassword: 'NewPassw0rd' });
      const again = await mod.consumePasswordResetAndSet({ token, newPassword: 'AnotherPw1' });
      expect(again.ok).toBe(false);
      expect(again.code).toBe('token_used');
    });

    it('rejects an expired token', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const sess = await mod.createPasswordResetSession({
        userId: reg.data!.userId, accountName: 'ed', email: 'ed@ex.com',
      });
      const token = sess.data!.token;
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
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const bad = await mod.changePassword({
        userId:      reg.data!.userId,
        oldPassword: 'wrong-pass-ab',
        newPassword: 'NewPassw0rd',
      });
      expect(bad.ok).toBe(false);
      expect(bad.code).toBe('bad_credentials');
    });

    it('succeeds when old password matches', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const ok = await mod.changePassword({
        userId:      reg.data!.userId,
        oldPassword: 'Passw0rdAvalon',
        newPassword: 'BrandNewPw1',
      });
      expect(ok.ok).toBe(true);
      const login = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'BrandNewPw1' });
      expect(login.ok).toBe(true);
      expect(login.data?.created).toBe(false);
    });
  });

  describe('email verification flow', () => {
    it('createEmailVerificationSession + consumeEmailVerification round-trip', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
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
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const sess = await mod.createEmailVerificationSession({ userId: reg.data!.userId, email: 'ed@ex.com' });
      await mod.consumeEmailVerification(sess.data!.token);
      const again = await mod.consumeEmailVerification(sess.data!.token);
      expect(again.ok).toBe(false);
      expect(again.code).toBe('token_used');
    });
  });

  describe('findAccountByUuidEmailPassword (claim-history)', () => {
    it('returns matched when 3 inputs align', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const r = await mod.findAccountByUuidEmailPassword(reg.data!.userId, 'ed@ex.com', 'Passw0rdAvalon');
      expect(r.ok).toBe(true);
      expect(r.data?.matched).toBe(true);
      expect(r.data?.legacyUserId).toBe(reg.data!.userId);
    });

    it('returns no_match when password wrong', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const r = await mod.findAccountByUuidEmailPassword(reg.data!.userId, 'ed@ex.com', 'wrong-pass-01');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('no_match');
    });

    it('returns no_match when email wrong', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
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

  // 2026-04-24 UX Phase 1 — primary email computation + per-provider slots.
  describe('getPrimaryEmail', () => {
    it('prefers Google over Discord over emailOnly', () => {
      expect(mod.getPrimaryEmail({
        googleEmail:  'g@x.com',
        discordEmail: 'd@x.com',
        emailOnly:    'e@x.com',
      })).toBe('g@x.com');
      expect(mod.getPrimaryEmail({
        discordEmail: 'd@x.com',
        emailOnly:    'e@x.com',
      })).toBe('d@x.com');
      expect(mod.getPrimaryEmail({ emailOnly: 'e@x.com' })).toBe('e@x.com');
    });

    it('ignores LINE email even when Google and Discord are absent', () => {
      // LINE 規格上常為 null，設計文件明列不作 fallback。
      expect(mod.getPrimaryEmail({
        lineEmail: 'line@x.com',
      })).toBeNull();
      expect(mod.getPrimaryEmail({
        lineEmail: 'line@x.com',
        emailOnly: 'e@x.com',
      })).toBe('e@x.com');
    });

    it('returns null when no provider supplies email', () => {
      expect(mod.getPrimaryEmail({})).toBeNull();
      expect(mod.getPrimaryEmail({
        googleEmail:  null,
        discordEmail: null,
        lineEmail:    null,
        emailOnly:    null,
      })).toBeNull();
    });

    it('treats empty / whitespace string as null', () => {
      expect(mod.getPrimaryEmail({ googleEmail: '', emailOnly: 'e@x.com' })).toBe('e@x.com');
      expect(mod.getPrimaryEmail({ googleEmail: '   ', emailOnly: 'e@x.com' })).toBe('e@x.com');
    });

    it('trims whitespace on returned value', () => {
      expect(mod.getPrimaryEmail({ googleEmail: '  g@x.com  ' })).toBe('g@x.com');
    });
  });

  describe('password signup writes emailOnly + primaryEmail', () => {
    it('password signup sets emailOnly to the signup email and primaryEmail matches', async () => {
      const r = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'AvalonPw01' });
      expect(r.ok).toBe(true);
      const row = store.auth_users.get(r.data!.userId)! as Record<string, unknown>;
      expect(row.emailOnly).toBe('ed@ex.com');
      expect(row.googleEmail).toBeNull();
      expect(row.discordEmail).toBeNull();
      expect(row.lineEmail).toBeNull();
      expect(row.primaryEmail).toBe('ed@ex.com');
    });
  });

  describe('ensureAccountByOAuthEmail writes per-provider email + recomputes primaryEmail', () => {
    it('Google signup writes googleEmail and sets primaryEmail to it', async () => {
      const r = await mod.ensureAccountByOAuthEmail({
        provider:           'google',
        providerExternalId: 'g-uid-abc',
        email:              'alice@gmail.com',
        displayName:        'Alice',
      });
      expect(r.ok).toBe(true);
      const row = store.auth_users.get(r.data!.account.userId)! as Record<string, unknown>;
      expect(row.googleEmail).toBe('alice@gmail.com');
      // discord / line 欄位在 OAuth new-row path 沒寫 → undefined。getPrimaryEmail
      // 容忍 undefined（按 null 處理），實務上前端讀 row 會 ??= null。
      expect(row.discordEmail).toBeFalsy();
      expect(row.lineEmail).toBeFalsy();
      expect(row.emailOnly).toBeNull();
      expect(row.primaryEmail).toBe('alice@gmail.com');
    });

    it('Discord binding on existing password account writes discordEmail but does NOT override primary until Google absent', async () => {
      // 1) password signup → emailOnly + primaryEmail 都是 ed@ex.com
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'AvalonPw01' });
      expect(reg.ok).toBe(true);

      // 2) 同 email 走 Discord OAuth → ensureAccountByOAuthEmail Path A
      const oauth = await mod.ensureAccountByOAuthEmail({
        provider:           'discord',
        providerExternalId: 'dc-123',
        email:              'ed@ex.com',
        displayName:        'Ed',
      });
      expect(oauth.ok).toBe(true);
      expect(oauth.data?.created).toBe(false);
      const row = store.auth_users.get(reg.data!.userId)! as Record<string, unknown>;
      expect(row.discordEmail).toBe('ed@ex.com');
      expect(row.emailOnly).toBe('ed@ex.com'); // 仍保留
      // primary = discord > emailOnly → discord 值（剛好相等）
      expect(row.primaryEmail).toBe('ed@ex.com');
    });

    it('Google binding after Discord overrides primaryEmail to Google', async () => {
      // 1) Discord signup
      const dc = await mod.ensureAccountByOAuthEmail({
        provider:           'discord',
        providerExternalId: 'dc-777',
        email:              'bob@discord.example',
        displayName:        'Bob',
      });
      expect(dc.ok).toBe(true);
      const userId = dc.data!.account.userId;

      // 2) 同 emailsLower → 不會找到既有 row，因為 google email 不同。
      // 模擬：把 Google email 寫到同一個 row — 需借 addEmailToUser 先把 google email
      // 掛上去。這裡直接操作 store 來模擬 linked provider scenario。
      const dRow = store.auth_users.get(userId)! as Record<string, unknown>;
      dRow.emails = [...(dRow.emails as string[]), 'bob@gmail.com'];
      dRow.emailsLower = [...(dRow.emailsLower as string[]), 'bob@gmail.com'];

      const gg = await mod.ensureAccountByOAuthEmail({
        provider:           'google',
        providerExternalId: 'g-uid-777',
        email:              'bob@gmail.com',
        displayName:        'Bob',
      });
      expect(gg.ok).toBe(true);
      expect(gg.data?.created).toBe(false);

      const row = store.auth_users.get(userId)! as Record<string, unknown>;
      expect(row.googleEmail).toBe('bob@gmail.com');
      expect(row.discordEmail).toBe('bob@discord.example');
      expect(row.primaryEmail).toBe('bob@gmail.com'); // google 優先
    });
  });

  describe('recomputePrimaryEmail', () => {
    it('updates primaryEmail when per-provider email changes', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'AvalonPw01' });
      // 直接動 row 模擬 Google 綁定後
      const row = store.auth_users.get(reg.data!.userId)! as Record<string, unknown>;
      row.googleEmail = 'ed@gmail.com';

      const r = await mod.recomputePrimaryEmail(reg.data!.userId);
      expect(r.ok).toBe(true);
      expect(r.data?.updated).toBe(true);
      expect(r.data?.primaryEmail).toBe('ed@gmail.com');

      const after = store.auth_users.get(reg.data!.userId)! as Record<string, unknown>;
      expect(after.primaryEmail).toBe('ed@gmail.com');
    });

    it('returns not_found for missing user', async () => {
      const r = await mod.recomputePrimaryEmail('ghost-uid');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('not_found');
    });

    it('is idempotent when primary does not change', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'AvalonPw01' });
      // primary = emailOnly = ed@ex.com（已寫）。再跑一次應回 updated=false。
      const r = await mod.recomputePrimaryEmail(reg.data!.userId);
      expect(r.ok).toBe(true);
      expect(r.data?.updated).toBe(false);
      expect(r.data?.primaryEmail).toBe('ed@ex.com');
    });
  });

  describe('addEmailToUser', () => {
    it('appends an email to the user row', async () => {
      const reg = await mod.loginOrRegister({ email: 'ed@ex.com', password: 'Passw0rdAvalon' });
      const r = await mod.addEmailToUser(reg.data!.userId, 'alt@ex.com');
      expect(r.ok).toBe(true);
      const row = store.auth_users.get(reg.data!.userId)!;
      expect((row.emails as string[])).toContain('alt@ex.com');
      expect((row.emailsLower as string[])).toContain('alt@ex.com');
    });

    it('refuses when email already taken by another user', async () => {
      const reg1 = await mod.loginOrRegister({ email: 'a@ex.com', password: 'Passw0rdAvalon' });
      await mod.loginOrRegister({ email: 'b@ex.com', password: 'Passw0rdAvalon' });
      const r = await mod.addEmailToUser(reg1.data!.userId, 'b@ex.com');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('email_taken');
    });
  });
});
