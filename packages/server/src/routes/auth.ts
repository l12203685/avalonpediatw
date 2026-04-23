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
  type LinkProvider,
} from '../services/supabase';
import { mintGuestToken, verifyGuestToken, generateGuestName } from '../middleware/guestAuth';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import {
  ensureSupabaseUserForFirebase,
  isSupabaseReady,
} from '../services/supabase';
import { isFirestoreReady } from '../services/firestoreAccounts';

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

// ── Guest cookie helpers (no cookie-parser dependency) ──────────────────────

const GUEST_COOKIE_NAME = 'guest_session';
const GUEST_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days
const IS_PROD = (process.env.NODE_ENV || 'development') === 'production';

/**
 * 從 raw `Cookie` header 取出指定名稱的 cookie 值，不引入 cookie-parser 相依。
 * 沒找到回 null。
 */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  const parts = header.split(';');
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (k !== name) continue;
    const v = p.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

/**
 * 設 `guest_session` 長效 cookie。HttpOnly + SameSite=Lax，讓 JS 讀不到但瀏覽器
 * 同站導覽時仍會帶；正式環境加 Secure 強制 HTTPS。
 */
function setGuestSessionCookie(res: Response, token: string): void {
  const parts = [
    `${GUEST_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${GUEST_COOKIE_MAX_AGE_SEC}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (IS_PROD) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ── 工具函式 ─────────────────────────────────────────────────

function issueJwt(payload: { sub: string; displayName: string; provider: string }): string {
  return sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES } as object);
}

function randomState(): string {
  return randomBytes(16).toString('hex');
}

// ── #42 link mode helpers ─────────────────────────────────────

/**
 * 從 Bearer header 或 `?token=` query 解析自訂 JWT，回 sub（= users.id）給綁定流程用。
 * 拿不到合法 JWT 回 null。Guest token 不允許綁定（guest 要先註冊）。
 *
 * Query string 支援是為了 redirect-based OAuth 起跳：瀏覽器 window.location 整頁
 * 跳轉送不出 custom header，所以 /auth/link/* 接受 ?token= 傳 JWT。只在 link
 * 起跳點用，OAuth provider callback 不需要再送 token。
 */
function parseBearerUserId(authHeader: string | undefined, queryToken?: string): string | null {
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
    if (payload.provider === 'guest') return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * 綁定 callback 核心：
 *   - 若目標 identity 從未綁 → 直接 link 到 currentUserId
 *   - 若已綁給別人（otherId != currentUserId）→ mergeUserAccounts(current, other)
 *   - 若已綁給自己 → no-op
 * 完成後 redirect 到個人頁並帶 success/error flag。
 */
async function handleLinkCallback(
  res: Response,
  currentUserId: string,
  provider: LinkProvider,
  externalId: string,
): Promise<void> {
  try {
    const existing = await findUserIdByProviderIdentity(provider, externalId);

    if (existing && existing !== currentUserId) {
      // 已有獨立帳號 → 合併到當前帳號（當前視為 primary，保留玩家現在登入的這個）
      const merged = await mergeUserAccounts(currentUserId, existing);
      if (!merged) {
        res.redirect(`${FRONTEND_URL}/profile?link_error=merge_failed&provider=${provider}`);
        return;
      }
      res.redirect(`${FRONTEND_URL}/profile?link_merged=1&provider=${provider}`);
      return;
    }

    if (!existing) {
      // 從未綁 → 直接 link
      const ok = await linkProviderIdentity(currentUserId, provider, externalId);
      if (!ok) {
        res.redirect(`${FRONTEND_URL}/profile?link_error=link_failed&provider=${provider}`);
        return;
      }
    }
    // existing === currentUserId → already linked, no-op
    res.redirect(`${FRONTEND_URL}/profile?link_ok=1&provider=${provider}`);
  } catch (err) {
    console.error('[auth/link-callback]', err);
    res.redirect(`${FRONTEND_URL}/profile?link_error=exception&provider=${provider}`);
  }
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

  // CSRF + 讀出 link_user_id（若是綁定流程）
  const session = await consumeOAuthSession(state, 'discord');
  if (!session) {
    return res.redirect(`${FRONTEND_URL}?auth_error=invalid_state`);
  }
  const linkUserId = session.linkUserId;

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

    // #42: 綁定流程 — 不發新 token，合併/綁定到當前 user 後導回個人頁
    if (linkUserId) {
      await handleLinkCallback(res, linkUserId, 'discord', discordUser.id);
      return;
    }

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

  const session = await consumeOAuthSession(state, 'line');
  if (!session) {
    return res.redirect(`${FRONTEND_URL}?auth_error=invalid_state`);
  }
  const linkUserId = session.linkUserId;

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

    // #42: 綁定流程 — 不發新 token，合併/綁定到當前 user 後導回個人頁
    if (linkUserId) {
      await handleLinkCallback(res, linkUserId, 'line', lineUser.userId);
      return;
    }

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
//
// Phase 1 IA 重構：POST /auth/guest 同時種 guest_session HttpOnly cookie；
// 新增 GET /auth/guest/resume、POST /auth/guest/rename、POST /auth/guest/upgrade
// 作為大廳 IA 的 foundation endpoint。

/**
 * POST /auth/guest
 * body: { displayName?: string }
 * → { token: string, user: { uid, displayName, provider: 'guest' } }
 *
 * 若 body 沒帶 displayName（或空字串），server 端生成 `Guest_NNN`（Ticket #81）。
 * 有帶的話驗證 1-40 字（保留舊行為，client 端通常會先帶 Guest_NNN 或使用者輸入）。
 */
router.post('/guest', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { displayName?: unknown };
  let candidate: string;
  if (body.displayName === undefined || body.displayName === null) {
    candidate = generateGuestName();
  } else if (typeof body.displayName !== 'string') {
    return res.status(400).json({ error: 'displayName must be a string' });
  } else {
    const trimmed = body.displayName.trim();
    if (trimmed.length === 0) {
      candidate = generateGuestName();
    } else if (trimmed.length > 40) {
      return res.status(400).json({ error: 'displayName must be 1-40 chars' });
    } else {
      candidate = trimmed;
    }
  }
  const { token, uid, displayName } = mintGuestToken(candidate);
  // 種一份 HttpOnly cookie 讓冷啟動可以從 /auth/guest/resume 續簽，
  // 不需要讓 client JS 自己暫存 token。
  setGuestSessionCookie(res, token);
  return res.json({
    token,
    user: {
      uid,
      displayName,
      provider: 'guest',
    },
  });
});

/**
 * GET /auth/guest/resume
 * 讀 guest_session cookie → 若有效，發一個新的 JWT 給該 guest 使用。
 * 缺 cookie 或 cookie 過期 → 401，前端會落回訪客登入流程。
 *
 * Phase 1 stub：直接用 cookie 內的 JWT 再 mint 一個新 token（uid 會換）。
 * Phase 2 會改成 sessionId → uid 的 Supabase lookup，保留原 uid + ELO 與戰績。
 */
router.get('/guest/resume', (req: Request, res: Response) => {
  const cookieToken = readCookie(req, GUEST_COOKIE_NAME);
  if (!cookieToken) {
    return res.status(401).json({ error: 'no guest session cookie' });
  }
  const identity = verifyGuestToken(cookieToken);
  if (!identity) {
    return res.status(401).json({ error: 'guest session expired or invalid' });
  }
  // 保留原 displayName，但發新 JWT 讓 client 的過期時鐘重置。
  const { token, uid, displayName } = mintGuestToken(identity.displayName);
  // 刷新 max-age，保持原 cookie token 不動，讓下次 resume 還能找到同一 signed uid。
  setGuestSessionCookie(res, cookieToken);
  return res.json({
    token,
    user: {
      uid,
      displayName,
      provider: 'guest',
      // Phase 2 migration 會用 cookieUid 對齊兩邊
      cookieUid: identity.uid,
    },
  });
});

/**
 * POST /auth/guest/rename
 * body: { newName: string }
 *
 * Ticket #81 驗證：
 *   - 非空白
 *   - 長度 2-20 字
 *   - 不以 `Guest_`（case-insensitive）開頭 — 避免使用者自行命名偽裝成
 *     server 分配的預設訪客名造成身份混淆
 *
 * Phase 1：輸入驗證 + 200 OK。24hr × 3 rate limit 與 persistence
 * Phase 2 搭配 guest registry table 再補上。
 */
router.post('/guest/rename', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { newName?: unknown };
  if (typeof body.newName !== 'string') {
    return res.status(400).json({ error: 'newName is required' });
  }
  const trimmed = body.newName.trim();
  if (trimmed.length < 2 || trimmed.length > 20) {
    return res.status(400).json({ error: 'newName must be 2-20 chars' });
  }
  if (/^guest_/i.test(trimmed)) {
    return res.status(400).json({
      error: 'newName cannot start with "Guest_" (reserved for default guest names)',
      code: 'RESERVED_PREFIX',
    });
  }
  // TODO(phase2): 讀 guest_session cookie → 驗證 rate-limit 3/24h → 寫 DB
  return res.json({ ok: true, newName: trimmed });
});

/**
 * POST /auth/guest/upgrade
 * body: { provider: 'google', providerToken: string }
 *
 * 2026-04-23 Edward 回報：綁 Google 後仍無法改名，被當訪客。Root cause：原本
 * stub 回 501 → 前端以為有綁成功但 server 沒做任何合併 → socket 仍以 guest
 * token 連線 → /api/profile/me PATCH 繼續被 `provider === 'guest'` 擋。
 *
 * 新行為（Google-only，Discord / Line 仍走 /auth/link/<provider> redirect）：
 *   1. 驗 Firebase ID token → 取得 uid / email / name / photo
 *   2. 確保 Supabase（或 Firestore fallback）已有對應 google user row
 *   3. 簽一個 provider='google' 的自訂 JWT 讓 socket 能以 google 身份重連
 *      （前端會拿 Firebase ID token 走 route 2 直接 verify，這裡回的 JWT
 *      主要給前端暫存和驗證用）
 *
 * 舊訪客 ELO / 戰績遷移走 ticket #46（已完成）— 這顆 endpoint 不動戰績，
 * 只負責把「身份從 guest 翻成 google」這一步打通。
 */
router.post('/guest/upgrade', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { provider?: unknown; providerToken?: unknown };
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const providerToken = typeof body.providerToken === 'string' ? body.providerToken : '';

  if (provider !== 'google') {
    return res.status(400).json({
      error: 'Only provider="google" is supported here; use /auth/link/discord or /auth/link/line for others',
    });
  }
  if (providerToken.length === 0) {
    return res.status(400).json({ error: 'providerToken (Firebase ID token) required' });
  }
  if (!isFirebaseAdminReady()) {
    return res.status(503).json({ error: 'Firebase admin not configured' });
  }

  try {
    const decoded = await verifyIdToken(providerToken);
    const firebaseUid = decoded.uid;
    const email = decoded.email ?? '';
    const name = decoded.name ?? email.split('@')[0] ?? 'Player';
    const photo = (decoded as typeof decoded & { picture?: string }).picture;

    // 確保 users row 存在（Supabase 主路徑；Firestore fallback）
    if (isSupabaseReady()) {
      await ensureSupabaseUserForFirebase(firebaseUid, name, email, photo);
    } else if (!isFirestoreReady()) {
      return res.status(503).json({ error: 'No account store configured' });
    }

    // 簽回一顆 provider='google' 的自訂 JWT。socket 端會優先走 Firebase ID
    // token 驗證（route 2），不過前端同時也會重建 socket — 此 JWT 當 fallback。
    const token = issueJwt({ sub: firebaseUid, displayName: name, provider: 'google' });

    return res.json({
      ok: true,
      token,
      user: { uid: firebaseUid, displayName: name, provider: 'google', email, photoURL: photo ?? null },
    });
  } catch (err) {
    console.error('[auth/guest/upgrade]', err);
    return res.status(400).json({ error: 'Invalid Firebase ID token or upgrade failed' });
  }
});

// ── #42 Link additional providers ────────────────────────────
//
// 流程：玩家在個人頁按「綁 Discord/Line」→ 前端帶 Bearer JWT 打
// GET /auth/link/discord → 驗證當前身份 → 發起 Discord OAuth
// （state 夾帶 linkUserId）→ Discord callback 進 handleLinkCallback。
//
// Google 綁定：前端用 Firebase SDK 拿 ID token 後打 POST /auth/link/google
//（不用跳第二層 OAuth），後端驗 token 後直接合併/綁。

/**
 * GET /auth/link/discord
 * Header: Authorization: Bearer <current JWT>
 * → redirect 到 Discord OAuth，state 內夾帶 linkUserId
 */
router.get('/link/discord', async (req: Request, res: Response) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(503).json({ error: 'Discord OAuth 未設定' });
  }
  const queryToken = (req.query.token as string | undefined) ?? undefined;
  const currentUserId = parseBearerUserId(req.headers.authorization, queryToken);
  if (!currentUserId) {
    return res.status(401).json({ error: 'Unauthorized — login first' });
  }
  const state = randomState();
  await createOAuthSession(state, 'discord', currentUserId);

  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify email',
    state,
  });
  return res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

/**
 * GET /auth/link/line
 * Header: Authorization: Bearer <current JWT>
 * → redirect 到 Line Login，state 內夾帶 linkUserId
 */
router.get('/link/line', async (req: Request, res: Response) => {
  if (!LINE_CHANNEL_ID) {
    return res.status(503).json({ error: 'Line Login 未設定' });
  }
  const queryToken = (req.query.token as string | undefined) ?? undefined;
  const currentUserId = parseBearerUserId(req.headers.authorization, queryToken);
  if (!currentUserId) {
    return res.status(401).json({ error: 'Unauthorized — login first' });
  }
  const state = randomState();
  await createOAuthSession(state, 'line', currentUserId);

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
