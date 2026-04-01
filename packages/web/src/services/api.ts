/**
 * REST API client for Avalon backend
 * Handles leaderboard & user profile endpoints
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

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
  provider: string;
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  recent_games: RecentGame[];
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
