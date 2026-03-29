/**
 * Supabase Database Row Types
 * Mirror the PostgreSQL schema — used for type-safe Supabase client queries on the server.
 * These types intentionally use snake_case to match DB column names directly.
 */

import type { Role, Team } from './game';

// ── Badge Names ──────────────────────────────────────────────────────────────

/** The six badges awarded at game end. Stored as TEXT[] in the users table. */
export type BadgeName =
  | '初勝'      // First Victory — first win
  | '梅林之盾'  // Merlin's Shield — won as Merlin without being assassinated
  | '刺客之影'  // Shadow Assassin — successfully assassinated Merlin as Assassin
  | '十人戰場'  // 10-Player Battlefield — participated in a 10-player game
  | '穩健'      // Steady — played 10+ games
  | '浴火重生'; // Phoenix Rising — won after 3+ consecutive losses

// ── Game Event Types ─────────────────────────────────────────────────────────

/** All possible event_type values stored in the game_events table. */
export type GameEventType =
  | 'game_started'          // 遊戲開始，角色分配完成
  | 'team_proposed'         // 隊長提名任務隊伍
  | 'team_selected'         // 與 team_proposed 相同（相容舊事件）
  | 'vote_cast'             // 單筆投票（一人一筆）
  | 'vote_resolved'         // 本輪投票結果揭曉（approve / reject）
  | 'quest_started'         // 任務隊伍出發
  | 'quest_vote_cast'       // 任務隊員提交成功/失敗牌
  | 'quest_resolved'        // 任務結果揭曉
  | 'assassination_started' // 暗殺階段開始（好方贏 3 輪後）
  | 'assassination_attempted' // 刺客選擇目標
  | 'game_ended';           // 遊戲結束（含勝負與原因）

// ── Database Row Interfaces ──────────────────────────────────────────────────

/** Row type for the `users` table. */
export interface DbUser {
  id: string;                  // UUID
  firebase_uid: string | null;
  discord_id: string | null;
  line_id: string | null;
  email: string | null;
  display_name: string;
  photo_url: string | null;
  provider: 'google' | 'discord' | 'line' | 'email' | 'guest';
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  total_kills: number;
  badges: BadgeName[];
  created_at: string;          // ISO 8601 timestamp
  updated_at: string;
}

/** Row type for the `rooms` table. */
export interface DbRoom {
  id: string;                  // 6-char code e.g. 'AB3XYZ'
  host_user_id: string | null; // UUID → users.id
  state: 'lobby' | 'voting' | 'quest' | 'discussion' | 'ended';
  player_count: number;
  max_players: number;
  evil_wins: boolean | null;   // null = in progress
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

/** Row type for the `game_records` table (one row per player per game). */
export interface DbGameRecord {
  id: string;                  // UUID
  room_id: string | null;      // → rooms.id
  player_user_id: string | null; // UUID → users.id
  role: Role;
  team: Team;
  won: boolean;
  elo_before: number;
  elo_after: number;
  elo_delta: number;
  player_count: number;
  duration_sec: number | null;
  is_bot: boolean;             // true = AI self-play record (SelfPlayEngine)
  created_at: string;
}

/** Row type for the `votes` table (team-approval votes). */
export interface DbVote {
  id: string;                  // UUID
  room_id: string | null;      // → rooms.id
  round_number: number;        // quest round 1–5
  vote_attempt: number;        // attempt within round 1–5
  voter_user_id: string | null; // UUID → users.id
  vote: boolean;               // true = approve, false = reject
  created_at: string;
}

/** Row type for the `quest_results` table. */
export interface DbQuestResult {
  id: string;                  // UUID
  room_id: string | null;      // → rooms.id
  round_number: number;
  result: 'success' | 'fail';
  fail_votes: number;
  team_user_ids: string[];     // UUID[]
  created_at: string;
}

/** Row type for the `oauth_sessions` table. */
export interface DbOAuthSession {
  id: string;                  // UUID
  state_token: string;
  provider: 'discord' | 'line';
  expires_at: string;
  created_at: string;
}

/** Row type for the `game_events` table (replay & AI training log). */
export interface DbGameEvent {
  id: string;                  // UUID
  room_id: string;
  seq: number;                 // monotonically increasing within a room, starts at 1
  event_type: GameEventType;
  actor_id: string | null;     // player uid who triggered the event
  event_data: Record<string, unknown>; // full JSONB snapshot
  created_at: string;
}

// ── API Response Types ───────────────────────────────────────────────────────

/**
 * Row returned by the `leaderboard_view` — used by GET /api/leaderboard.
 * Adds computed fields win_rate and rank on top of DbUser.
 */
export interface LeaderboardEntry {
  id: string;
  display_name: string;
  photo_url: string | null;
  provider: DbUser['provider'];
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  total_kills: number;
  badges: BadgeName[];
  win_rate: number;            // 0–100, one decimal place
  rank: number;
}

/** Response shape for GET /api/replay/:roomId */
export interface ReplayData {
  room: Pick<DbRoom, 'id' | 'player_count' | 'max_players' | 'evil_wins' | 'created_at' | 'ended_at'>;
  events: DbGameEvent[];
}

/** Response shape for GET /api/profile/me and /api/profile/:id */
export interface ProfileData extends DbUser {
  win_rate: number;            // computed: games_won / total_games * 100
  recent_games: Array<
    Pick<DbGameRecord, 'role' | 'won' | 'elo_delta' | 'player_count' | 'created_at'>
  >;
}
