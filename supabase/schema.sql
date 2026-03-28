-- ============================================================
-- Avalon Pedia — Supabase PostgreSQL Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- 用戶表
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid    TEXT UNIQUE,          -- Firebase Auth UID (Google/Email)
  discord_id      TEXT UNIQUE,          -- Discord OAuth user ID
  line_id         TEXT UNIQUE,          -- Line Login user ID
  email           TEXT,
  display_name    TEXT NOT NULL,
  photo_url       TEXT,
  provider        TEXT NOT NULL DEFAULT 'guest',  -- 'google'|'discord'|'line'|'email'|'guest'
  elo_rating      INTEGER NOT NULL DEFAULT 1000,
  total_games     INTEGER NOT NULL DEFAULT 0,
  games_won       INTEGER NOT NULL DEFAULT 0,
  games_lost      INTEGER NOT NULL DEFAULT 0,
  total_kills     INTEGER NOT NULL DEFAULT 0,
  badges          TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 房間表
CREATE TABLE IF NOT EXISTS rooms (
  id              TEXT PRIMARY KEY,     -- 6 碼代碼，如 'AB3XYZ'
  host_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT 'lobby',  -- 'lobby'|'voting'|'quest'|'discussion'|'ended'
  player_count    INTEGER NOT NULL DEFAULT 1,
  max_players     INTEGER NOT NULL DEFAULT 10,
  evil_wins       BOOLEAN,              -- NULL = 進行中
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

-- 遊戲記錄表（每位玩家每局一筆）
CREATE TABLE IF NOT EXISTS game_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  player_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  role            TEXT NOT NULL,        -- 'merlin'|'percival'|'loyal'|'assassin'|'morgana'|'mordred'|'oberon'
  team            TEXT NOT NULL,        -- 'good'|'evil'
  won             BOOLEAN NOT NULL,
  elo_before      INTEGER NOT NULL,
  elo_after       INTEGER NOT NULL,
  elo_delta       INTEGER NOT NULL,
  player_count    INTEGER NOT NULL,
  duration_sec    INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 投票歷程表（任務組合的贊成/反對）
CREATE TABLE IF NOT EXISTS votes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,     -- 第幾輪任務 (1-5)
  vote_attempt    INTEGER NOT NULL,     -- 第幾次投票 (1-5)
  voter_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  vote            BOOLEAN NOT NULL,     -- true=贊成, false=反對
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 任務結果表
CREATE TABLE IF NOT EXISTS quest_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,
  result          TEXT NOT NULL,        -- 'success'|'fail'
  fail_votes      INTEGER NOT NULL DEFAULT 0,
  team_user_ids   UUID[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OAuth 暫存表（Discord/Line CSRF state）
CREATE TABLE IF NOT EXISTS oauth_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_token     TEXT UNIQUE NOT NULL,
  provider        TEXT NOT NULL,        -- 'discord'|'line'
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 索引
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_game_records_player  ON game_records(player_user_id);
CREATE INDEX IF NOT EXISTS idx_game_records_room    ON game_records(room_id);
CREATE INDEX IF NOT EXISTS idx_votes_room           ON votes(room_id);
CREATE INDEX IF NOT EXISTS idx_rooms_state          ON rooms(state);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid   ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_discord_id     ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_line_id        ON users(line_id);

-- ============================================================
-- 自動更新 updated_at 的 trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_rooms_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Row Level Security（先開放，後續可依需求收緊）
-- ============================================================
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms         ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_sessions ENABLE ROW LEVEL SECURITY;

-- 後端使用 service_role key，繞過 RLS，以下 policy 供前端直連用（目前未使用）
CREATE POLICY "service_role_all" ON users         FOR ALL USING (true);
CREATE POLICY "service_role_all" ON rooms         FOR ALL USING (true);
CREATE POLICY "service_role_all" ON game_records  FOR ALL USING (true);
CREATE POLICY "service_role_all" ON votes         FOR ALL USING (true);
CREATE POLICY "service_role_all" ON quest_results FOR ALL USING (true);
CREATE POLICY "service_role_all" ON oauth_sessions FOR ALL USING (true);

-- 遊戲事件表（供回放 & AI 訓練用）
-- 每個遊戲動作存一筆，event_data 為 JSON 完整狀態快照
CREATE TABLE IF NOT EXISTS game_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,              -- 事件序號（遊戲內順序）
  event_type  TEXT NOT NULL,                 -- 'game_started'|'team_selected'|'vote_cast'|'quest_resolved'|'game_ended' 等
  actor_id    TEXT,                          -- 觸發事件的玩家 uid（可 NULL）
  event_data  JSONB NOT NULL DEFAULT '{}',   -- 完整事件資料（角色、投票、結果等）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_events_room ON game_events(room_id, seq);

-- ============================================================
-- update_player_stats — 原子更新用戶統計與 ELO
-- 由 saveGameRecords() 在每局結束後逐筆呼叫
-- ============================================================
CREATE OR REPLACE FUNCTION update_player_stats(
  p_user_id  UUID,
  p_won      BOOLEAN,
  p_elo_delta INTEGER
)
RETURNS VOID AS $$
BEGIN
  UPDATE users SET
    total_games = total_games + 1,
    games_won   = games_won   + CASE WHEN p_won THEN 1 ELSE 0 END,
    games_lost  = games_lost  + CASE WHEN p_won THEN 0 ELSE 1 END,
    elo_rating  = GREATEST(0, elo_rating + p_elo_delta),
    updated_at  = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql;
