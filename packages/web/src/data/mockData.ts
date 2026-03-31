/**
 * Mock data for UI development.
 * Replace with real API calls once server/ is ready.
 */

import { Room, Player, ChatMessage } from '@avalon/shared';

// ─── Mock Players ───────────────────────────────────────────────────────────

export const MOCK_PLAYERS: Player[] = [
  { id: 'p1', name: '梅林守護者', avatar: undefined, role: 'merlin', team: 'good', status: 'active', createdAt: Date.now() - 86400000 },
  { id: 'p2', name: '刺客之刃', avatar: undefined, role: 'assassin', team: 'evil', status: 'active', createdAt: Date.now() - 86400000 },
  { id: 'p3', name: '忠誠騎士', avatar: undefined, role: 'loyal', team: 'good', status: 'active', createdAt: Date.now() - 86400000 },
  { id: 'p4', name: '摩根娜', avatar: undefined, role: 'morgana', team: 'evil', status: 'active', createdAt: Date.now() - 86400000 },
  { id: 'p5', name: '珀西瓦爾', avatar: undefined, role: 'percival', team: 'good', status: 'active', createdAt: Date.now() - 86400000 },
  { id: 'p6', name: '奧伯倫', avatar: undefined, role: 'oberon', team: 'evil', status: 'disconnected', createdAt: Date.now() - 86400000 },
  { id: 'p7', name: '圓桌騎士', avatar: undefined, role: 'loyal', team: 'good', status: 'active', createdAt: Date.now() - 86400000 },
];

// ─── Mock Room (Voting Phase) ────────────────────────────────────────────────

export const MOCK_ROOM_VOTING: Room = {
  id: 'ROOM-MOCK',
  name: '測試房間',
  host: 'p1',
  state: 'voting',
  players: Object.fromEntries(MOCK_PLAYERS.map((p) => [p.id, p])),
  maxPlayers: 7,
  currentRound: 2,
  maxRounds: 5,
  votes: { p1: true, p3: false },
  questTeam: ['p1', 'p3', 'p5'],
  questResults: ['success'],
  failCount: 1,
  evilWins: null,
  leaderIndex: 0,
  createdAt: Date.now() - 600000,
  updatedAt: Date.now(),
};

// ─── Mock Room (Quest Phase) ─────────────────────────────────────────────────

export const MOCK_ROOM_QUEST: Room = {
  ...MOCK_ROOM_VOTING,
  id: 'ROOM-QUEST',
  state: 'quest',
  votes: {},
  questTeam: ['p1', 'p3', 'p5'],
  questResults: ['success', 'fail'],
  failCount: 0,
};

// ─── Mock Room (Ended) ───────────────────────────────────────────────────────

export const MOCK_ROOM_ENDED: Room = {
  ...MOCK_ROOM_VOTING,
  id: 'ROOM-ENDED',
  state: 'ended',
  votes: {},
  questResults: ['success', 'success', 'fail', 'success'],
  evilWins: false,
  failCount: 0,
};

// ─── Mock Chat Messages ──────────────────────────────────────────────────────

export const MOCK_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: 'msg1',
    roomId: 'ROOM-MOCK',
    playerId: 'p3',
    playerName: '忠誠騎士',
    message: '我覺得 p4 是邪惡的！',
    timestamp: Date.now() - 120000,
  },
  {
    id: 'msg2',
    roomId: 'ROOM-MOCK',
    playerId: 'p4',
    playerName: '摩根娜',
    message: '我是好的！不要懷疑我',
    timestamp: Date.now() - 90000,
  },
  {
    id: 'msg3',
    roomId: 'ROOM-MOCK',
    playerId: 'p1',
    playerName: '梅林守護者',
    message: '大家注意投票模式...',
    timestamp: Date.now() - 60000,
  },
  {
    id: 'msg4',
    roomId: 'ROOM-MOCK',
    playerId: 'p5',
    playerName: '珀西瓦爾',
    message: '支持這個隊伍配置',
    timestamp: Date.now() - 30000,
  },
];

// ─── Badges ──────────────────────────────────────────────────────────────────

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
}

export const ALL_BADGES: Badge[] = [
  { id: '初勝', name: '初勝', description: '贏得第一場遊戲', icon: '🏆', rarity: 'common' },
  { id: '梅林之盾', name: '梅林之盾', description: '作為 Merlin 存活到最後', icon: '🛡️', rarity: 'rare' },
  { id: '刺客之影', name: '刺客之影', description: '成功刺殺 Merlin', icon: '🗡️', rarity: 'epic' },
  { id: '十人戰場', name: '十人戰場', description: '在 10 人局中獲勝', icon: '⚔️', rarity: 'rare' },
  { id: '穩健', name: '穩健', description: '連續 3 場勝利', icon: '💎', rarity: 'epic' },
  { id: '浴火重生', name: '浴火重生', description: '從危急局面逆轉勝利', icon: '🔥', rarity: 'legendary' },
];

export const BADGE_RARITY_COLORS: Record<Badge['rarity'], string> = {
  common: 'border-gray-400 text-gray-300',
  rare: 'border-blue-400 text-blue-300',
  epic: 'border-purple-400 text-purple-300',
  legendary: 'border-yellow-400 text-yellow-300',
};

// ─── Mock Leaderboard ────────────────────────────────────────────────────────

export interface LeaderboardEntry {
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

export const MOCK_LEADERBOARD: LeaderboardEntry[] = [
  {
    rank: 1,
    userId: 'user1',
    displayName: '天選梅林',
    eloRating: 1842,
    totalGames: 87,
    gamesWon: 62,
    winRate: 71.3,
    favoriteRole: 'merlin',
    badges: ['初勝', '梅林之盾', '穩健', '浴火重生'],
  },
  {
    rank: 2,
    userId: 'user2',
    displayName: '黑暗刺客',
    eloRating: 1778,
    totalGames: 103,
    gamesWon: 71,
    winRate: 68.9,
    favoriteRole: 'assassin',
    badges: ['初勝', '刺客之影', '十人戰場'],
  },
  {
    rank: 3,
    userId: 'user3',
    displayName: '圓桌領袖',
    eloRating: 1720,
    totalGames: 65,
    gamesWon: 42,
    winRate: 64.6,
    favoriteRole: 'percival',
    badges: ['初勝', '梅林之盾'],
  },
  {
    rank: 4,
    userId: 'user4',
    displayName: '謎霧摩根',
    eloRating: 1695,
    totalGames: 94,
    gamesWon: 58,
    winRate: 61.7,
    favoriteRole: 'morgana',
    badges: ['初勝', '刺客之影', '穩健'],
  },
  {
    rank: 5,
    userId: 'user5',
    displayName: '忠誠守護',
    eloRating: 1650,
    totalGames: 78,
    gamesWon: 47,
    winRate: 60.3,
    favoriteRole: 'loyal',
    badges: ['初勝', '十人戰場'],
  },
  {
    rank: 6,
    userId: 'user6',
    displayName: '奧伯倫影',
    eloRating: 1612,
    totalGames: 55,
    gamesWon: 32,
    winRate: 58.2,
    favoriteRole: 'oberon',
    badges: ['初勝'],
  },
  {
    rank: 7,
    userId: 'user7',
    displayName: '珀西白騎',
    eloRating: 1580,
    totalGames: 43,
    gamesWon: 24,
    winRate: 55.8,
    favoriteRole: 'percival',
    badges: ['初勝', '浴火重生'],
  },
  {
    rank: 8,
    userId: 'user8',
    displayName: '戰場老兵',
    eloRating: 1545,
    totalGames: 120,
    gamesWon: 65,
    winRate: 54.2,
    favoriteRole: 'loyal',
    badges: ['初勝', '十人戰場', '穩健'],
  },
  {
    rank: 9,
    userId: 'user9',
    displayName: '新手騎士',
    eloRating: 1510,
    totalGames: 28,
    gamesWon: 15,
    winRate: 53.6,
    favoriteRole: 'loyal',
    badges: ['初勝'],
  },
  {
    rank: 10,
    userId: 'user10',
    displayName: '幻影刺客',
    eloRating: 1487,
    totalGames: 39,
    gamesWon: 20,
    winRate: 51.3,
    favoriteRole: 'assassin',
    badges: ['初勝', '刺客之影'],
  },
];

// ─── Mock User Profile ───────────────────────────────────────────────────────

export interface RecentGame {
  id: string;
  roomId: string;
  playedAt: number;
  role: string;
  team: 'good' | 'evil';
  won: boolean;
  questResults: ('success' | 'fail')[];
  playerCount: number;
  winner: 'good' | 'evil';
  durationMinutes: number;
}

export interface MockUserProfile {
  uid: string;
  displayName: string;
  photoURL?: string;
  eloRating: number;
  totalGames: number;
  gamesWon: number;
  gamesLost: number;
  winRate: number;
  badges: string[];
  favoriteRole?: string;
  winRateByRole: Record<string, { played: number; won: number; winRate: number }>;
  recentGames: RecentGame[];
}

export const MOCK_MY_PROFILE: MockUserProfile = {
  uid: 'me',
  displayName: '你的名字',
  eloRating: 1650,
  totalGames: 42,
  gamesWon: 26,
  gamesLost: 16,
  winRate: 61.9,
  badges: ['初勝', '梅林之盾', '十人戰場'],
  favoriteRole: 'merlin',
  winRateByRole: {
    merlin:   { played: 12, won: 9,  winRate: 75.0 },
    percival: { played: 8,  won: 5,  winRate: 62.5 },
    loyal:    { played: 10, won: 6,  winRate: 60.0 },
    assassin: { played: 6,  won: 3,  winRate: 50.0 },
    morgana:  { played: 4,  won: 2,  winRate: 50.0 },
    oberon:   { played: 2,  won: 1,  winRate: 50.0 },
  },
  recentGames: [
    {
      id: 'g1', roomId: 'R001', playedAt: Date.now() - 3600000,
      role: 'merlin', team: 'good', won: true,
      questResults: ['success', 'success', 'fail', 'success'],
      playerCount: 7, winner: 'good', durationMinutes: 24,
    },
    {
      id: 'g2', roomId: 'R002', playedAt: Date.now() - 86400000,
      role: 'assassin', team: 'evil', won: false,
      questResults: ['success', 'success', 'success'],
      playerCount: 6, winner: 'good', durationMinutes: 18,
    },
    {
      id: 'g3', roomId: 'R003', playedAt: Date.now() - 172800000,
      role: 'percival', team: 'good', won: true,
      questResults: ['fail', 'success', 'success', 'fail', 'success'],
      playerCount: 8, winner: 'good', durationMinutes: 32,
    },
    {
      id: 'g4', roomId: 'R004', playedAt: Date.now() - 259200000,
      role: 'morgana', team: 'evil', won: true,
      questResults: ['success', 'fail', 'fail', 'fail'],
      playerCount: 7, winner: 'evil', durationMinutes: 27,
    },
    {
      id: 'g5', roomId: 'R005', playedAt: Date.now() - 345600000,
      role: 'loyal', team: 'good', won: false,
      questResults: ['fail', 'success', 'fail', 'success', 'fail'],
      playerCount: 5, winner: 'evil', durationMinutes: 21,
    },
  ],
};

// ─── Role Display Helpers ────────────────────────────────────────────────────

export const ROLE_DISPLAY: Record<string, { label: string; icon: string; color: string }> = {
  merlin:   { label: 'Merlin',   icon: '🧙', color: 'text-blue-400' },
  percival: { label: 'Percival', icon: '🛡️', color: 'text-cyan-400' },
  loyal:    { label: '忠誠騎士', icon: '⚔️', color: 'text-indigo-400' },
  assassin: { label: '刺客',     icon: '🗡️', color: 'text-red-400' },
  morgana:  { label: 'Morgana',  icon: '👑', color: 'text-purple-400' },
  oberon:   { label: 'Oberon',   icon: '👻', color: 'text-gray-400' },
};

// ─── Replay Data ─────────────────────────────────────────────────────────────

export type ReplayEventType =
  | 'team-proposed'
  | 'vote-result'
  | 'quest-result'
  | 'assassination'
  | 'game-end';

export interface ReplayEvent {
  round: number;
  type: ReplayEventType;
  // team-proposed
  leader?: string;
  team?: string[];
  // vote-result
  approvals?: number;
  rejections?: number;
  approved?: boolean;
  failCount?: number;
  // quest-result
  questResult?: 'success' | 'fail';
  successVotes?: number;
  failVotes?: number;
  // assassination
  assassin?: string;
  target?: string;
  targetWasMerlin?: boolean;
  // game-end
  winner?: 'good' | 'evil';
  reason?: string;
}

export interface ReplayData {
  roomId: string;
  playedAt: number;
  durationMinutes: number;
  playerCount: number;
  winner: 'good' | 'evil';
  players: Array<{ id: string; name: string; role: string; team: 'good' | 'evil' }>;
  questResults: ('success' | 'fail')[];
  events: ReplayEvent[];
}

export const MOCK_REPLAY: ReplayData = {
  roomId: 'R001',
  playedAt: Date.now() - 3600000,
  durationMinutes: 24,
  playerCount: 7,
  winner: 'good',
  players: [
    { id: 'p1', name: '梅林守護者', role: 'merlin',   team: 'good' },
    { id: 'p2', name: '刺客之刃',   role: 'assassin', team: 'evil' },
    { id: 'p3', name: '忠誠騎士',   role: 'loyal',    team: 'good' },
    { id: 'p4', name: '摩根娜',     role: 'morgana',  team: 'evil' },
    { id: 'p5', name: '珀西瓦爾',   role: 'percival', team: 'good' },
    { id: 'p6', name: '奧伯倫',     role: 'oberon',   team: 'evil' },
    { id: 'p7', name: '圓桌騎士',   role: 'loyal',    team: 'good' },
  ],
  questResults: ['success', 'success', 'fail', 'success'],
  events: [
    // Round 1
    { round: 1, type: 'team-proposed', leader: '梅林守護者', team: ['梅林守護者', '珀西瓦爾'] },
    { round: 1, type: 'vote-result', approvals: 5, rejections: 2, approved: true, failCount: 0 },
    { round: 1, type: 'quest-result', questResult: 'success', successVotes: 2, failVotes: 0 },
    // Round 2
    { round: 2, type: 'team-proposed', leader: '刺客之刃', team: ['忠誠騎士', '刺客之刃', '圓桌騎士'] },
    { round: 2, type: 'vote-result', approvals: 3, rejections: 4, approved: false, failCount: 1 },
    { round: 2, type: 'team-proposed', leader: '忠誠騎士', team: ['梅林守護者', '忠誠騎士', '圓桌騎士'] },
    { round: 2, type: 'vote-result', approvals: 5, rejections: 2, approved: true, failCount: 1 },
    { round: 2, type: 'quest-result', questResult: 'success', successVotes: 3, failVotes: 0 },
    // Round 3
    { round: 3, type: 'team-proposed', leader: '摩根娜', team: ['摩根娜', '奧伯倫', '珀西瓦爾', '忠誠騎士'] },
    { round: 3, type: 'vote-result', approvals: 4, rejections: 3, approved: true, failCount: 0 },
    { round: 3, type: 'quest-result', questResult: 'fail', successVotes: 2, failVotes: 2 },
    // Round 4
    { round: 4, type: 'team-proposed', leader: '珀西瓦爾', team: ['梅林守護者', '珀西瓦爾', '忠誠騎士', '圓桌騎士'] },
    { round: 4, type: 'vote-result', approvals: 5, rejections: 2, approved: true, failCount: 0 },
    { round: 4, type: 'quest-result', questResult: 'success', successVotes: 4, failVotes: 0 },
    // Assassination
    { round: 4, type: 'assassination', assassin: '刺客之刃', target: '梅林守護者', targetWasMerlin: true },
    { round: 4, type: 'game-end', winner: 'evil', reason: '刺客成功暗殺 Merlin，邪惡陣營勝利！' },
  ],
};

// ─── AI Self-Play Stats ───────────────────────────────────────────────────────

export interface AiGameStat {
  date: string;         // YYYY-MM-DD
  gamesPlayed: number;
  goodWins: number;
  evilWins: number;
  avgDurationSeconds: number;
}

export interface AiRoleWinRate {
  role: string;
  gamesAsRole: number;
  wins: number;
  winRate: number;
}

export interface AiStatsData {
  totalGames: number;
  goodWinRate: number;
  evilWinRate: number;
  avgDurationSeconds: number;
  schedulerEnabled: boolean;
  lastRunAt: number;
  nextRunAt: number;
  agentBreakdown: Array<{ agent: string; games: number; wins: number; winRate: number }>;
  roleWinRates: AiRoleWinRate[];
  recentDaily: AiGameStat[];
}

export const MOCK_AI_STATS: AiStatsData = {
  totalGames: 1247,
  goodWinRate: 54.2,
  evilWinRate: 45.8,
  avgDurationSeconds: 38,
  schedulerEnabled: true,
  lastRunAt: Date.now() - 1800000,
  nextRunAt: Date.now() + 1800000,
  agentBreakdown: [
    { agent: 'HeuristicAgent', games: 890,  wins: 483, winRate: 54.3 },
    { agent: 'RandomAgent',    games: 357,  wins: 172, winRate: 48.2 },
  ],
  roleWinRates: [
    { role: 'merlin',   gamesAsRole: 312, wins: 196, winRate: 62.8 },
    { role: 'percival', gamesAsRole: 291, wins: 174, winRate: 59.8 },
    { role: 'loyal',    gamesAsRole: 489, wins: 271, winRate: 55.4 },
    { role: 'assassin', gamesAsRole: 208, wins: 101, winRate: 48.6 },
    { role: 'morgana',  gamesAsRole: 198, wins:  89, winRate: 45.0 },
    { role: 'oberon',   gamesAsRole: 149, wins:  62, winRate: 41.6 },
  ],
  recentDaily: [
    { date: '2026-03-23', gamesPlayed: 30, goodWins: 17, evilWins: 13, avgDurationSeconds: 36 },
    { date: '2026-03-24', gamesPlayed: 30, goodWins: 15, evilWins: 15, avgDurationSeconds: 39 },
    { date: '2026-03-25', gamesPlayed: 30, goodWins: 18, evilWins: 12, avgDurationSeconds: 37 },
    { date: '2026-03-26', gamesPlayed: 30, goodWins: 14, evilWins: 16, avgDurationSeconds: 41 },
    { date: '2026-03-27', gamesPlayed: 30, goodWins: 16, evilWins: 14, avgDurationSeconds: 38 },
    { date: '2026-03-28', gamesPlayed: 30, goodWins: 19, evilWins: 11, avgDurationSeconds: 35 },
    { date: '2026-03-29', gamesPlayed: 15, goodWins:  9, evilWins:  6, avgDurationSeconds: 38 },
  ],
};
