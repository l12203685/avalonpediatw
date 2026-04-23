/**
 * Ticket #42 route B — Firestore multi-account binding + OAuth session store.
 *
 * Mocks firebase-admin Firestore so we can exercise the real helpers end-to-end
 * without touching a live project. Matches the behavioural guarantees of the
 * legacy Supabase-based tests in `multiAccountBinding.test.ts` so the route
 * contract stays stable across the rewrite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory Firestore stub ────────────────────────────────────────

type Row = Record<string, unknown>;
type Collections = Record<string, Map<string, Row>>;

let store: Collections;

interface WhereClause { col: string; op: '=='; val: unknown }

function makeQuery(col: Map<string, Row>, clauses: WhereClause[] = []) {
  const matches = (row: Row): boolean =>
    clauses.every((c) => row[c.col] === c.val);

  return {
    where(col2: string, op: '==', val: unknown) {
      return makeQuery(col, [...clauses, { col: col2, op, val }]);
    },
    limit(_n: number) {
      return this;
    },
    async get() {
      const entries = Array.from(col.entries())
        .filter(([, row]) => matches(row));
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
      return {
        exists: row !== undefined,
        data: () => row,
      };
    },
    async set(patch: Row) {
      col.set(id, { ...patch });
    },
    async update(patch: Row) {
      const cur = col.get(id) ?? {};
      col.set(id, { ...cur, ...patch });
    },
    async delete() {
      col.delete(id);
    },
  };
}

function makeCollectionRef(name: string) {
  const col = store[name] ?? (store[name] = new Map<string, Row>());
  return {
    doc(id: string) { return makeDocRef(col, id); },
    where(c: string, op: '==', val: unknown) { return makeQuery(col, [{ col: c, op, val }]); },
    async get() {
      const entries = Array.from(col.entries());
      return {
        empty: entries.length === 0,
        docs: entries.map(([id, row]) => ({
          id,
          ref: makeDocRef(col, id),
          data: () => row,
        })),
      };
    },
    orderBy() { return this; },
    limit() { return this; },
  };
}

function makeFirestoreStub() {
  return {
    collection: (name: string) => makeCollectionRef(name),
    batch() {
      const ops: Array<() => Promise<void>> = [];
      return {
        update(ref: { update: (p: Row) => Promise<void> }, patch: Row) {
          ops.push(() => ref.update(patch));
        },
        delete(ref: { delete: () => Promise<void> }) {
          ops.push(() => ref.delete());
        },
        set(ref: { set: (p: Row) => Promise<void> }, patch: Row) {
          ops.push(() => ref.set(patch));
        },
        async commit() {
          for (const op of ops) await op();
        },
      };
    },
    async runTransaction<T>(fn: (tx: {
      get: (ref: { get: () => Promise<{ exists: boolean; data: () => Row | undefined }> }) =>
        Promise<{ exists: boolean; data: () => Row | undefined }>;
      delete: (ref: { delete: () => Promise<void> }) => void;
    }) => Promise<T>): Promise<T> {
      const deletes: Array<() => Promise<void>> = [];
      const tx = {
        get: async (ref: { get: () => Promise<{ exists: boolean; data: () => Row | undefined }> }) => ref.get(),
        delete: (ref: { delete: () => Promise<void> }) => { deletes.push(() => ref.delete()); },
      };
      const result = await fn(tx);
      for (const d of deletes) await d();
      return result;
    },
  };
}

// Mock firebase service layer so getFirestoreSafe returns our stub.
vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => true,
  getAdminFirestore:    () => makeFirestoreStub(),
}));

// Dynamic import AFTER mock set up.
type FirestoreAccountsModule = typeof import('../services/firestoreAccounts');
let mod: FirestoreAccountsModule;

describe('#42 route B — firestoreAccounts (Firestore-backed)', () => {
  beforeEach(async () => {
    store = {
      auth_users: new Map<string, Row>([
        ['user-a', {
          provider: 'discord',
          discord_id: 'dc-aaa', line_id: null, firebase_uid: null,
          email: 'a@ex.com',
          display_name: 'Alice',
          elo_rating: 1200, total_games: 10, games_won: 6, games_lost: 4,
          badges: ['first_win'],
        }],
        ['user-b', {
          provider: 'line',
          discord_id: null, line_id: 'ln-bbb', firebase_uid: null,
          email: 'b@ex.com',
          display_name: 'Bob',
          elo_rating: 1100, total_games: 5, games_won: 2, games_lost: 3,
          badges: ['first_win', 'loyal_defender'],
        }],
      ]),
      games: new Map<string, Row>([
        ['g1', { playerId: 'user-a', role: 'merlin',   won: true  }],
        ['g2', { playerId: 'user-b', role: 'assassin', won: false }],
        ['g3', { playerId: 'user-b', role: 'loyal',    won: true  }],
      ]),
      friendships: new Map<string, Row>([
        ['fr1', { follower_id: 'user-a', following_id: 'user-b' }],
        ['fr2', { follower_id: 'user-c', following_id: 'user-b' }],
      ]),
      oauth_sessions: new Map<string, Row>(),
    };
    mod = await import('../services/firestoreAccounts');
  });

  describe('getLinkedAccounts', () => {
    it('reports primary discord for user-a; line+google unbound', async () => {
      const links = await mod.getLinkedAccounts('user-a');
      expect(links).toHaveLength(3);
      const dc = links.find((l) => l.provider === 'discord')!;
      expect(dc.linked).toBe(true);
      expect(dc.primary).toBe(true);
      expect(dc.external_id).toBe('dc-aaa');
      expect(links.find((l) => l.provider === 'line')!.linked).toBe(false);
      expect(links.find((l) => l.provider === 'google')!.linked).toBe(false);
    });

    it('returns empty array when user row missing', async () => {
      const links = await mod.getLinkedAccounts('ghost-user');
      expect(links).toEqual([]);
    });

    // 2026-04-23 Edward 指令：已綁狀態 UI 需要 display_label — email / 顯示名
    it('attaches display_label per provider (discord#tail / email / display_name)', async () => {
      const links = await mod.getLinkedAccounts('user-a');
      const dc     = links.find((l) => l.provider === 'discord')!;
      const line   = links.find((l) => l.provider === 'line')!;
      const google = links.find((l) => l.provider === 'google')!;
      // user-a 只綁 discord → discord 有 label，其餘為 null（未綁）
      expect(dc.display_label).toBe('Alice#-aaa'); // slice(-4) of 'dc-aaa'
      expect(line.display_label).toBeNull();
      expect(google.display_label).toBeNull();
    });

    it('google provider prefers email over display_name in label', async () => {
      // 把 user-a 綁 google 試試
      store.auth_users.set('user-a', {
        ...(store.auth_users.get('user-a') as Row),
        firebase_uid: 'fb-aaa',
      });
      const links = await mod.getLinkedAccounts('user-a');
      const g = links.find((l) => l.provider === 'google')!;
      expect(g.linked).toBe(true);
      expect(g.display_label).toBe('a@ex.com');
    });

    it('falls back to externalId when display_name + email both missing', async () => {
      store.auth_users.set('user-x', {
        provider: 'line',
        line_id: 'ln-xxx',
        discord_id: null,
        firebase_uid: null,
        email: null,
        display_name: null,
      });
      const links = await mod.getLinkedAccounts('user-x');
      const line = links.find((l) => l.provider === 'line')!;
      expect(line.display_label).toBe('ln-xxx');
    });
  });

  describe('findUserIdByProviderIdentity', () => {
    it('returns user-b for line id ln-bbb', async () => {
      const id = await mod.findUserIdByProviderIdentity('line', 'ln-bbb');
      expect(id).toBe('user-b');
    });

    it('returns null for unknown identity', async () => {
      const id = await mod.findUserIdByProviderIdentity('discord', 'nope');
      expect(id).toBeNull();
    });
  });

  describe('linkProviderIdentity / unlinkProviderIdentity', () => {
    it('binds firebase_uid to user-a and unbinds back to null', async () => {
      expect(await mod.linkProviderIdentity('user-a', 'google', 'fb-xyz')).toBe(true);
      expect(store.auth_users.get('user-a')!.firebase_uid).toBe('fb-xyz');

      expect(await mod.unlinkProviderIdentity('user-a', 'google')).toBe(true);
      expect(store.auth_users.get('user-a')!.firebase_uid).toBeNull();
    });

    it('returns false when linking on missing user doc', async () => {
      expect(await mod.linkProviderIdentity('ghost', 'google', 'fb')).toBe(false);
    });
  });

  describe('mergeUserAccounts', () => {
    it('merges user-b into user-a: absorbs line_id, sums stats, migrates records', async () => {
      const ok = await mod.mergeUserAccounts('user-a', 'user-b');
      expect(ok).toBe(true);

      const survivor = store.auth_users.get('user-a')!;
      expect(survivor.line_id).toBe('ln-bbb');
      expect(survivor.total_games).toBe(15);
      expect(survivor.games_won).toBe(8);
      expect(survivor.games_lost).toBe(7);
      expect(survivor.elo_rating).toBe(1200);
      expect(survivor.badges).toEqual(expect.arrayContaining(['first_win', 'loyal_defender']));
      expect((survivor.badges as string[]).length).toBe(2);

      expect(store.auth_users.get('user-b')).toBeUndefined();

      // game_records playerId rewritten
      const recs = Array.from(store.games.values()).filter((r) => r.playerId === 'user-a');
      expect(recs).toHaveLength(3);

      // friendships rewritten + self-follow pruned
      const f = Array.from(store.friendships.values());
      expect(f.some((r) => r.follower_id === 'user-a' && r.following_id === 'user-a')).toBe(false);
      expect(f.some((r) => r.follower_id === 'user-c' && r.following_id === 'user-a')).toBe(true);
    });

    it('refuses to merge into itself', async () => {
      const ok = await mod.mergeUserAccounts('user-a', 'user-a');
      expect(ok).toBe(false);
    });

    it('returns false when either side is missing', async () => {
      const ok = await mod.mergeUserAccounts('user-a', 'ghost-z');
      expect(ok).toBe(false);
    });
  });

  describe('#42 bind-path fix — absorbGuestIntoUser', () => {
    it('rewrites games.playerId + friendships from guestUid → realUserId', async () => {
      // Seed a guest-owned game record + friendship row pointing to a third party
      // (user-c) so the rewrite doesn't collapse into a self-follow and trigger
      // the prune branch (that case is covered separately below).
      store.games.set('gGuest', { playerId: 'guest-uuid-1', role: 'merlin', won: true });
      store.friendships.set('frGuest', { follower_id: 'guest-uuid-1', following_id: 'user-c' });

      const ok = await mod.absorbGuestIntoUser('guest-uuid-1', 'user-a');
      expect(ok).toBe(true);

      // game_records rewritten
      const rec = store.games.get('gGuest')!;
      expect(rec.playerId).toBe('user-a');

      // friendships rewritten — now user-a → user-c (not self-follow, preserved)
      const fr = store.friendships.get('frGuest')!;
      expect(fr.follower_id).toBe('user-a');
      expect(fr.following_id).toBe('user-c');

      // user row NOT deleted (訪客沒有 row，absorb 只搬資料)
      expect(store.auth_users.get('user-a')).toBeDefined();
    });

    it('prunes self-follow rows created by rewrite', async () => {
      // guest follows user-a; after absorb, would create user-a → user-a self-follow
      store.friendships.set('frSelf', { follower_id: 'guest-x', following_id: 'user-a' });

      await mod.absorbGuestIntoUser('guest-x', 'user-a');

      const rows = Array.from(store.friendships.values());
      expect(rows.some((r) => r.follower_id === 'user-a' && r.following_id === 'user-a')).toBe(false);
    });

    it('refuses no-op (guestUid === realUserId)', async () => {
      const ok = await mod.absorbGuestIntoUser('same', 'same');
      expect(ok).toBe(false);
    });
  });

  describe('#42 bind-path fix — ensureAuthUserWithProvider', () => {
    it('creates a new auth_users doc when identity is fresh', async () => {
      const id = await mod.ensureAuthUserWithProvider(
        'discord', 'dc-new', 'Newbie', 'https://cdn.example/avatar.png', 'new@ex.com',
      );
      expect(id).toBe('dc-new');
      const row = store.auth_users.get('dc-new')!;
      expect(row.provider).toBe('discord');
      expect(row.discord_id).toBe('dc-new');
      expect(row.display_name).toBe('Newbie');
      expect(row.photo_url).toBe('https://cdn.example/avatar.png');
      expect(row.elo_rating).toBe(1000);
      expect(row.total_games).toBe(0);
    });

    it('updates existing doc if externalId matches its docId', async () => {
      store.auth_users.set('dc-aaa', {
        provider: 'discord', discord_id: 'dc-aaa', display_name: 'OldName',
        elo_rating: 1500, total_games: 20,
      });
      const id = await mod.ensureAuthUserWithProvider('discord', 'dc-aaa', 'NewName');
      expect(id).toBe('dc-aaa');
      const row = store.auth_users.get('dc-aaa')!;
      expect(row.display_name).toBe('NewName');
      // 既有戰績不被覆寫
      expect(row.elo_rating).toBe(1500);
      expect(row.total_games).toBe(20);
    });
  });

  describe('OAuth sessions', () => {
    it('create + consume round-trip returns the linkUserId', async () => {
      await mod.createOAuthSession('state-1', 'discord', 'user-a');
      const s = await mod.consumeOAuthSession('state-1', 'discord');
      // #42 bind-path fix：新增 isGuest 欄位，預設 false
      expect(s).toEqual({ linkUserId: 'user-a', isGuest: false });
      // single-use: second consume returns null
      expect(await mod.consumeOAuthSession('state-1', 'discord')).toBeNull();
    });

    it('propagates isGuest=true when createOAuthSession flags guest bind', async () => {
      await mod.createOAuthSession('state-guest', 'discord', 'guest-uuid', true);
      const s = await mod.consumeOAuthSession('state-guest', 'discord');
      expect(s).toEqual({ linkUserId: 'guest-uuid', isGuest: true });
    });

    it('rejects wrong provider', async () => {
      await mod.createOAuthSession('state-2', 'discord');
      const s = await mod.consumeOAuthSession('state-2', 'line');
      expect(s).toBeNull();
    });

    it('rejects expired sessions', async () => {
      await mod.createOAuthSession('state-3', 'line');
      // tamper stored expiresAt into the past
      const row = store.oauth_sessions.get('state-3')!;
      row.expiresAt = Date.now() - 1000;
      const s = await mod.consumeOAuthSession('state-3', 'line');
      expect(s).toBeNull();
    });

    it('verifyAndDeleteOAuthSession wrapper returns boolean', async () => {
      await mod.createOAuthSession('state-4', 'discord');
      expect(await mod.verifyAndDeleteOAuthSession('state-4', 'discord')).toBe(true);
      expect(await mod.verifyAndDeleteOAuthSession('state-4', 'discord')).toBe(false);
    });
  });
});
