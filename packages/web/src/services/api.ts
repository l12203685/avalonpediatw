/**
 * REST API client for Avalon backend
 * Handles leaderboard & user profile endpoints
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

// 2026-04-26: removed `NGROK_SKIP_HEADER` — backend tunnel migrated off ngrok
// (cloudflared quick tunnel today; named tunnel planned). The header was a
// no-op against non-ngrok hosts but caused confusion that ngrok was still in
// the picture. Re-introduce only if a tunnel that requires it comes back.

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

export interface UserProfile {
  id: string;
  display_name: string;
  photo_url: string | null;
  email?: string | null;
  provider: string;
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  recent_games: RecentGame[];
  /** 玩家可見短碼；新用戶註冊生成，舊用戶尚未 backfill 可能為 null */
  short_code?: string | null;
}

async function apiFetch<T>(path: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${SERVER_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

export async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  const data = await apiFetch<{ leaderboard: LeaderboardEntry[] }>('/api/leaderboard');
  return data.leaderboard;
}

export async function fetchMyProfile(token: string): Promise<UserProfile> {
  const data = await apiFetch<{ profile: UserProfile }>('/api/profile/me', token);
  return data.profile;
}

export async function fetchUserProfile(userId: string): Promise<UserProfile> {
  const data = await apiFetch<{ profile: UserProfile }>(`/api/profile/${userId}`);
  return data.profile;
}

export interface ProfileUpdatePatch {
  display_name?: string;
  photo_url?: string | null;
}

export async function updateMyProfile(
  token: string,
  patch: ProfileUpdatePatch,
): Promise<UserProfile> {
  const res = await fetch(`${SERVER_URL}/api/profile/me`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({} as { profile?: UserProfile; error?: string }));
  if (!res.ok || !('profile' in body) || !body.profile) {
    const err = (body as { error?: string }).error || `API ${res.status}: PATCH /api/profile/me`;
    throw new Error(err);
  }
  return (body as { profile: UserProfile }).profile;
}

/**
 * Edward 2026-04-25：上傳自訂頭像 (jpg/png/webp，<=1MB)。
 *
 * 後端 `POST /api/user/avatar` 走 raw body — 直接把 File 當 fetch body 傳即可，
 * Content-Type 設為 file.type（image/jpeg / image/png / image/webp 之一）。
 *
 * 成功回 { avatarUrl }；server 已寫入 Firestore `auth_users.{uid}.photo_url`。
 * 前端拿到 URL 後再 PATCH `/profile/me` 不必重複（server 已連 photo_url 一併更新）。
 */
export async function uploadAvatar(token: string, file: File): Promise<{ avatarUrl: string }> {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    throw new Error('只接受 JPG / PNG / WebP 圖片');
  }
  if (file.size > 1 * 1024 * 1024) {
    throw new Error('圖片超過 1MB 上限');
  }
  const res = await fetch(`${SERVER_URL}/api/user/avatar`, {
    method: 'POST',
    headers: {
      'Content-Type':  file.type,
      'Authorization': `Bearer ${token}`,
    },
    body: file,
  });
  const body = await res.json().catch(() => ({} as { avatarUrl?: string; error?: string }));
  if (!res.ok || !body.avatarUrl) {
    const err = body.error || `API ${res.status}: POST /api/user/avatar`;
    throw new Error(err);
  }
  return { avatarUrl: body.avatarUrl };
}

export interface GameEvent {
  seq:        number;
  event_type: string;
  actor_id:   string | null;
  event_data: Record<string, unknown>;
}

export async function fetchGameReplay(roomId: string): Promise<GameEvent[]> {
  const data = await apiFetch<{ room_id: string; events: GameEvent[] }>(`/api/replay/${roomId}`);
  return data.events;
}

// ── #42 Multi-account binding ─────────────────────────────────

export type LinkProvider = 'discord' | 'line' | 'google';

export interface LinkedAccount {
  provider: LinkProvider;
  linked: boolean;
  external_id: string | null;
  primary: boolean;
  /**
   * 2026-04-23 Edward：已綁定時 UI 顯「已綁定 @xxx」的 @xxx 取此欄。
   * google → email / display_name；discord → display_name#末四碼；line → display_name。
   * 未綁為 null。
   */
  display_label: string | null;
}

export async function fetchLinkedAccounts(token: string): Promise<LinkedAccount[]> {
  const data = await apiFetch<{ linked: LinkedAccount[] }>('/api/user/linked', token);
  return data.linked;
}

export async function unlinkAccount(token: string, provider: LinkProvider): Promise<LinkedAccount[]> {
  const res = await fetch(`${SERVER_URL}/api/user/unlink`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ provider }),
  });
  const body = await res.json().catch(() => ({} as { linked?: LinkedAccount[]; error?: string }));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `API ${res.status}: /api/user/unlink`);
  }
  return (body as { linked: LinkedAccount[] }).linked;
}

/** 綁 Google：前端拿 Firebase ID token 後打後端 */
export async function linkGoogleAccount(token: string, idToken: string): Promise<LinkedAccount[]> {
  const res = await fetch(`${SERVER_URL}/api/user/link/google`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ idToken }),
  });
  const body = await res.json().catch(() => ({} as { linked?: LinkedAccount[]; error?: string }));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `API ${res.status}: /api/user/link/google`);
  }
  return (body as { linked: LinkedAccount[] }).linked;
}

/**
 * 以另一個 uuid 合併戰績 — #98 個人戰績頁「以 uuid 綁定歷史戰績」按鈕。
 * 把 targetUuid (secondary) 的戰績/徽章/好友併到當前帳號 (primary)，secondary 刪掉。
 */
export async function mergeAccountByUuid(token: string, targetUuid: string): Promise<LinkedAccount[]> {
  const res = await fetch(`${SERVER_URL}/api/user/merge-by-uuid`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ uuid: targetUuid }),
  });
  const body = await res.json().catch(() => ({} as { linked?: LinkedAccount[]; error?: string }));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `API ${res.status}: /api/user/merge-by-uuid`);
  }
  return (body as { linked: LinkedAccount[] }).linked;
}

/** 拿綁 Discord/Line OAuth 起跳 URL — 直接跳轉整頁做 redirect OAuth */
export function buildLinkProviderUrl(token: string, provider: 'discord' | 'line'): string {
  const url = new URL(`${SERVER_URL}/auth/link/${provider}`);
  // server 端從 Authorization header 讀 JWT；但瀏覽器 window.location 直接跳整頁時
  // 送不出 custom header 到 redirect。解法：server 端接這個 GET 後 303 到 provider OAuth 頁。
  // 為了把 token 傳過去、又不走 header，改成放到 query string（server 端容忍 ?token= 或 Bearer）。
  url.searchParams.set('token', token);
  return url.toString();
}

// ── Friend / Follow API ───────────────────────────────────────

export interface FriendEntry {
  id: string;
  display_name: string;
  photo_url: string | null;
  elo_rating: number;
  badges: string[];
}

export async function fetchFriends(token: string): Promise<FriendEntry[]> {
  const data = await apiFetch<{ friends: FriendEntry[] }>('/api/friends', token);
  return data.friends;
}

export async function followUser(token: string, targetUserId: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  await fetch(`${SERVER_URL}/api/friends/${targetUserId}`, { method: 'POST', headers });
}

export async function unfollowUser(token: string, targetUserId: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  await fetch(`${SERVER_URL}/api/friends/${targetUserId}`, { method: 'DELETE', headers });
}

export async function checkFollowing(token: string, targetUserId: string): Promise<boolean> {
  const data = await apiFetch<{ following: boolean }>(`/api/friends/check/${targetUserId}`, token);
  return data.following;
}

// ── User Search (for Friends page) ────────────────────────────
export interface UserSearchEntry {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: string;
  elo_rating: number;
  badges: string[];
  following: boolean;
  short_code: string;
}

export async function searchUsers(token: string, query: string): Promise<UserSearchEntry[]> {
  const data = await apiFetch<{ results: UserSearchEntry[] }>(
    `/api/friends/search?q=${encodeURIComponent(query)}`,
    token,
  );
  return data.results;
}

// 依短碼加好友；回傳新加好友的 UUID。
export async function addFriendByShortCode(
  token: string,
  code: string,
): Promise<{ targetUserId: string }> {
  const res = await fetch(`${SERVER_URL}/api/friends/add-by-code`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({} as { targetUserId?: string; error?: string }));
  if (!res.ok || !body || typeof (body as { targetUserId?: unknown }).targetUserId !== 'string') {
    const err = (body as { error?: string }).error || `API ${res.status}: add-by-code`;
    throw new Error(err);
  }
  return { targetUserId: (body as { targetUserId: string }).targetUserId };
}

// ── Feedback / Error Reporting ────────────────────────────────

export async function submitFeedback(
  data: { type: 'bug' | 'suggestion'; message: string; gameState?: string },
  token?: string
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  await fetch(`${SERVER_URL}/api/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
}

export async function submitError(data: {
  message: string;
  stack?: string;
  gameState?: string;
}): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/api/feedback/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {
    // Swallow — error reporting must never throw
  }
}

// ── Error Utility ─────────────────────────────────────────────────────────────

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ── Analysis API (Google Sheets data) ────────────────────────────────────────

/**
 * Three-outcome breakdown — fixed display order matching the rank baseline:
 *   三紅 (red wins by 3 fails) → 三藍死 (blue wins, Merlin assassinated) →
 *   三藍活 (blue wins, Merlin survives).
 *
 * Pcts sum to ~100% (mutually exclusive). Edward 2026-04-26 spec: every
 * percentage in 深度分析 must be expanded into these three values.
 */
export interface OutcomeBreakdown {
  threeRed: number;
  threeBlueDead: number;
  threeBlueAlive: number;
  threeRedPct: number;
  threeBlueDeadPct: number;
  threeBlueAlivePct: number;
}

/**
 * Two-stage outcome contract (docs/stats/two_stage_outcome.md, 2026-10-12).
 *   任務結算 = 三紅 vs 三藍 (死或活)；刺殺結算 = 三藍局是否刺中梅林；
 *   最終：紅勝 = 三紅 + 三藍死，藍勝 = 三藍活。
 * 舊欄位 (winRate / redWin / blueWin / roleWinRates / seat*WinRates / roleTheory)
 * 全部保留任務結算口徑 (三藍死算藍勝)，不重新解釋；理論勝率在 players[].theory。
 */
export interface MissionStageSummary {
  games: number;
  threeRed: number;
  threeBlue: number;
  redPct: number;
  bluePct: number;
}

/** 刺殺結算 — 只算三藍局：三藍死 = 刺中、三藍活 = 沒刺中。 */
export interface AssassinationStageSummary {
  games: number;
  merlinKilled: number;
  merlinSurvived: number;
  killPct: number;
  survivePct: number;
}

/** 最終：紅勝 = 三紅 + 三藍死、藍勝 = 三藍活。 */
export interface FinalOutcomeSummary {
  games: number;
  redWins: number;
  blueWins: number;
  redPct: number;
  bluePct: number;
}

export interface AnalysisOverview {
  totalGames: number;
  totalPlayers: number;
  /** 任務結算紅方比例 (三紅 / 全部)，舊口徑保留。 */
  redWinRate: number;
  /** 任務結算藍方比例 ((三藍死 + 三藍活) / 全部)，舊口徑保留。 */
  blueWinRate: number;
  /** 三藍局刺中率。 */
  merlinKillRate: number;
  outcomeBreakdown: OutcomeBreakdown;
  /** 舊口徑 (roleTheory ≈ 任務結算勝率)；2026-10-13 起網站不再顯示 (改看 topPlayersByRoleTheory)。 */
  topPlayersByTheory: Array<{ name: string; roleTheory: number; winRate: number; games: number }>;
  topPlayersByGames: Array<{ name: string; games: number; winRate: number }>;
  /**
   * 契約新欄位 — 舊快取 (schemaVersion < 2) 全部缺，前端用 outcomeBreakdown
   * 現場算三段結算；排行在沒有 topPlayersByRoleTheory 時只提示「下次每日更新後提供」。
   */
  schemaVersion?: number;
  missionStage?: MissionStageSummary;
  assassinationStage?: AssassinationStageSummary;
  final?: FinalOutcomeSummary;
  /** 全體各角色最終勝率 % (紅角 = 三紅 + 三藍死；藍角 = 三藍活)。 */
  roleFinalWinRates?: Record<string, number>;
  /** 全期超額勝率排行 — 舊欄位，2026-10-13 起網站不再顯示 (改看 topPlayersByRoleTheory)。 */
  topPlayersByExcess?: Array<{ name: string; excessWinRate: number; finalWinRate: number; games: number }>;
  /** schemaVersion 3：全體各位置最終勝率 %，鍵 "1".."10" (位置理論的補值用)。 */
  seatFinalWinRates?: Record<string, number>;
  /**
   * schemaVersion 3：生涯 ≥ mainGames (100) 場 (不限近期出賽) 的玩家，依各人最近 mainGames 場的
   * 角色理論勝率排序；games = 該視窗場數。舊快取沒有此欄位 → 顯示「下次每日更新後提供」。
   */
  topPlayersByRoleTheory?: Array<{
    name: string; roleTheory: number; positionTheory: number; finalWinRate: number; games: number; careerGames: number;
  }>;
  /** schemaVersion 3：產生器的理論勝率設定；網站的說明文字依此組字，不寫死 100 場、3 場。 */
  theoryConfig?: AnalysisTheoryConfig;
  /**
   * Edward 2026-04-27 — `outcomes` (per-seat 三結果) and `roles[].outcomes`
   * (per-role 三結果) added so deep-analytics seat tooltip can show the
   * outcome split alongside overall win rate. Optional for cache backward
   * compatibility.
   */
  seatPositionWinRates: Array<{
    seat: string;
    overallWinRate: number;
    totalGames: number;
    outcomes?: OutcomeBreakdown;
    roles: Array<{ role: string; winRate: number; games: number; outcomes?: OutcomeBreakdown }>;
  }>;
}

export interface AnalysisPlayerStats {
  name: string;
  totalGames: number;
  /** 任務結算勝率 (三藍死算藍勝)，舊口徑保留。 */
  winRate: number;
  /** 舊欄位 (≈ 任務結算勝率)，不是 Edward 定義的角色理論勝率；網站不顯示，改看 `theory`。 */
  roleTheory: number;
  /** 舊欄位，恆為 0；網站不顯示，改看 `theory`。 */
  positionTheory: number;
  redWin: number;
  blueWin: number;
  red3Red: number;
  redMerlinDead: number;
  redMerlinAlive: number;
  blue3Red: number;
  blueMerlinDead: number;
  blueMerlinAlive: number;
  roleWinRates: Record<string, number>;
  roleDistribution: Record<string, number>;
  redRoleRate: number;
  blueRoleRate: number;
  seatWinRates: Record<string, number>;
  seatRedWinRates: Record<string, number>;
  seatBlueWinRates: Record<string, number>;
  rawRoleGames: Record<string, number>;
  /**
   * Edward 2026-04-27 — per-seat three-outcome distribution
   * (三紅 / 三藍死 / 三藍活). Optional for cache backward compatibility.
   */
  seatOutcomes?: Record<string, OutcomeBreakdown>;

  // --- 原始計數 (快取 players 列都有；finalFields() 的退路用) ---
  rawRedThreeRed?: number;
  rawRedMerlinDead?: number;
  rawRedMerlinAlive?: number;
  rawBlueThreeRed?: number;
  rawBlueMerlinDead?: number;
  rawBlueMerlinAlive?: number;
  rawRedGames?: number;
  rawBlueGames?: number;
  /** 藍方場到達三藍的場數 (merlinSurvivalRate 的分母)。 */
  rawBlueThreeBlue?: number;

  // --- 兩段結算契約欄位 (docs/stats/two_stage_outcome.md)；舊快取由後端退路補齊 ---
  /** (紅方場三紅 + 紅方場三藍死 + 藍方場三藍活) / 總場數 %。 */
  finalWinRate?: number;
  /** (三紅 + 三藍死) / 紅方場數 %。 */
  finalRedWinRate?: number;
  /** 三藍活 / 藍方場數 %。 */
  finalBlueWinRate?: number;
  /** 任務結算勝率 % (= 舊 winRate 語意)。 */
  missionWinRate?: number;
  /** 藍方場到達三藍時 三藍活 / (三藍活 + 三藍死) %；分母 0 時為 0。 */
  merlinSurvivalRate?: number;
  /** Σ 本人該角色出現比例 × 全體該角色最終勝率；算不出來為 null。 */
  expectedFinalWinRate?: number | null;
  /** finalWinRate − expectedFinalWinRate (可為負)；算不出來為 null，顯示「—」。 */
  excessWinRate?: number | null;
  /** 最早 / 最晚出賽日 YYYY-MM-DD，沒有則 ""。 */
  firstPlayed?: string;
  lastPlayed?: string;
  /** 理論勝率 (schemaVersion 3)：近 100 場、近 50 場、生涯；舊快取沒有 → 顯示「—」。 */
  theory?: PlayerTheory;
}

/**
 * 理論勝率 (Edward 2026-10-13，docs/stats/two_stage_outcome.md「理論勝率」)，在玩家自己的一段場次上算：
 *   角色理論勝率 = Σ 抽到該角色的機率（忠臣 4/10、其他角色各 1/10）× 本人該角色最終勝率
 *   位置理論勝率 = Σ 1/10 × 本人該位置最終勝率
 * 某角色或位置在這段場次中不到 3 場時，用全體的最終勝率補到 3 場 (sparseRoles / sparseSeats = 補了幾格)。
 */
export interface PlayerTheoryWindow {
  /** 視窗大小 N (最近 N 場)；0 = 生涯。 */
  window: number;
  /** 實際場數 (玩家場數不足 N 時就是全部場數)。 */
  games: number;
  roleTheory: number;
  positionTheory: number;
  finalWinRate: number;
  /** 視窗內最早 / 最晚有日期的局，YYYY-MM-DD。 */
  from: string;
  to: string;
  sparseRoles: number;
  sparseSeats: number;
}

/** `last<N>` (N = 產生器的 mainGames / shortGames，現在是 100 / 50) 與 career；讀的時候用 theoryLastWindows()。 */
export interface PlayerTheory {
  last100?: PlayerTheoryWindow;
  last50?: PlayerTheoryWindow;
  career?: PlayerTheoryWindow;
  [key: string]: PlayerTheoryWindow | undefined;
}

/** players[].theory 的「近 N 場」視窗，N 大的在前 (不假設一定是 100 / 50)。 */
export function theoryLastWindows(theory: PlayerTheory | null | undefined): PlayerTheoryWindow[] {
  if (!theory || typeof theory !== 'object') return [];
  return Object.entries(theory)
    .filter((e): e is [string, PlayerTheoryWindow] => /^last\d+$/.test(e[0]) && !!e[1] && typeof e[1] === 'object')
    .map(([, w]) => w)
    .filter(w => typeof w.window === 'number' && w.window > 0)
    .sort((a, b) => b.window - a.window);
}

/** overview.theoryConfig (schemaVersion 3)。 */
export interface AnalysisTheoryConfig {
  /** 少場補值門檻；0 = 不補。 */
  theoryMinCellGames: number;
  /** players[].theory 的近 N 場視窗 (mainGames, shortGames)。 */
  theoryWindows: number[];
  /** 主榜與總覽排行的視窗 (也是生涯場數門檻)。 */
  mainGames: number;
  /** 「近期出賽」= 近 N 天內有出賽。 */
  activeDays: number;
}

/** 產生器的預設值 (舊快取沒有 theoryConfig 時用)。 */
export const DEFAULT_THEORY_CONFIG: AnalysisTheoryConfig = {
  theoryMinCellGames: 3, theoryWindows: [100, 50], mainGames: 100, activeDays: 90,
};

/** overview.theoryConfig 或 leaderboard.config 的值；缺的鍵用預設值。 */
export function theorySettings(...given: Array<object | null | undefined>): AnalysisTheoryConfig {
  const sources = given.map(src => (src && typeof src === 'object' ? (src as Record<string, unknown>) : null));
  const pick = (key: 'theoryMinCellGames' | 'mainGames' | 'activeDays'): number => {
    for (const src of sources) {
      const v = src?.[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    }
    return DEFAULT_THEORY_CONFIG[key];
  };
  const windows = sources
    .map(src => src?.theoryWindows)
    .find((w): w is number[] => Array.isArray(w) && w.length > 0 && w.every(n => typeof n === 'number' && n > 0));
  return {
    theoryMinCellGames: pick('theoryMinCellGames'),
    theoryWindows: windows ?? DEFAULT_THEORY_CONFIG.theoryWindows,
    mainGames: pick('mainGames'),
    activeDays: pick('activeDays'),
  };
}

/**
 * /players/:name 的 radar — 契約：winRate / redWinRate 已是最終口徑，
 * missionWinRate 是舊的任務結算勝率，excessWinRate 可能為 null (網站不再顯示)。
 * roleTheory / positionTheory：新後端 = theory.career 的角色理論／位置理論 (舊快取為 null)；
 * 舊後端送的是舊口徑 (≈ 勝率 / 0)，所以網站只讀 player.theory，不讀這兩個鍵。
 */
export interface AnalysisPlayerRadar {
  player: AnalysisPlayerStats;
  radar: {
    winRate: number;
    redWinRate: number;
    blueMerlinProtect: number;
    missionWinRate?: number;
    excessWinRate?: number | null;
    redMerlinKillRate: number;
    experience: number;
    roleTheory?: number | null;
    positionTheory?: number | null;
  };
}

/** 玩家層的最終口徑欄位 — 缺值時由 finalFields() 以原始計數算出 (與後端 withFinalFields 同公式)。 */
export interface PlayerFinalFields {
  finalWinRate: number | null;
  finalRedWinRate: number | null;
  finalBlueWinRate: number | null;
  missionWinRate: number | null;
  merlinSurvivalRate: number | null;
  expectedFinalWinRate: number | null;
  excessWinRate: number | null;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Round to one decimal with ties to even, exactly like Python's round() in
 * generate_cache.py (rnd1): 56.25 → 56.2, 56.35 → 56.4. Math.round would give
 * 56.3 and make the fallback differ from the cache by 0.1 on exact ties.
 */
function rnd1(n: number): number {
  const scaled = n * 10;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  if (frac === 0.5) return (floor % 2 === 0 ? floor : floor + 1) / 10;
  return Math.round(scaled) / 10;
}

/** n / d 的一位小數百分比；分母 0 時回 0 (與 generate_cache.py 相同慣例)。 */
function pctOf(n: number, d: number): number {
  return d > 0 ? rnd1((n / d) * 100) : 0;
}

/**
 * 玩家的最終口徑欄位。快取已有的欄位直接用；缺的由原始三結果計數現場算
 * (公式同 packages/server/services/sheetsAnalysis.ts withFinalFields 與
 * generate_cache.py)。expectedFinalWinRate 需要 overview.roleFinalWinRates：
 * 有 rawRoleGames 時用 rnd1(Σ rawRoleGames[r] × rate[r] / totalGames) (Python 口徑)，
 * 否則用 roleDistribution (%) 加權。算不出來的欄位為 null，顯示「—」。
 */
export function finalFields(
  p: AnalysisPlayerStats,
  roleFinalWinRates?: Record<string, number>,
): PlayerFinalFields {
  const out: PlayerFinalFields = {
    finalWinRate: isFiniteNum(p.finalWinRate) ? p.finalWinRate : null,
    finalRedWinRate: isFiniteNum(p.finalRedWinRate) ? p.finalRedWinRate : null,
    finalBlueWinRate: isFiniteNum(p.finalBlueWinRate) ? p.finalBlueWinRate : null,
    missionWinRate: isFiniteNum(p.missionWinRate) ? p.missionWinRate : null,
    merlinSurvivalRate: isFiniteNum(p.merlinSurvivalRate) ? p.merlinSurvivalRate : null,
    expectedFinalWinRate: isFiniteNum(p.expectedFinalWinRate) ? p.expectedFinalWinRate : null,
    excessWinRate: isFiniteNum(p.excessWinRate) ? p.excessWinRate : null,
  };

  const raw = [
    p.rawRedThreeRed, p.rawRedMerlinDead, p.rawRedMerlinAlive,
    p.rawBlueThreeRed, p.rawBlueMerlinDead, p.rawBlueMerlinAlive,
  ];
  if (raw.every(isFiniteNum)) {
    const [redThreeRed, redDead, redAlive, blueThreeRed, blueDead, blueAlive] = raw as number[];
    const total = isFiniteNum(p.totalGames) && p.totalGames > 0
      ? p.totalGames
      : redThreeRed + redDead + redAlive + blueThreeRed + blueDead + blueAlive;
    const redGames = isFiniteNum(p.rawRedGames) ? p.rawRedGames : redThreeRed + redDead + redAlive;
    const blueGames = isFiniteNum(p.rawBlueGames) ? p.rawBlueGames : blueThreeRed + blueDead + blueAlive;
    const blueThreeBlue = isFiniteNum(p.rawBlueThreeBlue) ? p.rawBlueThreeBlue : blueDead + blueAlive;

    if (out.finalWinRate === null) out.finalWinRate = pctOf(redThreeRed + redDead + blueAlive, total);
    if (out.finalRedWinRate === null) out.finalRedWinRate = pctOf(redThreeRed + redDead, redGames);
    if (out.finalBlueWinRate === null) out.finalBlueWinRate = pctOf(blueAlive, blueGames);
    if (out.missionWinRate === null) out.missionWinRate = pctOf(redThreeRed + blueDead + blueAlive, total);
    if (out.merlinSurvivalRate === null) out.merlinSurvivalRate = pctOf(blueAlive, blueThreeBlue);
  }
  if (out.missionWinRate === null && isFiniteNum(p.winRate)) out.missionWinRate = p.winRate;

  if (out.expectedFinalWinRate === null && roleFinalWinRates) {
    const roleGames = p.rawRoleGames;
    const dist = p.roleDistribution;
    if (roleGames && typeof roleGames === 'object' && isFiniteNum(p.totalGames) && p.totalGames > 0) {
      let sum = 0;
      let covered = 0;
      for (const [role, games] of Object.entries(roleGames)) {
        const rate = roleFinalWinRates[role];
        if (!isFiniteNum(games) || !isFiniteNum(rate)) continue;
        sum += games * rate;
        covered += games;
      }
      out.expectedFinalWinRate = covered > 0 ? rnd1(sum / p.totalGames) : null;
    } else if (dist && typeof dist === 'object') {
      let expected = 0;
      let covered = 0;
      for (const [role, share] of Object.entries(dist)) {
        const rate = roleFinalWinRates[role];
        if (!isFiniteNum(share) || !isFiniteNum(rate)) continue;
        expected += (share / 100) * rate;
        covered += share;
      }
      out.expectedFinalWinRate = covered > 0 ? rnd1(expected) : null;
    }
  }

  if (out.excessWinRate === null && out.finalWinRate !== null && out.expectedFinalWinRate !== null) {
    out.excessWinRate = rnd1(out.finalWinRate - out.expectedFinalWinRate);
  }
  return out;
}

/** 百分比顯示；null / 非數字顯示「—」。 */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  return isFiniteNum(v) ? `${v.toFixed(digits)}%` : '—';
}

/** 帶正負號的百分點顯示 (超額勝率用)；null 顯示「—」。 */
export function fmtSignedPct(v: number | null | undefined, digits = 1): string {
  if (!isFiniteNum(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/** 帶正負號的百分點差 (不加 %，例：+10.4)；用在兩個百分比相減，避免讀成相對成長。 */
export function fmtSignedPoints(v: number | null | undefined, digits = 1): string {
  if (!isFiniteNum(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

export interface ChemistryMatrix {
  players: string[];
  /** Row labels (from sheet first column). Falls back to `players` if missing. */
  rowLabels?: string[];
  values: (number | null)[][];
  /**
   * Edward 2026-04-27 — `outcomePair` only.
   * Optional aux matrices used by the three-outcome split tooltip:
   * `values` carries threeRedPct, these carry threeBlueDeadPct and
   * threeBlueAlivePct so the tooltip can show all three.
   */
  threeBlueDeadPct?: (number | null)[][];
  threeBlueAlivePct?: (number | null)[][];
  /** `outcomePair` only: games the pair played together (null = none / self). */
  games?: (number | null)[][];
  /**
   * `outcomePair` only: "games" = counted from the game log. Older caches (no source) held the
   * overall split in every cell (三紅 45.5 % everywhere); the server drops those, and the UI
   * hides an outcomePair without this marker too.
   */
  source?: string;
}

export interface ChemistryData {
  coWin: ChemistryMatrix;
  coLose: ChemistryMatrix;
  winCorr: ChemistryMatrix;
  coWinMinusLose: ChemistryMatrix;
  /**
   * Edward 2026-04-27 — 5th matrix for the deep-analytics chemistry tab. Holds
   * per-pair three-outcome distribution; cell value is threeRedPct so the
   * existing colour-scale renderer keeps working. Optional for cache
   * backward compatibility — UI hides this matrix when the field is missing.
   */
  outcomePair?: ChemistryMatrix;
}

export interface MissionAnalysisData {
  missionPassRates: Array<{ round: number; passRate: number; totalGames: number }>;
  missionOutcomeByRound: Array<{ round: number; allPass: number; oneFail: number; twoFail: number; total: number }>;
  /** Absent in caches rebuilt by the raw-牌譜 pipeline (61b7398) — UI hides the panel. */
  missionOutcomeCorrelation?: Array<{
    round: number;
    passedGames: number;
    passedThenBlueWin: number;
    passedBlueWinRate: number;
    passedOutcomes: OutcomeBreakdown;
    failedGames: number;
    failedThenRedWin: number;
    failedRedWinRate: number;
    failedOutcomes: OutcomeBreakdown;
  }>;
}

/**
 * `outcomes` (三結果) is absent throughout `rounds` in caches rebuilt by the
 * raw-牌譜 pipeline (61b7398) — UI falls back to the single redWinRate.
 */
interface VisionEntry {
  games: number;
  mission1PassRate: number;
  redWinRate: number;
  blueWinRate?: number;
  outcomes?: OutcomeBreakdown;
}

export interface RoundsAnalysisData {
  visionStats: {
    merlinInTeam: VisionEntry;
    merlinNotInTeam: VisionEntry;
    percivalInTeam: VisionEntry;
    percivalNotInTeam: VisionEntry;
  };
  redInR11: Array<{ redCount: number; games: number; mission1PassRate: number; redWinRate: number; outcomes?: OutcomeBreakdown }>;
  mission1Branch: Array<{ passed: boolean; games: number; redWinRate: number; merlinKillRate: number; outcomes?: OutcomeBreakdown }>;
  roundProgression: Record<string, { bluePct: number; redPct: number; total: number }>;
  gameStates: Array<{ state: string; games: number; redWinRate: number; outcomes?: OutcomeBreakdown }>;
}

interface ApiEnvelope<T> { success: boolean; data?: T; error?: string }

/**
 * 分析 API 的 HTTP 錯誤 — 帶 status 與伺服器 JSON body 的 `error` 文字，讓
 * 「快取尚未產生」(503 + "not yet generated") 能與其他 503 (routes/analysis.ts
 * sheetsGuard 載入快取失敗、Render 重佈時代理層回的 503) 和 404 (舊後端沒有
 * 這條路由) 分開處理。
 */
export class AnalysisApiError extends Error {
  readonly status: number;
  /** 伺服器回的 `{ error }` 文字；body 不是 JSON (代理層 HTML) 時為 undefined。 */
  readonly serverError?: string;
  constructor(status: number, path: string, serverError?: string) {
    super(`Analysis API ${status}: ${path}${serverError ? ` (${serverError})` : ''}`);
    this.name = 'AnalysisApiError';
    this.status = status;
    this.serverError = serverError;
  }
}

/** 503 且伺服器明說 "… not yet generated"：快取尚無此段，等每日重算。其他 503 不算。 */
export function isAnalysisNotGenerated(err: unknown): boolean {
  return err instanceof AnalysisApiError
    && err.status === 503
    && /not yet generated/i.test(err.serverError ?? '');
}

/** 404：後端還是沒有這條路由的舊版本 (網站先於伺服器部署)；不是快取問題，重算也救不了。 */
export function isAnalysisRouteMissing(err: unknown): boolean {
  return err instanceof AnalysisApiError && err.status === 404;
}

async function readServerError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as Partial<ApiEnvelope<unknown>> | null;
    return body && typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

async function analysisApiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}/api/analysis${path}`);
  if (!res.ok) throw new AnalysisApiError(res.status, path, await readServerError(res));
  const body = (await res.json()) as ApiEnvelope<T>;
  if (!body.success || !body.data) throw new Error(body.error || 'Unknown error');
  return body.data;
}

export async function fetchAnalysisOverview(): Promise<AnalysisOverview> {
  return analysisApiFetch<AnalysisOverview>('/overview');
}

export async function fetchAnalysisPlayers(): Promise<{ players: AnalysisPlayerStats[]; total: number }> {
  return analysisApiFetch<{ players: AnalysisPlayerStats[]; total: number }>('/players');
}

export async function fetchAnalysisPlayerByName(name: string): Promise<AnalysisPlayerRadar> {
  return analysisApiFetch<AnalysisPlayerRadar>(`/players/${encodeURIComponent(name)}`);
}

export async function fetchAnalysisChemistry(): Promise<ChemistryData> {
  return analysisApiFetch<ChemistryData>('/chemistry');
}

export async function fetchAnalysisMissions(): Promise<MissionAnalysisData> {
  return analysisApiFetch<MissionAnalysisData>('/missions');
}

export async function fetchAnalysisRounds(): Promise<RoundsAnalysisData> {
  return analysisApiFetch<RoundsAnalysisData>('/rounds');
}

// ── Leaderboard (cache section `leaderboard`, docs/stats/two_stage_outcome.md) ──
// 全部由 generate_cache.py 算好 (LEADERBOARD_CONFIG)；後端與網站只讀不重算。
// 2026-10-13 起：每個榜都帶 `metric`，數字都是「各人最近 N 場」(條件篩選可以是近期，
// 資料不能少場)。舊快取的榜沒有 `metric` (超額勝率) → 網站不顯示，改提示「下次每日更新後提供」。
// 快取缺此段時 /leaderboard 回 503 "Leaderboard not yet generated" → 顯示「排行尚未產生」；
// 舊後端沒有此路由時回 404 → 顯示「後端尚未更新」。

export type AnalysisLeaderboardBoardId =
  | 'main' | 'last50' | 'improved' | 'assassin' | 'newcomers' | 'roleTitles'
  | 'online' | 'recent'; // online / recent：舊快取才有

export interface AnalysisLeaderboardRow {
  rank: number;
  name: string;
  /** 排序值：main / last50 / newcomers = 角色理論；improved = 角色理論差；assassin = 刺中率；roleTitles = 該角色最終勝率。 */
  value: number;
  // main / last50 / newcomers：都是該榜視窗 (各人最近 N 場；新人 = 全部場次) 內的數字
  roleTheory?: number;
  positionTheory?: number;
  finalWinRate?: number;
  /** 生涯場數。 */
  careerGames?: number;
  from?: string;
  to?: string;
  /** 用全體勝率補值的角色格 (共 7) / 位置格 (共 10) 數。 */
  sparseRoles?: number;
  sparseSeats?: number;
  /** 視窗場數 (assassin = 刺殺次數；roleTitles = 該角色場數)。 */
  games: number;
  // improved
  recentRoleTheory?: number;
  priorRoleTheory?: number;
  recentFinalWinRate?: number;
  priorFinalWinRate?: number;
  recentGames?: number;
  priorGames?: number;
  // assassin
  hits?: number;
  attempts?: number;
  // newcomers
  firstPlayed?: string;
  // roleTitles
  role?: string;
  wins?: number;
  careerRoleGames?: number;
  // 舊快取的超額榜才有 (網站不再顯示)
  excessWinRate?: number;
  expectedFinalWinRate?: number;
}

export interface AnalysisLeaderboardBoard {
  /** 固定 id；未知 id 仍可解析 (以小卡通用格式顯示)。 */
  id: AnalysisLeaderboardBoardId | (string & Record<never, never>);
  /** 這個榜的 value 是什麼；舊快取沒有。 */
  metric?: 'roleTheory' | 'roleTheoryDelta' | 'hitRate' | 'finalWinRate' | (string & Record<never, never>);
  title: string;
  titleEn?: string;
  /** 例：「各人最近 100 場」；新人榜：「2026-07-15 ～ 2026-10-12 首次出賽」。 */
  period: string;
  periodEn?: string;
  /** 各人最近 N 場 (main 100、last50 50、improved 50、assassin 20 次刺殺、roleTitles 該角色 20 場)。 */
  windowGames?: number;
  /** 新人榜：首次出賽要在近 N 天內 (舊快取：日期視窗)。 */
  windowDays?: number;
  /** 新人榜：看全部場次 (例外)。 */
  allGames?: boolean;
  minGames?: number;
  note?: string;
  noteEn?: string;
  rows: AnalysisLeaderboardRow[];
}

export interface AnalysisLeaderboardData {
  asOf: string;
  dates?: { parsed: number; unparsed: number; earliest: string; latest: string };
  /** generate_cache.py LEADERBOARD_CONFIG 的複本 (新舊快取的鍵不同)。 */
  config?: Record<string, unknown>;
  boards: AnalysisLeaderboardBoard[];
}

/** 2026-10-13 之後的榜 (帶 metric)；舊快取的超額榜回 false。 */
export function isTheoryBoard(board: Pick<AnalysisLeaderboardBoard, 'metric'> | null | undefined): boolean {
  return typeof board?.metric === 'string' && board.metric.length > 0;
}

export async function fetchAnalysisLeaderboard(): Promise<AnalysisLeaderboardData> {
  return analysisApiFetch<AnalysisLeaderboardData>('/leaderboard');
}

export interface LakeRoleStat {
  role: string;
  games: number;
  redWinRate: number;
  blueWinRate?: number;
  outcomes: OutcomeBreakdown;
}

export interface LakePerLake {
  lake: string;
  totalGames: number;
  holderStats: Array<{ faction: string; games: number; redWinRate: number; outcomes: OutcomeBreakdown }>;
  comboStats: Array<{ holderFaction: string; targetFaction: string; games: number; redWinRate: number; outcomes: OutcomeBreakdown }>;
}

export interface LakeDetailedStats {
  lake: string;
  holderRoleStats: LakeRoleStat[];
  targetRoleStats: LakeRoleStat[];
  sameFaction: { games: number; redWinRate: number; outcomes: OutcomeBreakdown };
  diffFaction: { games: number; redWinRate: number; outcomes: OutcomeBreakdown };
}

export interface LakeAnalysisData {
  perLake: LakePerLake[];
  holderRoleStats: LakeRoleStat[];
  targetRoleStats: LakeRoleStat[];
  allLakeRoleStats: LakeDetailedStats[];
}

export async function fetchAnalysisLake(): Promise<LakeAnalysisData> {
  return analysisApiFetch<LakeAnalysisData>('/lake');
}

// ── Seat Order Analysis API ──────────────────────────────────────────────────

export interface SeatOrderPermutation {
  order: string;
  total: number;
  '\u4e09\u85cd\u6885\u6d3b': number;
  '\u4e09\u85cd\u6885\u6b7b': number;
  '\u4e09\u7d05': number;
  '\u4e09\u85cd\u6885\u6d3bpct': number;
  '\u4e09\u85cd\u6885\u6b7bpct': number;
  '\u4e09\u7d05pct': number;
  '\u7a7f\u63d2\u4efb\u52d9': number;
  redWinRate: number;
  blueWinRate: number;
  merlinKillRate: number;
  '\u7a7f\u63d2\u7387': number;
  /** 穿插紅勝率 / 無穿插紅勝率 — absent in the raw-牌譜 rebuild (61b7398); UI hides the interleave table. */
  '\u7a7f\u63d2\u7d05\u52dd\u7387'?: number;
  '\u7121\u7a7f\u63d2\u7d05\u52dd\u7387'?: number;
}

export interface SeatOrderData {
  permutations: SeatOrderPermutation[];
  totalGames: number;
  overallRedWinRate: number;
}

export async function fetchAnalysisSeatOrder(): Promise<SeatOrderData> {
  return analysisApiFetch<SeatOrderData>('/seat-order');
}

// ── Captain Analysis API ─────────────────────────────────────────────────────

export interface CaptainMissionEntry {
  mission: number;
  redCaptainRate: number;
  blueCaptainRate: number;
  games: number;
}

export interface CaptainFactionVsOutcome {
  captainFaction: string;
  missionResult: 'pass' | 'fail';
  count: number;
  percentage: number;
}

export interface CaptainMissionGameWinRate {
  captainFaction: string;
  missionResult: 'pass' | 'fail';
  totalMissions: number;
  redGameWinRate: number;
  blueGameWinRate: number;
  outcomes: OutcomeBreakdown;
}

export interface CaptainAnalysisData {
  perMission: CaptainMissionEntry[];
  captainFactionVsOutcome: CaptainFactionVsOutcome[];
  captainMissionGameWinRates: CaptainMissionGameWinRate[];
}

export async function fetchAnalysisCaptain(): Promise<CaptainAnalysisData> {
  return analysisApiFetch<CaptainAnalysisData>('/captain');
}

// ── Panel A: Player archetype (4-axis radar) ─────────────────────────────────

export interface ArchetypeAxes {
  honesty: number;
  consistency: number;
  stickiness: number;
  flip: number;
}

export interface ArchetypePlayerResponse {
  player: { name: string; totalGames: number };
  data: {
    axes: ArchetypeAxes;
    /** percentile 0-100 vs N>=10 cohort (50 = median, 100 = top). */
    percentiles: ArchetypeAxes;
    sampleSize: number;
    hasData: boolean;
  };
  cohort: {
    n: number;
    means: ArchetypeAxes;
    stds: ArchetypeAxes;
  };
  axisLabels: ArchetypeAxes & Record<string, string>;
  axisHelp: Record<string, string>;
}

export async function fetchPlayerArchetype(name: string): Promise<ArchetypePlayerResponse> {
  return analysisApiFetch<ArchetypePlayerResponse>(
    `/profile/${encodeURIComponent(name)}/archetype`,
  );
}

// ── Panel B: Strength signature (per-role winrate × z-score) ─────────────────

export interface StrengthRoleEntry {
  role: string;
  winRate: number | null;
  sampleSize: number;
  zScore: number | null;
  color: 'high' | 'neutral' | 'low' | 'insufficient';
}

export interface StrengthPlayerResponse {
  player: { name: string; totalGames: number };
  data: {
    roles: StrengthRoleEntry[];
    topRoles: string[];
    bottomRoles: string[];
    hasData: boolean;
  };
  cohort: {
    perRole: Record<string, { mean: number; std: number; n: number }>;
    minRoleSample: number;
    rolesOrder: string[];
  };
}

export async function fetchPlayerStrength(name: string): Promise<StrengthPlayerResponse> {
  return analysisApiFetch<StrengthPlayerResponse>(
    `/profile/${encodeURIComponent(name)}/strength`,
  );
}

// ── Panel C: Playstyle snapshot (R3+ 強硬度 / 刺座 / 隊長 stickiness) ─────────

export interface PlaystyleSplit {
  red: number | null;
  blue: number | null;
}

export interface PlaystylePlayerResponse {
  player: { name: string; totalGames: number };
  data: {
    r3RejectRate: PlaystyleSplit;
    r3RejectPercentile: PlaystyleSplit;
    assassinTopSeats: number[] | null;
    assassinAttempts: number;
    captainStickiness: number | null;
    captainStickinessPercentile: number | null;
    sampleSize: number;
    hasData: boolean;
  };
  cohort: {
    r3Red: { n: number; mean: number | null; std: number | null };
    r3Blue: { n: number; mean: number | null; std: number | null };
    captainStickiness: { n: number; mean: number | null; std: number | null };
    assassinAttempts: { n: number };
  };
  thresholds: {
    r3MinVotes: number;
    assassinMinAttempts: number;
    captainMinProposals: number;
  };
  labels: {
    r3RejectRedLabel: string;
    r3RejectBlueLabel: string;
    assassinTargetLabel: string;
    captainStickinessLabel: string;
  };
}

export async function fetchPlayerPlaystyle(name: string): Promise<PlaystylePlayerResponse> {
  return analysisApiFetch<PlaystylePlayerResponse>(
    `/profile/${encodeURIComponent(name)}/playstyle`,
  );
}

// ── Feature Studies API (3rd analytics tab) ──────────────────────────────────

export type FeatureVisualType = 'bar' | 'table' | 'divergent' | 'line' | 'lakeClaim';

/**
 * L141 `lakeClaim` 一格 (docs/stats/two_stage_outcome.md)：持湖者宣告紅/藍時，
 * 目標真的是紅/藍的機率，附 n 與 Wilson 95% 區間；n < minSample 標 lowSample。
 * `rows` 依首湖/二湖/三湖分；`holderRows` 依持湖者陣營分。
 */
export interface LakeClaimCell {
  lake?: string;
  lakeEn?: string;
  holder?: string;
  holderEn?: string;
  declared: string;
  declaredEn?: string;
  n: number;
  hits?: number;
  hitRate: number;
  ciLow: number;
  ciHigh: number;
  lowSample: boolean;
}

export interface LakeClaimData {
  minSample?: number;
  rows: LakeClaimCell[];
  holderRows?: LakeClaimCell[];
  undeclared?: number;
}

export interface FeatureStudyEntry {
  loopId: string;
  title: string;
  titleEn: string;
  oneLineHook: string;
  oneLineHookEn: string;
  sampleSize: {
    games: number;
    links?: number;
    attempts?: number;
    chances?: number;
    leaderEvents?: number;
  };
  visualType: FeatureVisualType;
  /** Visual-type-specific payload (open envelope; renderer dispatches by visualType). */
  data: Record<string, unknown>;
  takeaway: string;
  takeawayEn: string;
  sourceReport: string;
  /** generate_cache.py 算的研究 (L141) 才有：asOf 日期。 */
  computedAt?: string | null;
}

export interface FeatureStudiesData {
  generatedAt: string;
  sampleSize: { games: number; lakeLinks: number };
  features: FeatureStudyEntry[];
}

export async function fetchFeatureStudies(): Promise<FeatureStudiesData> {
  return analysisApiFetch<FeatureStudiesData>('/feature-studies');
}

// ── Wiki API ─────────────────────────────────────────────────────────────────

export interface WikiArticleApi {
  id: string;
  title: string;
  category: string;
  content: string;
  excerpt: string;
  tags: string[];
  source: string;
}

export async function fetchWikiArticles(): Promise<{ articles: WikiArticleApi[]; total: number }> {
  return analysisApiFetch<{ articles: WikiArticleApi[]; total: number }>('/wiki');
}

// ── Pair Stats & Timeline (#98 個人戰績瘦身) ─────────────────────────────────

export interface PairStats {
  opponentId: string;
  totalGames: number;
  sharedGames: number;
  myWins: number;
  /** 我贏的場次中，對方同場的比例 (0-100) */
  sameWinRate: number;
  /** 我輸的場次中，對方同場的比例 (0-100) */
  sameLossRate: number;
  /** 排除同場後的我方勝率；獨立場次為 0 時回 null */
  independentWinRate: number | null;
}

export async function fetchPairStatsBatch(
  token: string,
  opponentIds: string[],
): Promise<PairStats[]> {
  if (opponentIds.length === 0) return [];
  const ids = opponentIds.join(',');
  const data = await apiFetch<{ pairs: PairStats[] }>(
    `/api/stats/pair-batch?ids=${encodeURIComponent(ids)}`,
    token,
  );
  return data.pairs;
}

export interface TimelineEntry {
  gameId: string;
  endedAt: number;
  won: boolean;
  playerCount: number;
  winner: 'good' | 'evil';
  role: string | null;
  team: 'good' | 'evil' | null;
}

export async function fetchMyTimeline(
  token: string,
  limit = 50,
): Promise<TimelineEntry[]> {
  const data = await apiFetch<{ timeline: TimelineEntry[] }>(
    `/api/stats/timeline?limit=${limit}`,
    token,
  );
  return data.timeline;
}

// ── AI Stats API ──────────────────────────────────────────────────────────────

export interface AiStatsDataApi {
  totalGames: number;
  goodWinRate: number;
  evilWinRate: number;
  avgDurationSeconds: number;
  schedulerEnabled: boolean;
  lastRunAt: number;
  nextRunAt: number;
  agentBreakdown: Array<{ agent: string; games: number; wins: number; winRate: number }>;
  roleWinRates: Array<{ role: string; gamesAsRole: number; wins: number; winRate: number }>;
  recentDaily: Array<{
    date: string;
    gamesPlayed: number;
    goodWins: number;
    evilWins: number;
    avgDurationSeconds: number;
  }>;
}

export async function fetchAnalyticsOverview(): Promise<AiStatsDataApi> {
  return apiFetch<AiStatsDataApi>('/api/analytics/overview');
}

// ── Replay API ────────────────────────────────────────────────────────────────

export type ReplayEventType =
  | 'team-proposed'
  | 'vote-result'
  | 'quest-result'
  | 'assassination'
  | 'game-end';

export interface ReplayEventApi {
  round: number;
  type: ReplayEventType;
  leader?: string;
  team?: string[];
  approvals?: number;
  rejections?: number;
  approved?: boolean;
  failCount?: number;
  questResult?: 'success' | 'fail';
  successVotes?: number;
  failVotes?: number;
  assassin?: string;
  target?: string;
  targetWasMerlin?: boolean;
  winner?: 'good' | 'evil';
  reason?: string;
}

export interface ReplayDataApi {
  roomId: string;
  playedAt: number;
  durationMinutes: number;
  playerCount: number;
  winner: 'good' | 'evil';
  players: Array<{ id: string; name: string; role: string; team: 'good' | 'evil' }>;
  questResults: ('success' | 'fail')[];
  events: ReplayEventApi[];
}

export async function fetchReplay(roomId: string): Promise<ReplayDataApi> {
  return apiFetch<ReplayDataApi>(`/api/replay/${roomId}/structured`);
}

// ── Claim System API ─────────────────────────────────────────────────────────

export interface ClaimableRecord {
  recordId: string;
  gameId: string;
  playerId: string;
  displayName: string;
  role: string | null;
  team: 'good' | 'evil' | null;
  won: boolean;
  playerCount: number;
  roomName: string;
  createdAt: number;
  ownerUid: string | null;
  matchScore?: number;
}

export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface ClaimRequestApi {
  id: string;
  uid: string;
  email: string | null;
  displayName: string;
  targetRecordIds: string[];
  evidenceNote: string;
  autoMatched: boolean;
  status: ClaimStatus;
  submittedAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
  rejectReason: string | null;
  approvedRecordIds: string[] | null;
}

export interface PendingClaimView {
  claim: ClaimRequestApi;
  records: ClaimableRecord[];
}

export interface AdminMe {
  isAdmin: boolean;
  email: string | null;
  displayName: string;
  provider: string;
}

export interface AuditLogEntryApi {
  id: string;
  action: 'approve' | 'reject' | 'addAdmin' | 'removeAdmin';
  adminEmail: string;
  targetClaimId?: string;
  targetRecordIds?: string[];
  ts: number;
  details?: string;
}

async function claimApi<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init?.token) headers['Authorization'] = `Bearer ${init.token}`;
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body,
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string };
  if (!res.ok || body.success === false) {
    throw new Error(body.error || `API ${res.status}: ${path}`);
  }
  return (body.data ?? (body as unknown as T));
}

// ── Player ────────────────────────────────────────────────────────────────────

export async function fetchMyClaims(token: string): Promise<ClaimRequestApi[]> {
  const data = await claimApi<{ claims: ClaimRequestApi[] }>('/api/claims/mine', { token });
  return data.claims;
}

export async function submitClaim(
  token: string,
  body: { targetRecordIds: string[]; evidenceNote?: string; autoMatched?: boolean }
): Promise<ClaimRequestApi> {
  const data = await claimApi<{ claim: ClaimRequestApi }>('/api/claims', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.claim;
}

export async function fetchAutoMatchCandidates(token: string): Promise<ClaimableRecord[]> {
  const data = await claimApi<{ records: ClaimableRecord[] }>('/api/claims/auto-match', { token });
  return data.records;
}

export async function searchManualRecords(
  token: string,
  body: { oldNickname: string; since?: number; until?: number }
): Promise<ClaimableRecord[]> {
  const data = await claimApi<{ records: ClaimableRecord[] }>('/api/claims/search-manual', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.records;
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export async function fetchAdminMe(token: string): Promise<AdminMe> {
  return claimApi<AdminMe>('/api/admin/me', { token });
}

export async function fetchPendingClaims(token: string): Promise<PendingClaimView[]> {
  const data = await claimApi<{ pending: PendingClaimView[] }>('/api/admin/claims/pending', { token });
  return data.pending;
}

export async function approveClaimApi(
  token: string,
  claimId: string,
  approvedRecordIds: string[]
): Promise<ClaimRequestApi> {
  const data = await claimApi<{ claim: ClaimRequestApi }>(`/api/admin/claims/${claimId}/approve`, {
    token,
    method: 'POST',
    body: JSON.stringify({ approvedRecordIds }),
  });
  return data.claim;
}

export async function rejectClaimApi(
  token: string,
  claimId: string,
  reason: string
): Promise<ClaimRequestApi> {
  const data = await claimApi<{ claim: ClaimRequestApi }>(`/api/admin/claims/${claimId}/reject`, {
    token,
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  return data.claim;
}

// ── Admin: game import (hineko_20260424_1035) ─────────────────────────────
// Thin wrappers over /api/admin/games/import/{json,sheets}. See
// packages/server/src/services/GameImportService.ts for the backing logic.

export interface ImportedGamePreview {
  gameId: string;
  roomName: string;
  playerCount: number;
  winner: 'good' | 'evil';
  winReason: string;
  createdAt: number;
}

export interface GameImportResult {
  sourceTag: 'sheets' | 'json';
  preview: ImportedGamePreview[];
  totalCount: number;
  writtenCount: number;
  skippedExisting: number;
  errors: { row: number; reason: string }[];
}

export async function importGamesFromJson(
  token: string,
  body: { dryRun: boolean; limit?: number; jsonData: unknown[] },
): Promise<GameImportResult> {
  return claimApi<GameImportResult>('/api/admin/games/import/json', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function importGamesFromSheets(
  token: string,
  body: { dryRun: boolean; limit?: number; sheetId?: string },
): Promise<GameImportResult> {
  return claimApi<GameImportResult>('/api/admin/games/import/sheets', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function fetchAdminList(token: string): Promise<string[]> {
  const data = await claimApi<{ emails: string[] }>('/api/admin/admins', { token });
  return data.emails;
}

export async function addAdminApi(token: string, email: string): Promise<string[]> {
  const data = await claimApi<{ emails: string[] }>('/api/admin/admins', {
    token,
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  return data.emails;
}

export async function removeAdminApi(token: string, email: string): Promise<string[]> {
  const data = await claimApi<{ emails: string[] }>(
    `/api/admin/admins/${encodeURIComponent(email)}`,
    { token, method: 'DELETE' },
  );
  return data.emails;
}

export async function fetchAuditLog(token: string): Promise<AuditLogEntryApi[]> {
  const data = await claimApi<{ entries: AuditLogEntryApi[] }>('/api/admin/audit', { token });
  return data.entries;
}

// ── #54 Phase 2 Day 3: ELO admin ──────────────────────────────────────────────

export type EloAttributionMode = 'legacy' | 'per_event';

export interface EloConfigView {
  startingElo: number;
  minElo: number;
  baseKFactor: number;
  teamBaselines: { good: number; evil: number };
  outcomeWeights: {
    good_wins_quests: number;
    evil_wins_quests: number;
    assassin_kills_merlin: number;
  };
  roleKWeights: Record<string, number>;
  attributionMode: EloAttributionMode;
  attributionWeights: {
    proposal: number;
    outerWhiteInnerBlack: number;
    information?: number;
    misdirection?: number;
  };
}

export interface EloConfigResult {
  config: EloConfigView;
  supabaseReady: boolean;
  warning?: string;
}

export async function fetchEloConfig(token: string): Promise<EloConfigResult> {
  const data = await claimApi<{ config: EloConfigView; supabaseReady: boolean }>(
    '/api/admin/elo/config',
    { token },
  );
  return { config: data.config, supabaseReady: data.supabaseReady };
}

export async function updateEloConfig(
  token: string,
  patch: {
    attributionMode?: EloAttributionMode;
    attributionWeights?: Partial<EloConfigView['attributionWeights']>;
  },
): Promise<EloConfigResult> {
  // Direct fetch so we can surface the Supabase "in-memory only" warning that
  // the server returns as HTTP 207 with a `warning` field outside the envelope.
  const res = await fetch(`${SERVER_URL}/api/admin/elo/config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: { config: EloConfigView; supabaseReady: boolean };
    error?: string;
    warning?: string;
  };
  if (!res.ok || body.success === false || !body.data) {
    throw new Error(body.error || `API ${res.status}: /api/admin/elo/config`);
  }
  return {
    config: body.data.config,
    supabaseReady: body.data.supabaseReady,
    warning: body.warning,
  };
}
