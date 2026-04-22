/**
 * Ticket #42 — Multi-account binding + merge.
 *
 * Tests the Supabase service helpers by mocking `@supabase/supabase-js`'s
 * createClient so the real getSupabaseClient() returns our in-memory stub.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// Set BEFORE importing supabase module so its module-scoped SUPABASE_URL isn't empty.
// (Must happen statically — test file top-level runs before dynamic imports below.)
process.env.SUPABASE_URL = 'http://stub';
process.env.SUPABASE_SERVICE_KEY = 'stub';

// ---------------------------------------------------------------------------
// In-memory table state (rebuilt per test)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
interface TableState { rows: Row[] }

let tables: Record<string, TableState>;

// ---------------------------------------------------------------------------
// Minimal Supabase query builder stub
// ---------------------------------------------------------------------------

function makeClient() {
  function from(table: string) {
    const state = tables[table] ?? { rows: [] };
    tables[table] = state;

    interface Filter { col: string; op: 'eq' | 'in'; val: unknown }
    const filters: Filter[] = [];
    let action: 'select' | 'update' | 'delete' | 'insert' | null = null;
    let patch: Row | null = null;

    const matches = (r: Row): boolean =>
      filters.every((f) => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'in') return (f.val as unknown[]).includes(r[f.col]);
        return true;
      });

    const listResultThenable = {
      then<T>(resolve: (v: { data: Row[] | null; error: null }) => T) {
        const rows = state.rows.filter(matches);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };

    const singleResult = () => {
      const rows = state.rows.filter(matches);
      if (rows.length === 0) return Promise.resolve({ data: null, error: { message: 'not found' } });
      return Promise.resolve({ data: rows[0], error: null });
    };

    // Chainable select
    const selectChain = () => ({
      eq(col: string, val: unknown) {
        filters.push({ col, op: 'eq', val });
        return {
          eq(col2: string, val2: unknown) {
            filters.push({ col: col2, op: 'eq', val: val2 });
            return {
              single: singleResult,
              then<T>(resolve: (v: { data: Row[] | null; error: null }) => T) {
                return listResultThenable.then(resolve);
              },
            };
          },
          single: singleResult,
          then<T>(resolve: (v: { data: Row[] | null; error: null }) => T) {
            return listResultThenable.then(resolve);
          },
        };
      },
      in(col: string, val: unknown) {
        filters.push({ col, op: 'in', val });
        return listResultThenable;
      },
    });

    return {
      select(_cols: string) {
        action = 'select';
        return selectChain();
      },
      update(p: Row) {
        action = 'update';
        patch = p;
        return {
          eq(col: string, val: unknown) {
            filters.push({ col, op: 'eq', val });
            const rows = state.rows.filter(matches);
            for (const r of rows) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      delete() {
        action = 'delete';
        const doDelete = () => {
          const keep = state.rows.filter((r) => !matches(r));
          state.rows.length = 0;
          state.rows.push(...keep);
          return Promise.resolve({ data: null, error: null });
        };
        const chain = {
          eq(col: string, val: unknown) {
            filters.push({ col, op: 'eq', val });
            return {
              eq(col2: string, val2: unknown) {
                filters.push({ col: col2, op: 'eq', val: val2 });
                return doDelete();
              },
              then<T>(resolve: (v: { data: null; error: null }) => T) {
                return doDelete().then(resolve);
              },
            };
          },
        };
        return chain;
      },
      insert(row: Row) {
        action = 'insert';
        state.rows.push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  /**
   * RPC stub: simulates the merge_user_accounts plpgsql function in JavaScript.
   * This mirrors the logic in supabase/migrations/20260422150000_merge_user_accounts_rpc.sql.
   */
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn === 'merge_user_accounts') {
      const primaryId   = params.p_primary_id   as string;
      const secondaryId = params.p_secondary_id as string;
      if (primaryId === secondaryId) {
        return Promise.resolve({ data: false, error: null });
      }
      const usersState = tables['users'] ?? { rows: [] };
      const primary   = usersState.rows.find((r) => r.id === primaryId) as Row | undefined;
      const secondary = usersState.rows.find((r) => r.id === secondaryId) as Row | undefined;
      if (!primary || !secondary) {
        return Promise.resolve({ data: false, error: null });
      }
      // Merge stats
      primary.elo_rating  = Math.max((primary.elo_rating as number) ?? 1000, (secondary.elo_rating as number) ?? 1000);
      primary.total_games = ((primary.total_games as number) ?? 0) + ((secondary.total_games as number) ?? 0);
      primary.games_won   = ((primary.games_won   as number) ?? 0) + ((secondary.games_won   as number) ?? 0);
      primary.games_lost  = ((primary.games_lost  as number) ?? 0) + ((secondary.games_lost  as number) ?? 0);
      primary.badges      = Array.from(new Set([
        ...((primary.badges as string[]) ?? []),
        ...((secondary.badges as string[]) ?? []),
      ]));
      // Absorb provider fields
      for (const col of ['discord_id', 'line_id', 'firebase_uid', 'email'] as const) {
        const pv = primary[col];
        const sv = secondary[col];
        if ((pv === null || pv === undefined || pv === '') && typeof sv === 'string' && sv.length > 0) {
          primary[col] = sv;
        }
      }
      // Clear secondary unique fields
      secondary.discord_id = null;
      secondary.line_id    = null;
      secondary.firebase_uid = null;
      // Migrate game_records
      const gr = tables['game_records'] ?? { rows: [] };
      for (const r of gr.rows) {
        if (r.player_user_id === secondaryId) r.player_user_id = primaryId;
      }
      // Migrate friendships
      const fs = tables['friendships'] ?? { rows: [] };
      for (const r of fs.rows) {
        if (r.follower_id  === secondaryId) r.follower_id  = primaryId;
        if (r.following_id === secondaryId) r.following_id = primaryId;
      }
      // Remove self-following
      fs.rows = fs.rows.filter((r) => !(r.follower_id === primaryId && r.following_id === primaryId));
      tables['friendships'] = fs;
      // Remove duplicate pairs (keep first)
      const seen = new Set<string>();
      fs.rows = fs.rows.filter((r) => {
        const key = `${r.follower_id}|${r.following_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      tables['friendships'] = fs;
      // Delete secondary user
      usersState.rows = usersState.rows.filter((r) => r.id !== secondaryId);
      return Promise.resolve({ data: true, error: null });
    }

    if (fn === 'consume_oauth_session') {
      // Not exercised by mergeUserAccounts tests — return empty
      return Promise.resolve({ data: [], error: null });
    }

    return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
  }

  return { from, rpc };
}

// Mock the createClient so real supabase.ts's getSupabaseClient returns our stub
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeClient() as unknown,
}));

// Dynamic-import the supabase module AFTER process.env above has been set,
// since its module-scoped constants read env at load time.
type SupabaseModule = typeof import('../services/supabase');
let mod: SupabaseModule;

describe('#42 Multi-account binding — service helpers', () => {
  beforeAll(async () => {
    mod = await import('../services/supabase');
  });

  beforeEach(() => {
    tables = {
      users: {
        rows: [
          {
            id: 'user-a', provider: 'discord',
            discord_id: 'dc-aaa', line_id: null, firebase_uid: null,
            email: 'a@ex.com',
            elo_rating: 1200, total_games: 10, games_won: 6, games_lost: 4,
            badges: ['first_win'],
          },
          {
            id: 'user-b', provider: 'line',
            discord_id: null, line_id: 'ln-bbb', firebase_uid: null,
            email: 'b@ex.com',
            elo_rating: 1100, total_games: 5, games_won: 2, games_lost: 3,
            badges: ['first_win', 'loyal_defender'],
          },
        ],
      },
      game_records: {
        rows: [
          { id: 'g1', player_user_id: 'user-a', role: 'merlin',   won: true  },
          { id: 'g2', player_user_id: 'user-b', role: 'assassin', won: false },
          { id: 'g3', player_user_id: 'user-b', role: 'loyal',    won: true  },
        ],
      },
      friendships: {
        rows: [
          { follower_id: 'user-a', following_id: 'user-b' },
          { follower_id: 'user-c', following_id: 'user-b' },
        ],
      },
    };
  });

  describe('getLinkedAccounts', () => {
    it('reports primary discord binding for user-a, line+google unbound', async () => {
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
      const after = tables.users.rows.find((r) => r.id === 'user-a')!;
      expect(after.firebase_uid).toBe('fb-xyz');

      expect(await mod.unlinkProviderIdentity('user-a', 'google')).toBe(true);
      const after2 = tables.users.rows.find((r) => r.id === 'user-a')!;
      expect(after2.firebase_uid).toBeNull();
    });
  });

  describe('mergeUserAccounts', () => {
    it('merges user-b into user-a: absorbs line_id, sums stats, migrates records', async () => {
      const ok = await mod.mergeUserAccounts('user-a', 'user-b');
      expect(ok).toBe(true);

      const survivor = tables.users.rows.find((r) => r.id === 'user-a')!;
      expect(survivor.line_id).toBe('ln-bbb');
      expect(survivor.total_games).toBe(15);
      expect(survivor.games_won).toBe(8);
      expect(survivor.games_lost).toBe(7);
      expect(survivor.elo_rating).toBe(1200);
      expect(survivor.badges).toEqual(expect.arrayContaining(['first_win', 'loyal_defender']));
      expect((survivor.badges as string[]).length).toBe(2);

      expect(tables.users.rows.find((r) => r.id === 'user-b')).toBeUndefined();

      const recs = tables.game_records.rows.filter((r) => r.player_user_id === 'user-a');
      expect(recs).toHaveLength(3);

      const f = tables.friendships.rows;
      expect(f.some((r) => r.follower_id === 'user-a' && r.following_id === 'user-a')).toBe(false);
      expect(f.some((r) => r.follower_id === 'user-c' && r.following_id === 'user-a')).toBe(true);
    });

    it('refuses to merge into itself', async () => {
      const ok = await mod.mergeUserAccounts('user-a', 'user-a');
      expect(ok).toBe(false);
    });
  });
});
