-- ============================================================
-- Migration: consume_oauth_session RPC
-- 目的: 原子化地查詢 + 刪除 oauth_sessions row，防止 TOCTOU 競爭條件。
--       攻擊者無法在 SELECT 和 DELETE 之間重放 state token。
-- 呼叫方: packages/server/src/services/supabase.ts consumeOAuthSession()
-- ============================================================

CREATE OR REPLACE FUNCTION consume_oauth_session(
  p_state_token TEXT,
  p_provider    TEXT
)
RETURNS TABLE(link_user_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session oauth_sessions%ROWTYPE;
BEGIN
  -- SELECT FOR UPDATE: 鎖定 row，防止並發請求使用同一個 state token
  SELECT * INTO v_session
  FROM oauth_sessions
  WHERE state_token = p_state_token
    AND provider    = p_provider
  FOR UPDATE;

  -- state 不存在
  IF v_session.id IS NULL THEN
    RETURN;
  END IF;

  -- state 已過期
  IF v_session.expires_at < NOW() THEN
    -- 清理過期 row
    DELETE FROM oauth_sessions WHERE id = v_session.id;
    RETURN;
  END IF;

  -- 用完即刪（在同一 transaction 中原子完成）
  DELETE FROM oauth_sessions WHERE id = v_session.id;

  -- 回傳 link_user_id（NULL 代表非綁定流程）
  RETURN QUERY SELECT v_session.link_user_id::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION consume_oauth_session(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_oauth_session(TEXT, TEXT) TO service_role;
