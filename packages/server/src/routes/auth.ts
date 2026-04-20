import { Router, Request, Response, IRouter } from 'express';
import { sign } from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { upsertUser, createOAuthSession, verifyAndDeleteOAuthSession } from '../services/supabase';
import { mintGuestToken } from '../middleware/guestAuth';

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

// ── Discord OAuth ─────────────────────────────────────────────

/**
 * GET /auth/discord
 * 重導向到 Discord OAuth 授權頁面
 */
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

/**
 * GET /auth/discord/callback
 * Discord 授權後的回調
 */
router.get('/discord/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?auth_error=discord_denied`);
  }

  // CSRF 驗證
  const valid = await verifyAndDeleteOAuthSession(state, 'discord');
  if (!valid) {
    return res.redirect(`${FRONTEND_URL}?auth_error=invalid_state`);
  }

  try {
    // 1. code → access_token
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

    // 2. access_token → user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json() as {
      id: string; username: string; global_name?: string; avatar?: string; email?: string;
    };

    // Discord 新 API：global_name 是顯示名稱，username 是 unique handle
    const displayName = discordUser.global_name || discordUser.username;
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : undefined;

    // 3. 查/建 Supabase 用戶
    const dbUserId = await upsertUser({
      discord_id:   discordUser.id,
      display_name: displayName,
      email:        discordUser.email,
      photo_url:    avatarUrl,
      provider:     'discord',
    });

    // 4. 發行自訂 JWT（sub = discord_id 或 dbUserId）
    const jwt = issueJwt({
      sub:         dbUserId || discordUser.id,
      displayName: displayName,
      provider:    'discord',
    });

    // 5. 重導向前端並帶 token
    return res.redirect(`${FRONTEND_URL}?oauth_token=${encodeURIComponent(jwt)}&provider=discord`);
  } catch (err) {
    console.error('[discord-oauth]', err);
    return res.redirect(`${FRONTEND_URL}?auth_error=discord_failed`);
  }
});

// ── Line Login ────────────────────────────────────────────────

/**
 * GET /auth/line
 * 重導向到 Line Login 授權頁面
 */
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

/**
 * GET /auth/line/callback
 * Line 授權後的回調
 */
router.get('/line/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?auth_error=line_denied`);
  }

  const valid = await verifyAndDeleteOAuthSession(state, 'line');
  if (!valid) {
    return res.redirect(`${FRONTEND_URL}?auth_error=invalid_state`);
  }

  try {
    // 1. code → access_token
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

    // 2. access_token → profile
    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const lineUser = await profileRes.json() as {
      userId: string; displayName: string; pictureUrl?: string;
    };

    // 3. 查/建 Supabase 用戶
    const dbUserId = await upsertUser({
      line_id:      lineUser.userId,
      display_name: lineUser.displayName,
      photo_url:    lineUser.pictureUrl,
      provider:     'line',
    });

    // 4. 發行自訂 JWT
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

// ── Guest Mint ────────────────────────────────────────────────
//
// S10 fix (Plan v2 R1.0): guest uid is now server-minted. Clients used to
// build `JSON.stringify({uid: uuidv4(), displayName})` locally and send it as
// socket handshake, which let attackers impersonate other users by supplying
// their uid. Clients now POST here and receive a JWT whose `sub` is
// server-generated; the attacker can no longer choose their own uid.
//
// A 3-day grace window in middleware/guestAuth.ts keeps existing legacy JSON
// tokens working so already-connected players aren't kicked out the moment
// this ships (see GUEST_LEGACY_CUTOFF in .env.example).

/**
 * POST /auth/guest
 * body: { displayName: string }
 * → { token: string, user: { uid, displayName, provider: 'guest' } }
 */
router.post('/guest', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { displayName?: unknown };
  if (typeof body.displayName !== 'string') {
    return res.status(400).json({ error: 'displayName is required' });
  }
  const trimmed = body.displayName.trim();
  if (trimmed.length < 1 || trimmed.length > 40) {
    return res.status(400).json({ error: 'displayName must be 1-40 chars' });
  }
  const { token, uid, displayName } = mintGuestToken(trimmed);
  return res.json({
    token,
    user: {
      uid,
      displayName,
      provider: 'guest',
    },
  });
});

export { router as authRouter };
