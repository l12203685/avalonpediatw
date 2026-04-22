import { Router, Request, Response, IRouter } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import {
  getGameEvents,
  isSupabaseReady,
  getDbUserOverrides,
  updateDbUserProfile,
  ensureSupabaseUserForFirebase,
  getSupabaseIdByFirebaseUid,
  getLinkedAccounts,
  findUserIdByProviderIdentity,
  linkProviderIdentity,
  mergeUserAccounts,
  unlinkProviderIdentity,
  type ProfileEditableFields,
  type DbUserOverrides,
  type LinkProvider,
} from '../services/supabase';
import {
  getFirestoreLeaderboard,
  getFirestoreUserProfile,
  type UserProfile as FirestoreUserProfile,
} from '../services/FirestoreLeaderboard';
import {
  isFirestoreReady,
  // Used by resolveSupabaseUserId's Firestore path.
} from '../services/firestoreAccounts';
import { SelfPlayEngine } from '../ai/SelfPlayEngine';
import { getSelfPlayStatus, buildAgents } from '../ai/SelfPlayScheduler';
import { createHttpRateLimit } from '../middleware/rateLimit';
import { verifyGuestToken } from '../middleware/guestAuth';

const router: IRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET as string;

// Rate limiting: 60 requests/min per IP for public routes, 10/min for admin
const publicLimiter = createHttpRateLimit(60 * 1000, 60);
const adminLimiter  = createHttpRateLimit(60 * 1000, 10);

// ── 工具：從 Authorization header 解析玩家身份 ─────────────────
// 支援 Firebase ID Token、自訂 JWT（Discord/Line）、Guest JSON
// 回傳 { playerId, displayName?, provider? }，以便在 Firestore/Sheets 找不到記錄時
// 仍可回傳空 profile（顯示玩家名稱 + 零遊戲）。
interface ResolvedAuth {
  playerId: string;
  displayName?: string;
  provider?: string;
  email?: string;
  firebaseUid?: string;
  photoUrl?: string;
}

async function resolvePlayerAuth(authHeader: string | undefined): Promise<ResolvedAuth | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // 路徑 1：自訂 JWT（Discord/Line：sub 是 player ID）
  // 僅對看起來像 JWT 的 token（三段 dot-separated）才嘗試 JWT verify。
  const looksLikeJwt = typeof token === 'string' && token.split('.').length === 3;
  if (looksLikeJwt) {
    try {
      const payload = verify(token, JWT_SECRET) as JwtPayload & {
        sub?: string;
        displayName?: string;
        provider?: string;
      };
      // Guest JWT 也會 verify 通過但 provider === 'guest'，交給下面的 guest 路徑統一處理。
      if (payload.sub && payload.provider !== 'guest') {
        return {
          playerId:    payload.sub,
          displayName: payload.displayName,
          provider:    payload.provider,
        };
      }
    } catch {
      // not a custom JWT, continue
    }

    // 路徑 2：Firebase ID Token → uid 就是 playerId
    if (isFirebaseAdminReady()) {
      try {
        const decoded = await verifyIdToken(token);
        const decodedTyped = decoded as typeof decoded & { picture?: string };
        return {
          playerId:    decoded.uid,
          displayName: decoded.name || (decoded.email?.split('@')[0] ?? undefined),
          provider:    'google',
          email:       decoded.email,
          firebaseUid: decoded.uid,
          photoUrl:    decodedTyped.picture,
        };
      } catch {
        // invalid token
      }
    }
  }

  // 路徑 3：Guest — server-signed JWT (new) or legacy JSON within 3-day grace.
  // See middleware/guestAuth.ts for S10 impersonation fix (Plan v2 R1.0).
  const guest = verifyGuestToken(token);
  if (guest) {
    return {
      playerId:    guest.uid,
      displayName: guest.displayName,
      provider:    'guest',
    };
  }

  return null;
}

/** @deprecated 保留以防其他呼叫者，內部改用 resolvePlayerAuth */
async function resolvePlayerId(authHeader: string | undefined): Promise<string | null> {
  const auth = await resolvePlayerAuth(authHeader);
  return auth?.playerId ?? null;
}
void resolvePlayerId;

/** 建立空 profile（新登入但尚無遊戲記錄的玩家） */
function emptyProfile(auth: ResolvedAuth): {
  id: string;
  display_name: string;
  photo_url: string | null;
  email: string | null;
  provider: string;
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  recent_games: [];
  short_code: string | null;
} {
  return {
    id:           auth.playerId,
    display_name: auth.displayName || auth.playerId,
    photo_url:    auth.photoUrl ?? null,
    email:        auth.email ?? null,
    provider:     auth.provider || 'guest',
    elo_rating:   1000,
    total_games:  0,
    games_won:    0,
    games_lost:   0,
    badges:       [],
    recent_games: [],
    short_code:   null,
  };
}

/**
 * 將 auth 轉成用戶 row id：
 * - Firebase (google)：查/建 Supabase row 回 UUID；Firestore 模式用 firebaseUid
 *   當作 auth_users doc id（本檔 MVP — 完整 user doc 建立交給 #46 帳號遷移）
 * - Discord/Line：JWT sub 即為 user id（Supabase 模式要 UUID；Firestore 模式
 *   任意 string 皆可）
 * - Guest → null（不能編輯）
 *
 * Firestore 路徑在 Ticket #42 rewrite 新增：Supabase 未配置但 Firebase admin
 * ready 時（= 目前生產環境）直接用 auth.playerId 作 auth_users doc id；
 * Discord/Line callback 建 row 那條走 firestoreAccounts upsert flow（後續
 * 票補齊，本次先支援已登入狀態的綁定查詢）。
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
async function resolveSupabaseUserId(auth: ResolvedAuth): Promise<string | null> {
  if (auth.provider === 'google' && auth.firebaseUid) {
    const supa = await ensureSupabaseUserForFirebase(
      auth.firebaseUid,
      auth.displayName || auth.firebaseUid,
      auth.email,
      auth.photoUrl,
    );
    if (supa) return supa;
    // Firestore fallback: use the firebase uid directly as auth_users doc id.
    if (isFirestoreReady()) return auth.firebaseUid;
    return null;
  }
  if (auth.provider === 'google') {
    const supa = await getSupabaseIdByFirebaseUid(auth.playerId);
    if (supa) return supa;
    if (isFirestoreReady()) return auth.playerId;
    return null;
  }
  if (auth.provider === 'discord' || auth.provider === 'line') {
    if (UUID_RE.test(auth.playerId)) return auth.playerId;
    if (isFirestoreReady()) return auth.playerId;
  }
  return null;
}

/**
 * Route guard: any multi-account binding endpoint requires either Supabase or
 * Firestore to be live. With Ticket #42 route B this becomes true in production
 * (Firebase admin ready), which the legacy `isSupabaseReady()` gate wrongly
 * denied.
 */
function isAccountStoreReady(): boolean {
  return isSupabaseReady() || isFirestoreReady();
}

/** 把 Supabase override 欄位合併到 Firestore profile 上面 */
function mergeOverrides<T extends FirestoreUserProfile>(
  profile: T,
  overrides: DbUserOverrides | null,
): T & { email: string | null; short_code: string | null } {
  if (!overrides) {
    return { ...profile, email: null, short_code: profile.short_code ?? null } as T & {
      email: string | null; short_code: string | null;
    };
  }
  return {
    ...profile,
    display_name: overrides.display_name ?? profile.display_name,
    photo_url:    overrides.photo_url ?? profile.photo_url,
    provider:     overrides.provider ?? profile.provider,
    email:        overrides.email,
    short_code:   overrides.short_code ?? profile.short_code ?? null,
  } as T & { email: string | null; short_code: string | null };
}

// ── GET /api/leaderboard ──────────────────────────────────────
// 回傳全部有遊戲紀錄的玩家（預估 300-500 位），含 <30 場的菜雞。
// 前端依 tier 分組顯示；若只拿前 50 名會砍掉菜雞 tab 的所有玩家。
router.get('/leaderboard', publicLimiter, async (_req: Request, res: Response) => {
  try {
    const leaderboard = await getFirestoreLeaderboard();
    return res.json({ leaderboard });
  } catch (err) {
    console.error('[api/leaderboard] Firestore error:', err);
    return res.json({ leaderboard: [], message: 'Database not configured' });
  }
});

// ── GET /api/profile/me ───────────────────────────────────────
router.get('/profile/me', publicLimiter, async (req: Request, res: Response) => {
  // Resolve player from auth token
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    // 先用 playerId 試查
    let profile = await getFirestoreUserProfile(auth.playerId);
    // 若找不到，再嘗試用 displayName 查（Firestore games 有時用 display name 當 playerId）
    if (!profile && auth.displayName) {
      profile = await getFirestoreUserProfile(auth.displayName);
    }

    // 拉 Supabase users table 的權威 override（display_name / photo_url / email / provider）
    const supabaseId = await resolveSupabaseUserId(auth);
    const overrides = supabaseId ? await getDbUserOverrides(supabaseId) : null;

    // 仍找不到 Firestore profile → 回空 profile + overrides
    if (!profile) {
      const empty = emptyProfile(auth);
      if (overrides) {
        return res.json({
          profile: {
            ...empty,
            id:           supabaseId ?? empty.id,
            display_name: overrides.display_name,
            photo_url:    overrides.photo_url,
            email:        overrides.email,
            provider:     overrides.provider,
            short_code:   overrides.short_code ?? empty.short_code,
          },
        });
      }
      return res.json({ profile: empty });
    }

    const merged = mergeOverrides(profile, overrides);
    // 若有 Supabase id 就以 UUID 為 id，供 PATCH/friend 關聯
    if (supabaseId) {
      (merged as { id: string }).id = supabaseId;
    }
    return res.json({ profile: merged });
  } catch (err) {
    console.error('[api/profile/me] Firestore error:', err);
    // 退化成空 profile 而非 503，避免個人資料頁整個壞掉
    return res.json({ profile: emptyProfile(auth) });
  }
});

// ── PATCH /api/profile/me ─────────────────────────────────────
// 僅允許編輯自己的 display_name 與 photo_url；guest 禁止。
router.patch('/profile/me', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.provider === 'guest') {
    return res.status(403).json({ error: 'Guest accounts cannot edit profile' });
  }
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const body = (req.body ?? {}) as { display_name?: unknown; photo_url?: unknown };
  const patch: ProfileEditableFields = {};

  // display_name 驗證
  if (body.display_name !== undefined) {
    if (typeof body.display_name !== 'string') {
      return res.status(400).json({ error: 'display_name must be a string' });
    }
    const trimmed = body.display_name.trim();
    if (trimmed.length === 0 || trimmed.length > 40) {
      return res.status(400).json({ error: 'display_name must be 1-40 chars' });
    }
    patch.display_name = trimmed;
  }

  // photo_url 驗證（null/空字串 → 清除；http(s) URL → 設定）
  if (body.photo_url !== undefined) {
    if (body.photo_url === null) {
      patch.photo_url = null;
    } else if (typeof body.photo_url === 'string') {
      const trimmed = body.photo_url.trim();
      if (trimmed.length === 0) {
        patch.photo_url = null;
      } else if (trimmed.length > 500) {
        return res.status(400).json({ error: 'photo_url too long (max 500)' });
      } else if (!/^https?:\/\//i.test(trimmed)) {
        return res.status(400).json({ error: 'photo_url must be http(s) URL' });
      } else {
        patch.photo_url = trimmed;
      }
    } else {
      return res.status(400).json({ error: 'photo_url must be string or null' });
    }
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No editable fields provided' });
  }

  const supabaseId = await resolveSupabaseUserId(auth);
  if (!supabaseId) {
    return res.status(503).json({ error: 'User row not found in database' });
  }

  const updated = await updateDbUserProfile(supabaseId, patch);
  if (!updated) {
    return res.status(500).json({ error: 'Update failed' });
  }

  // 回傳更新後的 profile（合併 Firestore + Supabase 最新 override）
  try {
    let profile = await getFirestoreUserProfile(supabaseId);
    if (!profile && auth.displayName) {
      profile = await getFirestoreUserProfile(auth.displayName);
    }
    const overrides = await getDbUserOverrides(supabaseId);
    if (!profile) {
      const empty = emptyProfile(auth);
      return res.json({
        profile: {
          ...empty,
          id:           supabaseId,
          display_name: updated.display_name,
          photo_url:    updated.photo_url,
          email:        overrides?.email ?? auth.email ?? null,
          provider:     overrides?.provider ?? auth.provider ?? 'unknown',
        },
      });
    }
    const merged = mergeOverrides(profile, overrides);
    (merged as { id: string }).id = supabaseId;
    return res.json({ profile: merged });
  } catch {
    // 讀不到 Firestore 也回成功—改以 updated+overrides 合成
    return res.json({
      profile: {
        id:           supabaseId,
        display_name: updated.display_name,
        photo_url:    updated.photo_url,
        email:        auth.email ?? null,
        provider:     auth.provider ?? 'unknown',
        elo_rating:   1000,
        total_games:  0,
        games_won:    0,
        games_lost:   0,
        badges:       [] as string[],
        recent_games: [],
      },
    });
  }
});

// ── GET /api/profile/:id ──────────────────────────────────────
router.get('/profile/:id', publicLimiter, async (req: Request, res: Response) => {
  try {
    const profile = await getFirestoreUserProfile(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    // 若 :id 長得像 UUID，順便合併 Supabase override（display_name/photo_url）
    if (UUID_RE.test(req.params.id)) {
      const overrides = await getDbUserOverrides(req.params.id);
      return res.json({ profile: mergeOverrides(profile, overrides) });
    }
    return res.json({ profile });
  } catch (err) {
    console.error('[api/profile] Firestore error:', err);
    return res.status(503).json({ error: 'Database not configured' });
  }
});

// ── #42 Multi-account binding ─────────────────────────────────
//
// 前端流程：
//   GET /api/user/linked       → 列當前 user 三個 provider 綁定狀態
//   POST /api/user/link/google → body { idToken }，後端驗 Firebase token 綁 Google
//   POST /api/user/unlink      → body { provider: 'discord'|'line'|'google' } 解綁
// Discord / Line 綁定走 /auth/link/<provider> redirect-based OAuth 流程。

const LINK_PROVIDERS: readonly LinkProvider[] = ['discord', 'line', 'google'] as const;

function isLinkProvider(x: unknown): x is LinkProvider {
  return typeof x === 'string' && (LINK_PROVIDERS as readonly string[]).includes(x);
}

// GET /api/user/linked
router.get('/user/linked', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.provider === 'guest') {
    return res.status(403).json({ error: 'Guest accounts cannot bind providers' });
  }
  if (!isAccountStoreReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const supabaseId = await resolveSupabaseUserId(auth);
  if (!supabaseId) return res.status(404).json({ error: 'User row not found' });
  const linked = await getLinkedAccounts(supabaseId);
  return res.json({ linked });
});

// POST /api/user/unlink { provider }
router.post('/user/unlink', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.provider === 'guest') {
    return res.status(403).json({ error: 'Guest accounts cannot bind providers' });
  }
  if (!isAccountStoreReady()) return res.status(503).json({ error: 'Database not configured' });

  const { provider } = (req.body ?? {}) as { provider?: unknown };
  if (!isLinkProvider(provider)) {
    return res.status(400).json({ error: 'provider must be one of discord/line/google' });
  }
  const supabaseId = await resolveSupabaseUserId(auth);
  if (!supabaseId) return res.status(404).json({ error: 'User row not found' });

  // 至少留 1 個 provider 才能 unlink（否則會變成無法登入的孤兒）
  const linked = await getLinkedAccounts(supabaseId);
  const linkedCount = linked.filter((l) => l.linked).length;
  const targetIsLinked = linked.find((l) => l.provider === provider && l.linked);
  if (!targetIsLinked) {
    return res.status(400).json({ error: 'Provider is not currently linked' });
  }
  if (linkedCount <= 1) {
    return res.status(400).json({
      error: 'Cannot unlink the last remaining provider — account would become unreachable',
      code:  'LAST_PROVIDER',
    });
  }

  const ok = await unlinkProviderIdentity(supabaseId, provider);
  if (!ok) return res.status(500).json({ error: 'Unlink failed' });
  const after = await getLinkedAccounts(supabaseId);
  return res.json({ ok: true, linked: after });
});

// POST /api/user/link/google { idToken }
// Firebase Auth 的 ID token 比跳 OAuth 好用很多 — 前端拿完直接送過來綁就行。
router.post('/user/link/google', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.provider === 'guest') {
    return res.status(403).json({ error: 'Guest accounts cannot bind providers' });
  }
  if (!isAccountStoreReady()) return res.status(503).json({ error: 'Database not configured' });

  const { idToken } = (req.body ?? {}) as { idToken?: unknown };
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return res.status(400).json({ error: 'idToken required' });
  }
  if (!isFirebaseAdminReady()) {
    return res.status(503).json({ error: 'Firebase admin not configured' });
  }

  let firebaseUid: string;
  try {
    const decoded = await verifyIdToken(idToken);
    firebaseUid = decoded.uid;
  } catch {
    return res.status(400).json({ error: 'Invalid Firebase ID token' });
  }

  const supabaseId = await resolveSupabaseUserId(auth);
  if (!supabaseId) return res.status(404).json({ error: 'User row not found' });

  // 若 firebase_uid 已屬另一 user row → 合併
  const existing = await findUserIdByProviderIdentity('google', firebaseUid);
  if (existing && existing !== supabaseId) {
    const merged = await mergeUserAccounts(supabaseId, existing);
    if (!merged) return res.status(500).json({ error: 'Merge failed' });
    const linked = await getLinkedAccounts(supabaseId);
    return res.json({ ok: true, merged: true, linked });
  }
  if (!existing) {
    const linked = await linkProviderIdentity(supabaseId, 'google', firebaseUid);
    if (!linked) return res.status(500).json({ error: 'Link failed' });
  }
  const linked = await getLinkedAccounts(supabaseId);
  return res.json({ ok: true, merged: false, linked });
});

// ── GET /api/replay/:roomId ───────────────────────────────────
router.get('/replay/:roomId', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const events = await getGameEvents(req.params.roomId);
  if (events.length === 0) {
    return res.status(404).json({ error: 'No events found for this room' });
  }
  return res.json({ room_id: req.params.roomId, events });
});

// ── POST /api/ai/selfplay ─────────────────────────────────────
// Admin-only endpoint to trigger self-play data generation
// Body: { playerCount?: 5-10, games?: 1-100, persist?: boolean, mode?: 'normal'|'hard'|'mixed'|'baseline' }
router.post('/ai/selfplay', adminLimiter, async (req: Request, res: Response) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const playerCount = Math.min(10, Math.max(5, Number(req.body?.playerCount) || 5));
  const games       = Math.min(100, Math.max(1, Number(req.body?.games) || 10));
  const persist     = req.body?.persist !== false;
  const validModes  = ['normal', 'hard', 'mixed', 'baseline'] as const;
  const mode        = validModes.includes(req.body?.mode) ? req.body.mode as typeof validModes[number] : 'normal';

  try {
    const engine = new SelfPlayEngine();
    const agents = buildAgents(playerCount, mode);
    const stats = await engine.runBatch(agents, games, persist);
    return res.json({ ok: true, mode, playerCount, ...stats });
  } catch (err) {
    console.error('[ai/selfplay]', err);
    return res.status(500).json({ error: 'Self-play failed' });
  }
});

// ── GET /api/ai/stats ─────────────────────────────────────────
router.get('/ai/stats', publicLimiter, async (_req: Request, res: Response) => {
  const defaultResponse = {
    totalGames: 0,
    goodWinRate: 0,
    evilWinRate: 0,
    avgRounds: 0,
    roleWinRates: {} as Record<string, { wins: number; total: number; rate: number }>,
    gamesLast7Days: [] as { date: string; count: number }[],
    playerCountBreakdown: {} as Record<string, number>,
    scheduler: getSelfPlayStatus(),
  };

  if (!isSupabaseReady()) {
    return res.json({ ...defaultResponse, message: 'Database not configured' });
  }

  const { getSupabaseClient } = await import('../services/supabase');
  const db = getSupabaseClient();
  if (!db) return res.json(defaultResponse);

  try {
    // ── 1. All AI game records (room_id starts with AI-) ──────────────────
    const { data: records } = await db
      .from('game_records')
      .select('room_id, role, team, won, player_count, created_at')
      .like('room_id', 'AI-%');

    const allRecords = (records ?? []) as {
      room_id: string;
      role: string;
      team: string;
      won: boolean;
      player_count: number;
      created_at: string;
    }[];

    // ── Unique games ───────────────────────────────────────────────────────
    const uniqueRooms = new Set(allRecords.map(r => r.room_id));
    const totalGames = uniqueRooms.size;

    // ── Good/Evil win rates ────────────────────────────────────────────────
    // Determine winner per room: find any record where won=true to learn which team won
    const roomWinTeam = new Map<string, string>();
    for (const r of allRecords) {
      if (r.won && !roomWinTeam.has(r.room_id)) {
        roomWinTeam.set(r.room_id, r.team);
      }
    }
    let goodWins = 0, evilWins = 0;
    for (const team of roomWinTeam.values()) {
      if (team === 'good') goodWins++;
      else if (team === 'evil') evilWins++;
    }
    const goodWinRate = totalGames > 0 ? Math.round((goodWins / totalGames) * 100) : 0;
    const evilWinRate = totalGames > 0 ? Math.round((evilWins / totalGames) * 100) : 0;

    // ── Average rounds per game (quest_resolved events) ───────────────────
    const { data: questEvents } = await db
      .from('game_events')
      .select('room_id')
      .like('room_id', 'AI-%')
      .eq('event_type', 'quest_resolved');

    const roundsPerRoom = new Map<string, number>();
    for (const ev of (questEvents ?? []) as { room_id: string }[]) {
      roundsPerRoom.set(ev.room_id, (roundsPerRoom.get(ev.room_id) ?? 0) + 1);
    }
    const totalRounds = [...roundsPerRoom.values()].reduce((a, b) => a + b, 0);
    const avgRounds = roundsPerRoom.size > 0
      ? Math.round((totalRounds / roundsPerRoom.size) * 10) / 10
      : 0;

    // ── Role win rates ─────────────────────────────────────────────────────
    const roleMap = new Map<string, { wins: number; total: number }>();
    for (const r of allRecords) {
      if (!roleMap.has(r.role)) roleMap.set(r.role, { wins: 0, total: 0 });
      const entry = roleMap.get(r.role)!;
      entry.total++;
      if (r.won) entry.wins++;
    }
    const roleWinRates: Record<string, { wins: number; total: number; rate: number }> = {};
    for (const [role, { wins, total }] of roleMap) {
      roleWinRates[role] = { wins, total, rate: total > 0 ? Math.round((wins / total) * 100) : 0 };
    }

    // ── Games per day for last 7 days ─────────────────────────────────────
    const roomDayMap = new Map<string, Set<string>>();
    for (const r of allRecords) {
      const d = new Date(r.created_at).toISOString().slice(0, 10);
      if (!roomDayMap.has(d)) roomDayMap.set(d, new Set());
      roomDayMap.get(d)!.add(r.room_id);
    }
    const now = new Date();
    const gamesLast7Days: { date: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      gamesLast7Days.push({ date: d, count: roomDayMap.get(d)?.size ?? 0 });
    }

    // ── Player count breakdown ─────────────────────────────────────────────
    const pcRoomMap = new Map<number, Set<string>>();
    for (const r of allRecords) {
      const pc = r.player_count;
      if (!pcRoomMap.has(pc)) pcRoomMap.set(pc, new Set());
      pcRoomMap.get(pc)!.add(r.room_id);
    }
    const playerCountBreakdown: Record<string, number> = {};
    for (const [pc, rooms] of pcRoomMap) {
      playerCountBreakdown[String(pc)] = rooms.size;
    }

    return res.json({
      totalGames,
      goodWinRate,
      evilWinRate,
      avgRounds,
      roleWinRates,
      gamesLast7Days,
      playerCountBreakdown,
      scheduler: getSelfPlayStatus(),
    });
  } catch (err) {
    console.error('[ai/stats]', err);
    return res.status(500).json({ error: 'Failed to fetch AI stats' });
  }
});

export { router as apiRouter };
