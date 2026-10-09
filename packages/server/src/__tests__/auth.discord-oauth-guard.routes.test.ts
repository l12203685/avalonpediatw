/**
 * Discord OAuth routes must stay "not configured" (503) when only the
 * Application ID is present.
 *
 * render.yaml pre-fills DISCORD_CLIENT_ID because the Discord bot needs it to
 * register slash commands (2026-10-09). Login / link additionally need
 * DISCORD_CLIENT_SECRET for the code exchange; without it the old guard
 * (`if (!DISCORD_CLIENT_ID)`) would let users through Discord's consent screen
 * only to fail on the callback.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-discord-guard';
process.env.DISCORD_CLIENT_ID = '1138799027664732180';
delete process.env.DISCORD_CLIENT_SECRET;
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

describe('Discord OAuth guard with Application ID but no client secret', () => {
  it.each(['/auth/discord', '/auth/oauth/login/discord', '/auth/link/discord'])(
    'GET %s → 503 "Discord OAuth 未設定", no OAuth session, no redirect to Discord',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Discord OAuth 未設定' });
      expect(res.headers.location).toBeUndefined();
    },
  );

  it('never creates an OAuth session', () => {
    expect(createOAuthSessionMock).not.toHaveBeenCalled();
  });
});
