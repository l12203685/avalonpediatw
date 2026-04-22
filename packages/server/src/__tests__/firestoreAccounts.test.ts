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

  describe('OAuth sessions', () => {
    it('create + consume round-trip returns the linkUserId', async () => {
      await mod.createOAuthSession('state-1', 'discord', 'user-a');
      const s = await mod.consumeOAuthSession('state-1', 'discord');
      expect(s).toEqual({ linkUserId: 'user-a' });
      // single-use: second consume returns null
      expect(await mod.consumeOAuthSession('state-1', 'discord')).toBeNull();
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
