# ELO Phase 3 Shadow-Mode Observation Checklist

> Source: `#54 Phase 3 — backtest + 2-week shadow`
> Related: `supabase/migrations/20260422140000_elo_phase3_shadow.sql`,
> `packages/server/src/services/EloShadowWriter.ts`,
> `scripts/elo_shadow_weekly_review.py`

## Activation Plan

### Step 1 — Run the migration

```
supabase migration up
# or, with direct psql:
psql "$SUPABASE_DB_URL" -f supabase/migrations/20260422140000_elo_phase3_shadow.sql
```

Idempotent — safe to re-run. Adds `shadowEnabled`, `shadowStartedAt`,
`shadowReviewPeriodDays` keys to the `elo_config.active` row with defaults
`false`, `null`, `14`.

### Step 2 — Flip the flag

Use the admin API (single-row upsert):

```
curl -X POST "$BASE_URL/api/admin/elo/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"shadowEnabled": true, "shadowStartedAt": 1713826800000}'
```

Or directly in SQL:

```sql
UPDATE elo_config
   SET config = config || jsonb_build_object(
          'shadowEnabled', true,
          'shadowStartedAt', (extract(epoch from now()) * 1000)::bigint
        ),
       updated_at = NOW()
 WHERE key = 'active';
```

The Supabase Realtime subscription in `EloConfigLoader` picks up the change
within seconds; `setShadowWriterOptions({enabled: true})` fires automatically
so the writer starts double-writing on the NEXT completed game.

### Step 3 — Verify writes

After the first completed game, inspect:

```
firebase database:get /rankings_shadow --json
```

Each entry has `shadowElo`, `legacyElo`, `delta`, `totalGames`, `updatedAt`.
If the path is empty, check the server log for `elo_shadow_written` or
`elo_shadow_write_error` events.

### Kill switch

Flip `shadowEnabled` back to `false` at any time via the same admin API or
SQL statement. Existing `rankings_shadow/` entries stay for audit; no new
writes happen until the flag is flipped on again.

## Observation Window

Duration: `shadowReviewPeriodDays` (default 14). The cadence below assumes
14 days; tune the script's `--week-label` if you run a shorter window.

### Week 1 — Mid-window snapshot

Run the review script:

```
python scripts/elo_shadow_weekly_review.py \
  --source json \
  --live-json /tmp/rankings_week1.json \
  --shadow-json /tmp/rankings_shadow_week1.json \
  --week-label "Week 1 mid"
```

What to look at:

- [ ] Top20 overlap between live and shadow (target 55-70%)
- [ ] Shadow Top20 avg ELO > live Top20 avg (per_event inflates the top band)
- [ ] Avg |shadow - live| ELO per player (target 100-300; > 500 investigate)
- [ ] Anomaly rate `|delta| > 200 ELO` (target <= 5%; > 10% investigate factor weights)
- [ ] No `elo_shadow_write_error` entries in the server log
- [ ] Shadow writer latency (should be fire-and-forget; no user-visible impact)

Early-warning triggers (take action without waiting for Week 2):

- Shadow write failure rate > 1% over 50 games → flip kill switch, investigate
- Any player's shadow ELO < minElo (should never happen — bug)
- `attributionApplied=false` on > 10% of games → per_event is falling back to
  legacy; vote/quest history likely missing on new records

### Week 2 — Final gate

Re-run the script with the full window:

```
python scripts/elo_shadow_weekly_review.py \
  --source json \
  --live-json /tmp/rankings_week2.json \
  --shadow-json /tmp/rankings_shadow_week2.json \
  --week-label "Week 2 final"
```

## Decision Gate

| Metric                         | SHIP          | CONTINUE      | ROLLBACK      |
|--------------------------------|---------------|---------------|---------------|
| Top20 overlap                  | >= 50%        | 40-50%        | < 40%         |
| Anomaly rate (\|delta\| > 200) | <= 5%         | 5-10%         | > 10%         |
| Shadow write failure rate      | 0%            | 0%            | > 1%          |
| Signal (winner vs loser delta) | >= 10 ELO     | 5-10 ELO      | < 5 ELO       |
| Role baseline spread           | evil-good 15-30 ELO | > 30 ELO or < 0 | > 80 ELO     |

**SHIP path** (per_event goes live):

1. Flip `attributionMode='per_event'` via admin API
2. Leave `shadowEnabled=true` for one more week as audit log
3. After audit week clean, flip `shadowEnabled=false`
4. Phase 3 closed

**CONTINUE path** (retune weights, extend window):

1. Apply the backtest's recommended weight bump (proposal 1.0, info 2.0, misd 2.0)
2. Reset `shadowStartedAt` to now
3. Extend window another 2 weeks
4. Re-run this checklist

**ROLLBACK path** (per_event abandoned):

1. Flip `shadowEnabled=false`
2. Keep `attributionMode='legacy'` (never changed)
3. Optionally clear `rankings_shadow/` path (audit decision)
4. Write Phase 3 postmortem + close issue #54

## Related Files

- Code: `packages/server/src/services/EloShadowWriter.ts`
- Code: `packages/server/src/services/EloRanking.ts` (`runShadowDoubleWrite`)
- Code: `packages/server/src/services/EloConfigLoader.ts` (`applyPartialConfig` shadow sync)
- Config: `packages/server/src/services/EloConfig.ts` (`shadowEnabled`, `shadowStartedAt`, `shadowReviewPeriodDays`)
- Migration: `supabase/migrations/20260422140000_elo_phase3_shadow.sql`
- Script: `scripts/elo_shadow_weekly_review.py`
- Backtest report: see subagent result `elo_phase3_backtest_2146_2026-04-22.md`
