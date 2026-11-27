import express from 'express';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getKnight,
  knightTuningOverrides,
  listKnights,
  setLiveKnightAdjustProvider,
} from '../arena/knights';
import { createKnightsRouter } from '../routes/knights';
import {
  buildPublicKnightsPayload,
  GitHubPlayerKnightsBackend,
  MemoryPlayerKnightsBackend,
  PLAYER_KNIGHTS_PATH,
  playerKnightsRepoConfig,
  PlayerKnightsStore,
  validatePlayerKnightAdjust,
} from '../services/playerKnightsStore';
import {
  resolveAuthenticatedKnightUser,
  resolveKnightAdminEmail,
} from '../services/knightAdminAuth';
import type { AccountRecord } from '../services/githubAuthAccounts';

const TEST_JWT_SECRET = 'test-player-knights-secret';

function makeToken(payload: { sub: string; displayName: string; provider?: string }): string {
  return sign(
    { sub: payload.sub, displayName: payload.displayName, provider: payload.provider ?? 'email' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeAccount(userId: string, primaryEmail: string): AccountRecord {
  return {
    userId,
    accountName: userId,
    primaryEmail,
    emails: [primaryEmail],
    emailsVerified: [primaryEmail],
    displayName: userId,
    photoUrl: null,
  };
}

function createTestApp(opts: {
  accounts?: Record<string, AccountRecord | null>;
  store?: PlayerKnightsStore;
} = {}) {
  const store = opts.store ?? new PlayerKnightsStore(new MemoryPlayerKnightsBackend());
  const accounts = opts.accounts ?? {
    'uid-admin': makeAccount('uid-admin', 'L12203685@gmail.com'),
    'uid-alice': makeAccount('uid-alice', 'alice@example.com'),
    'uid-bob': makeAccount('uid-bob', 'bob@example.com'),
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/knights',
    createKnightsRouter({
      store,
      disableRateLimit: true,
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        findAccountByUserId: async (uid) => accounts[uid] ?? null,
      },
      findFidelity: (q) => (q.toLowerCase().includes('ed')
        ? {
            knight: 'AI騎士_ED_01',
            generatedAt: '2026-11-26T15:24:48.129Z',
            method: '真人局重播',
            time: {
              overall: { n: 1000, D: 0.81, K: 0.83, V2: 0.86 },
              vote: { n: 400, D: 0.9, K: 0.92, V2: 0.94 },
            },
            half: null,
          }
        : null),
    }),
  );

  return { app, store };
}

afterEach(() => {
  setLiveKnightAdjustProvider(null);
});

describe('playerKnightsStore config & GitHub backend', () => {
  it('reuses GITHUB_ACCOUNTS_* without introducing new env vars', () => {
    expect(playerKnightsRepoConfig({})).toBeNull();
    expect(playerKnightsRepoConfig({ GITHUB_ACCOUNTS_TOKEN: 'tok', GITHUB_ACCOUNTS_REPO: 'badrepo' })).toBeNull();

    const cfg = playerKnightsRepoConfig({
      GITHUB_ACCOUNTS_TOKEN: 'ghp_test',
      GITHUB_ACCOUNTS_REPO: 'l12203685/private-state',
      GITHUB_ACCOUNTS_BRANCH: 'prod',
      GITHUB_API_BASE: 'https://api.github.example',
    });
    expect(cfg).toEqual({
      token: 'ghp_test',
      repo: 'l12203685/private-state',
      branch: 'prod',
      path: PLAYER_KNIGHTS_PATH,
      api: 'https://api.github.example',
    });
    expect(PLAYER_KNIGHTS_PATH).toBe('bot-state/player-knights.json');
  });

  it('reads and writes via GitHubJsonFile and merges on 409 conflict', async () => {
    let remoteState = {
      version: 1,
      updatedAt: '2026-11-27T01:00:00.000Z',
      claims: {},
      knights: {},
    };
    let remoteSha = 'sha-1';
    let putCalls = 0;

    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        const content = Buffer.from(JSON.stringify(remoteState), 'utf8').toString('base64');
        return new Response(JSON.stringify({ content, sha: remoteSha }), { status: 200 });
      }
      putCalls += 1;
      const body = JSON.parse(String(init.body)) as { content: string; sha?: string };
      if (putCalls === 1) {
        // Simulate concurrent write on remote before our first PUT
        remoteSha = 'sha-2';
        return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 });
      }
      expect(body.sha).toBe('sha-2');
      remoteState = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      remoteSha = 'sha-3';
      return new Response(JSON.stringify({ content: { sha: remoteSha } }), { status: 200 });
    }) as unknown as typeof fetch;

    const backend = new GitHubPlayerKnightsBackend(
      {
        token: 'tok',
        repo: 'owner/private-repo',
        branch: 'main',
        path: PLAYER_KNIGHTS_PATH,
        api: 'https://api.github.com',
      },
      fakeFetch,
    );
    const store = new PlayerKnightsStore(backend);
    const res = await store.submitClaim({
      uid: 'uid-alice',
      displayName: 'Alice',
      playerId: 'ED',
      knightId: null,
      note: 'private note',
    });
    expect(res.ok).toBe(true);
    expect(putCalls).toBe(2);
    expect(Object.keys(remoteState.claims)).toHaveLength(1);
  });
});

describe('validatePlayerKnightAdjust', () => {
  it('accepts valid whitelist knobs and residualOff', () => {
    const res = validatePlayerKnightAdjust({
      schema: 1,
      note: '紅方大膽一點',
      source: 'ai-paste',
      overrides: { redNormalVote: 0.65, redR1Teammate: false },
      sides: { good: { goodBayesGood: 0.75 } },
      roles: { merlin: { merlinNormalVote: 0.85 } },
      residualOff: ['vote', 'team'],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.adjust?.overrides).toEqual({ redNormalVote: 0.65, redR1Teammate: false });
    expect(res.adjust?.residualOff).toEqual(['vote', 'team']);
  });

  it('rejects non-whitelist knobs, out-of-range values, URLs, and unknown residualOff actions', () => {
    const res = validatePlayerKnightAdjust({
      schema: 1,
      note: 'see https://evil.example',
      overrides: { notARealKnob: 1, redNormalVote: 1.5, redR1Teammate: 'yes' },
      residualOff: ['hack'],
      extraField: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('notARealKnob'))).toBe(true);
    expect(res.errors.some((e) => e.includes('redNormalVote'))).toBe(true);
    expect(res.errors.some((e) => e.includes('redR1Teammate'))).toBe(true);
    expect(res.errors.some((e) => e.includes('hack'))).toBe(true);
    expect(res.errors.some((e) => e.includes('extraField'))).toBe(true);
    expect(res.errors.some((e) => e.includes('網址'))).toBe(true);
  });
});

describe('knightAdminAuth (GitHub accounts email check without Firestore)', () => {
  it('rejects guest JWT and resolves email/OAuth JWT', async () => {
    const guestToken = makeToken({ sub: 'guest-1', displayName: 'Guest_1', provider: 'guest' });
    expect(await resolveAuthenticatedKnightUser(`Bearer ${guestToken}`, { jwtSecret: TEST_JWT_SECRET })).toBeNull();

    const userToken = makeToken({ sub: 'uid-alice', displayName: 'Alice', provider: 'email' });
    const user = await resolveAuthenticatedKnightUser(`Bearer ${userToken}`, { jwtSecret: TEST_JWT_SECRET });
    expect(user).toEqual({ uid: 'uid-alice', displayName: 'Alice', provider: 'email' });
  });

  it('verifies admin strictly by findAccountByUserId -> primaryEmail against SEED_ADMIN_EMAILS', async () => {
    const adminUser = { uid: 'uid-admin', displayName: 'Edward', provider: 'email' };
    const normalUser = { uid: 'uid-alice', displayName: 'Alice', provider: 'email' };

    const adminEmail = await resolveKnightAdminEmail(adminUser, {
      findAccountByUserId: async () => makeAccount('uid-admin', '  AVALONPEDIATW@GMAIL.COM '),
    });
    expect(adminEmail).toBe('avalonpediatw@gmail.com');

    const nonAdmin = await resolveKnightAdminEmail(normalUser, {
      findAccountByUserId: async () => makeAccount('uid-alice', 'alice@example.com'),
    });
    expect(nonAdmin).toBeNull();

    const missing = await resolveKnightAdminEmail(normalUser, {
      findAccountByUserId: async () => null,
    });
    expect(missing).toBeNull();
  });
});

describe('Knights API: claim lifecycle, admin review, Layer 2 adjust & public privacy', () => {
  it('requires non-guest auth for /me and /claim', async () => {
    const { app } = createTestApp();
    expect((await request(app).get('/api/knights/me')).status).toBe(401);

    const guestToken = makeToken({ sub: 'g-1', displayName: 'Guest', provider: 'guest' });
    expect(
      (await request(app).post('/api/knights/claim').set('Authorization', `Bearer ${guestToken}`).send({ playerId: 'ED' })).status,
    ).toBe(401);
  });

  it('enforces admin-only review and full claim -> approve -> adjust -> public flow without leaking PII', async () => {
    const { app, store } = createTestApp();
    const aliceToken = makeToken({ sub: 'uid-alice', displayName: 'Alice' });
    const bobToken = makeToken({ sub: 'uid-bob', displayName: 'Bob' });
    const adminToken = makeToken({ sub: 'uid-admin', displayName: 'Edward' });

    // 1. Non-admin cannot view admin claims
    const nonAdminList = await request(app)
      .get('/api/knights/admin/claims')
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(nonAdminList.status).toBe(403);

    // 2. Alice submits claim "ED"
    const claimRes = await request(app)
      .post('/api/knights/claim')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ playerId: 'ED', note: 'private-claim-note-do-not-leak' });
    expect(claimRes.status).toBe(201);
    expect(claimRes.body.claim.status).toBe('pending');
    const claimId = claimRes.body.claim.id as string;

    // Duplicate pending claim rejected
    const dupRes = await request(app)
      .post('/api/knights/claim')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ playerId: 'ed' });
    expect(dupRes.status).toBe(409);

    // 3. Before approval, Alice cannot save Layer 2 adjustments
    const prematureAdjust = await request(app)
      .put('/api/knights/me/adjust')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ adjust: { schema: 1, overrides: { redNormalVote: 0.7 } } });
    expect(prematureAdjust.status).toBe(403);

    // Public endpoint must NOT include pending claims
    const pubBefore = await request(app).get('/api/knights/public');
    expect(pubBefore.status).toBe(200);
    expect(pubBefore.body.knights).toEqual([]);

    // 4. Non-admin cannot review claim
    const nonAdminReview = await request(app)
      .post(`/api/knights/admin/claims/${claimId}/review`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ decision: 'approved' });
    expect(nonAdminReview.status).toBe(403);

    // 5. Admin lists pending claims and approves Alice's claim
    const adminList = await request(app)
      .get('/api/knights/admin/claims')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.claims).toHaveLength(1);
    expect(adminList.body.claims[0].id).toBe(claimId);

    const approveRes = await request(app)
      .post(`/api/knights/admin/claims/${claimId}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'approved', reason: '確認本人' });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.claim.status).toBe('approved');
    expect(approveRes.body.claim.reviewedBy).toBe('l12203685@gmail.com');

    // Bob cannot claim already-approved playerId "ED"
    const bobClaim = await request(app)
      .post('/api/knights/claim')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ playerId: 'ED' });
    expect(bobClaim.status).toBe(409);

    // Bob submits another claim and admin rejects it
    const bobOther = await request(app)
      .post('/api/knights/claim')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ playerId: 'PendingOnlyPlayer', note: 'bob-secret-note' });
    expect(bobOther.status).toBe(201);
    const rejectRes = await request(app)
      .post(`/api/knights/admin/claims/${bobOther.body.claim.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'rejected', reason: '資料不符' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.claim.status).toBe('rejected');

    // 6. Alice validates and saves Layer 2 adjust with private note & feedback
    const validateRes = await request(app)
      .post('/api/knights/me/adjust/validate')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        adjust: {
          schema: 1,
          note: 'private-adjust-note-do-not-leak',
          overrides: { redNormalVote: 0.6 },
          sides: { good: { goodBayesGood: 0.72 } },
          residualOff: ['vote'],
        },
      });
    expect(validateRes.status).toBe(200);
    expect(validateRes.body.ok).toBe(true);
    expect(validateRes.body.diffSummary).toContain('redNormalVote=0.6');

    const saveRes = await request(app)
      .put('/api/knights/me/adjust')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        adjust: {
          schema: 1,
          note: 'private-adjust-note-do-not-leak',
          overrides: { redNormalVote: 0.6 },
          sides: { good: { goodBayesGood: 0.72 } },
          residualOff: ['vote'],
        },
        feedback: 'secret-feedback-raw-text-from-alice',
        source: 'web',
      });
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.ok).toBe(true);
    expect(saveRes.body.history).toHaveLength(1);
    expect(saveRes.body.history[0].feedback).toBe('secret-feedback-raw-text-from-alice');

    // 7. Alice fetches /me and sees her knight, fidelity, and history
    const meRes = await request(app)
      .get('/api/knights/me')
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.isAdmin).toBe(false);
    expect(meRes.body.knight.playerId).toBe('ED');
    expect(meRes.body.knight.adjust.overrides.redNormalVote).toBe(0.6);
    expect(meRes.body.knight.history).toHaveLength(1);
    expect(meRes.body.fidelity.knight).toBe('AI騎士_ED_01');

    // 8. Public endpoint GET /api/knights/public exposes ONLY whitelisted knobs and ZERO PII
    const pubAfter = await request(app).get('/api/knights/public');
    expect(pubAfter.status).toBe(200);
    expect(pubAfter.body.schema).toBe(1);
    expect(pubAfter.body.knights).toHaveLength(1);
    expect(pubAfter.body.knights[0]).toMatchObject({
      playerId: 'ED',
      adjust: {
        schema: 1,
        overrides: { redNormalVote: 0.6 },
        sides: { good: { goodBayesGood: 0.72 } },
        residualOff: ['vote'],
      },
    });

    const serialized = JSON.stringify(pubAfter.body);
    expect(serialized).not.toContain('uid-alice');
    expect(serialized).not.toContain('uid-admin');
    expect(serialized).not.toContain('uid-bob');
    expect(serialized).not.toContain('ownerUid');
    expect(serialized).not.toContain('email');
    expect(serialized).not.toContain('l12203685');
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('private-claim-note-do-not-leak');
    expect(serialized).not.toContain('private-adjust-note-do-not-leak');
    expect(serialized).not.toContain('secret-feedback-raw-text-from-alice');
    expect(serialized).not.toContain('bob-secret-note');
    expect(serialized).not.toContain('PendingOnlyPlayer');
    expect(serialized).not.toContain('history');
    expect(serialized).not.toContain('reviewedBy');

    // Direct helper check as well
    const directPublic = buildPublicKnightsPayload(store.getState());
    expect(Object.keys(directPublic.knights[0].adjust)).not.toContain('note');
  });

  it('merges live Layer 2 overlay on top of Layer 1 in knightTuningOverrides', () => {
    const sample = listKnights().find((k) => k.id !== 'baike' && k.profile);
    expect(sample).toBeDefined();
    if (!sample) return;

    const before = knightTuningOverrides(sample.id, 'loyal', 'good');
    setLiveKnightAdjustProvider((knightId) =>
      knightId === sample.id
        ? { overrides: { redNormalVote: 0.42 }, sides: { good: { goodBayesGood: 0.88 } } }
        : null,
    );
    const after = knightTuningOverrides(sample.id, 'loyal', 'good');
    expect(after.redNormalVote).toBe(0.42);
    expect(after.goodBayesGood).toBe(0.88);
    expect(getKnight(sample.id)?.id).toBe(sample.id);
    // Clean up restores original
    setLiveKnightAdjustProvider(null);
    expect(knightTuningOverrides(sample.id, 'loyal', 'good')).toEqual(before);
  });
});
