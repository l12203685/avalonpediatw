/**
 * HTTP-level tests for `stats.ts` `resolveSelfId` — the auth helper shared by
 * `/api/stats/pair/:opponentId`, `/api/stats/pair-batch`, and `/api/stats/timeline`.
 *
 * Before 2026-04-24 the Firebase branch returned the raw Firebase uid, but
 * downstream `GameHistoryRepository.listPlayerGames` keys on Supabase UUID
 * (`users.id`). On socket reconnect, Google-login users' stored Bearer token is
 * swapped to a Firebase ID token (see `packages/web/src/services/socket.ts`
 * reconnect_attempt handler), so all three stats endpoints returned empty for
 * Google users despite their games existing in Firestore. This suite is the
 * regression guard for the `getSupabaseIdByFirebaseUid` mapping.
 *
 * Tests cover:
 *   Path 1 — custom JWT (Discord/Line/password): sub IS the Supabase UUID
 *   Path 2 — Firebase ID token: firebase_uid → mapped to Supabase UUID
 *   Path 2b — Firebase ID token with no Supabase row: returns null → 401
 *   Invalid — neither JWT nor Firebase verifies: returns null → 401
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { sign } from 'jsonwebtoken';

// ── Env bootstrap ────────────────────────────────────────────────
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-stats-routes';

// ── Module mocks ────────────────────────────────────────────────

const verifyIdTokenMock = vi.fn();
const getSupabaseIdByFirebaseUidMock = vi.fn();
const listPlayerGamesMock = vi.fn();

vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => true,
  verifyIdToken:        verifyIdTokenMock,
}));

vi.mock('../services/supabase', () => ({
  getSupabaseIdByFirebaseUid: getSupabaseIdByFirebaseUidMock,
}));

vi.mock('../services/GameHistoryRepository', () => ({
  GameHistoryRepository: function GameHistoryRepositoryMock() {
    return {
      listPlayerGames: listPlayerGamesMock,
    };
  },
}));

// Rate-limit middleware is pure and has no external deps — no need to mock.

// ── App factory ─────────────────────────────────────────────────

let app: Express;

beforeAll(async () => {
  const { statsRouter } = await import('../routes/stats');
  app = express();
  app.use(express.json());
  app.use('/api/stats', statsRouter);
});

beforeEach(() => {
  verifyIdTokenMock.mockReset();
  getSupabaseIdByFirebaseUidMock.mockReset();
  listPlayerGamesMock.mockReset();
  listPlayerGamesMock.mockResolvedValue([]); // default: no games recorded
});

function makeCustomJwt(params: { sub: string; provider?: string }): string {
  return sign(
    { sub: params.sub, provider: params.provider ?? 'password' },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );
}

// ── Tests ───────────────────────────────────────────────────────

describe('stats.resolveSelfId — Path 1 (custom JWT)', () => {
  it('custom JWT provider=password → selfId is payload.sub (no supabase lookup)', async () => {
    const supaUuid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const jwt = makeCustomJwt({ sub: supaUuid, provider: 'password' });

    const res = await request(app)
      .get('/api/stats/timeline?limit=10')
      .set('Authorization', `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(listPlayerGamesMock).toHaveBeenCalledWith(supaUuid, 10);
    // Firebase mapping must NOT be hit on the JWT happy-path
    expect(getSupabaseIdByFirebaseUidMock).not.toHaveBeenCalled();
  });

  it('custom JWT provider=discord → selfId is payload.sub', async () => {
    const supaUuid = 'bbbbbbbb-1111-2222-3333-555555555555';
    const jwt = makeCustomJwt({ sub: supaUuid, provider: 'discord' });

    const res = await request(app)
      .get('/api/stats/timeline')
      .set('Authorization', `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(listPlayerGamesMock).toHaveBeenCalledWith(supaUuid, 50);
    expect(getSupabaseIdByFirebaseUidMock).not.toHaveBeenCalled();
  });
});

describe('stats.resolveSelfId — Path 2 (Firebase ID token → Supabase UUID)', () => {
  it('Firebase token is mapped via getSupabaseIdByFirebaseUid → Supabase UUID fed to repo', async () => {
    const firebaseUid = 'google-uid-xyz';
    const supaUuid    = 'cccccccc-1111-2222-3333-666666666666';

    verifyIdTokenMock.mockResolvedValueOnce({ uid: firebaseUid });
    getSupabaseIdByFirebaseUidMock.mockResolvedValueOnce(supaUuid);

    const threeSegmentToken = 'header.payload.sig';
    const res = await request(app)
      .get('/api/stats/timeline?limit=25')
      .set('Authorization', `Bearer ${threeSegmentToken}`);

    expect(res.status).toBe(200);
    expect(verifyIdTokenMock).toHaveBeenCalledWith(threeSegmentToken);
    expect(getSupabaseIdByFirebaseUidMock).toHaveBeenCalledWith(firebaseUid);
    // Critical assertion: downstream gets Supabase UUID, NOT firebase uid
    expect(listPlayerGamesMock).toHaveBeenCalledWith(supaUuid, 25);
  });

  it('Firebase token also maps correctly for /api/stats/pair/:opponentId', async () => {
    const firebaseUid = 'google-uid-pair';
    const supaUuid    = 'dddddddd-1111-2222-3333-777777777777';

    verifyIdTokenMock.mockResolvedValueOnce({ uid: firebaseUid });
    getSupabaseIdByFirebaseUidMock.mockResolvedValueOnce(supaUuid);

    const res = await request(app)
      .get('/api/stats/pair/opponent-uuid-1')
      .set('Authorization', 'Bearer header.payload.sig');

    expect(res.status).toBe(200);
    expect(listPlayerGamesMock).toHaveBeenCalledWith(supaUuid, 200);
  });

  it('Firebase token also maps correctly for /api/stats/pair-batch', async () => {
    const firebaseUid = 'google-uid-batch';
    const supaUuid    = 'eeeeeeee-1111-2222-3333-888888888888';

    verifyIdTokenMock.mockResolvedValueOnce({ uid: firebaseUid });
    getSupabaseIdByFirebaseUidMock.mockResolvedValueOnce(supaUuid);

    const res = await request(app)
      .get('/api/stats/pair-batch?ids=opp-a,opp-b')
      .set('Authorization', 'Bearer header.payload.sig');

    expect(res.status).toBe(200);
    expect(listPlayerGamesMock).toHaveBeenCalledWith(supaUuid, 200);
  });

  it('Firebase token verifies but has no Supabase mapping → 401 (not silent blank)', async () => {
    verifyIdTokenMock.mockResolvedValueOnce({ uid: 'firebase-no-row' });
    getSupabaseIdByFirebaseUidMock.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/stats/timeline')
      .set('Authorization', 'Bearer header.payload.sig');

    expect(res.status).toBe(401);
    // Must never call the downstream repo when mapping fails — otherwise we'd
    // silently return empty arrays which is exactly the original bug behavior
    expect(listPlayerGamesMock).not.toHaveBeenCalled();
  });
});

describe('stats.resolveSelfId — rejection paths', () => {
  it('invalid three-segment token: not a JWT, Firebase rejects → 401', async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error('bad token'));

    const res = await request(app)
      .get('/api/stats/timeline')
      .set('Authorization', 'Bearer totally.invalid.token');

    expect(res.status).toBe(401);
    expect(listPlayerGamesMock).not.toHaveBeenCalled();
  });

  it('no Authorization header → 401', async () => {
    const res = await request(app).get('/api/stats/timeline');
    expect(res.status).toBe(401);
    expect(listPlayerGamesMock).not.toHaveBeenCalled();
  });

  it('Authorization missing Bearer prefix → 401', async () => {
    const res = await request(app)
      .get('/api/stats/timeline')
      .set('Authorization', 'SomeOtherScheme xyz');

    expect(res.status).toBe(401);
    expect(listPlayerGamesMock).not.toHaveBeenCalled();
  });
});
