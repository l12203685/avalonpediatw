/**
 * GET /auth/providers when Discord and LINE are fully configured and Firebase
 * admin is up: all three true (the web then shows the buttons again).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-providers-ready';
process.env.DISCORD_CLIENT_ID = 'test-discord-client';
process.env.DISCORD_CLIENT_SECRET = 'test-discord-secret';
process.env.LINE_CHANNEL_ID = 'test-line-client';
process.env.LINE_CHANNEL_SECRET = 'test-line-secret';

vi.mock('../services/firebase', () => ({
  isFirebaseAdminReady: () => true,
  getAdminFirestore: () => null,
  verifyIdToken: vi.fn(),
  initializeFirebase: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
  upsertUser: vi.fn().mockResolvedValue('stub-id'),
  createOAuthSession: vi.fn(),
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

describe('GET /auth/providers (all configured)', () => {
  it('reports discord, line and google as ready', async () => {
    const res = await request(app).get('/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discord: true, line: true, google: true });
  });

  it('LINE login redirects to LINE once the secret is there', async () => {
    const res = await request(app).get('/auth/line');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/access\.line\.me\//);
  });
});
