-- ============================================================
-- Avalon Pedia — Migration 20260422140000_elo_phase3_shadow
-- Purpose: #54 Phase 3 — shadow-mode infrastructure for per-event ELO
-- Issue:   #54 ELO 計算改為資料驅動 (Phase 3 backtest + 2-week shadow)
-- Created: 2026-04-22 +08
--
-- Changes:
--   1. Extend elo_config JSONB with Phase 3 keys so admin UI can control
--      shadow-writer enablement + backtest snapshot metadata without a
--      code deploy.
--   2. Stamp an initial snapshot row in elo_config with shadowEnabled=false
--      so the 2-week observation window is explicitly off until Edward
--      flips it.
--   3. Idempotent — safe to re-run.
--
-- Firebase RTDB path `rankings_shadow/{uid}` holds the shadow entries.
-- RTDB has no schema migration — the path is created on first write.
--
-- Rollback:
--   UPDATE elo_config
--      SET config = config
--                 - 'shadowEnabled'
--                 - 'shadowStartedAt'
--                 - 'shadowReviewPeriodDays'
--    WHERE key = 'active';
--   -- (JSONB `-` operator drops the keys; live/shadow rankings are NOT
--   --  touched. Firebase RTDB `rankings_shadow/` stays as audit log
--   --  unless manually cleared.)
-- ============================================================

UPDATE elo_config
   SET config = config
             || jsonb_build_object(
                  'shadowEnabled',       COALESCE(config -> 'shadowEnabled',       to_jsonb(false)),
                  'shadowStartedAt',     COALESCE(config -> 'shadowStartedAt',     'null'::jsonb),
                  'shadowReviewPeriodDays', COALESCE(config -> 'shadowReviewPeriodDays', to_jsonb(14))
                ),
       updated_at = NOW()
 WHERE key = 'active';

-- Defensive insert if row missing.
INSERT INTO elo_config (key, config)
VALUES (
  'active',
  jsonb_build_object(
    'shadowEnabled',          false,
    'shadowStartedAt',        null,
    'shadowReviewPeriodDays', 14
  )
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- END
-- ============================================================
