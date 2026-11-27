/**
 * 統一 AI騎士（C）— 站長私人重玩測驗（Replay Quiz）前端 API 服務。
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export type ReplayQuizAction = 'team' | 'vote' | 'lakeTarget' | 'lakeClaim' | 'assassinate';

export type ReplayQuizAnswerValue = number[] | boolean | number | 'good' | 'evil';

export const REPLAY_QUIZ_ACTIONS: readonly ReplayQuizAction[] = [
  'team',
  'vote',
  'lakeTarget',
  'lakeClaim',
  'assassinate',
];

export const ACTION_LABELS: Record<ReplayQuizAction, string> = {
  team: '派隊',
  vote: '投票',
  lakeTarget: '選湖',
  lakeClaim: '湖中宣告',
  assassinate: '刺殺',
};

export const ROLE_LABELS: Record<string, string> = {
  merlin: '梅林',
  percival: '派西維爾',
  loyal: '忠臣',
  assassin: '刺客',
  morgana: '莫甘娜',
  mordred: '莫德雷德',
  oberon: '奧伯倫',
  minion: '爪牙',
};

export function seatLabel(seat: number): string {
  return seat === 10 ? '0家' : `${seat}家`;
}

export interface ReplayQuizSeatInfo {
  seat: number;
  label: string;
}

export interface ReplayQuizVoteHistoryItem {
  round: number;
  attempt: number;
  leaderSeat: number;
  leaderLabel: string;
  teamSeats: number[];
  approved: boolean;
  forced: boolean;
  approveSeats: number[];
  rejectSeats: number[];
}

export interface ReplayQuizQuestHistoryItem {
  round: number;
  teamSeats: number[];
  result: 'success' | 'fail';
  failCount: number;
}

export interface ReplayQuizLakeHistoryItem {
  round: number;
  holderSeat: number;
  holderLabel: string;
  targetSeat: number;
  targetLabel: string;
  declaredClaim: 'good' | 'evil' | 'none';
}

export interface ReplayQuizPrivateLakeResult {
  round: number;
  targetSeat: number;
  targetLabel: string;
  result: 'good' | 'evil';
}

export interface ReplayQuizVision {
  knownEvils: number[];
  knownWizards?: number[];
  allEvilSeats?: number[];
  allEvilRoles?: Record<number, string>;
  myLakeResults: ReplayQuizPrivateLakeResult[];
}

export interface ReplayQuizQuestion {
  questionId: string;
  action: ReplayQuizAction;
  mySeat: number;
  mySeatLabel: string;
  myRole: string;
  myTeam: 'good' | 'evil';
  playerCount: number;
  seats: ReplayQuizSeatInfo[];
  evilCount: number;
  currentRound: number;
  currentAttempt?: number;
  currentLeaderSeat: number;
  currentLeaderLabel: string;
  proposedTeamSeats?: number[];
  requiredTeamSize?: number;
  validTargetSeats?: number[];
  inspectedTargetSeat?: number;
  inspectedTargetLabel?: string;
  inspectedResult?: 'good' | 'evil';
  vision: ReplayQuizVision;
  questHistory: ReplayQuizQuestHistoryItem[];
  voteHistory: ReplayQuizVoteHistoryItem[];
  lakeHistory: ReplayQuizLakeHistoryItem[];
}

export interface ActionAgreementStat {
  answered: number;
  matched: number;
  rate: number | null;
}

export interface ReplayQuizStats {
  overall: ActionAgreementStat;
  byAction: Record<ReplayQuizAction, ActionAgreementStat>;
}

export interface ReplayQuizNextResponse {
  schema: 1;
  playerId: string;
  poolSize: number;
  remainingCount: number;
  question: ReplayQuizQuestion | null;
  stats: ReplayQuizStats;
}

export interface ReplayQuizAnswerResponse {
  schema: 1;
  matched: boolean;
  actualAnswer: ReplayQuizAnswerValue;
  actualAnswerLabel: string;
  userAnswerLabel: string;
  gameDate: string;
  record: {
    id: string;
    questionId: string;
    seat: number;
    role: string;
    action: ReplayQuizAction;
    matched: boolean;
    reason?: string;
    answeredAt: string;
  };
  stats: ReplayQuizStats;
}

export interface ReplayQuizRecentItem {
  id: string;
  questionId: string;
  gameDate: string;
  seat: number;
  seatLabel: string;
  role: string;
  action: ReplayQuizAction;
  userAnswerLabel: string;
  actualAnswerLabel: string;
  matched: boolean;
  reason?: string;
  answeredAt: string;
}

export interface ReplayQuizStatsResponse {
  schema: 1;
  playerId: string;
  poolSize: number;
  remainingCount: number;
  stats: ReplayQuizStats;
  recent: ReplayQuizRecentItem[];
}

export class ReplayQuizApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ReplayQuizApiError';
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw new ReplayQuizApiError(data.error || `請求失敗 (${res.status})`, res.status, data.code);
  }
  return data as T;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export function fetchNextReplayQuiz(
  token: string,
  opts: { action?: ReplayQuizAction; playerId?: string } = {},
): Promise<ReplayQuizNextResponse> {
  const params = new URLSearchParams();
  if (opts.action) params.set('action', opts.action);
  if (opts.playerId) params.set('playerId', opts.playerId);
  const qs = params.toString();
  return requestJson<ReplayQuizNextResponse>(`/api/replay-quiz/next${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(token),
  });
}

export function submitReplayQuizAnswer(
  token: string,
  payload: {
    questionId: string;
    answer: ReplayQuizAnswerValue;
    reason?: string;
    playerId?: string;
  },
): Promise<ReplayQuizAnswerResponse> {
  return requestJson<ReplayQuizAnswerResponse>('/api/replay-quiz/answer', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
}

export function fetchReplayQuizStats(
  token: string,
  opts: { playerId?: string; limit?: number } = {},
): Promise<ReplayQuizStatsResponse> {
  const params = new URLSearchParams();
  if (opts.playerId) params.set('playerId', opts.playerId);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return requestJson<ReplayQuizStatsResponse>(`/api/replay-quiz/stats${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(token),
  });
}
