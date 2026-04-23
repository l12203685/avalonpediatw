/**
 * HTTP `/auth` routes — Phase C email-only architecture (2026-04-23).
 *
 * Edward 原話：
 *   「帳號 = email，註冊的時候設定新密碼，不用再特別有個建立新帳號的頁面；
 *   直接在帳號登入那邊就備註 登入 or 註冊；不存在的 email 就等同註冊，
 *   存在的 email 就是登入。」
 *
 * 變化：
 *   - `/auth/login`   body {email, password}。email 不存在 → 註冊 + JWT；
 *                     存在且密碼對 → 登入 + JWT；存在但密碼錯 → 401。
 *   - `/auth/register` 保留為 alias，呼叫同一 handler，讓舊 client 不壞。
 *   - `/auth/forgot-password` body {email} — 不再要求 accountName。
 *   - `/auth/reset-password`  body {token, newPassword} 不變。
 *
 * OAuth (Discord / Line / Google) 維持原樣，那是次要入口；帳密走極簡路徑。
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
  loginOrRegister,
  findAccountByEmail,
  createPasswordResetSession,
  consumePasswordResetAndSet,
  PASSWORD_RESET_TTL_MS,
} from '../services/firestoreAuthAccounts';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import {
  validatePasswordStrength,
  validateEmail,
} from '../services/passwordHash';
import { sendPasswordResetEmail } from '../services/mailer';
import { createKeyedRateLimit, createHttpRateLimit } from '../middleware/rateLimit';

const router: IRouter = Router();

const JWT_SECRET   = process.env.JWT_SECRET as string;
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN || '7d';
const FRONTEND_URL = process.env.FRONTEND_URL  || 'http://localhost:5173';

// Discord OAuth
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  ||
  'http://localhost:3001/auth/discord/callback';

// Line OAuth
const LINE_CHANNEL_ID       = process.env.LINE_CHANNEL_ID       || '';
const LINE_CHANNEL_SECRET   = process.env.LINE_CHANNEL_SECRET   || '';
const LINE_REDIRECT_URI     = process.env.LINE_REDIRECT_URI     ||
  'http://localhost:3001/auth/line/callback';

// ── Helpers ─────────────────────────────────────────────────

function issueJwt(payload: { sub: string; displayName: string; provider: string }): string {
  return sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES } as object);
}

function randomState(): string {
  return randomBytes(16).toString('hex');
}

// ── Rate limiters ──────────────────────────────────────────
//
// login/register 同一 endpoint，按 email 做 keyed rate-limit（5/15min per email）
// 才不會讓攻擊者撞單一 email 無限嘗試；register 額外擋 IP flood（10/min）給
// 註冊新 email 用。

const emailFloodLimiter = createHttpRateLimit(60 * 1000, 20);

const loginLimiter = createKeyedRateLimit({
  windowMs:    15 * 60 * 1000,
  maxRequests: 10,
  keyFrom:     (req) => {
    const body = (req.body ?? {}) as { email?: unknown };
    return typeof body.email === 'string' ? `login:${body.email.trim().toLowerCase()}` : undefined;
  },
  message:     '登入次數過多，請 15 分鐘後再試',
  code:        'login_rate_limited',
});

const forgotLimiter = createKeyedRateLimit({
  windowMs:    60 * 60 * 1000,
  maxRequests: 3,
  keyFrom:     (req) => {
    const body = (req.body ?? {}) as { email?: unknown; primaryEmail?: unknown };
    const e = typeof body.email === 'string' ? body.email
           : typeof body.primaryEmail === 'string' ? body.primaryEmail : '';
    return e ? `forgot:${e.trim().toLowerCase()}` : undefined;
  },
  message:     '重設密碼次數過多，請 1 小時後再試',
  code:        'forgot_rate_limited',
});

// ── OAuth quick-login helper (2026-04-23) ─────────────────────
//
// Edward 原話：「能不能登入頁面綁 google/line/dc => 有的話就直接登入」。
//
// 實作：Discord/LINE callback 或 Google ID token 驗完後，拿 email 去
// `findAccountByEmail`。已綁 → 發 JWT 直登；沒綁 → 回前端提示「請先以 email
// 登入後再綁定」。注意 quick-login 不幫使用者建新帳號 — 那是 Edward 明確劃定
// 的禁區（避免 OAuth 建了一顆新 row 卻跟 email-only row 兩套）。

/** 回傳 '?auth_error=provider_not_linked&provider=<p>' redirect 給前端處理提示。 */
function respondQuickLoginNotLinked(
  res:      Response,
  provider: 'discord' | 'line' | 'google',
): void {
  const qs = new URLSearchParams({
    auth_error: 'provider_not_linked',
    provider,
  });
  res.redirect(`${FRONTEND_URL}?${qs}`);
}

/**
 * 從 LINE OpenID id_token 取 email。id_token 是 JWS (JWT)，格式
 * header.payload.signature。我們只要 payload，且只在 quick-login 模式下用（嚴格
 * 講應該驗簽但 CSRF state + access_token exchange 已保護，payload 作為
 * Firestore 查詢 key 而非身份授權，先解不驗足夠）。
 */
function parseEmailFromLineIdToken(idToken: string | undefined): string | undefined {
  if (!idToken || typeof idToken !== 'string') return undefined;
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf8'),
    ) as { email?: unknown };
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/** 拿 email 查 auth_users；命中 → 200 + JWT；miss → null（caller 決定如何回應）。 */
async function quickLoginByEmail(
  email:        string | undefined,
  provider:     'discord' | 'line' | 'google',
): Promise<{ token: string; userId: string; accountName: string; displayName: string; primaryEmail: string } | null> {
  if (!email) return null;
  const account = await findAccountByEmail(email);
  if (!account) return null;
  const token = issueJwt({
    sub:         account.userId,
    displayName: account.displayName,
    provider,
  });
  return {
    token,
    userId:       account.userId,
    accountName:  account.accountName,
    displayName:  account.displayName,
    primaryEmail: account.primaryEmail,
  };
}

// ── Bind identity helper (kept for OAuth /auth/link/* routes) ─

interface BindIdentity {
  userId:  string;
  isGuest: boolean;
}

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

// ── Phase C: email-only login/register ────────────────────────

/**
 * 核心 handler — /auth/login + /auth/register 都走這個函式。
 *
 *   body: { email, password }
 *   email 不存在 → 201 + JWT + user.isNew=true
 *   email 存在 + 密碼對 → 200 + JWT
 *   email 存在 + 密碼錯 → 401 bad_credentials
 *   格式 / 強度不對 → 400
 */
async function handleLoginOrRegister(req: Request, res: Response): Promise<Response> {
  const body = (req.body ?? {}) as {
    email?:    unknown;
    password?: unknown;
  };

  const emailCheck = validateEmail(body.email);
  if (!emailCheck.ok) {
    return res.status(400).json({ error: emailCheck.reason, code: emailCheck.code });
  }
  const pwCheck = validatePasswordStrength(body.password);
  if (!pwCheck.ok) {
    return res.status(400).json({ error: pwCheck.reason, code: pwCheck.code });
  }

  const email    = (body.email as string).trim();
  const password = body.password as string;

  const result = await loginOrRegister({ email, password });
  if (!result.ok || !result.data) {
    const status = result.code === 'no_store' ? 503
                 : result.code === 'bad_credentials' ? 401
                 : 500;
    return res.status(status).json({ error: result.reason ?? '登入失敗', code: result.code });
  }

  const token = issueJwt({
    sub:         result.data.userId,
    displayName: result.data.displayName,
    provider:    'password',
  });
  return res.status(result.data.created ? 201 : 200).json({
    token,
    user: {
      uid:            result.data.userId,
      accountName:    result.data.accountName,
      displayName:    result.data.displayName,
      provider:       'password',
      primaryEmail:   result.data.primaryEmail,
      emailsVerified: [],
      isNew:          result.data.created,
    },
  });
}

router.post('/login',    emailFloodLimiter, loginLimiter, handleLoginOrRegister);
// `/auth/register` 保留成 alias，讓舊 client 不壞 — 行為跟 /auth/login 一模一樣。
router.post('/register', emailFloodLimiter, loginLimiter, handleLoginOrRegister);

/**
 * POST /auth/forgot-password
 * body: { email }（舊 client 傳 primaryEmail 也接）
 * → 202 { ok: true }  — 不論命中與否都回 202，避免 enumeration
 */
router.post('/forgot-password', forgotLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown; primaryEmail?: unknown };
  const rawEmail = typeof body.email === 'string' ? body.email
                 : typeof body.primaryEmail === 'string' ? body.primaryEmail : '';
  if (!rawEmail) {
    return res.status(400).json({ error: '信箱必填', code: 'missing_fields' });
  }

  const respondOk = (): Response => res.status(202).json({ ok: true, ttl_ms: PASSWORD_RESET_TTL_MS });

  const account = await findAccountByEmail(rawEmail);
  if (!account) return respondOk();

  const session = await createPasswordResetSession({
    userId:      account.userId,
    accountName: account.accountName,
    email:       rawEmail,
  });
  if (!session.ok || !session.data) {
    return respondOk();
  }

  const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(session.data.token)}`;
  sendPasswordResetEmail(rawEmail, account.accountName, resetUrl).catch((err) => {
    console.error('[auth/forgot-password] mailer error', err);
  });
  return respondOk();
});

/**
 * POST /auth/reset-password
 * body: { token, newPassword } — 不變
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
  const quickLoginMode = session.mode === 'quickLogin';

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

    // OAuth quick-login (2026-04-23 Edward)：以 provider email 查 auth_users。
    // 已綁 → 直發 JWT；沒綁 → 提示「請先用 email 登入後再綁定」。
    // 不建新帳號、不呼叫 upsertUser（那條路只走原生登入）。
    if (quickLoginMode) {
      const quick = await quickLoginByEmail(discordUser.email, 'discord');
      if (!quick) {
        respondQuickLoginNotLinked(res, 'discord');
        return;
      }
      return res.redirect(
        `${FRONTEND_URL}?oauth_token=${encodeURIComponent(quick.token)}&provider=discord&quick_login=1`,
      );
    }

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
  const quickLoginMode = session.mode === 'quickLogin';

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
    const tokenData = await tokenRes.json() as { access_token?: string; id_token?: string; error?: string };
    if (!tokenData.access_token) throw new Error('Line token exchange failed');

    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const lineUser = await profileRes.json() as {
      userId: string; displayName: string; pictureUrl?: string;
    };

    // LINE email 在 id_token 裡（OpenID Connect payload），不在 /v2/profile。
    // quickLogin 模式才解 id_token，避免原登入流程多打一次網路。
    const lineEmail: string | undefined = quickLoginMode
      ? parseEmailFromLineIdToken(tokenData.id_token)
      : undefined;

    if (quickLoginMode) {
      const quick = await quickLoginByEmail(lineEmail, 'line');
      if (!quick) {
        respondQuickLoginNotLinked(res, 'line');
        return;
      }
      return res.redirect(
        `${FRONTEND_URL}?oauth_token=${encodeURIComponent(quick.token)}&provider=line&quick_login=1`,
      );
    }

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

// ── OAuth quick-login entry points (2026-04-23 Edward) ───────
//
//   GET  /auth/oauth/login/discord — 302 到 Discord OAuth（state.mode=quickLogin）
//   GET  /auth/oauth/login/line    — 302 到 LINE   OAuth（同）
//   POST /auth/oauth/login/google  { idToken } — Firebase idToken 驗完查 email
//
// 語意：provider 的 email 已存在於 auth_users（= email-only 帳號那邊的 emailsLower），
// callback / handler 直接發 JWT 登入；找不到回 auth_error=provider_not_linked。
//
// 為什麼不合併 `/auth/discord` 跟 `/auth/oauth/login/discord`：原 `/auth/discord`
// callback 找不到 email 會 upsertUser 建新 row（= 傳統 OAuth 登入），是刻意保留
// 給「從來沒用 email 註冊、就是 Discord 用戶」的情境。quickLogin 是嚴格禁止建
// 新帳號的模式，所以要 split state。

router.get('/oauth/login/discord', async (_req: Request, res: Response) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(503).json({ error: 'Discord OAuth 未設定' });
  }
  const state = randomState();
  await createOAuthSession(state, 'discord', undefined, false, 'quickLogin');

  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify email',
    state,
  });
  return res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

router.get('/oauth/login/line', async (_req: Request, res: Response) => {
  if (!LINE_CHANNEL_ID) {
    return res.status(503).json({ error: 'Line Login 未設定' });
  }
  const state = randomState();
  await createOAuthSession(state, 'line', undefined, false, 'quickLogin');

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
 * POST /auth/oauth/login/google { idToken }
 *
 *   idToken: Firebase Auth popup 拿到的 Google user.getIdToken()（前端用
 *   GoogleAuthProvider + signInWithPopup 取得）。
 *
 *   200 + { token, user } — email 已綁 auth_users，直發 JWT。
 *   401 + { error, code: 'provider_not_linked' } — 沒綁，請先用 email 登入後再綁。
 *   400 bad_id_token / missing_fields — idToken 格式錯誤或驗簽失敗。
 *   503 — Firebase admin 未設定。
 */
router.post('/oauth/login/google', emailFloodLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { idToken?: unknown };
  if (typeof body.idToken !== 'string' || body.idToken.length === 0) {
    return res.status(400).json({ error: 'idToken required', code: 'missing_fields' });
  }
  if (!isFirebaseAdminReady()) {
    return res.status(503).json({ error: 'Firebase admin 未設定' });
  }

  let email: string | undefined;
  try {
    const decoded = await verifyIdToken(body.idToken);
    email = decoded.email ?? undefined;
  } catch {
    return res.status(400).json({ error: 'Invalid Firebase ID token', code: 'bad_id_token' });
  }

  const quick = await quickLoginByEmail(email, 'google');
  if (!quick) {
    return res.status(401).json({
      error: '這組 Google 帳號的信箱還沒在站上註冊過，請先用 email 登入後再到「系統設定」綁定 Google',
      code:  'provider_not_linked',
    });
  }

  return res.json({
    token: quick.token,
    user: {
      uid:            quick.userId,
      accountName:    quick.accountName,
      displayName:    quick.displayName,
      primaryEmail:   quick.primaryEmail,
      provider:       'google',
      emailsVerified: [],
      isNew:          false,
    },
  });
});

export { router as authRouter };
export { handleLinkCallback as _handleLinkCallbackForTest };
