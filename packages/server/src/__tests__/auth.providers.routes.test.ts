/**
 * GET /auth/providers (2026-10-13): the web shows a Google / Discord / LINE
 * button only when this deployment can finish that flow. Players took the
 * failing LINE / Discord buttons for "the stats need a login".
 *
 * Here: Discord has the Application ID only (as render.yaml pre-fills it), LINE
 * has the channel id only, Firebase admin is off → all three false, and the
 * LINE routes answer 503 like Discord's instead of redirecting to LINE.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-providers';
process.env.DISCORD_CLIENT_ID = '1138799027664732180';
delete process.env.DISCORD_CLIENT_SECRET;
process.env.LINE_CHANNEL_ID = 'test-line-channel-only';
delete process.env.LINE_CHANNEL_SECRET;
process.env.FRONTEND_URL = 'https://test-frontend.example.com';

const createOAuthSessionMock = vi.fn();

vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => false,
  getAdminFirestore: () => null,
  verifyIdToken: vi.fn(),
  initializeFirebase: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
  upsertUser: vi.fn().mockResolvedValue('stub-id'),
  createOAuthSession: createOAuthSessionMock,
  consumeOAuthSession: vi.fn().mockResolvedValue(null),
  findUserIdByProviderIdentity: vi.fn().mockResolvedValue(null),
  linkProviderIdentity: vi.fn().mockResolvedValue(false),
  mergeUserAccounts: vi.fn().mockResolvedValue(false),
  absorbGuestIntoUser: vi.fn().mockResolvedValue(false),
  ensureUserForProviderIdentity: vi.fn().mockResolvedValue(null),
  ensureSupabaseUserForFirebase: vi.fn().mockResolvedValue(null),
  isSupabaseReady: () => false,
}));

vi.mock('../services/mailer', () => ({
  sendPasswordResetEmail: vi.fn(async () => ({ ok: true, messageId: 'stub' })),
  sendEmailVerificationEmail: vi.fn(),
  sendMail: vi.fn(),
  isMailerReady: vi.fn().mockResolvedValue(true),
  __setMailerForTest: vi.fn(),
}));

let app: Express;

beforeAll(async () => {
  const { authRouter } = await import('../routes/auth');
  app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
});

describe('GET /auth/providers', () => {
  it('reports every OAuth flow that cannot complete as false (public, no token needed)', async () => {
    const res = await request(app).get('/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discord: false, line: false, google: false });
    expect(res.headers['cache-control']).toContain('max-age');
  });
});

describe('LINE OAuth guard with a channel id but no secret', () => {
  it.each(['/auth/line', '/auth/oauth/login/line', '/auth/link/line'])(
    'GET %s → 503 "Line Login 未設定", no redirect to LINE',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Line Login 未設定' });
      expect(res.headers.location).toBeUndefined();
    },
  );

  it('never creates an OAuth session', () => {
    expect(createOAuthSessionMock).not.toHaveBeenCalled();
  });
});
