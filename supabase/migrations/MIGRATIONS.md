# Supabase Migrations

SSoT for database schema evolution. Every schema change lives here as a timestamped SQL file, applied in order.

Baseline established: **2026-04-20** (Plan v2 R0-B).

---

## Layout

```
supabase/
  schema.sql                              # Legacy one-shot setup (kept for fresh-DB bootstrap only)
  migrations/
    20260420000000_baseline.sql           # Declarative snapshot of current prod schema
    MIGRATIONS.md                         # This file
    <timestamp>_<short_description>.sql   # Future forward migrations
```

**`schema.sql` (top-level)** is frozen as a historical one-shot installer. New changes go under `migrations/` only.

---

## Naming Convention

```
<YYYYMMDDHHMMSS>_<lowercase_snake_case_description>.sql
```

- Timestamp is UTC-ish sortable; use Taipei-time datetime without punctuation (e.g. `20260420231000_add_guest_claim_token.sql`). Ordering matters, not exact timezone — just stay monotonic.
- Description: under ~40 chars, describes the forward change.
- One logical change per file. Merging unrelated ALTERs into one migration makes rollback painful.

Examples:
- `20260421090000_add_guest_claim_token.sql`         (R1.2)
- `20260422140000_game_events_add_user_id.sql`       (R2 dual-write start)
- `20260501100000_drop_update_player_stats.sql`      (R4 SP removal)

---

## Idempotency Rules

Every migration MUST be safe to re-run (Supabase MCP / CI / manual reruns all happen).

- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `CREATE OR REPLACE FUNCTION/TRIGGER/VIEW`
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (PG 9.6+)
- Policies: wrap in `DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_policies ...) $$` block (see baseline).
- `DROP ... IF EXISTS` for removals.

If a statement is not naturally idempotent, wrap it in `DO $$` with a check.

---

## Rollback Strategy

Supabase free tier has no transactional DDL across migrations, so:

1. **Every forward migration** carries a matching rollback plan written in a top comment block (NOT a separate `_down.sql` file — pair keeps them in sync).

   Format:
   ```sql
   -- ============================================================
   -- Migration: <timestamp>_<name>
   -- Rollback:
   --   1. ALTER TABLE game_events DROP COLUMN IF EXISTS user_id;
   --   2. DROP INDEX IF EXISTS idx_game_events_user_id;
   -- ============================================================
   ```

2. **Rollbacks are manual.** Run in Supabase SQL Editor when needed. No auto-rollback tooling until R6+.

3. **Destructive migrations** (column drops, data loss risk) REQUIRE:
   - Edward explicit approval (DC message logged)
   - Data export snapshot first (see "Backup before destructive" below)
   - Deployed to staging DB for 24h before prod

4. **Rollback never restores dropped data.** If a migration drops rows/columns and must be undone, recovery is from Supabase PITR or exported backup — not from reversing the migration.

---

## Backup Before Destructive

Before any migration that includes `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN ... TYPE`, or backfills mass `UPDATE`:

```bash
# In Supabase SQL Editor, export affected tables:
COPY (SELECT * FROM <table>) TO STDOUT WITH CSV HEADER;
# Save to supabase/backups/<date>_<table>.csv (gitignored — use R2 or local only)
```

Or use Supabase Dashboard → Database → Backups → Download.

---

## Applying Migrations

**Current state (2026-04-20)**: No migration runner wired yet. Apply manually.

1. Open Supabase SQL Editor
2. Paste migration file contents
3. Run
4. Verify with sanity query from the file's bottom comment
5. Log applied migration in `supabase/migrations/applied.log` (create on first apply):
   ```
   2026-04-20T23:15:00+08 20260420000000_baseline.sql OK edward@l12203685
   ```

**Target state (R6)**: Wire up `supabase db push` via Supabase CLI in CI. Baseline is the prerequisite for that wiring.

---

## Plan v2 Addendum — Known Schema Gaps

Reference: Plan v2 `§R0-R6` and Edward 5-question decisions (2026-04-20 07:03, DC msg_id 1495681404745289779).

| Phase | Gap | Baseline Stance | Migration Plan |
|-------|-----|-----------------|----------------|
| R1.0 | Guest JSON `uid` trust removal + 3-day grace | N/A (code-only change) | No schema migration. Handled in `auth.ts`. |
| R1.2 | `users.is_guest BOOLEAN`, `users.guest_claim_token TEXT`, `users.merged_into_user_id UUID` for guest → registered upgrade path | NOT present | Forward migration `<ts>_users_add_guest_fields.sql`. `guest_claim_token` needs unique index + partial (`WHERE guest_claim_token IS NOT NULL`). |
| R1.4/R1.5 | `game_records.source TEXT` + `game_events.user_id UUID` dual-write column (Edward 決議 #4) | Only `actor_id TEXT` exists | Two separate migrations: (a) add `game_events.user_id UUID REFERENCES users(id)` nullable; (b) add FK index. `actor_id` kept during dual-write, dropped in R5. |
| R2.0 | `pending_results` outbox table (Edward 決議 #5 — Supabase table over Render cron) | NOT present | Forward migration `<ts>_add_pending_results_outbox.sql` with retry_count, last_error, next_retry_at index. |
| R2 | `stats_cache` materialized view or table for leaderboard/profile | NOT present | Materialized view preferred; refresh on game_records insert via trigger or scheduled job. |
| R4 | DROP FUNCTION `update_player_stats` (Edward 決議 #2) | Present in baseline | R4.0 audit → R4.1 remove RPC call from `saveGameRecords` → R4.2 migration `<ts>_drop_update_player_stats.sql`. Must not be done before ELO recalculation path is data-driven. |
| R4 | ELO history table (replay 2145 games source-of-truth) | NOT present | `<ts>_add_elo_events.sql` for audit trail. |
| R4/R5 | DROP `game_events.actor_id` after dual-write complete | Present in baseline | Only after R2 dual-write is 100% validated and R4 backfill migrates all historical rows to `user_id`. |
| R3 | `claim_requests` Supabase table (Firestore migration) | NOT present | `<ts>_add_claim_requests.sql` for claim system ID migration. |

---

## RLS Policy Notes

Baseline uses `USING (true)` policies that rely on service_role key bypassing RLS. This is **safe today** because:
- Server uses `SUPABASE_SERVICE_KEY` (service_role).
- No frontend uses anon key to hit Supabase directly.

**Before any R2+ feature that lets the browser talk to Supabase with the anon key**, the policies MUST be rewritten to per-row checks:

```sql
-- Example for users table
DROP POLICY IF EXISTS "service_role_all" ON users;
CREATE POLICY "user_read_own" ON users
  FOR SELECT USING ((SELECT auth.uid())::text = id::text);
CREATE POLICY "user_update_own" ON users
  FOR UPDATE USING ((SELECT auth.uid())::text = id::text);
-- service_role still bypasses RLS implicitly
```

Index `users(id)` is already PK so this policy is fast. Future per-tenant tables (game_records, friendships) need the same pattern — FK columns used by RLS policies MUST be indexed.

---

## Checklist for New Migrations

- [ ] File name follows `<timestamp>_<snake_case>.sql`
- [ ] Top block documents: purpose, date, author, rollback plan
- [ ] All statements idempotent (`IF NOT EXISTS` / `OR REPLACE` / `DO $$` guards)
- [ ] Indexes for any new FK / RLS-filter column
- [ ] No `GRANT ALL` or wide-open policies without justification
- [ ] Destructive ops pre-approved by Edward with backup taken
- [ ] Appended to `applied.log` after running
- [ ] Linked to Plan v2 phase (R0/R1/R2/...) in commit message

---

## References

- Plan v2: `/mnt/c/Users/admin/staging/subagent_results/avalonpediatw_refactor_plan_v2.md`
- Baseline file: `supabase/migrations/20260420000000_baseline.sql`
- Server Supabase client: `packages/server/src/services/supabase.ts`
- Friendships table origin: `packages/server/src/routes/friends.ts` (lines 1-10 comment)
- Edward 5-question decisions: `staging/session_state.md` §"Edward 五題決議"
