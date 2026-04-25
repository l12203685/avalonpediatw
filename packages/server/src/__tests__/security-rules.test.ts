// ============================================================================
// Avalon Pedia TW — Firebase security-rules regression tests
// ----------------------------------------------------------------------------
// Two layers:
//
//   1. STATIC layer (always runs): parses firestore.rules + database.rules.json
//      and asserts structural invariants so future edits cannot accidentally
//      loosen the lockdown (for example by re-introducing `allow ... if true`).
//
//   2. EMULATOR layer (opt-in): when the Firebase emulator is running and
//      @firebase/rules-unit-testing is available, runs live allow/deny checks
//      against the rules via initializeTestEnvironment. Skipped by default
//      because the emulator needs a Java runtime that this environment may
//      not have.
//
// To run the emulator layer locally:
//
//   pnpm --filter @avalon/server add -D @firebase/rules-unit-testing
//   firebase emulators:start --only firestore,database
//   AVALON_RULES_EMULATOR=1 pnpm --filter @avalon/server test \
//     -- src/__tests__/security-rules.test.ts
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// File loading helpers — rules live at the repo root.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, '../../../..');
const FIRESTORE_RULES_PATH = join(REPO_ROOT, 'firestore.rules');
const RTDB_RULES_PATH = join(REPO_ROOT, 'database.rules.json');

function loadFirestoreRules(): string {
  return readFileSync(FIRESTORE_RULES_PATH, 'utf8');
}

function loadRtdbRules(): { raw: string; json: Record<string, unknown> } {
  const raw = readFileSync(RTDB_RULES_PATH, 'utf8');
  // database.rules.json officially allows // comments. Strip them before
  // JSON.parse. Keep it simple: line comments only (no block comments used).
  const stripped = raw
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return { raw, json: JSON.parse(stripped) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Static invariants — Firestore
// ---------------------------------------------------------------------------

describe('firestore.rules — static invariants', () => {
  const rules = loadFirestoreRules();

  it('declares rules_version = "2"', () => {
    expect(rules).toMatch(/rules_version\s*=\s*['"]2['"]/);
  });

  it('never contains an unconditional `if true` allow', () => {
    // Look for `allow <anything> : if true` in any form. Comments are fine,
    // but the live rule body must never be unconditionally permissive.
    const stripped = rules.replace(/\/\/[^\n]*/g, ''); // drop line comments
    expect(stripped).not.toMatch(/allow[^;]*if\s+true\b/);
  });

  it('has a default-deny catch-all match /{document=**}', () => {
    expect(rules).toMatch(/match\s+\/\{document=\*\*\}\s*\{[^}]*allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;/s);
  });

  it('explicitly denies client access to games/{gameId}', () => {
    // Accept any of read|write|read,write being denied; the test above
    // already proves nothing is open.
    const gamesBlock = rules.match(/match\s+\/games\/\{gameId\}\s*\{[\s\S]*?^\s*\}/m);
    expect(gamesBlock, 'games/{gameId} rule block must exist').not.toBeNull();
    expect(gamesBlock![0]).toMatch(/allow\s+read\s*,\s*write\s*:\s*if\s+false/);
  });

  it('explicitly denies client access to replays/{gameId}', () => {
    const replaysBlock = rules.match(/match\s+\/replays\/\{gameId\}\s*\{[\s\S]*?^\s*\}/m);
    expect(replaysBlock, 'replays/{gameId} rule block must exist').not.toBeNull();
    expect(replaysBlock![0]).toMatch(/allow\s+read\s*,\s*write\s*:\s*if\s+false/);
  });

  it('has a users/{uid} block (deny-by-default placeholder)', () => {
    const usersBlock = rules.match(/match\s+\/users\/\{uid\}\s*\{[\s\S]*?^\s*\}/m);
    expect(usersBlock, 'users/{uid} rule block must exist').not.toBeNull();
    // Placeholder today: fully denied. If opened later, this test must be
    // updated and the emulator suite extended.
    expect(usersBlock![0]).toMatch(/allow\s+read\s*,\s*write\s*:\s*if\s+false/);
  });
});

// ---------------------------------------------------------------------------
// Static invariants — Realtime Database
// ---------------------------------------------------------------------------

describe('database.rules.json — static invariants', () => {
  const { raw, json } = loadRtdbRules();

  it('parses as JSON (after stripping // comments)', () => {
    expect(json).toBeTypeOf('object');
    expect(json.rules).toBeTypeOf('object');
  });

  it('root .read / .write are false (deny-by-default)', () => {
    const rules = json.rules as Record<string, unknown>;
    expect(rules['.read']).toBe(false);
    expect(rules['.write']).toBe(false);
  });

  it('never contains an unconditional "true" rule', () => {
    // Strip whitespace/comments and search for `: true` on any rule key.
    // Any rule like `".read": true` would be an unconditional grant.
    const stripped = raw.replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toMatch(/"\.(read|write)"\s*:\s*true/);
  });

  it('rooms/ and rankings/ are fully server-only', () => {
    const rules = json.rules as Record<string, Record<string, unknown>>;
    expect(rules.rooms['.read']).toBe(false);
    expect(rules.rooms['.write']).toBe(false);
    expect(rules.rankings['.read']).toBe(false);
    expect(rules.rankings['.write']).toBe(false);
  });

  it('users/$uid owner-scoped read, server-only write', () => {
    const users = (json.rules as Record<string, Record<string, Record<string, unknown>>>).users;
    expect(users['.read']).toBe(false);
    expect(users['.write']).toBe(false);
    expect(users.$uid['.read']).toBe('auth != null && auth.uid === $uid');
    expect(users.$uid['.write']).toBe(false);
  });

  it('user-stats/$uid owner-scoped read, server-only write', () => {
    const stats = (json.rules as Record<string, Record<string, Record<string, unknown>>>)['user-stats'];
    expect(stats['.read']).toBe(false);
    expect(stats['.write']).toBe(false);
    expect(stats.$uid['.read']).toBe('auth != null && auth.uid === $uid');
    expect(stats.$uid['.write']).toBe(false);
  });

  it('presence/$uid owner-scoped read+write with required-field validation', () => {
    const presence = (json.rules as Record<string, Record<string, Record<string, unknown>>>).presence;
    expect(presence['.read']).toBe(false);
    expect(presence['.write']).toBe(false);
    expect(presence.$uid['.read']).toBe('auth != null && auth.uid === $uid');
    expect(presence.$uid['.write']).toBe('auth != null && auth.uid === $uid');
    expect(presence.$uid['.validate']).toMatch(/hasChildren\(\[['"]online['"],\s*['"]lastSeen['"]\]\)/);
    // online must be boolean; lastSeen must be a recent number (append-only-ish).
    const presenceOnline = presence.$uid.online as Record<string, unknown> | undefined;
    expect(presenceOnline).toBeDefined();
    expect(presenceOnline!['.validate']).toContain('newData.isBoolean()');
    const presenceLastSeen = presence.$uid.lastSeen as Record<string, unknown> | undefined;
    expect(presenceLastSeen).toBeDefined();
    expect(presenceLastSeen!['.validate']).toContain('newData.isNumber()');
  });

  it('rankings/$uid declares a schema validator so server writes are structurally sound', () => {
    const rankings = (json.rules as Record<string, Record<string, Record<string, unknown>>>).rankings;
    const ranker = rankings.$uid as Record<string, unknown>;
    expect(ranker['.validate']).toContain('eloRating');
    expect(ranker['.validate']).toContain('totalGames');
  });
});

// ---------------------------------------------------------------------------
// Emulator layer (opt-in). Skipped unless AVALON_RULES_EMULATOR=1 and the
// @firebase/rules-unit-testing module is installed. Provided here as a
// ready-to-run scaffold rather than a live test, because the baseline CI
// environment does not include the Java runtime that the Firebase emulator
// requires.
// ---------------------------------------------------------------------------

const EMULATOR_ENABLED = process.env.AVALON_RULES_EMULATOR === '1';

describe.skipIf(!EMULATOR_ENABLED)('firestore + rtdb rules — emulator layer', () => {
  // Note: dynamic import so missing devDep doesn't break the static layer.
  it('denies anonymous reads/writes on games/ and replays/', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rut: any;
    try {
      rut = await import('@firebase/rules-unit-testing');
    } catch {
      // Test skipped at runtime if module missing even though env flag is set.
      expect.fail(
        '@firebase/rules-unit-testing is not installed. Run ' +
          '`pnpm --filter @avalon/server add -D @firebase/rules-unit-testing` first.'
      );
    }

    const env = await rut.initializeTestEnvironment({
      projectId: 'demo-avalon-rules',
      firestore: {
        rules: loadFirestoreRules(),
        host: '127.0.0.1',
        port: 8080,
      },
      database: {
        rules: JSON.stringify((loadRtdbRules()).json),
        host: '127.0.0.1',
        port: 9000,
      },
    });

    try {
      const anon = env.unauthenticatedContext();
      const anonFs = anon.firestore();

      // Anonymous read of games/* must be denied.
      await rut.assertFails(anonFs.collection('games').doc('any').get());
      // Anonymous write of games/* must be denied.
      await rut.assertFails(anonFs.collection('games').doc('any').set({ gameId: 'x' }));
      // Anonymous read of replays/* must be denied.
      await rut.assertFails(anonFs.collection('replays').doc('any').get());
      // Arbitrary unknown collection still denied by default-deny catch-all.
      await rut.assertFails(anonFs.collection('mystery').doc('x').set({ foo: 1 }));

      // Signed-in user cannot read games/* directly either (server-only today).
      const alice = env.authenticatedContext('alice');
      await rut.assertFails(alice.firestore().collection('games').doc('any').get());
    } finally {
      await env.cleanup();
    }
  });

  it('allows presence/$uid owner write, denies non-owner write', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rut: any;
    try {
      rut = await import('@firebase/rules-unit-testing');
    } catch {
      expect.fail('@firebase/rules-unit-testing missing');
    }

    const env = await rut.initializeTestEnvironment({
      projectId: 'demo-avalon-rules',
      database: {
        rules: JSON.stringify((loadRtdbRules()).json),
        host: '127.0.0.1',
        port: 9000,
      },
    });

    try {
      const alice = env.authenticatedContext('alice').database();
      // Owner can write own presence.
      await rut.assertSucceeds(
        alice.ref('presence/alice').set({ online: true, lastSeen: Date.now() })
      );
      // Owner cannot write somebody else's presence.
      await rut.assertFails(
        alice.ref('presence/bob').set({ online: true, lastSeen: Date.now() })
      );
      // Missing required children -> validation fails.
      await rut.assertFails(alice.ref('presence/alice').set({ online: true }));
    } finally {
      await env.cleanup();
    }
  });
});
