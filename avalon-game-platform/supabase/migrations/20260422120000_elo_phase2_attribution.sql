-- ============================================================
-- Avalon Pedia — Migration 20260422120000_elo_phase2_attribution
-- Purpose: #54 Phase 2 Day 3 — enable realtime hot-reload on elo_config
--          and seed Phase 2 attribution fields into the active row.
-- Issue:   #54 ELO 計算改為資料驅動 (Phase 2)
-- Created: 2026-04-22 +08
--
-- Changes:
--   1. Add the elo_config table to the supabase_realtime publication so
--      the server can subscribe to UPDATE/INSERT/DELETE events and hot-
--      reload the in-memory EloConfig cache without a restart.
--   2. Merge Phase 2 keys (attributionMode / attributionWeights) into the
--      existing 'active' config row if they are missing. Existing Phase 1
--      fields are preserved by the jsonb concatenation operator.
--   3. Idempotent — safe to re-run.
-- ============================================================

-- 1. Realtime publication ------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname  = 'supabase_realtime'
       AND tablename = 'elo_config'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE elo_config;
  END IF;
END $$;

-- 2. Seed Phase 2 keys ---------------------------------------------------
-- `||` concatenation keeps every existing key from Phase 1 and only adds
-- attribution-related keys that don't already exist. Running again is a
-- no-op because the same keys collide and the new values equal the old.
UPDATE elo_config
   SET config = config
             || jsonb_build_object(
                  'attributionMode',    COALESCE(config -> 'attributionMode', to_jsonb('legacy'::text)),
                  'attributionWeights', COALESCE(
                    config -> 'attributionWeights',
                    jsonb_build_object(
                      'proposal',              2.0,
                      'outerWhiteInnerBlack',  3.0
                    )
                  )
                ),
       updated_at = NOW()
 WHERE key = 'active';

-- 3. Ensure a row exists (defensive; baseline migration should have seeded).
INSERT INTO elo_config (key, config)
VALUES (
  'active',
  jsonb_build_object(
    'attributionMode',    'legacy',
    'attributionWeights', jsonb_build_object(
      'proposal',              2.0,
      'outerWhiteInnerBlack',  3.0
    )
  )
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- END
-- ============================================================
