-- ============================================================
-- Avalon Pedia — Supabase Schema Baseline (Plan v2 R0-B)
-- Migration ID: 20260420000000_baseline
-- Purpose: Declarative snapshot of current production schema.
--          Serves as the SSoT starting point for all R1.2 / R2 / R4
--          forward migrations. Idempotent — safe to run on an existing
--          database without data loss (all statements use IF NOT EXISTS
--          or CREATE OR REPLACE).
-- Created: 2026-04-20 23:10 +08
-- Author:  Plan v2 R0-B subagent (GM dispatched)
-- ============================================================
--
-- NOTES ON KNOWN DEBT (Edward 5-question decisions, 2026-04-20):
--   #2  update_player_stats stored procedure → TO BE DROPPED in R4.
--       Kept here for fidelity to current prod state. Do NOT add new
--       callers. See saveGameRecords() in packages/server/src/services/supabase.ts.
--   #4  game_events.actor_id (TEXT) vs user_id (UUID) — dual-write
--       phase planned in R2. Baseline keeps only actor_id; R2 will add
--       user_id UUID column via follow-up migration.
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- ============================================================
-- gen_random_uuid() requires pgcrypto (usually pre-enabled in Supabase)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- TABLES
-- ============================================================

-- 用戶表
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid    TEXT UNIQUE,            -- Firebase Auth UID (Google/Email)
  discord_id      TEXT UNIQUE,            -- Discord OAuth user ID
  line_id         TEXT UNIQUE,            -- Line Login user ID
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
  id              TEXT PRIMARY KEY,               -- 6 碼代碼，如 'AB3XYZ'
  host_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT 'lobby',  -- 'lobby'|'voting'|'quest'|'discussion'|'ended'
  player_count    INTEGER NOT NULL DEFAULT 1,
  max_players     INTEGER NOT NULL DEFAULT 10,
  evil_wins       BOOLEAN,                        -- NULL = 進行中
  is_private      BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE = 需要密碼才能加入
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

-- 遊戲記錄表（每位玩家每局一筆）
CREATE TABLE IF NOT EXISTS game_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  player_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  role            TEXT NOT NULL,   -- 'merlin'|'percival'|'loyal'|'assassin'|'morgana'|'mordred'|'oberon'|'minion'
  team            TEXT NOT NULL,   -- 'good'|'evil'
  won             BOOLEAN NOT NULL,
  elo_before      INTEGER NOT NULL,
  elo_after       INTEGER NOT NULL,
  elo_delta       INTEGER NOT NULL,
  player_count    INTEGER NOT NULL,
  duration_sec    INTEGER,
  is_bot          BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE = AI 自對弈記錄（SelfPlayEngine）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 投票歷程表（任務組合的贊成/反對）
CREATE TABLE IF NOT EXISTS votes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,   -- 第幾輪任務 (1-5)
  vote_attempt    INTEGER NOT NULL,   -- 第幾次投票 (1-5)
  voter_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  vote            BOOLEAN NOT NULL,   -- TRUE=贊成, FALSE=反對
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 任務結果表
CREATE TABLE IF NOT EXISTS quest_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,
  result          TEXT NOT NULL,     -- 'success'|'fail'
  fail_votes      INTEGER NOT NULL DEFAULT 0,
  team_user_ids   UUID[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OAuth 暫存表（Discord/Line CSRF state token）
CREATE TABLE IF NOT EXISTS oauth_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_token     TEXT UNIQUE NOT NULL,
  provider        TEXT NOT NULL,     -- 'discord'|'line'
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 遊戲事件表（供回放 & AI 訓練用）
-- 每個遊戲動作存一筆，event_data 為 JSON 完整狀態快照
-- NOTE: actor_id 是 TEXT 型（Firebase uid / guest uuid），Plan v2 R2 將加
--       user_id UUID FK 欄位雙寫過渡（Edward 決議 #4）。
CREATE TABLE IF NOT EXISTS game_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,                 -- 事件序號（遊戲內順序，從 1 起）
  event_type  TEXT NOT NULL,                    -- 見 GameEventType 型別定義
  actor_id    TEXT,                             -- 觸發事件的玩家 uid（可 NULL）
  event_data  JSONB NOT NULL DEFAULT '{}',      -- 完整事件資料（角色、投票、結果等）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, seq)                         -- 同一房間不重複序號
);

-- 好友/追蹤關係表
-- NOTE: 原定義在 packages/server/src/routes/friends.ts 註解內，未納入 schema.sql。
--       baseline 把它明確化，與 friends 路由實際查詢一致。
CREATE TABLE IF NOT EXISTS friendships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (follower_id, following_id)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_game_records_player   ON game_records(player_user_id);
CREATE INDEX IF NOT EXISTS idx_game_records_room     ON game_records(room_id);
CREATE INDEX IF NOT EXISTS idx_game_records_created  ON game_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_votes_room            ON votes(room_id);
CREATE INDEX IF NOT EXISTS idx_rooms_state           ON rooms(state);
CREATE INDEX IF NOT EXISTS idx_rooms_created         ON rooms(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid    ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_discord_id      ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_line_id         ON users(line_id);
CREATE INDEX IF NOT EXISTS idx_users_elo             ON users(elo_rating DESC);  -- 排行榜排序
CREATE INDEX IF NOT EXISTS idx_game_events_room      ON game_events(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_friendships_follower  ON friendships(follower_id);
CREATE INDEX IF NOT EXISTS idx_friendships_following ON friendships(following_id);

-- ============================================================
-- TRIGGERS — auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_rooms_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ROW LEVEL SECURITY
-- 後端使用 service_role key 繞過 RLS；
-- policy 開放供未來前端直連使用（目前後端統一代理）。
-- WARNING: `USING (true)` 等同全開放；僅 service_role 繞 RLS 才安全。
--          任何前端使用 anon key 直連的設計，必須在 R2 前重寫 policy
--          為 `USING ((SELECT auth.uid()) = id)` 型態。
-- ============================================================
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms          ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_records   ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_results  ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships    ENABLE ROW LEVEL SECURITY;

-- Idempotent policy creation (CREATE POLICY has no IF NOT EXISTS before PG 15+)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON users FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON rooms FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'game_records' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON game_records FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'votes' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON votes FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'quest_results' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON quest_results FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'oauth_sessions' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON oauth_sessions FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'game_events' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON game_events FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'friendships' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON friendships FOR ALL USING (true);
  END IF;
END $$;

-- ============================================================
-- VIEWS
-- ============================================================

-- 排行榜視圖（供 /api/leaderboard 使用）
CREATE OR REPLACE VIEW leaderboard_view AS
SELECT
  u.id,
  u.display_name,
  u.photo_url,
  u.provider,
  u.elo_rating,
  u.total_games,
  u.games_won,
  u.games_lost,
  u.total_kills,
  u.badges,
  CASE
    WHEN u.total_games > 0
    THEN ROUND(u.games_won::NUMERIC / u.total_games * 100, 1)
    ELSE 0
  END AS win_rate,
  RANK() OVER (ORDER BY u.elo_rating DESC) AS rank
FROM users u
WHERE u.total_games > 0
ORDER BY u.elo_rating DESC;

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- 原子更新用戶統計與 ELO
-- 由 saveGameRecords() 在每局結束後逐筆呼叫
--
-- DEPRECATED (Edward 決議 #2, 2026-04-20)：R4 將廢此 SP 改資料驅動。
-- 理由：
--   1. 與 GameServer.persistGameResult 的 hardcoded +20/-15 可能雙算 ELO
--   2. R4 ELO 重算需 replay 2145 局歷史，SP 的 INSERT/UPDATE 固定邏輯阻礙重算
--   3. 計算邏輯應在應用層 (EloAttributionEngine)，DB 層只負責存 final value
-- 遷移步驟：R4.0 audit → R4.1 removeRPC call → R4.2 DROP FUNCTION
CREATE OR REPLACE FUNCTION update_player_stats(
  p_user_id   UUID,
  p_won       BOOLEAN,
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

-- 頒發徽章（冪等：已有則不重複添加）
-- 由後端在遊戲結束後依條件呼叫
-- 徽章清單：初勝 / 梅林之盾 / 刺客之影 / 完美刺客 / 梅林逃脫 / 十人戰場 / 大局觀 / 穩健 / 浴火重生 / 速戰速決
CREATE OR REPLACE FUNCTION award_badge(
  p_user_id UUID,
  p_badge   TEXT
)
RETURNS VOID AS $$
BEGIN
  UPDATE users
  SET badges     = array_append(badges, p_badge),
      updated_at = NOW()
  WHERE id = p_user_id
    AND NOT (p_badge = ANY(badges));
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- END OF BASELINE
-- ============================================================
