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
  email?: string | null;
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

export interface AnalysisOverview {
  totalGames: number;
  totalPlayers: number;
  redWinRate: number;
  blueWinRate: number;
  merlinKillRate: number;
  outcomeBreakdown: {
    threeRed: number;
    threeBlueAlive: number;
    threeBlueDead: number;
    threeRedPct: number;
    threeBlueAlivePct: number;
    threeBlueDeadPct: number;
  };
  topPlayersByTheory: Array<{ name: string; roleTheory: number; winRate: number; games: number }>;
  topPlayersByGames: Array<{ name: string; games: number; winRate: number }>;
  seatPositionWinRates: Array<{
    seat: string;
    overallWinRate: number;
    totalGames: number;
    roles: Array<{ role: string; winRate: number; games: number }>;
  }>;
}

export interface AnalysisPlayerStats {
  name: string;
  totalGames: number;
  winRate: number;
  roleTheory: number;
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
}

export interface AnalysisPlayerRadar {
  player: AnalysisPlayerStats;
  radar: {
    winRate: number;
    redWinRate: number;
    blueMerlinProtect: number;
    roleTheory: number;
    positionTheory: number;
    redMerlinKillRate: number;
    experience: number;
  };
}

export interface ChemistryMatrix {
  players: string[];
  /** Row labels (from sheet first column). Falls back to `players` if missing. */
  rowLabels?: string[];
  values: number[][];
}

export interface ChemistryData {
  coWin: ChemistryMatrix;
  coLose: ChemistryMatrix;
  winCorr: ChemistryMatrix;
  coWinMinusLose: ChemistryMatrix;
}

export interface MissionAnalysisData {
  missionPassRates: Array<{ round: number; passRate: number; totalGames: number }>;
  missionOutcomeByRound: Array<{ round: number; allPass: number; oneFail: number; twoFail: number; total: number }>;
  missionOutcomeCorrelation: Array<{
    round: number;
    passedGames: number;
    passedThenBlueWin: number;
    passedBlueWinRate: number;
    failedGames: number;
    failedThenRedWin: number;
    failedRedWinRate: number;
  }>;
}

export interface RoundsAnalysisData {
  visionStats: {
    merlinInTeam: { games: number; mission1PassRate: number; redWinRate: number; blueWinRate: number };
    merlinNotInTeam: { games: number; mission1PassRate: number; redWinRate: number; blueWinRate: number };
    percivalInTeam: { games: number; mission1PassRate: number; redWinRate: number };
    percivalNotInTeam: { games: number; mission1PassRate: number; redWinRate: number };
  };
  redInR11: Array<{ redCount: number; games: number; mission1PassRate: number; redWinRate: number }>;
  mission1Branch: Array<{ passed: boolean; games: number; redWinRate: number; merlinKillRate: number }>;
  roundProgression: Record<string, { bluePct: number; redPct: number; total: number }>;
  gameStates: Array<{ state: string; games: number; redWinRate: number }>;
}

interface ApiEnvelope<T> { success: boolean; data?: T; error?: string }

async function analysisApiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}/api/analysis${path}`);
  if (!res.ok) throw new Error(`Analysis API ${res.status}: ${path}`);
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

export interface LakeRoleStat {
  role: string;
  games: number;
  redWinRate: number;
  blueWinRate?: number;
}

export interface LakePerLake {
  lake: string;
  totalGames: number;
  holderStats: Array<{ faction: string; games: number; redWinRate: number }>;
  comboStats: Array<{ holderFaction: string; targetFaction: string; games: number; redWinRate: number }>;
}

export interface LakeDetailedStats {
  lake: string;
  holderRoleStats: LakeRoleStat[];
  targetRoleStats: LakeRoleStat[];
  sameFaction: { games: number; redWinRate: number };
  diffFaction: { games: number; redWinRate: number };
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
  '\u7a7f\u63d2\u7d05\u52dd\u7387': number;
  '\u7121\u7a7f\u63d2\u7d05\u52dd\u7387': number;
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
}

export interface CaptainAnalysisData {
  perMission: CaptainMissionEntry[];
  captainFactionVsOutcome: CaptainFactionVsOutcome[];
  captainMissionGameWinRates: CaptainMissionGameWinRate[];
}

export async function fetchAnalysisCaptain(): Promise<CaptainAnalysisData> {
  return analysisApiFetch<CaptainAnalysisData>('/captain');
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
