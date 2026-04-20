import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
 * 一局結束後，批次儲存所有玩家的遊戲記錄並更新 ELO
 */
export async function saveGameRecords(records: DbGameRecord[]): Promise<void> {
  const db = getSupabaseClient();
  if (!db || records.length === 0) return;

  try {
    // 寫入 game_records
    const { error } = await db.from('game_records').insert(records);
    if (error) {
      console.error('[supabase] saveGameRecords error:', error.message);
      return;
    }

    // 更新每位玩家的 ELO 和勝負統計
    for (const record of records) {
      await db.rpc('update_player_stats', {
        p_user_id:  record.player_user_id,
        p_won:      record.won,
        p_elo_delta: record.elo_delta,
      });
    }
  } catch (err) {
    console.error('[supabase] saveGameRecords exception:', err);
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
 * 批次儲存一局的所有遊戲事件（AI 訓練資料 & 回放用）
 */
export async function saveGameEvents(events: DbGameEvent[]): Promise<void> {
  const db = getSupabaseClient();
  if (!db || events.length === 0) return;
  const { error } = await db.from('game_events').insert(events);
  if (error) console.error('[supabase] saveGameEvents error:', error.message);
}

/**
 * 取得一局的完整事件序列（供回放用）
 */
export async function getGameEvents(roomId: string): Promise<DbGameEvent[]> {
  const db = getSupabaseClient();
  if (!db) return [];
  const { data } = await db
    .from('game_events')
    .select('room_id, seq, event_type, actor_id, event_data')
    .eq('room_id', roomId)
    .order('seq', { ascending: true });
  return (data ?? []) as DbGameEvent[];
}

// ── OAuth session（CSRF state）────────────────────────────────

export async function createOAuthSession(stateToken: string, provider: 'discord' | 'line'): Promise<void> {
  const db = getSupabaseClient();
  if (!db) return;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 分鐘
  await db.from('oauth_sessions').insert({
    state_token: stateToken,
    provider,
    expires_at: expiresAt.toISOString(),
  });
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

export async function verifyAndDeleteOAuthSession(
  stateToken: string,
  provider: 'discord' | 'line'
): Promise<boolean> {
  const db = getSupabaseClient();
  if (!db) return true; // Supabase 未設定時跳過 CSRF 檢查

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
