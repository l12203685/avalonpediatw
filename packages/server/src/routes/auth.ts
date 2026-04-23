/**
 * HTTP `/auth` routes.
 *
 * Phase A new-login rewrite (2026-04-23, Edward arch decision):
 *   - Drop guest mode. All players register with (accountName + password +
 *     primaryEmail) before seeing the lobby.
 *   - Add register / login / forgot-password / reset-password endpoints.
 *   - Keep Discord / Line / Google OAuth paths (including /auth/link/*) so
 *     players who already have a password account can still link social
 *     providers for SSO.
 *   - The old guest endpoints (/auth/guest, /auth/guest/resume,
 *     /auth/guest/rename, /auth/guest/upgrade) are removed. Existing guest
 *     JWTs still validate at the socket layer (middleware/auth.ts) so anyone
 *     mid-game keeps their session; they simply can't mint new guest tokens.
 */

import { Router, Request, Response, IRouter } from 'express';
import { sign, verify, JwtPayload } from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import {
  upsertUser,
  createOAuthSession,
  consumeOAuthSession,
  findUserIdByProviderIdentity,
  linkProviderIdentity,
  mergeUserAccounts,
  absorbGuestIntoUser,
  ensureUserForProviderIdentity,
  type LinkProvider,
} from '../services/supabase';
import {
  registerAccount,
  verifyCredentials,
  findAccountByNameAndEmail,
  createPasswordResetSession,
  consumePasswordResetAndSet,
  PASSWORD_RESET_TTL_MS,
} from '../services/firestoreAuthAccounts';
import {
  validateAccountName,
  validatePasswordStrength,
  validateEmail,
} from '../services/passwordHash';
import { sendPasswordResetEmail } from '../services/mailer';
import { createKeyedRateLimit, createHttpRateLimit } from '../middleware/rateLimit';

const router: IRouter = Router();

const JWT_SECRET   = process.env.JWT_SECRET as string;
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN || '7d';
const FRONTEND_URL = process.env.FRONTEND_URL  || 'http://localhost:5173';

// Discord OAuth 設定
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  ||
  'http://localhost:3001/auth/discord/callback';

// Line OAuth 設定
const LINE_CHANNEL_ID       = process.env.LINE_CHANNEL_ID       || '';
const LINE_CHANNEL_SECRET   = process.env.LINE_CHANNEL_SECRET   || '';
const LINE_REDIRECT_URI     = process.env.LINE_REDIRECT_URI     ||
  'http://localhost:3001/auth/line/callback';

// ── 工具函式 ─────────────────────────────────────────────────

function issueJwt(payload: { sub: string; displayName: string; provider: string }): string {
  return sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES } as object);
}

function randomState(): string {
  return randomBytes(16).toString('hex');
}

// ── Phase A new-login rate limiters ──────────────────────────
//
// `register` keyed by IP (global flood defence); login keyed by accountName
// (5 attempts per 15 min per account — blocks credential stuffing against one
// target without locking out everyone behind a shared NAT); forgot-password
// keyed by email (3/hr per email — blocks mail bombing).

const registerLimiter = createHttpRateLimit(60 * 1000, 10);

const loginLimiter = createKeyedRateLimit({
  windowMs:    15 * 60 * 1000,
  maxRequests: 5,
  keyFrom:     (req) => {
    const body = (req.body ?? {}) as { accountName?: unknown };
    return typeof body.accountName === 'string' ? `login:${body.accountName}` : undefined;
  },
  message:     '登入次數過多，請 15 分鐘後再試',
  code:        'login_rate_limited',
});

const forgotLimiter = createKeyedRateLimit({
  windowMs:    60 * 60 * 1000,
  maxRequests: 3,
  keyFrom:     (req) => {
    const body = (req.body ?? {}) as { primaryEmail?: unknown };
    return typeof body.primaryEmail === 'string' ? `forgot:${body.primaryEmail}` : undefined;
  },
  message:     '重設密碼次數過多，請 1 小時後再試',
  code:        'forgot_rate_limited',
});

// ── Bind identity helper (kept for OAuth /auth/link/* routes) ─

interface BindIdentity {
  userId:  string;
  isGuest: boolean;
}

/**
 * Extract the current user from a Bearer header (or ?token= query). Returns
 * null for invalid / missing tokens. `isGuest` is true when the JWT's
 * provider is 'guest' — the /auth/link/* callbacks use this to fire the
 * guest → real-account merge path.
 *
 * Legacy guest JWTs still validate here so anyone mid-game can link Discord
 * / Line to keep their stats; new guest tokens are no longer minted (Phase A
 * dropped /auth/guest).
 */
function parseBearerUserId(authHeader: string | undefined, queryToken?: string): BindIdentity | null {
  let token: string | null = null;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (typeof queryToken === 'string' && queryToken.length > 0) {
    token = queryToken;
  }
  if (!token || token.split('.').length !== 3) return null;
  try {
    const payload = verify(token, JWT_SECRET) as JwtPayload & { sub?: string; provider?: string };
    if (!payload.sub) return null;
    return {
      userId:  payload.sub,
      isGuest: payload.provider === 'guest',
    };
  } catch {
    return null;
  }
}

async function handleLinkCallback(
  res: Response,
  currentUserId: string,
  provider: LinkProvider,
  externalId: string,
  options: {
    isGuest:     boolean;
    displayName: string;
    avatarUrl?:  string;
    email?:      string;
  },
): Promise<void> {
  try {
    const existing = await findUserIdByProviderIdentity(provider, externalId);

    if (options.isGuest) {
      let realUserId: string | null = existing;
      if (!realUserId) {
        realUserId = await ensureUserForProviderIdentity(
          provider,
          externalId,
          options.displayName,
          options.avatarUrl,
          options.email,
        );
        if (!realUserId) {
          res.redirect(`${FRONTEND_URL}/profile?link_error=create_failed&provider=${provider}`);
          return;
        }
      }
      await absorbGuestIntoUser(currentUserId, realUserId);
      const jwt = issueJwt({
        sub:         realUserId,
        displayName: options.displayName,
        provider,
      });
      res.redirect(
        `${FRONTEND_URL}?oauth_token=${encodeURIComponent(jwt)}&provider=${provider}&link_merged=1`,
      );
      return;
    }

    if (existing && existing !== currentUserId) {
      const merged = await mergeUserAccounts(currentUserId, existing);
      if (!merged) {
        res.redirect(`${FRONTEND_URL}/profile?link_error=merge_failed&provider=${provider}`);
        return;
      }
      res.redirect(`${FRONTEND_URL}/profile?link_merged=1&provider=${provider}`);
      return;
    }

    if (!existing) {
      const ok = await linkProviderIdentity(currentUserId, provider, externalId);
      if (!ok) {
        res.redirect(`${FRONTEND_URL}/profile?link_error=link_failed&provider=${provider}`);
        return;
      }
    }
    res.redirect(`${FRONTEND_URL}/profile?link_ok=1&provider=${provider}`);
  } catch (err) {
    console.error('[auth/link-callback]', err);
    res.redirect(`${FRONTEND_URL}/profile?link_error=exception&provider=${provider}`);
  }
}

// ── Phase A: Account + Password endpoints ────────────────────

/**
 * POST /auth/register
 * body: { accountName, password, primaryEmail }
 * → 201 { token, user }
 *
 * Validates input, enforces uniqueness on (accountNameLower, primaryEmail),
 * hashes the password, issues a JWT with provider='password'. Caller lands
 * in the lobby immediately; first-login profile setup (Phase B) prompts for
 * email verification.
 */
router.post('/register', registerLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    accountName?:  unknown;
    password?:     unknown;
    primaryEmail?: unknown;
  };

  const nameCheck = validateAccountName(body.accountName);
  if (!nameCheck.ok) {
    return res.status(400).json({ error: nameCheck.reason, code: nameCheck.code });
  }
  const pwCheck = validatePasswordStrength(body.password);
  if (!pwCheck.ok) {
    return res.status(400).json({ error: pwCheck.reason, code: pwCheck.code });
  }
  const emailCheck = validateEmail(body.primaryEmail);
  if (!emailCheck.ok) {
    return res.status(400).json({ error: emailCheck.reason, code: emailCheck.code });
  }

  const accountName  = (body.accountName as string).trim();
  const password     = body.password as string;
  const primaryEmail = (body.primaryEmail as string).trim();

  const result = await registerAccount({ accountName, password, primaryEmail });
  if (!result.ok || !result.data) {
    return res.status(result.code === 'account_taken' || result.code === 'email_taken' ? 409 : 500)
      .json({ error: result.reason ?? '註冊失敗', code: result.code });
  }

  const token = issueJwt({
    sub:         result.data.userId,
    displayName: accountName,
    provider:    'password',
  });
  return res.status(201).json({
    token,
    user: {
      uid:            result.data.userId,
      accountName,
      displayName:    accountName,
      provider:       'password',
      primaryEmail,
      emailsVerified: [],
    },
  });
});

/**
 * POST /auth/login
 * body: { accountName, password }
 * → 200 { token, user }
 *
 * Timing-uniform: invalid-account path also runs a dummy scrypt compare so
 * response times don't leak whether the account exists.
 */
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { accountName?: unknown; password?: unknown };
  if (typeof body.accountName !== 'string' || typeof body.password !== 'string') {
    return res.status(400).json({ error: '帳號與密碼必填', code: 'missing_fields' });
  }

  const result = await verifyCredentials(body.accountName, body.password);
  if (!result.ok || !result.data) {
    const status = result.code === 'no_store' ? 503 : 401;
    return res.status(status).json({ error: result.reason ?? '登入失敗', code: result.code });
  }

  const token = issueJwt({
    sub:         result.data.userId,
    displayName: result.data.displayName,
    provider:    'password',
  });
  return res.json({
    token,
    user: {
      uid:          result.data.userId,
      accountName:  result.data.accountName,
      displayName:  result.data.displayName,
      provider:     'password',
      primaryEmail: result.data.primaryEmail,
    },
  });
});

/**
 * POST /auth/forgot-password
 * body: { accountName, primaryEmail }
 * → 202 { ok: true }  (always 202 even on no-match to avoid user enumeration)
 *
 * If (accountName + email) matches a real row, mints a 30-min reset token
 * and emails a reset URL. If not, silently no-ops so attackers can't tell
 * whether an account exists from this endpoint.
 */
router.post('/forgot-password', forgotLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { accountName?: unknown; primaryEmail?: unknown };
  if (typeof body.accountName !== 'string' || typeof body.primaryEmail !== 'string') {
    return res.status(400).json({ error: '帳號與信箱必填', code: 'missing_fields' });
  }

  const respondOk = () => res.status(202).json({ ok: true, ttl_ms: PASSWORD_RESET_TTL_MS });

  const account = await findAccountByNameAndEmail(body.accountName, body.primaryEmail);
  if (!account) return respondOk();

  const session = await createPasswordResetSession({
    userId:      account.userId,
    accountName: account.accountName,
    email:       body.primaryEmail,
  });
  if (!session.ok || !session.data) {
    return respondOk();
  }

  const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(session.data.token)}`;
  sendPasswordResetEmail(body.primaryEmail, account.accountName, resetUrl).catch((err) => {
    console.error('[auth/forgot-password] mailer error', err);
  });
  return respondOk();
});

/**
 * POST /auth/reset-password
 * body: { token, newPassword }
 * → 200 { ok: true, userId }
 *
 * Consumes the one-time reset token from /auth/forgot-password and writes
 * the new password hash. Token is single-use and expires after 30 min.
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { token?: unknown; newPassword?: unknown };
  if (typeof body.token !== 'string' || body.token.length === 0) {
    return res.status(400).json({ error: '缺少重設 token', code: 'missing_token' });
  }
  const pwCheck = validatePasswordStrength(body.newPassword);
  if (!pwCheck.ok) {
    return res.status(400).json({ error: pwCheck.reason, code: pwCheck.code });
  }

  const result = await consumePasswordResetAndSet({
    token:       body.token,
    newPassword: body.newPassword as string,
  });
  if (!result.ok || !result.data) {
    const status = result.code === 'token_invalid' || result.code === 'token_expired' || result.code === 'token_used'
      ? 400 : 500;
    return res.status(status).json({ error: result.reason, code: result.code });
  }
  return res.json({ ok: true, userId: result.data.userId });
});

// ── Discord OAuth ─────────────────────────────────────────────

router.get('/discord', async (_req: Request, res: Response) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(503).json({ error: 'Discord OAuth 未設定' });
  }
  const state = randomState();
  await createOAuthSession(state, 'discord');

  const params = new URLSearchParams({
    client_id:    DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:        'identify email',
    state,
  });
  return res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

router.get('/discord/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?auth_error=discord_denied`);
  }

  const session = await consumeOAuthSession(state, 'discord');
  if (!session) {
    return res.redirect(`${FRONTEND_URL}?auth_error=invalid_state`);
  }
  const linkUserId = session.linkUserId;
  const isGuestBind = session.isGuest === true;

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) throw new Error('Discord token exchange failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json() as {
      id: string; username: string; global_name?: string; avatar?: string; email?: string;
    };

    const displayName = discordUser.global_name || discordUser.username;
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : undefined;

    if (linkUserId) {
      await handleLinkCallback(res, linkUserId, 'discord', discordUser.id, {
        isGuest:     isGuestBind,
        displayName,
        avatarUrl,
        email:       discordUser.email,
      });
      return;
    }

    const dbUserId = await upsertUser({
      discord_id:   discordUser.id,
      display_name: displayName,
      email:        discordUser.email,
      photo_url:    avatarUrl,
      provider:     'discord',
    });

    const jwt = issueJwt({
      sub:         dbUserId || discordUser.id,
      displayName: displayName,
      provider:    'discord',
    });

    return res.redirect(`${FRONTEND_URL}?oauth_token=${encodeURIComponent(jwt)}&provider=discord`);
  } catch (err) {
    console.error('[discord-oauth]', err);
    return res.redirect(`${FRONTEND_URL}?auth_error=discord_failed`);
  }
});

// ── Line Login ────────────────────────────────────────────────

router.get('/line', async (_req: Request, res: Response) => {
  if (!LINE_CHANNEL_ID) {
    return res.status(503).json({ error: 'Line Login 未設定' });
  }
  const state = randomState();
  await createOAuthSession(state, 'line');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     LINE_CHANNEL_ID,
    redirect_uri:  LINE_REDIRECT_URI,
    state,
    scope:         'profile openid email',
  });
  return res.redirect(`https://access.line.me/oauth2/v2.1/authorize?${params}`);
});

router.get('/line/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?auth_error=line_denied`);
  }

  const session = await consumeOAuthSession(state, 'line');
  if (!session) {
    return res.redirect(`${FRONTEND_URL}?auth_error=invalid_state`);
  }
  const linkUserId = session.linkUserId;
  const isGuestBind = session.isGuest === true;

  try {
    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  LINE_REDIRECT_URI,
        client_id:     LINE_CHANNEL_ID,
        client_secret: LINE_CHANNEL_SECRET,
      }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) throw new Error('Line token exchange failed');

    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const lineUser = await profileRes.json() as {
      userId: string; displayName: string; pictureUrl?: string;
    };

    if (linkUserId) {
      await handleLinkCallback(res, linkUserId, 'line', lineUser.userId, {
        isGuest:     isGuestBind,
        displayName: lineUser.displayName,
        avatarUrl:   lineUser.pictureUrl,
      });
      return;
    }

    const dbUserId = await upsertUser({
      line_id:      lineUser.userId,
      display_name: lineUser.displayName,
      photo_url:    lineUser.pictureUrl,
      provider:     'line',
    });

    const jwt = issueJwt({
      sub:         dbUserId || lineUser.userId,
      displayName: lineUser.displayName,
      provider:    'line',
    });

    return res.redirect(`${FRONTEND_URL}?oauth_token=${encodeURIComponent(jwt)}&provider=line`);
  } catch (err) {
    console.error('[line-oauth]', err);
    return res.redirect(`${FRONTEND_URL}?auth_error=line_failed`);
  }
});

// ── Link additional providers (#42 kept path) ────────────────

router.get('/link/discord', async (req: Request, res: Response) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(503).json({ error: 'Discord OAuth 未設定' });
  }
  const queryToken = (req.query.token as string | undefined) ?? undefined;
  const identity = parseBearerUserId(req.headers.authorization, queryToken);
  if (!identity) {
    return res.status(401).json({ error: 'Unauthorized — login first' });
  }
  const state = randomState();
  await createOAuthSession(state, 'discord', identity.userId, identity.isGuest);

  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify email',
    state,
  });
  return res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

router.get('/link/line', async (req: Request, res: Response) => {
  if (!LINE_CHANNEL_ID) {
    return res.status(503).json({ error: 'Line Login 未設定' });
  }
  const queryToken = (req.query.token as string | undefined) ?? undefined;
  const identity = parseBearerUserId(req.headers.authorization, queryToken);
  if (!identity) {
    return res.status(401).json({ error: 'Unauthorized — login first' });
  }
  const state = randomState();
  await createOAuthSession(state, 'line', identity.userId, identity.isGuest);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     LINE_CHANNEL_ID,
    redirect_uri:  LINE_REDIRECT_URI,
    state,
    scope:         'profile openid email',
  });
  return res.redirect(`https://access.line.me/oauth2/v2.1/authorize?${params}`);
});

export { router as authRouter };
export { handleLinkCallback as _handleLinkCallbackForTest };
