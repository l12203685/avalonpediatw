-- ============================================================
-- Migration: merge_user_accounts RPC
-- 目的: 把帳號合併的 8 個獨立操作包在單一 PostgreSQL transaction 中，
--       確保原子性。任一步失敗整個合併 ROLLBACK，不會產生半合併的資料損毀。
-- 呼叫方: packages/server/src/services/supabase.ts mergeUserAccounts()
-- ============================================================

CREATE OR REPLACE FUNCTION merge_user_accounts(
  p_primary_id   UUID,
  p_secondary_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_primary   users%ROWTYPE;
  v_secondary users%ROWTYPE;
  v_elo       INTEGER;
  v_total     INTEGER;
  v_won       INTEGER;
  v_lost      INTEGER;
  v_badges    TEXT[];
  v_patch     JSONB := '{}';
BEGIN
  -- 防止自我合併
  IF p_primary_id = p_secondary_id THEN
    RETURN FALSE;
  END IF;

  -- 鎖定兩個 row，防止並發合併同一對帳號（TOCTOU 防護）
  SELECT * INTO v_primary   FROM users WHERE id = p_primary_id   FOR UPDATE;
  SELECT * INTO v_secondary FROM users WHERE id = p_secondary_id FOR UPDATE;

  IF v_primary.id IS NULL OR v_secondary.id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- ── Step 1: 合併統計 ──────────────────────────────────────
  v_elo   := GREATEST(COALESCE(v_primary.elo_rating, 1000),
                      COALESCE(v_secondary.elo_rating, 1000));
  v_total := COALESCE(v_primary.total_games, 0) + COALESCE(v_secondary.total_games, 0);
  v_won   := COALESCE(v_primary.games_won,   0) + COALESCE(v_secondary.games_won,   0);
  v_lost  := COALESCE(v_primary.games_lost,  0) + COALESCE(v_secondary.games_lost,  0);

  -- badges 去重聯集
  SELECT ARRAY(
    SELECT DISTINCT unnest(
      COALESCE(v_primary.badges, '{}') ||
      COALESCE(v_secondary.badges, '{}')
    )
  ) INTO v_badges;

  -- ── Step 2: 把 secondary 的 provider 欄位補到 primary（若 primary 為空）──
  IF (v_primary.discord_id IS NULL OR v_primary.discord_id = '') AND
     (v_secondary.discord_id IS NOT NULL AND v_secondary.discord_id <> '') THEN
    v_patch := v_patch || jsonb_build_object('discord_id', v_secondary.discord_id);
  END IF;
  IF (v_primary.line_id IS NULL OR v_primary.line_id = '') AND
     (v_secondary.line_id IS NOT NULL AND v_secondary.line_id <> '') THEN
    v_patch := v_patch || jsonb_build_object('line_id', v_secondary.line_id);
  END IF;
  IF (v_primary.firebase_uid IS NULL OR v_primary.firebase_uid = '') AND
     (v_secondary.firebase_uid IS NOT NULL AND v_secondary.firebase_uid <> '') THEN
    v_patch := v_patch || jsonb_build_object('firebase_uid', v_secondary.firebase_uid);
  END IF;
  IF (v_primary.email IS NULL OR v_primary.email = '') AND
     (v_secondary.email IS NOT NULL AND v_secondary.email <> '') THEN
    v_patch := v_patch || jsonb_build_object('email', v_secondary.email);
  END IF;

  -- ── Step 3: 先清空 secondary 的 UNIQUE 欄位，避免後續更新衝突 ──
  UPDATE users
  SET discord_id   = NULL,
      line_id      = NULL,
      firebase_uid = NULL
  WHERE id = p_secondary_id;

  -- ── Step 4: 更新 primary 統計 + provider 補齊 ──
  UPDATE users
  SET elo_rating  = v_elo,
      total_games = v_total,
      games_won   = v_won,
      games_lost  = v_lost,
      badges      = v_badges,
      discord_id   = COALESCE((v_patch->>'discord_id'),   discord_id),
      line_id      = COALESCE((v_patch->>'line_id'),      line_id),
      firebase_uid = COALESCE((v_patch->>'firebase_uid'), firebase_uid),
      email        = COALESCE((v_patch->>'email'),        email),
      updated_at  = NOW()
  WHERE id = p_primary_id;

  -- ── Step 5: 搬移 game_records ──
  UPDATE game_records
  SET player_user_id = p_primary_id
  WHERE player_user_id = p_secondary_id;

  -- ── Step 6: 搬移 friendships（兩邊 follower/following）──
  UPDATE friendships SET follower_id  = p_primary_id WHERE follower_id  = p_secondary_id;
  UPDATE friendships SET following_id = p_primary_id WHERE following_id = p_secondary_id;

  -- ── Step 7: 刪自追蹤 + 重複 pair ──
  DELETE FROM friendships
  WHERE follower_id = p_primary_id AND following_id = p_primary_id;

  -- 重複 pair：保留 id 最小的那筆
  DELETE FROM friendships f1
  USING friendships f2
  WHERE f1.follower_id  = f2.follower_id
    AND f1.following_id = f2.following_id
    AND f1.id > f2.id;

  -- ── Step 8: 刪 secondary user row ──
  DELETE FROM users WHERE id = p_secondary_id;

  RETURN TRUE;
END;
$$;

-- 只允許 service role 呼叫（前端不可直接觸發）
REVOKE ALL ON FUNCTION merge_user_accounts(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_user_accounts(UUID, UUID) TO service_role;
