-- ============================================================
-- Avalon Pedia — Migration 20260422000000_add_elo_config
-- Purpose: Persist the data-driven ELO configuration (#54 Phase 1).
-- Issue:   #54 ELO 計算改為資料驅動（陣營 baseline + 三結局分權）
-- Created: 2026-04-22 00:00 +08
-- Author:  GM-dispatched implementer subagent (#54 Phase 1)
--
-- Design (see packages/server/src/services/EloConfig.ts)
--   • Single JSONB row (key='active') holds the live config snapshot.
--   • Phase 1 seeds the row with the defaults hardcoded in EloConfig.ts.
--     Phase 2 will wire an admin endpoint to mutate this row and a
--     server-side loader to refresh the in-memory cache.
--     Phase 3 will snapshot historical configs (via history table) for
--     replay/backfill jobs.
--   • Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS elo_config (
  key         TEXT PRIMARY KEY,
  config      JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE elo_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'elo_config' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON elo_config FOR ALL USING (true);
  END IF;
END $$;

-- Seed the active config row with the Phase 1 defaults. These values
-- MUST stay in sync with DEFAULT_ELO_CONFIG in EloConfig.ts; Phase 2
-- will flip the source of truth from code to DB.
INSERT INTO elo_config (key, config)
VALUES (
  'active',
  jsonb_build_object(
    'startingElo',   1000,
    'minElo',        100,
    'baseKFactor',   32,
    'teamBaselines', jsonb_build_object(
      'good', 1500,
      'evil', 1500
    ),
    'outcomeWeights', jsonb_build_object(
      'good_wins_quests',       1.0,
      'evil_wins_quests',       1.0,
      'assassin_kills_merlin',  1.5
    ),
    'roleKWeights', jsonb_build_object(
      'merlin',   1.5,
      'assassin', 1.5,
      'percival', 1.2,
      'morgana',  1.2,
      'oberon',   1.1,
      'mordred',  1.3,
      'minion',   1.0,
      'loyal',    1.0
    )
  )
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- END
-- ============================================================
