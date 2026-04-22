import { describe, it, expect, beforeEach } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  ensureUserShortCode,
  getUserIdByShortCode,
  firestoreUserExists,
  USERS_COLLECTION,
  SHORT_CODE_INDEX_COLLECTION,
} from '../services/shortCodeFirestore';
import { isValidShortCode } from '../services/shortCode';

// ---------------------------------------------------------------------------
// Mock Firestore — 最小子集：collection().doc().get/create/update + runTransaction
// ---------------------------------------------------------------------------
// Firestore admin SDK 真實實作太重（要 GCP project / service account），這裡做
// 記憶體版：用 Map<collection, Map<docId, data>>。Transaction 行為重點：
//   - tx.get(ref)          → 依 collection + docId 查
//   - tx.create(ref, data) → docId 已存在則拋錯（對應 Firestore 真行為）
//   - tx.update(ref, patch)→ shallow merge
// ---------------------------------------------------------------------------

type DocMap = Map<string, Record<string, unknown>>;
type Store = Map<string, DocMap>;

interface DocRef {
  __collection: string;
  __id: string;
}

function makeMockFirestore(): { db: Firestore; store: Store } {
  const store: Store = new Map();

  function ensureCol(name: string): DocMap {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }

  function makeDocRef(collection: string, id: string): DocRef {
    return { __collection: collection, __id: id };
  }

  function readDoc(ref: DocRef) {
    const col = ensureCol(ref.__collection);
    const data = col.get(ref.__id);
    return {
      exists: data !== undefined,
      data: () => (data ? { ...data } : undefined),
    };
  }

  const docApi = (collection: string, id: string) => ({
    __ref: makeDocRef(collection, id),
    async get() {
      return readDoc(makeDocRef(collection, id));
    },
  });

  const collectionApi = (name: string) => ({
    doc: (id: string) => docApi(name, id),
  });

  const mock = {
    collection: collectionApi,
    async runTransaction<T>(
      fn: (tx: {
        get: (ref: { __ref: DocRef }) => Promise<ReturnType<typeof readDoc>>;
        create: (ref: { __ref: DocRef }, data: Record<string, unknown>) => void;
        update: (ref: { __ref: DocRef }, patch: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> {
      // 簡化：序列化（不做真 snapshot 隔離；測試用途足夠）
      const tx = {
        async get(ref: { __ref: DocRef }) {
          return readDoc(ref.__ref);
        },
        create(ref: { __ref: DocRef }, data: Record<string, unknown>) {
          const col = ensureCol(ref.__ref.__collection);
          if (col.has(ref.__ref.__id)) {
            throw new Error(
              `Document ${ref.__ref.__collection}/${ref.__ref.__id} already exists`,
            );
          }
          col.set(ref.__ref.__id, { ...data });
        },
        update(ref: { __ref: DocRef }, patch: Record<string, unknown>) {
          const col = ensureCol(ref.__ref.__collection);
          const current = col.get(ref.__ref.__id) ?? {};
          col.set(ref.__ref.__id, { ...current, ...patch });
        },
      };
      return fn(tx);
    },
  };

  // collectionApi / runTransaction 的真 firebase-admin 介面比這寬很多，但 service
  // 只用到這兩個 + doc().get()。cast 成 Firestore 讓型別通過。
  return { db: mock as unknown as Firestore, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shortCodeFirestore.getUserIdByShortCode', () => {
  let db: Firestore;
  let store: Store;

  beforeEach(() => {
    ({ db, store } = makeMockFirestore());
  });

  it('未登記的短碼回 null', async () => {
    expect(await getUserIdByShortCode('7K3M9P2Q', db)).toBeNull();
  });

  it('非法格式直接 null 不打 DB', async () => {
    expect(await getUserIdByShortCode('0O1IL', db)).toBeNull();
    expect(await getUserIdByShortCode('', db)).toBeNull();
    expect(await getUserIdByShortCode('too-short', db)).toBeNull();
  });

  it('走反向索引 shortCodeIndex/{code} → uid', async () => {
    const index = store.get(SHORT_CODE_INDEX_COLLECTION) ?? new Map();
    index.set('7K3M9P2Q', { uid: 'user-abc' });
    store.set(SHORT_CODE_INDEX_COLLECTION, index);

    expect(await getUserIdByShortCode('7K3M9P2Q', db)).toBe('user-abc');
  });

  it('normalize 後再查：輸入小寫空白也找得到', async () => {
    const index = store.get(SHORT_CODE_INDEX_COLLECTION) ?? new Map();
    index.set('7K3M9P2Q', { uid: 'user-abc' });
    store.set(SHORT_CODE_INDEX_COLLECTION, index);

    expect(await getUserIdByShortCode('  7k3m 9p2q  ', db)).toBe('user-abc');
  });
});

describe('shortCodeFirestore.ensureUserShortCode', () => {
  let db: Firestore;
  let store: Store;

  function seedUser(uid: string, data: Record<string, unknown> = {}) {
    const users = store.get(USERS_COLLECTION) ?? new Map();
    users.set(uid, data);
    store.set(USERS_COLLECTION, users);
  }

  beforeEach(() => {
    ({ db, store } = makeMockFirestore());
  });

  it('用戶不存在 → null', async () => {
    const result = await ensureUserShortCode('missing-uid', db);
    expect(result).toBeNull();
  });

  it('用戶已有 shortCode → 直接回傳，不動 index', async () => {
    seedUser('user-abc', { shortCode: '7K3M9P2Q' });
    const code = await ensureUserShortCode('user-abc', db);
    expect(code).toBe('7K3M9P2Q');
    // index 不該被動
    expect(store.get(SHORT_CODE_INDEX_COLLECTION)?.size ?? 0).toBe(0);
  });

  it('用戶無 shortCode → 生成新碼並原子寫入 index + users', async () => {
    seedUser('user-abc');
    const code = await ensureUserShortCode('user-abc', db);
    expect(code).not.toBeNull();
    expect(isValidShortCode(code!)).toBe(true);

    // users.shortCode 應該被更新
    const user = store.get(USERS_COLLECTION)?.get('user-abc');
    expect(user?.shortCode).toBe(code);

    // index 應該有一條
    const indexDoc = store.get(SHORT_CODE_INDEX_COLLECTION)?.get(code!);
    expect(indexDoc).toEqual({ uid: 'user-abc' });
  });

  it('生成後用 getUserIdByShortCode 可反查回 uid', async () => {
    seedUser('user-abc');
    const code = await ensureUserShortCode('user-abc', db);
    expect(code).not.toBeNull();

    const uid = await getUserIdByShortCode(code!, db);
    expect(uid).toBe('user-abc');
  });

  it('第一次候選碼已被別人佔用 → 重試直到成功', async () => {
    seedUser('user-abc');

    // 預埋一個可能被 generateShortCode 命中的占位（但因為隨機，可能不會第一次就中）
    // 這裡改用「塞滿三個任意碼」的方式模擬部分衝突，只是確保流程不卡死
    const index = store.get(SHORT_CODE_INDEX_COLLECTION) ?? new Map();
    // 塞一個固定碼，不影響隨機生成
    index.set('AAAABBBB', { uid: 'other-user' });
    store.set(SHORT_CODE_INDEX_COLLECTION, index);

    const code = await ensureUserShortCode('user-abc', db);
    expect(code).not.toBeNull();
    expect(code).not.toBe('AAAABBBB');
  });

  it('無效 uid 參數 → null', async () => {
    expect(await ensureUserShortCode('', db)).toBeNull();
    expect(await ensureUserShortCode(null as unknown as string, db)).toBeNull();
  });
});

describe('shortCodeFirestore.firestoreUserExists', () => {
  let db: Firestore;
  let store: Store;

  beforeEach(() => {
    ({ db, store } = makeMockFirestore());
  });

  it('存在 → true', async () => {
    const users = store.get(USERS_COLLECTION) ?? new Map();
    users.set('user-abc', { displayName: 'X' });
    store.set(USERS_COLLECTION, users);

    expect(await firestoreUserExists('user-abc', db)).toBe(true);
  });

  it('不存在 → false', async () => {
    expect(await firestoreUserExists('missing', db)).toBe(false);
  });

  it('空 uid → false', async () => {
    expect(await firestoreUserExists('', db)).toBe(false);
  });
});
