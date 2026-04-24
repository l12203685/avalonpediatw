/**
 * Integration test — signup 路徑必須把玩家短碼寫入 Firestore `shortCodeIndex`，
 * 這樣 `/api/friends/add-by-code` 才查得到（#48 修復）。
 *
 * 覆蓋：
 *   1. 密碼 signup（`loginOrRegister` created=true）→ shortCodeIndex 有新項 uid=userId
 *   2. OAuth 自動建帳（`ensureAccountByOAuthEmail` created=true）→ 同上
 *   3. `getUserIdByShortCode` 用剛寫入的短碼反查拿得回 userId（端到端資料流）
 *   4. 登入既有帳號（created=false）→ 不重複寫 shortCodeIndex
 *
 * 測試 Firestore stub 支援 `tx.create`（ShortCodeFirestore 寫索引用）；這比
 * `firestoreAuthAccounts.test.ts` / `auth.routes.test.ts` 的舊 stub 多一個 op。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory Firestore stub（multi-collection + tx.create 支援）──────

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
    __col: col,
    __id:  id,
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
    async runTransaction<T>(
      fn: (tx: {
        get: (target: unknown) => Promise<unknown>;
        set:    (ref: { set:    (p: Row) => Promise<void> }, patch: Row) => void;
        update: (ref: { update: (p: Row) => Promise<void> }, patch: Row) => void;
        create: (ref: { __col: Map<string, Row>; __id: string }, data: Row) => void;
        delete: (ref: { delete: () => Promise<void> }) => void;
      }) => Promise<T>,
    ): Promise<T> {
      const ops: Array<() => void | Promise<void>> = [];
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
        create: (ref: { __col: Map<string, Row>; __id: string }, data: Row) => {
          // Firestore 真實 `tx.create` 語意：docId 已存在則拋錯
          if (ref.__col.has(ref.__id)) {
            throw new Error(
              `Document already exists: ${ref.__id}`,
            );
          }
          ops.push(() => { ref.__col.set(ref.__id, { ...data }); });
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

type AuthModule  = typeof import('../services/firestoreAuthAccounts');
type ShortModule = typeof import('../services/shortCodeFirestore');
let authMod:  AuthModule;
let shortMod: ShortModule;

describe('signup → Firestore shortCodeIndex integration (#48)', () => {
  beforeEach(async () => {
    store = {
      auth_users:              new Map(),
      shortCodeIndex:          new Map(),
      password_reset_sessions: new Map(),
      email_verifications:     new Map(),
    };
    authMod  = await import('../services/firestoreAuthAccounts');
    shortMod = await import('../services/shortCodeFirestore');
  });

  it('password signup writes shortCodeIndex and is reverse-lookup-able', async () => {
    const r = await authMod.loginOrRegister({
      email:    'newcomer@example.com',
      password: 'StrongPw01',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.created).toBe(true);
    const userId = r.data!.userId;

    // 1. auth_users 有新 row 且帶 shortCode 欄位
    const row = store.auth_users.get(userId);
    expect(row).toBeTruthy();
    const code = row!.shortCode as string | undefined;
    expect(typeof code).toBe('string');
    expect(code!.length).toBe(8);

    // 2. shortCodeIndex/{code}.uid = userId
    const indexRow = store.shortCodeIndex.get(code!);
    expect(indexRow).toEqual({ uid: userId });

    // 3. getUserIdByShortCode 反查可取回 userId（端到端流程）
    //    建一個 stub firestore handle 指向同一個 store（因為 mock 每次 call
    //    `getAdminFirestore()` 都是 fresh stub，但共用 store）
    const stubDb = makeFirestoreStub() as unknown as Parameters<typeof shortMod.getUserIdByShortCode>[1];
    const resolved = await shortMod.getUserIdByShortCode(code!, stubDb);
    expect(resolved).toBe(userId);
  });

  it('signup → getShortCodeByUid 正向讀 auth_users.shortCode 取回同一個 code（#48 讀路徑遷徙）', async () => {
    const r = await authMod.loginOrRegister({
      email:    'readback@example.com',
      password: 'StrongPw01',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.created).toBe(true);
    const userId = r.data!.userId;

    const storedCode = (store.auth_users.get(userId)!.shortCode) as string;
    expect(storedCode).toBeTruthy();

    // 正向讀：profile 顯示頁 / override merge 會走這條
    const stubDb = makeFirestoreStub() as unknown as Parameters<typeof shortMod.getShortCodeByUid>[1];
    const resolved = await shortMod.getShortCodeByUid(userId, stubDb);
    expect(resolved).toBe(storedCode);

    // 反向也能查回來（加好友流程）
    const reverseDb = makeFirestoreStub() as unknown as Parameters<typeof shortMod.getUserIdByShortCode>[1];
    const reversed = await shortMod.getUserIdByShortCode(storedCode, reverseDb);
    expect(reversed).toBe(userId);
  });

  it('getShortCodeByUid 無此 uid → null', async () => {
    const stubDb = makeFirestoreStub() as unknown as Parameters<typeof shortMod.getShortCodeByUid>[1];
    const resolved = await shortMod.getShortCodeByUid('nonexistent-uid', stubDb);
    expect(resolved).toBeNull();
  });

  it('getShortCodeByUid 空字串 → null', async () => {
    const stubDb = makeFirestoreStub() as unknown as Parameters<typeof shortMod.getShortCodeByUid>[1];
    expect(await shortMod.getShortCodeByUid('', stubDb)).toBeNull();
  });

  it('OAuth auto-register writes shortCodeIndex', async () => {
    const r = await authMod.ensureAccountByOAuthEmail({
      provider:           'google',
      providerExternalId: 'google-uid-xyz',
      email:              'oauthnew@example.com',
      displayName:        'OAuth Newcomer',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.created).toBe(true);
    const userId = r.data!.account.userId;

    const row = store.auth_users.get(userId);
    expect(row).toBeTruthy();
    const code = row!.shortCode as string | undefined;
    expect(typeof code).toBe('string');

    const indexRow = store.shortCodeIndex.get(code!);
    expect(indexRow).toEqual({ uid: userId });
  });

  it('login of existing account does NOT re-write shortCodeIndex', async () => {
    // First signup → creates code A
    const reg = await authMod.loginOrRegister({
      email:    'existing@example.com',
      password: 'StrongPw01',
    });
    expect(reg.ok).toBe(true);
    const firstRow = store.auth_users.get(reg.data!.userId)!;
    const firstCode = firstRow.shortCode as string;
    expect(firstCode).toBeTruthy();
    expect(store.shortCodeIndex.size).toBe(1);

    // Re-login → must not write new index entry
    const login = await authMod.loginOrRegister({
      email:    'existing@example.com',
      password: 'StrongPw01',
    });
    expect(login.ok).toBe(true);
    expect(login.data?.created).toBe(false);
    expect(store.shortCodeIndex.size).toBe(1);
    // 原 code 維持不動
    const afterRow = store.auth_users.get(reg.data!.userId)!;
    expect(afterRow.shortCode).toBe(firstCode);
  });

  it('OAuth login of existing email-only account does NOT re-write shortCodeIndex', async () => {
    // 1. password signup 先建
    const reg = await authMod.loginOrRegister({
      email:    'hybrid@example.com',
      password: 'StrongPw01',
    });
    expect(reg.ok).toBe(true);
    const firstCode = (store.auth_users.get(reg.data!.userId)!.shortCode) as string;
    expect(store.shortCodeIndex.size).toBe(1);

    // 2. 同 email 走 OAuth login → 走 Path A（登入 + 補綁 externalId）
    const oauth = await authMod.ensureAccountByOAuthEmail({
      provider:           'discord',
      providerExternalId: 'discord-xyz',
      email:              'hybrid@example.com',
      displayName:        'Hybrid',
    });
    expect(oauth.ok).toBe(true);
    expect(oauth.data?.created).toBe(false);

    // shortCodeIndex 保持 1 項，code 未變
    expect(store.shortCodeIndex.size).toBe(1);
    const stillRow = store.auth_users.get(reg.data!.userId)!;
    expect(stillRow.shortCode).toBe(firstCode);
  });
});
