/**
 * Central API client.
 * Server URL comes from VITE_SERVER_URL env var, falling back to same-domain origin.
 */

const BASE_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? window.location.origin;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}

async function apiFetch<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ─── Wiki ────────────────────────────────────────────────────────────────────

export interface WikiArticleApi {
  id: string;
  title: string;
  category: string;
  content: string;
  excerpt: string;
  tags: string[];
  author: string;
  updatedAt: string; // ISO string from server
  views: number;
}

export interface WikiCategoryApi {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export interface WikiListResponse {
  categories: WikiCategoryApi[];
  articles: WikiArticleApi[];
}

export async function fetchWiki(): Promise<WikiListResponse> {
  return apiFetch<WikiListResponse>('/api/wiki');
}

export async function fetchWikiArticle(id: string): Promise<WikiArticleApi> {
  return apiFetch<WikiArticleApi>(`/api/wiki/article/${id}`);
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export interface LeaderboardEntryApi {
  rank: number;
  userId: string;
  displayName: string;
  photoURL?: string;
  eloRating: number;
  totalGames: number;
  gamesWon: number;
  winRate: number;
  favoriteRole?: string;
  badges: string[];
}

export async function fetchLeaderboard(): Promise<LeaderboardEntryApi[]> {
  return apiFetch<LeaderboardEntryApi[]>('/api/elo/leaderboard');
}

// ─── Replay ───────────────────────────────────────────────────────────────────

export type ReplayEventTypeApi =
  | 'team-proposed'
  | 'vote-result'
  | 'quest-result'
  | 'assassination'
  | 'game-end';

export interface ReplayEventApi {
  round: number;
  type: ReplayEventTypeApi;
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

export async function fetchReplay(gameId: string): Promise<ReplayDataApi> {
  return apiFetch<ReplayDataApi>(`/api/replay/${gameId}`);
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface AiGameStatApi {
  date: string;
  gamesPlayed: number;
  goodWins: number;
  evilWins: number;
  avgDurationSeconds: number;
}

export interface AiRoleWinRateApi {
  role: string;
  gamesAsRole: number;
  wins: number;
  winRate: number;
}

export interface AiStatsDataApi {
  totalGames: number;
  goodWinRate: number;
  evilWinRate: number;
  avgDurationSeconds: number;
  schedulerEnabled: boolean;
  lastRunAt: number;
  nextRunAt: number;
  agentBreakdown: Array<{ agent: string; games: number; wins: number; winRate: number }>;
  roleWinRates: AiRoleWinRateApi[];
  recentDaily: AiGameStatApi[];
}

export async function fetchAnalyticsOverview(): Promise<AiStatsDataApi> {
  return apiFetch<AiStatsDataApi>('/api/analytics/overview');
}

export { getErrorMessage };
