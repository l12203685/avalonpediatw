import { Router, Request, Response, IRouter, raw as expressRaw } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady, getAdminStorageBucket } from '../services/firebase';
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
import { getShortCodeByUid } from '../services/shortCodeFirestore';
import { SelfPlayEngine } from '../ai/SelfPlayEngine';
import { getSelfPlayStatus, buildAgents } from '../ai/SelfPlayScheduler';
import { createHttpRateLimit } from '../middleware/rateLimit';
import { verifyGuestToken } from '../middleware/guestAuth';
import { ComputedStatsRepositoryV2 } from '../services/ComputedStatsRepositoryV2';
import { getLeaderboardV3 } from '../services/LeaderboardV3';
import { resolveDisplayNameFallback } from '@avalon/shared';

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

/**
 * 讀 Firestore `auth_users/{uid}` 的 display_name / photo_url override（2026-04-25
 * hineko avatar upload 引入）。production 走 Firestore SSoT；Supabase override
 * 在 Firebase-only 部署回 null，這條補足空缺。
 */
async function getFirestoreAuthOverrides(
  uid: string,
): Promise<{ display_name: string | null; photo_url: string | null } | null> {
  if (!isFirestoreReady()) return null;
  try {
    const { getAdminFirestore } = await import('../services/firebase');
    const db = getAdminFirestore();
    const snap = await db.collection('auth_users').doc(uid).get();
    if (!snap.exists) return null;
    const data = (snap.data() ?? {}) as { display_name?: string; photo_url?: string | null };
    return {
      display_name: typeof data.display_name === 'string' ? data.display_name : null,
      photo_url:    typeof data.photo_url === 'string' ? data.photo_url : null,
    };
  } catch {
    return null;
  }
}

/** 把 Supabase override 欄位合併到 Firestore profile 上面 */
function mergeOverrides<T extends FirestoreUserProfile>(
  profile: T,
  overrides: DbUserOverrides | null,
  firestoreShortCode: string | null = null,
): T & { email: string | null; short_code: string | null } {
  // 短碼讀路徑 2026-04-24 已遷 Firestore（shortCodeIndex + auth_users.shortCode），
  // 不再從 overrides.short_code 讀（那條路已刪）。caller 傳 firestoreShortCode
  // 進來；profile.short_code 只是 FirestoreLeaderboard 保留的型別欄位、目前不會
  // 實際帶值。
  if (!overrides) {
    return { ...profile, email: null, short_code: firestoreShortCode ?? profile.short_code ?? null } as T & {
      email: string | null; short_code: string | null;
    };
  }
  return {
    ...profile,
    display_name: overrides.display_name ?? profile.display_name,
    photo_url:    overrides.photo_url ?? profile.photo_url,
    provider:     overrides.provider ?? profile.provider,
    email:        overrides.email,
    short_code:   firestoreShortCode ?? profile.short_code ?? null,
  } as T & { email: string | null; short_code: string | null };
}

// ── GET /api/leaderboard ──────────────────────────────────────
// 回傳 ≥20 場玩家（Edward 2026-04-26 16:05 上榜門檻）。
// 個別玩家 <20 場仍可從 search/profile 看完整 stats — 這裡只過濾「上榜列表」，不影響統計分析。
router.get('/leaderboard', publicLimiter, async (_req: Request, res: Response) => {
  try {
    const leaderboard = await getFirestoreLeaderboard();
    return res.json({ leaderboard });
  } catch (err) {
    console.error('[api/leaderboard] Firestore error:', err);
    return res.json({ leaderboard: [], message: 'Database not configured' });
  }
});

// ── GET /api/leaderboard/v3 ────────────────────────────────────
// Edward 2026-04-26 22:41/22:45 — 8 metric leaderboard + Bayesian shrinkage + 角色×位置精準 metric.
// 入場門檻：能力角 (刺/娜/德/奧/派/梅) ≥ 3 場 each, 忠臣 ≥ 15 場.
// 讀 analysis_cache.json (rebuilt from 2146 raw 牌譜)，無 Firestore 依賴，回傳完整 entries.
// 前端 LeaderboardPage 用 toggle (Raw/Shrinkage) 切換版本，sortable 8 欄 + 精準 metric.
router.get('/leaderboard/v3', publicLimiter, async (_req: Request, res: Response) => {
  try {
    const data = await getLeaderboardV3();
    return res.json({ version: 3, ...data });
  } catch (err) {
    console.error('[api/leaderboard/v3] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/leaderboard/v2 ────────────────────────────────────
// Edward 2026-04-24 雙維度分類排行榜（TierGroup × EloTag）。
// 讀 `computed_stats/` collection → computeLeaderboardByTier 分組 → enrich displayName。
// 回傳 `{ version: 2, groups: { rookie, regular, veteran, expert, master } }`，前端 LeaderboardPage 依此渲染。
router.get('/leaderboard/v2', publicLimiter, async (_req: Request, res: Response) => {
  try {
    const repo = new ComputedStatsRepositoryV2();
    const rawGroups = await repo.getLeaderboard();
    // Edward 2026-04-24 15:27：`sheets:unknown` 是全站平均 aggregate 玩家，
    // 不進排行榜（但其戰績已貢獻給其他玩家 stats）。
    const groups = Object.fromEntries(
      Object.entries(rawGroups).map(([tierGroup, entries]) => [
        tierGroup,
        entries
          .filter((e) => e.playerId !== 'sheets:unknown')
          .map((e) => ({
            ...e,
            displayName: resolveDisplayNameFallback(e.playerId),
            photoUrl: null,
          })),
      ]),
    );
    return res.json({ version: 2, groups });
  } catch (err) {
    console.error('[api/leaderboard/v2] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
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
    // 短碼走 Firestore（2026-04-24 #48 讀路徑遷徙）— supabaseId 同時是 Firestore
    // auth_users doc id（Firestore fallback path）或 Supabase UUID；兩者 uid
    // 都是 shortCodeIndex 的 key。
    const firestoreShortCode = supabaseId ? await getShortCodeByUid(supabaseId) : null;
    // 2026-04-25 hineko avatar upload：若 Supabase 不在但 Firestore 在，
    // auth_users override 的 display_name / photo_url 是權威來源。
    const authOverrides = supabaseId ? await getFirestoreAuthOverrides(supabaseId) : null;

    // 仍找不到 Firestore profile → 回空 profile + overrides
    if (!profile) {
      const empty = emptyProfile(auth);
      if (overrides || authOverrides) {
        return res.json({
          profile: {
            ...empty,
            id:           supabaseId ?? empty.id,
            display_name: authOverrides?.display_name ?? overrides?.display_name ?? empty.display_name,
            photo_url:    authOverrides?.photo_url    ?? overrides?.photo_url    ?? empty.photo_url,
            email:        overrides?.email ?? auth.email ?? empty.email,
            provider:     overrides?.provider ?? auth.provider ?? empty.provider,
            short_code:   firestoreShortCode ?? empty.short_code,
          },
        });
      }
      if (firestoreShortCode) {
        return res.json({ profile: { ...empty, short_code: firestoreShortCode } });
      }
      return res.json({ profile: empty });
    }

    const merged = mergeOverrides(profile, overrides, firestoreShortCode);
    // 若有 Supabase id 就以 UUID 為 id，供 PATCH/friend 關聯
    if (supabaseId) {
      (merged as { id: string }).id = supabaseId;
    }
    // auth_users override 蓋過 Firestore profile（Firestore profile 不帶
    // display_name / photo_url，但 mergeOverrides 走 Supabase override 路徑時
    // 不會看 authOverrides）。確保兩條都被 union 到。
    if (authOverrides) {
      if (authOverrides.display_name) (merged as { display_name: string }).display_name = authOverrides.display_name;
      if (authOverrides.photo_url !== null) {
        (merged as { photo_url: string | null }).photo_url = authOverrides.photo_url;
      } else if (overrides?.photo_url == null) {
        (merged as { photo_url: string | null }).photo_url = null;
      }
    }
    return res.json({ profile: merged });
  } catch (err) {
    console.error('[api/profile/me] Firestore error:', err);
    // 退化成空 profile 而非 503，避免個人資料頁整個壞掉
    return res.json({ profile: emptyProfile(auth) });
  }
});

// ── PATCH /api/profile/me ─────────────────────────────────────
// 允許編輯 display_name 與 photo_url；guest 禁止。
// 2026-04-25 hineko avatar upload：production 已遷 Firestore SSoT，PATCH 不再
// 強制要求 Supabase。改成兩條寫路徑：
//   1) Supabase ready → updateDbUserProfile（保留既有寫路徑）
//   2) Firebase admin ready → updateAuthUserProfileFields（Firestore `auth_users.{display_name,photo_url}`）
// 其中至少一條成功就回 200；皆失敗回 503。
router.patch('/profile/me', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.provider === 'guest') {
    return res.status(403).json({ error: 'Guest accounts cannot edit profile' });
  }
  if (!isAccountStoreReady()) {
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

  // 雙寫：Supabase + Firestore。任一條成功即回 200；皆失敗才回 500。
  let updatedDisplayName: string | null = null;
  let updatedPhotoUrl:    string | null = null;
  let anyOk = false;

  if (isSupabaseReady()) {
    const supaUpd = await updateDbUserProfile(supabaseId, patch);
    if (supaUpd) {
      anyOk = true;
      updatedDisplayName = supaUpd.display_name;
      updatedPhotoUrl    = supaUpd.photo_url;
    }
  }

  if (isFirestoreReady()) {
    const { updateAuthUserProfileFields } = await import('../services/firestoreAuthAccounts');
    const fsUpd = await updateAuthUserProfileFields(supabaseId, patch);
    if (fsUpd.ok && fsUpd.data) {
      anyOk = true;
      // Firestore 視為權威來源；若兩邊都成功，前端拿 Firestore 結果
      updatedDisplayName = fsUpd.data.display_name ?? updatedDisplayName;
      updatedPhotoUrl    = fsUpd.data.photo_url    ?? (patch.photo_url === null ? null : updatedPhotoUrl);
    }
  }

  if (!anyOk) {
    return res.status(500).json({ error: 'Update failed' });
  }

  // 回傳更新後的 profile（合併 Firestore + Supabase + auth_users override）
  try {
    let profile = await getFirestoreUserProfile(supabaseId);
    if (!profile && auth.displayName) {
      profile = await getFirestoreUserProfile(auth.displayName);
    }
    const overrides = await getDbUserOverrides(supabaseId);
    const firestoreShortCode = await getShortCodeByUid(supabaseId);
    const authOverrides = await getFirestoreAuthOverrides(supabaseId);
    const finalDisplayName = updatedDisplayName ?? authOverrides?.display_name ?? overrides?.display_name ?? null;
    const finalPhotoUrl    = updatedPhotoUrl    ?? authOverrides?.photo_url    ?? overrides?.photo_url    ?? null;
    if (!profile) {
      const empty = emptyProfile(auth);
      return res.json({
        profile: {
          ...empty,
          id:           supabaseId,
          display_name: finalDisplayName ?? empty.display_name,
          photo_url:    finalPhotoUrl,
          email:        overrides?.email ?? auth.email ?? null,
          provider:     overrides?.provider ?? auth.provider ?? 'unknown',
          short_code:   firestoreShortCode ?? empty.short_code,
        },
      });
    }
    const merged = mergeOverrides(profile, overrides, firestoreShortCode);
    (merged as { id: string }).id = supabaseId;
    if (finalDisplayName !== null) (merged as { display_name: string }).display_name = finalDisplayName;
    (merged as { photo_url: string | null }).photo_url = finalPhotoUrl;
    return res.json({ profile: merged });
  } catch {
    return res.json({
      profile: {
        id:           supabaseId,
        display_name: updatedDisplayName ?? auth.displayName ?? supabaseId,
        photo_url:    updatedPhotoUrl,
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

// ── POST /api/user/avatar ─────────────────────────────────────
// 玩家上傳自訂頭像 → Firebase Storage → 寫回 photo_url。
//
// Edward 2026-04-25 「讓玩家顯圖可以自行上傳」。設計：
//   - Body: 二進位 image bytes（Content-Type 是真實 MIME，由 client fetch 傳）
//   - Limit: 1 MB，jpg / png / webp 三格式
//   - Storage path: `avatars/{uid}/{timestamp}.{ext}`
//   - 寫 Firestore `auth_users/{uid}.photo_url`（雙寫 Supabase 若 ready）
//   - 回 { avatarUrl }
//
// 為何 raw body 不走 multer：(a) 不引新依賴；(b) 純單檔 binary 上傳，無需
// multipart 解析；(c) 前端用 fetch 直接送 File body，最直觀。
const AVATAR_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const AVATAR_ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

router.post(
  '/user/avatar',
  publicLimiter,
  // 限制 raw body 大小 + 接受三種 MIME
  expressRaw({
    type:  Object.keys(AVATAR_ALLOWED_MIME),
    limit: AVATAR_MAX_BYTES,
  }),
  async (req: Request, res: Response) => {
    const auth = await resolvePlayerAuth(req.headers.authorization);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    if (auth.provider === 'guest') {
      return res.status(403).json({ error: 'Guest accounts cannot upload avatar' });
    }
    if (!isFirebaseAdminReady()) {
      return res.status(503).json({ error: 'Firebase admin not configured' });
    }

    const contentType = (req.headers['content-type'] ?? '').toString().split(';')[0].trim().toLowerCase();
    const ext = AVATAR_ALLOWED_MIME[contentType];
    if (!ext) {
      return res.status(400).json({ error: 'Invalid content type — only image/jpeg, image/png, image/webp accepted' });
    }

    const buf = req.body as Buffer | undefined;
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: 'Empty body' });
    }
    if (buf.length > AVATAR_MAX_BYTES) {
      return res.status(413).json({ error: 'File too large (max 1 MB)' });
    }

    const supabaseId = await resolveSupabaseUserId(auth);
    if (!supabaseId) {
      return res.status(503).json({ error: 'User row not found in database' });
    }

    let publicUrl: string;
    try {
      const bucket = getAdminStorageBucket();
      const objectPath = `avatars/${supabaseId}/${Date.now()}.${ext}`;
      const file = bucket.file(objectPath);
      await file.save(buf, {
        metadata: { contentType },
        resumable: false,
      });
      // 讓物件公開可讀（讀取走 Cloud Storage CDN，不必每次拿 signed URL）。
      // bucket-level Uniform Access 模式下 makePublic 會 throw，這時改用
      // long-lived signed URL（10 年）作為 fallback。
      try {
        await file.makePublic();
        publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURI(objectPath)}`;
      } catch (publicErr) {
        const msg = publicErr instanceof Error ? publicErr.message : String(publicErr);
        console.warn('[api/user/avatar] makePublic failed, fallback to signed URL:', msg);
        const [signed] = await file.getSignedUrl({
          action: 'read',
          // 10 年內視同永久；前端任何時候 GET 都能取
          expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
        });
        publicUrl = signed;
      }
    } catch (err) {
      console.error('[api/user/avatar] upload error:', err);
      return res.status(500).json({ error: 'Upload failed' });
    }

    // 寫回 photo_url（Firestore 主，Supabase 同步）
    let writeOk = false;
    if (isFirestoreReady()) {
      const { updateAuthUserProfileFields } = await import('../services/firestoreAuthAccounts');
      const fsUpd = await updateAuthUserProfileFields(supabaseId, { photo_url: publicUrl });
      if (fsUpd.ok) writeOk = true;
    }
    if (isSupabaseReady()) {
      const supaUpd = await updateDbUserProfile(supabaseId, { photo_url: publicUrl });
      if (supaUpd) writeOk = true;
    }
    if (!writeOk) {
      return res.status(500).json({ error: 'Avatar uploaded but DB update failed', avatarUrl: publicUrl });
    }

    return res.json({ avatarUrl: publicUrl });
  },
);

// 自定義錯誤 handler 為 expressRaw 超出 limit 時轉成 413（預設會 throw 500）。
// 掛在 router 末端、其他 routes 之前的位置不影響其他 path。
router.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
    return res.status(413).json({ error: 'File too large (max 1 MB)' });
  }
  return next(err);
});

// ── GET /api/profile/:id ──────────────────────────────────────
router.get('/profile/:id', publicLimiter, async (req: Request, res: Response) => {
  try {
    const profile = await getFirestoreUserProfile(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    // 若 :id 長得像 UUID，順便合併 Supabase override（display_name/photo_url）
    // 短碼走 Firestore（2026-04-24 #48 讀路徑遷徙）
    if (UUID_RE.test(req.params.id)) {
      const overrides = await getDbUserOverrides(req.params.id);
      const firestoreShortCode = await getShortCodeByUid(req.params.id);
      return res.json({ profile: mergeOverrides(profile, overrides, firestoreShortCode) });
    }
    // 非 UUID id（Firestore auth_users docId 例如 Discord externalId）— 仍補短碼
    const firestoreShortCode = await getShortCodeByUid(req.params.id);
    if (firestoreShortCode) {
      return res.json({ profile: mergeOverrides(profile, null, firestoreShortCode) });
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

// GET /api/user/me
// 2026-04-24 UX Phase 1：前端 IdentityBadge + LoginBindingPage 讀的權威資料源。
// 回 { userId, primaryEmail, emailOnly, linkedProviders: [{provider, linked, email, displayLabel}] }。
// - primaryEmail 由後端根據 Google > Discord > emailOnly 優先序計算並存在 auth_users row
// - emailOnly 為純 email 退路（OAuth 都沒綁才會有值）
// - linkedProviders 直接回 getLinkedAccounts 結果 + 補 email 欄位給前端顯示
router.get('/user/me', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!isAccountStoreReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  // 訪客 — 回最小身份資料，primaryEmail 為 null，linkedProviders 全 linked=false。
  if (auth.provider === 'guest') {
    return res.json({
      userId:         auth.playerId,
      displayName:    auth.displayName ?? null,
      primaryEmail:   null,
      emailOnly:      null,
      provider:       'guest',
      linkedProviders: [
        { provider: 'google',  linked: false, email: null, displayLabel: null, primary: false },
        { provider: 'discord', linked: false, email: null, displayLabel: null, primary: false },
        { provider: 'line',    linked: false, email: null, displayLabel: null, primary: false },
      ],
    });
  }

  const supabaseId = await resolveSupabaseUserId(auth);
  if (!supabaseId) return res.status(404).json({ error: 'User row not found' });

  // 並行讀 auth_users row（取 primaryEmail / emailOnly / per-provider email）+ linkedProviders。
  const [authUserRow, linked] = await Promise.all([
    (async (): Promise<{
      primaryEmail: string | null;
      emailOnly:    string | null;
      googleEmail:  string | null;
      discordEmail: string | null;
      lineEmail:    string | null;
      displayName:  string | null;
    } | null> => {
      if (!isFirestoreReady()) return null;
      try {
        const { getAdminFirestore } = await import('../services/firebase');
        const db = getAdminFirestore();
        const snap = await db.collection('auth_users').doc(supabaseId).get();
        if (!snap.exists) return null;
        const data = (snap.data() ?? {}) as {
          primaryEmail?: string; emailOnly?: string | null;
          googleEmail?: string | null; discordEmail?: string | null; lineEmail?: string | null;
          display_name?: string;
        };
        return {
          primaryEmail: typeof data.primaryEmail === 'string' ? data.primaryEmail : null,
          emailOnly:    typeof data.emailOnly === 'string' ? data.emailOnly : null,
          googleEmail:  typeof data.googleEmail === 'string' ? data.googleEmail : null,
          discordEmail: typeof data.discordEmail === 'string' ? data.discordEmail : null,
          lineEmail:    typeof data.lineEmail === 'string' ? data.lineEmail : null,
          displayName:  typeof data.display_name === 'string' ? data.display_name : null,
        };
      } catch {
        return null;
      }
    })(),
    getLinkedAccounts(supabaseId),
  ]);

  const providerEmailMap = {
    google:  authUserRow?.googleEmail  ?? null,
    discord: authUserRow?.discordEmail ?? null,
    line:    authUserRow?.lineEmail    ?? null,
  };
  const linkedProviders = linked.map((l) => ({
    provider:     l.provider,
    linked:       l.linked,
    email:        providerEmailMap[l.provider],
    displayLabel: l.display_label,
    primary:      l.primary,
  }));

  return res.json({
    userId:         supabaseId,
    displayName:    authUserRow?.displayName ?? auth.displayName ?? null,
    primaryEmail:   authUserRow?.primaryEmail ?? null,
    emailOnly:      authUserRow?.emailOnly ?? null,
    provider:       auth.provider ?? null,
    linkedProviders,
  });
});

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

// POST /api/user/merge-by-uuid { uuid }
// 2026-04-23 Edward：個人戰績頁提供「以 uuid 綁定歷史戰績」按鈕 — 玩家
// 輸入另一個 uuid 把該帳號的戰績/徽章/好友關係併到當前帳號，然後刪 secondary。
// 規則：
//   - 拒絕 guest
//   - uuid 必須是合法 UUID 格式（或至少看起來像 auth_users doc id — 非空字串）
//   - primary === secondary 直接回 409
//   - primary/secondary 任一不存在回 404
router.post('/user/merge-by-uuid', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.provider === 'guest') {
    return res.status(403).json({ error: 'Guest accounts cannot merge' });
  }
  if (!isAccountStoreReady()) return res.status(503).json({ error: 'Database not configured' });

  const { uuid } = (req.body ?? {}) as { uuid?: unknown };
  if (typeof uuid !== 'string' || uuid.trim().length === 0) {
    return res.status(400).json({ error: 'uuid required' });
  }
  const secondaryId = uuid.trim();
  if (secondaryId.length > 128) {
    return res.status(400).json({ error: 'uuid too long' });
  }

  const primaryId = await resolveSupabaseUserId(auth);
  if (!primaryId) return res.status(404).json({ error: 'Current user row not found' });
  if (primaryId === secondaryId) {
    return res.status(409).json({ error: 'Cannot merge account into itself' });
  }

  const merged = await mergeUserAccounts(primaryId, secondaryId);
  if (!merged) {
    return res.status(404).json({ error: 'Merge failed — target uuid may not exist or is already merged' });
  }
  const linked = await getLinkedAccounts(primaryId);
  return res.json({ ok: true, merged: true, primaryId, secondaryId, linked });
});

// ── Phase A: 密碼管理 + 舊戰績 claim ────────────────────────
//
// PATCH /api/user/password { oldPassword, newPassword }
// 僅 provider='password' 帳號可改自己的密碼；需附上 Bearer JWT + 原密碼。
// 403 對 guest / OAuth-only 帳號；401 對 bad token；400 對 bad password。
router.patch('/user/password', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.provider !== 'password') {
    return res.status(403).json({ error: '此帳號未設定密碼', code: 'no_password' });
  }
  if (!isFirestoreReady()) return res.status(503).json({ error: 'Database not configured' });

  const { oldPassword, newPassword } = (req.body ?? {}) as {
    oldPassword?: unknown;
    newPassword?: unknown;
  };
  if (typeof oldPassword !== 'string' || oldPassword.length === 0) {
    return res.status(400).json({ error: '請輸入原密碼', code: 'missing_old' });
  }
  const { validatePasswordStrength: vpw } = await import('../services/passwordHash');
  const { changePassword } = await import('../services/firestoreAuthAccounts');
  const strength = vpw(newPassword);
  if (!strength.ok) {
    return res.status(400).json({ error: strength.reason, code: strength.code });
  }
  const result = await changePassword({
    userId:      auth.playerId,
    oldPassword,
    newPassword: newPassword as string,
  });
  if (!result.ok) {
    const status = result.code === 'bad_credentials' ? 401
      : result.code === 'not_found'       ? 404
      : 500;
    return res.status(status).json({ error: result.reason, code: result.code });
  }
  return res.json({ ok: true });
});

// POST /api/user/claim-history { uuid, email, password }
// 玩家註冊新帳號後要把舊的 uuid 帳號戰績搬過來：輸入舊 uuid + 該帳號的信箱 +
// 該帳號的密碼。三項都對才允許 merge，避免惡意 claim 別人的戰績。
//
// 成功後：(舊 uuid, 當前登入 uuid) 走 mergeUserAccounts — 戰績、好友、
// ELO、徽章都併到當前帳號，舊 auth_users row 刪除。
router.post('/user/claim-history', publicLimiter, async (req: Request, res: Response) => {
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.provider === 'guest') {
    return res.status(403).json({ error: '訪客帳號不能 claim 戰績', code: 'guest_forbidden' });
  }
  if (!isFirestoreReady()) return res.status(503).json({ error: 'Database not configured' });

  const { uuid, email, password } = (req.body ?? {}) as {
    uuid?: unknown; email?: unknown; password?: unknown;
  };
  if (typeof uuid !== 'string' || uuid.trim().length === 0) {
    return res.status(400).json({ error: '請輸入舊帳號 uuid', code: 'missing_uuid' });
  }
  if (typeof email !== 'string' || email.length === 0) {
    return res.status(400).json({ error: '請輸入舊帳號信箱', code: 'missing_email' });
  }
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: '請輸入舊帳號密碼', code: 'missing_password' });
  }

  const legacyUuid = uuid.trim();
  if (legacyUuid === auth.playerId) {
    return res.status(409).json({ error: '不能 claim 自己', code: 'same_account' });
  }

  const { findAccountByUuidEmailPassword } = await import('../services/firestoreAuthAccounts');
  const matched = await findAccountByUuidEmailPassword(legacyUuid, email, password);
  if (!matched.ok || !matched.data) {
    // 401 keeps response opaque — we don't tell the caller which of the 3
    // inputs was wrong to avoid enumeration.
    return res.status(401).json({ error: '找不到符合的舊帳號', code: 'no_match' });
  }

  const merged = await mergeUserAccounts(auth.playerId, matched.data.legacyUserId);
  if (!merged) {
    return res.status(500).json({ error: '戰績合併失敗', code: 'merge_failed' });
  }
  return res.json({ ok: true, claimedUuid: legacyUuid });
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
  let firebaseEmail: string | undefined;
  try {
    const decoded = await verifyIdToken(idToken);
    firebaseUid   = decoded.uid;
    firebaseEmail = decoded.email ?? undefined;
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
    // 2026-04-24 UX Phase 1：傳 firebaseEmail 讓 linkProviderIdentity 寫 googleEmail
    // 並重算 primaryEmail（優先序 google > discord > emailOnly）。
    const linked = await linkProviderIdentity(supabaseId, 'google', firebaseUid, firebaseEmail);
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
