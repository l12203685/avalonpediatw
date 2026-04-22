import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { generateUniqueShortCode, normalizeShortCode, isValidShortCode } from './shortCode';

// ── 初始化 ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

export function isSupabaseReady(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

// ── 型別 ────────────────────────────────────────────────────
export interface DbUser {
  id?: string;
  firebase_uid?: string | null;
  discord_id?: string | null;
  line_id?: string | null;
  email?: string;
  display_name: string;
  photo_url?: string | null;
  provider: 'google' | 'discord' | 'line' | 'email' | 'guest';
  elo_rating?: number;
  total_games?: number;
  games_won?: number;
  games_lost?: number;
  /** 玩家可見短碼；新用戶註冊時自動生成 */
  short_code?: string | null;
}

export interface DbGameRecord {
  room_id: string;
  player_user_id: string;
  role: string;
  team: 'good' | 'evil';
  won: boolean;
  elo_before: number;
  elo_after: number;
  elo_delta: number;
  player_count: number;
  duration_sec?: number;
}

// ── 用戶 CRUD ───────────────────────────────────────────────

/**
 * 依 provider + ID 查找或建立用戶，回傳用戶的 UUID
 */
export async function upsertUser(data: DbUser): Promise<string | null> {
  const db = getSupabaseClient();
  if (!db) return null;

  try {
    // 決定查詢條件（依 provider 不同）
    let existing: { id: string } | null = null;

    if (data.firebase_uid) {
      const { data: row } = await db
        .from('users')
        .select('id')
        .eq('firebase_uid', data.firebase_uid)
        .single();
      existing = row;
    } else if (data.discord_id) {
      const { data: row } = await db
        .from('users')
        .select('id')
        .eq('discord_id', data.discord_id)
        .single();
      existing = row;
    } else if (data.line_id) {
      const { data: row } = await db
        .from('users')
        .select('id')
        .eq('line_id', data.line_id)
        .single();
      existing = row;
    }

    if (existing) {
      // 更新現有用戶的 display_name / photo_url
      await db
        .from('users')
        .update({ display_name: data.display_name, photo_url: data.photo_url ?? null })
        .eq('id', existing.id);
      return existing.id;
    }

    // 為新用戶生成唯一短碼（加好友/精準配對用）
    // 衝突用 DB unique index 保證；這裡 5 次重試足以覆蓋 32^8 空間
    let shortCode: string | null = null;
    try {
      shortCode = await generateUniqueShortCode(async (candidate) => {
        const { data: row } = await db
          .from('users')
          .select('id')
          .eq('short_code', candidate)
          .maybeSingle();
        return !!row;
      });
    } catch (err) {
      // 生成失敗不阻擋註冊（向下相容既有搜尋用 UUID 末 6 碼）
      console.error('[supabase] upsertUser shortCode generation failed:', err);
    }

    // 建立新用戶
    const { data: newUser, error } = await db
      .from('users')
      .insert({
        firebase_uid: data.firebase_uid ?? null,
        discord_id:  data.discord_id  ?? null,
        line_id:     data.line_id     ?? null,
        email:       data.email       ?? '',
        display_name: data.display_name,
        photo_url:   data.photo_url   ?? null,
        provider:    data.provider,
        short_code:  shortCode,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[supabase] upsertUser error:', error.message);
      return null;
    }
    return newUser?.id ?? null;
  } catch (err) {
    console.error('[supabase] upsertUser exception:', err);
    return null;
  }
}

/**
 * 依 UUID 取得用戶 ELO
 */
export async function getUserElo(userId: string): Promise<number> {
  const db = getSupabaseClient();
  if (!db) return 1000;
  const { data, error } = await db.from('users').select('elo_rating').eq('id', userId).single();
  if (error) return 1000;
  return data?.elo_rating ?? 1000;
}

/**
 * 批次取得多位用戶的 ELO — 單次 DB 請求取回所有玩家，避免 N+1。
 * 回傳 Map<userId, eloRating>。若某 userId 不存在則預設 1000。
 */
export async function getUserEloBulk(userIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (userIds.length === 0) return result;
  const db = getSupabaseClient();
  if (!db) {
    userIds.forEach((id) => result.set(id, 1000));
    return result;
  }
  const { data, error } = await db
    .from('users')
    .select('id, elo_rating')
    .in('id', userIds);
  if (!error && data) {
    for (const row of data) {
      result.set(row.id as string, (row.elo_rating as number) ?? 1000);
    }
  }
  // 補上查不到的 userId（預設 1000）
  for (const id of userIds) {
    if (!result.has(id)) result.set(id, 1000);
  }
  return result;
}

// ── 房間 ─────────────────────────────────────────────────────

export async function saveRoom(roomId: string, hostUserId: string | null, playerCount: number): Promise<void> {
  const db = getSupabaseClient();
  if (!db) return;
  await db.from('rooms').upsert({
    id: roomId,
    host_user_id: hostUserId,
    player_count: playerCount,
    state: 'lobby',
  }, { onConflict: 'id' });
}

export async function updateRoomState(
  roomId: string,
  state: string,
  evilWins?: boolean | null
): Promise<void> {
  const db = getSupabaseClient();
  if (!db) return;
  const update: Record<string, unknown> = { state };
  if (evilWins !== undefined) {
    update.evil_wins = evilWins;
    update.ended_at = new Date().toISOString();
  }
  await db.from('rooms').update(update).eq('id', roomId);
}

// ── 遊戲記錄 ─────────────────────────────────────────────────

/**
 * 一局結束後，批次儲存所有玩家的遊戲記錄並更新 ELO。
 *
 * Returns true when the insert + stats update actually ran against Supabase,
 * false when the call was a no-op (client not configured, empty input, or
 * insert/rpc error). Callers should gate their success log on this return
 * value so that "Saved N records" never appears when nothing was persisted.
 */
export async function saveGameRecords(records: DbGameRecord[]): Promise<boolean> {
  const db = getSupabaseClient();
  if (!db || records.length === 0) return false;

  try {
    // 寫入 game_records
    const { error } = await db.from('game_records').insert(records);
    if (error) {
      console.error('[supabase] saveGameRecords error:', error.message);
      return false;
    }

    // 更新每位玩家的 ELO 和勝負統計
    for (const record of records) {
      await db.rpc('update_player_stats', {
        p_user_id:  record.player_user_id,
        p_won:      record.won,
        p_elo_delta: record.elo_delta,
      });
    }
    return true;
  } catch (err) {
    console.error('[supabase] saveGameRecords exception:', err);
    return false;
  }
}

// ── 徽章系統 ─────────────────────────────────────────────────

/** 依成就條件檢查並新增徽章（冪等 — 重複傳相同徽章不會重複寫入） */
export async function awardBadges(userId: string, newBadges: string[]): Promise<void> {
  const db = getSupabaseClient();
  if (!db || newBadges.length === 0) return;

  const { data: user } = await db.from('users').select('badges').eq('id', userId).single();
  if (!user) return;

  const existing: string[] = user.badges ?? [];
  const toAdd = newBadges.filter(b => !existing.includes(b));
  if (toAdd.length === 0) return;

  await db.from('users').update({ badges: [...existing, ...toAdd] }).eq('id', userId);
  console.log(`[supabase] Awarded badges to ${userId}: ${toAdd.join(', ')}`);
}

// ── 遊戲事件 ─────────────────────────────────────────────────

export interface DbGameEvent {
  room_id:    string;
  seq:        number;
  event_type: string;
  actor_id:   string | null;
  event_data: Record<string, unknown>;
}

/**
 * 批次儲存一局的所有遊戲事件（AI 訓練資料 & 回放用）。
 *
 * Returns true when the insert actually completed against Supabase, false
 * when the call was a no-op (client not configured, empty input, or insert
 * error). Callers should gate their success log on this return value.
 */
export async function saveGameEvents(events: DbGameEvent[]): Promise<boolean> {
  const db = getSupabaseClient();
  if (!db || events.length === 0) return false;
  const { error } = await db.from('game_events').insert(events);
  if (error) {
    console.error('[supabase] saveGameEvents error:', error.message);
    return false;
  }
  return true;
}

/**
 * 取得一局的完整事件序列（供回放用）
 */
export async function getGameEvents(
  roomId: string,
  limitRows = 2000,
): Promise<DbGameEvent[]> {
  const db = getSupabaseClient();
  if (!db) return [];
  // 安全: 加上 limit 防止 AI 自動對戰產生大量事件時單次拉回數千筆，
  // 造成記憶體壓力與回應逾時。正常對局事件數遠低於 2000。
  const { data } = await db
    .from('game_events')
    .select('room_id, seq, event_type, actor_id, event_data')
    .eq('room_id', roomId)
    .order('seq', { ascending: true })
    .limit(limitRows);
  return (data ?? []) as DbGameEvent[];
}

// ── OAuth session（CSRF state）────────────────────────────────

/**
 * 建立 OAuth state session 做 CSRF 防護。
 *
 * #42: 新增 `linkUserId` 參數 — 若非空，表示這次 OAuth 流程是「已登入用戶綁定
 * 新 provider」而非登入，callback 會用這個欄位決定要合併/綁定到哪個 user row。
 * 透過 state token 附帶 userId 而非 URL query 避免被竄改。
 */
export async function createOAuthSession(
  stateToken: string,
  provider: 'discord' | 'line',
  linkUserId?: string,
): Promise<void> {
  const db = getSupabaseClient();
  if (!db) return;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 分鐘
  await db.from('oauth_sessions').insert({
    state_token:   stateToken,
    provider,
    expires_at:    expiresAt.toISOString(),
    link_user_id:  linkUserId ?? null,
  });
}

/**
 * 驗證 state 並取出 link_user_id（#42 綁定流程用）。
 * 用完刪 row。state 不存在/過期回 null。
 *
 * 跟 verifyAndDeleteOAuthSession 區別：後者回 boolean；這個版本要把 link_user_id
 * 取回給 callback 決定要綁哪個 user。
 */
export async function consumeOAuthSession(
  stateToken: string,
  provider: 'discord' | 'line',
): Promise<{ linkUserId: string | null } | null> {
  const db = getSupabaseClient();
  // 安全: Supabase 不可用時必須回 null（驗證失敗），讓 callback 走 auth_error 路徑。
  // 舊行為回 { linkUserId: null } 等同跳過 CSRF 驗證，讓任意 state 被接受。
  if (!db) return null;
  try {
    // 呼叫 DB-side RPC: 在單一 transaction 中 SELECT FOR UPDATE + DELETE，
    // 防止 TOCTOU 競爭條件（攻擊者無法在查詢和刪除之間重放同一 state token）。
    const { data, error } = await db.rpc('consume_oauth_session', {
      p_state_token: stateToken,
      p_provider:    provider,
    });
    if (error) return null;
    // RPC 回傳 rows 陣列：state 有效時恰好一筆，不存在/過期時空陣列
    if (!data || (data as unknown[]).length === 0) return null;
    const row = (data as Array<{ link_user_id: string | null }>)[0];
    return { linkUserId: row.link_user_id ?? null };
  } catch {
    return null;
  }
}

// ── 排行榜 & 用戶資料 ─────────────────────────────────────────

export interface LeaderboardEntry {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: string;
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  win_rate: number;
}

export interface UserProfile {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: string;
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  recent_games: RecentGame[];
}

export interface RecentGame {
  id: string;
  room_id: string;
  role: string;
  team: 'good' | 'evil';
  won: boolean;
  elo_delta: number;
  player_count: number;
  created_at: string;
}

/**
 * 取得排行榜（依 ELO 降序，最多 50 人）
 */
export async function getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  const db = getSupabaseClient();
  if (!db) return [];

  const { data, error } = await db
    .from('users')
    .select('id, display_name, photo_url, provider, elo_rating, total_games, games_won, games_lost, badges')
    .gte('total_games', 1)
    .order('elo_rating', { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.map(row => ({
    ...row,
    badges: row.badges ?? [],
    win_rate: row.total_games > 0 ? Math.round((row.games_won / row.total_games) * 100) : 0,
  }));
}

/**
 * 取得單一用戶資料（含最近 20 局遊戲）
 */
export async function getDbUserProfile(userId: string): Promise<UserProfile | null> {
  const db = getSupabaseClient();
  if (!db) return null;

  const { data: user, error } = await db
    .from('users')
    .select('id, display_name, photo_url, provider, elo_rating, total_games, games_won, games_lost, badges')
    .eq('id', userId)
    .single();

  if (error || !user) return null;

  const { data: games } = await db
    .from('game_records')
    .select('id, room_id, role, team, won, elo_delta, player_count, created_at')
    .eq('player_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  return {
    ...user,
    recent_games: (games || []) as RecentGame[],
  };
}

/**
 * 依 firebase_uid 查 Supabase UUID（用於 profile 路由）
 */
export async function getSupabaseIdByFirebaseUid(firebaseUid: string): Promise<string | null> {
  const db = getSupabaseClient();
  if (!db) return null;
  const { data } = await db.from('users').select('id').eq('firebase_uid', firebaseUid).single();
  return data?.id ?? null;
}

/**
 * 以 Supabase 用戶 UUID 查回用戶的 email（可能為空字串）。
 * 用於 admin 白名單檢核 — Discord/Line JWT 本身不攜帶 email。
 */
export async function getUserEmailById(userId: string): Promise<string | null> {
  const db = getSupabaseClient();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('users')
      .select('email')
      .eq('id', userId)
      .single();
    if (error || !data) return null;
    const email = (data.email as string | null) ?? '';
    return email || null;
  } catch {
    return null;
  }
}

// ── Profile Overrides ──────────────────────────────────────

export interface ProfileEditableFields {
  display_name?: string;
  photo_url?: string | null;
}

export interface DbUserOverrides {
  display_name: string;
  photo_url: string | null;
  email: string | null;
  provider: string;
  short_code: string | null;
}

export async function getDbUserOverrides(userId: string): Promise<DbUserOverrides | null> {
  const db = getSupabaseClient();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('users')
      .select('display_name, photo_url, email, provider, short_code')
      .eq('id', userId)
      .single();
    if (error || !data) return null;
    return {
      display_name: data.display_name as string,
      photo_url:    (data.photo_url as string | null) ?? null,
      email:        (data.email as string | null) ?? null,
      provider:     (data.provider as string) ?? 'unknown',
      short_code:   (data.short_code as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

// ── 玩家短碼（加好友用）──────────────────────────────────────

/**
 * 依短碼查用戶 UUID。
 * 短碼非法格式 → 直接 null（不查 DB）。
 */
export async function getUserIdByShortCode(code: string): Promise<string | null> {
  const normalized = normalizeShortCode(code);
  if (!isValidShortCode(normalized)) return null;

  const db = getSupabaseClient();
  if (!db) return null;
  try {
    const { data } = await db
      .from('users')
      .select('id')
      .eq('short_code', normalized)
      .maybeSingle();
    return (data?.id as string) ?? null;
  } catch (err) {
    console.error('[supabase] getUserIdByShortCode error:', err);
    return null;
  }
}

/**
 * 為缺少短碼的舊用戶 backfill 一個。若已有短碼則直接回傳現值。
 * 失敗（DB 沒設定、網路錯）回 null，呼叫端退化回 UUID 末 6 碼顯示。
 */
export async function ensureUserShortCode(userId: string): Promise<string | null> {
  const db = getSupabaseClient();
  if (!db) return null;
  try {
    const { data: existing } = await db
      .from('users')
      .select('short_code')
      .eq('id', userId)
      .maybeSingle();
    if (!existing) return null;
    if (existing.short_code) return existing.short_code as string;

    const code = await generateUniqueShortCode(async (candidate) => {
      const { data: row } = await db
        .from('users')
        .select('id')
        .eq('short_code', candidate)
        .maybeSingle();
      return !!row;
    });

    await db.from('users').update({ short_code: code }).eq('id', userId);
    return code;
  } catch (err) {
    console.error('[supabase] ensureUserShortCode error:', err);
    return null;
  }
}

export async function updateDbUserProfile(
  userId: string,
  patch: ProfileEditableFields,
): Promise<{ display_name: string; photo_url: string | null } | null> {
  const db = getSupabaseClient();
  if (!db) return null;

  const update: Record<string, string | null> = {};
  if (typeof patch.display_name === 'string') {
    const trimmed = patch.display_name.trim().slice(0, 40);
    if (trimmed.length === 0) return null;
    update.display_name = trimmed;
  }
  if (patch.photo_url === null) {
    update.photo_url = null;
  } else if (typeof patch.photo_url === 'string') {
    const trimmed = patch.photo_url.trim().slice(0, 500);
    if (trimmed.length === 0) {
      update.photo_url = null;
    } else if (/^https?:\/\//i.test(trimmed)) {
      // 安全: 只接受 http/https URL，拒絕 javascript: / data: 等可觸發 XSS 的 scheme
      update.photo_url = trimmed;
    }
    // 其他 scheme 靜默拒絕（不更新欄位）
  }

  if (Object.keys(update).length === 0) return null;

  try {
    const { data, error } = await db
      .from('users')
      .update(update)
      .eq('id', userId)
      .select('display_name, photo_url')
      .single();
    if (error || !data) return null;
    return {
      display_name: data.display_name as string,
      photo_url:    (data.photo_url as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

export async function ensureSupabaseUserForFirebase(
  firebaseUid: string,
  displayName: string,
  email?: string,
  photoUrl?: string,
): Promise<string | null> {
  const existing = await getSupabaseIdByFirebaseUid(firebaseUid);
  if (existing) return existing;
  return upsertUser({
    firebase_uid: firebaseUid,
    display_name: displayName,
    email:        email ?? '',
    photo_url:    photoUrl ?? null,
    provider:     'google',
  });
}

export async function verifyAndDeleteOAuthSession(
  stateToken: string,
  provider: 'discord' | 'line'
): Promise<boolean> {
  const db = getSupabaseClient();
  // 安全: Supabase 不可用時必須回 false（驗證失敗），不得跳過 CSRF 檢查。
  // 攻擊者可偽造任意 state 繞過 CSRF 防護，不能靜默放行。
  if (!db) return false;

  const { data, error } = await db
    .from('oauth_sessions')
    .select('id, expires_at')
    .eq('state_token', stateToken)
    .eq('provider', provider)
    .single();

  if (error || !data) return false;
  if (new Date(data.expires_at) < new Date()) return false;

  // 用完即刪
  await db.from('oauth_sessions').delete().eq('id', data.id);
  return true;
}

// ── 多帳號綁定 / 合併（#42）──────────────────────────────────
//
// 支援 Discord / Line / Google (Firebase) 三 provider 綁到同一個 users row。
// 設計：既有 users table 已有 discord_id / line_id / firebase_uid 欄位，
// 綁定 = 在當前登入 user row 上寫對應 provider 欄位；
// 合併 = 若目標 provider identity 已有獨立 user row，把那個 row 的戰績/好友
// 搬到主帳號，再刪 secondary row。
//
// provider: 'discord' | 'line' | 'google'
// providerField 對應 column:
//   discord -> discord_id
//   line    -> line_id
//   google  -> firebase_uid

export type LinkProvider = 'discord' | 'line' | 'google';

export interface LinkedAccountSummary {
  provider: LinkProvider;
  linked: boolean;
  external_id: string | null;    // 顯示用（Discord/Line 的 raw id / Firebase uid）
  primary: boolean;               // 是否為此 user row 原生 provider
}

function providerToColumn(provider: LinkProvider): 'discord_id' | 'line_id' | 'firebase_uid' {
  switch (provider) {
    case 'discord': return 'discord_id';
    case 'line':    return 'line_id';
    case 'google':  return 'firebase_uid';
  }
}

/**
 * 取得 user row 所有已綁定的 provider 狀態。
 * Guest 傳入 null 時回空陣列。
 */
export async function getLinkedAccounts(userId: string): Promise<LinkedAccountSummary[]> {
  const db = getSupabaseClient();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('users')
      .select('provider, discord_id, line_id, firebase_uid')
      .eq('id', userId)
      .single();
    if (error || !data) return [];

    const primary = (data.provider as string) ?? '';
    const providers: LinkProvider[] = ['discord', 'line', 'google'];
    return providers.map((p) => {
      const col = providerToColumn(p);
      const raw = (data as Record<string, unknown>)[col];
      const externalId = typeof raw === 'string' && raw.length > 0 ? raw : null;
      return {
        provider: p,
        linked: externalId !== null,
        external_id: externalId,
        primary: primary === p,
      };
    });
  } catch (err) {
    console.error('[supabase] getLinkedAccounts exception:', err);
    return [];
  }
}

/**
 * 查目標 OAuth identity 目前屬於哪個 user row（沒綁回 null）。
 */
export async function findUserIdByProviderIdentity(
  provider: LinkProvider,
  externalId: string,
): Promise<string | null> {
  const db = getSupabaseClient();
  if (!db) return null;
  const col = providerToColumn(provider);
  try {
    const { data, error } = await db
      .from('users')
      .select('id')
      .eq(col, externalId)
      .single();
    if (error || !data) return null;
    return (data.id as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * 把 secondary user row 的戰績/好友/徽章搬到 primary user row，並刪 secondary。
 *
 * 實作: 呼叫 PostgreSQL RPC `merge_user_accounts`，整個合併在單一 DB transaction
 * 中原子執行。任一步失敗自動 ROLLBACK，不會有半合併的資料損毀狀態。
 * Migration: supabase/migrations/20260422150000_merge_user_accounts_rpc.sql
 *
 * 合併規則：
 *   - game_records.player_user_id → primary（保留所有戰績）
 *   - users.total_games/games_won/games_lost → 兩邊相加
 *   - users.elo_rating → 取兩邊較高者（避免合併後 ELO 灌水問題，保守做法）
 *   - users.badges → 去重聯集
 *   - friendships (follower_id/following_id 中指向 secondary 的全改成 primary)
 *   - 清空兩邊互相追蹤造成的自追蹤，去重複 follower-following pair
 *   - 最後 delete secondary user row
 *
 * 回傳 true 表示合併完成（即使部分 sub-step 失敗也會繼續；caller 視為 best-effort）。
 * 回傳 false 表示 primaryId === secondaryId 或 db 不可用。
 */
export async function mergeUserAccounts(
  primaryId: string,
  secondaryId: string,
): Promise<boolean> {
  const db = getSupabaseClient();
  if (!db) return false;
  if (primaryId === secondaryId) return false;

  try {
    // 呼叫 DB-side RPC，整個合併在單一 transaction 中原子執行。
    // 任一步驟失敗 PostgreSQL 自動 ROLLBACK，不會留下半合併狀態。
    const { data, error } = await db.rpc('merge_user_accounts', {
      p_primary_id:   primaryId,
      p_secondary_id: secondaryId,
    });
    if (error) {
      console.error('[supabase] mergeUserAccounts rpc error:', error instanceof Error ? error.message : String(error));
      return false;
    }
    return data === true;
  } catch (err) {
    console.error('[supabase] mergeUserAccounts exception:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * 綁定 OAuth identity 到指定 user row。
 * 若目標 identity 已被綁給別人 → caller 應先呼叫 mergeUserAccounts。
 */
export async function linkProviderIdentity(
  userId: string,
  provider: LinkProvider,
  externalId: string,
): Promise<boolean> {
  const db = getSupabaseClient();
  if (!db) return false;
  const col = providerToColumn(provider);
  try {
    const { error } = await db
      .from('users')
      .update({ [col]: externalId })
      .eq('id', userId);
    if (error) {
      console.error('[supabase] linkProviderIdentity error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[supabase] linkProviderIdentity exception:', err);
    return false;
  }
}

/**
 * 解除綁定（不可解除唯一剩餘的 provider — caller 應檢查至少還有 1 條可登入）。
 */
export async function unlinkProviderIdentity(
  userId: string,
  provider: LinkProvider,
): Promise<boolean> {
  const db = getSupabaseClient();
  if (!db) return false;
  const col = providerToColumn(provider);
  try {
    const { error } = await db
      .from('users')
      .update({ [col]: null })
      .eq('id', userId);
    if (error) {
      console.error('[supabase] unlinkProviderIdentity error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[supabase] unlinkProviderIdentity exception:', err);
    return false;
  }
}

// ── 好友 / 追蹤系統 ───────────────────────────────────────────

export interface FriendEntry {
  id: string;
  display_name: string;
  photo_url: string | null;
  elo_rating: number;
  badges: string[];
}

/**
 * 取得我追蹤的用戶清單（join friendships → users）
 */
export async function getFriends(followerId: string): Promise<FriendEntry[]> {
  const db = getSupabaseClient();
  if (!db) return [];

  const { data, error } = await db
    .from('friendships')
    .select('following_id, users!friendships_following_id_fkey(id, display_name, photo_url, elo_rating, badges)')
    .eq('follower_id', followerId);

  if (error || !data) return [];

  type FriendshipRow = {
    following_id: string;
    users: { id: string; display_name: string; photo_url: string | null; elo_rating: number; badges: string[] | null }[] | null;
  };

  return (data as unknown as FriendshipRow[])
    .map((row) => {
      const u = Array.isArray(row.users) ? row.users[0] : row.users;
      if (!u) return null;
      return {
        id:           u.id,
        display_name: u.display_name,
        photo_url:    u.photo_url ?? null,
        elo_rating:   u.elo_rating ?? 1000,
        badges:       u.badges ?? [],
      };
    })
    .filter((entry): entry is FriendEntry => entry !== null);
}

/**
 * 追蹤用戶（重複追蹤靜默忽略）
 */
export async function followUser(followerId: string, followingId: string): Promise<void> {
  const db = getSupabaseClient();
  if (!db) return;

  const { error } = await db
    .from('friendships')
    .insert({ follower_id: followerId, following_id: followingId });

  // Ignore unique constraint violation (duplicate follow)
  if (error && !error.message.includes('duplicate') && !error.code?.includes('23505')) {
    console.error('[supabase] followUser error:', error.message);
  }
}

/**
 * 取消追蹤用戶
 */
export async function unfollowUser(followerId: string, followingId: string): Promise<void> {
  const db = getSupabaseClient();
  if (!db) return;

  const { error } = await db
    .from('friendships')
    .delete()
    .eq('follower_id', followerId)
    .eq('following_id', followingId);

  if (error) console.error('[supabase] unfollowUser error:', error.message);
}

/**
 * 檢查是否已追蹤某用戶
 */
export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  const db = getSupabaseClient();
  if (!db) return false;

  const { data } = await db
    .from('friendships')
    .select('id')
    .eq('follower_id', followerId)
    .eq('following_id', followingId)
    .single();

  return !!data;
}

// ── 玩家搜尋（供好友搜尋/加好友頁用）────────────────────────
export interface UserSearchEntry {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: string;
  elo_rating: number;
  badges: string[];
  following: boolean;   // 搜尋者是否已追蹤此人
  short_code: string;   // 玩家可見短碼（8 字元 A-Z0-9）；舊帳號未 backfill 時退回 UUID 末 6 碼
}

/**
 * 搜尋玩家：依暱稱（ilike 模糊）或 UUID 末 6 碼（精準）匹配
 * - query 為空字串：回傳最近 20 位 ELO 最高玩家（方便探索）
 * - 自動排除搜尋者自己
 * - 最多回 20 筆
 * - 同時 join 檢查 searcher 是否已追蹤結果玩家
 */
export async function searchUsers(
  query: string,
  searcherId: string | null,
  limit = 20,
): Promise<UserSearchEntry[]> {
  const db = getSupabaseClient();
  if (!db) return [];

  const safeQuery = (query || '').trim().slice(0, 60);
  // 防 LIKE 萬用字元注入：% 和 _ 要 escape
  const likePattern = safeQuery.replace(/[\\%_]/g, (m) => `\\${m}`);

  try {
    let builder = db
      .from('users')
      .select('id, display_name, photo_url, provider, elo_rating, badges, short_code')
      .order('elo_rating', { ascending: false })
      .limit(limit);

    if (safeQuery.length > 0) {
      // 支援三種輸入：暱稱模糊、UUID 字串包含（舊相容）、玩家短碼精準
      // 短碼正規化後（去空白+大寫）若為合法格式 → 加精準匹配
      const normalizedCode = normalizeShortCode(safeQuery);
      const codeFilter = isValidShortCode(normalizedCode)
        ? `,short_code.eq.${normalizedCode}`
        : '';
      builder = builder.or(
        `display_name.ilike.%${likePattern}%,id.ilike.%${likePattern}%${codeFilter}`,
      );
    }

    if (searcherId) {
      builder = builder.neq('id', searcherId);
    }

    const { data, error } = await builder;
    if (error || !data) {
      if (error) console.error('[supabase] searchUsers error:', error.message);
      return [];
    }

    // 取出結果 id 清單，一次查 searcher 的 follow 關係
    let followingSet = new Set<string>();
    if (searcherId && data.length > 0) {
      const ids = data.map((u) => u.id as string);
      const { data: rel } = await db
        .from('friendships')
        .select('following_id')
        .eq('follower_id', searcherId)
        .in('following_id', ids);
      if (rel) {
        followingSet = new Set(
          (rel as { following_id: string }[]).map((r) => r.following_id),
        );
      }
    }

    return data.map((u) => {
      const id = u.id as string;
      const persistedCode = (u.short_code as string | null) ?? null;
      return {
        id,
        display_name: (u.display_name as string) || '',
        photo_url:    (u.photo_url as string | null) ?? null,
        provider:     (u.provider as string) || 'guest',
        elo_rating:   (u.elo_rating as number) ?? 1000,
        badges:       (u.badges as string[] | null) ?? [],
        following:    followingSet.has(id),
        // 優先用 DB 持久短碼；舊用戶未 backfill 時退回 UUID 末 6 碼（向下相容）
        short_code:   persistedCode ?? id.replace(/-/g, '').slice(-6).toUpperCase(),
      };
    });
  } catch (err) {
    console.error('[supabase] searchUsers exception:', err);
    return [];
  }
}
