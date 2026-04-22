/**
 * EloConfigLoader — Supabase-backed config loader for ELO tuning (#54 Phase 2 Day 3)
 *
 * Responsibilities:
 *   1. On server boot, load the persisted config row (if any) and feed it to
 *      `setEloConfig()` so the Phase 1 pipeline picks up Edward's last choice.
 *   2. Subscribe to Supabase Realtime `postgres_changes` on the `elo_config`
 *      table so live admin edits hot-reload without a server restart.
 *   3. Expose a narrow write helper for the admin API route so all persistence
 *      goes through a single validated path.
 *
 * Supabase schema expected (create once via SQL editor or migration):
 *   create table if not exists public.elo_config (
 *     key text primary key,
 *     value jsonb not null,
 *     updated_at timestamptz not null default now(),
 *     updated_by text
 *   );
 *   -- Realtime must be enabled on the table for the subscription to fire:
 *   -- alter publication supabase_realtime add table public.elo_config;
 *
 * Only one row is used: key = 'active'. The `value` column stores a
 * `Partial<EloConfig>` that gets merged onto `DEFAULT_ELO_CONFIG` via
 * `setEloConfig()`; unset fields keep their defaults.
 *
 * Degradation contract: if Supabase is not configured (no URL/service key),
 * we log a single warning and keep running on `DEFAULT_ELO_CONFIG`. The
 * admin write endpoint surfaces a 503 instead of silently dropping writes.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  EloConfig,
  DEFAULT_ELO_CONFIG,
  setEloConfig,
  getEloConfig,
} from './EloConfig';
import { setShadowWriterOptions } from './EloShadowWriter';
import { getSupabaseClient, isSupabaseReady } from './supabase';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Single-row primary key — all active config merges into this one row. */
const CONFIG_ROW_KEY = 'active';
const CONFIG_TABLE = 'elo_config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Row shape matches `supabase/migrations/20260422000000_add_elo_config.sql`:
 *   - Phase 1 baseline column is `config JSONB` (not `value`).
 *   - `updated_by` references users(id) as UUID; we pass the admin's
 *     Supabase UUID when available, otherwise null.
 */
interface EloConfigRow {
  key: string;
  config: Partial<EloConfig> | null;
  updated_at?: string;
  updated_by?: string | null;
}

export interface EloConfigLoadResult {
  source: 'supabase' | 'default' | 'error';
  appliedPartial: Partial<EloConfig> | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeChannel: RealtimeChannel | null = null;

// ---------------------------------------------------------------------------
// Load (boot path)
// ---------------------------------------------------------------------------

/**
 * Load the persisted ELO config from Supabase and apply it to the in-memory
 * singleton via `setEloConfig()`. Called once on server boot.
 *
 * Safe to call without Supabase configured — logs and returns {source:'default'}.
 */
export async function loadEloConfigFromSupabase(): Promise<EloConfigLoadResult> {
  if (!isSupabaseReady()) {
    console.log(
      '[EloConfigLoader] Supabase not configured — using DEFAULT_ELO_CONFIG (attributionMode=legacy).'
    );
    return { source: 'default', appliedPartial: null };
  }

  const db = getSupabaseClient();
  if (!db) {
    return { source: 'default', appliedPartial: null };
  }

  try {
    const { data, error } = await db
      .from(CONFIG_TABLE)
      .select('key, config, updated_at, updated_by')
      .eq('key', CONFIG_ROW_KEY)
      .maybeSingle<EloConfigRow>();

    if (error) {
      // Table missing or permissions issue — fall back to defaults so server
      // boot isn't blocked by an optional config table.
      console.warn(
        `[EloConfigLoader] Could not read elo_config row (${error.code ?? '?'}): ${error.message}. ` +
          `Using DEFAULT_ELO_CONFIG. If this is a fresh install, run the migrations in supabase/migrations/.`
      );
      return { source: 'error', appliedPartial: null, error: error.message };
    }

    if (!data || !data.config) {
      console.log('[EloConfigLoader] No elo_config row persisted yet — using DEFAULT_ELO_CONFIG.');
      return { source: 'default', appliedPartial: null };
    }

    applyPartialConfig(data.config);
    console.log(
      `[EloConfigLoader] Applied persisted config from Supabase (attributionMode=${getEloConfig().attributionMode}).`
    );
    return { source: 'supabase', appliedPartial: data.config };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[EloConfigLoader] Boot load failed: ${msg}. Using DEFAULT_ELO_CONFIG.`);
    return { source: 'error', appliedPartial: null, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Subscribe (hot-reload path)
// ---------------------------------------------------------------------------

/**
 * Subscribe to Supabase Realtime `postgres_changes` events on the
 * `elo_config` table. Any INSERT/UPDATE on the 'active' row will re-apply
 * the merged partial to `setEloConfig()` without a restart.
 *
 * Returns the channel so callers can unsubscribe in tests; returns null if
 * Supabase is not configured.
 */
export function subscribeEloConfigChanges(): RealtimeChannel | null {
  if (!isSupabaseReady()) return null;
  if (activeChannel) return activeChannel;

  const db = getSupabaseClient();
  if (!db) return null;

  const channel = db
    .channel('elo_config_changes')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: CONFIG_TABLE,
        filter: `key=eq.${CONFIG_ROW_KEY}`,
      },
      (payload) => {
        try {
          const next = (payload.new as EloConfigRow | null)?.config ?? null;
          if (!next) {
            // Row deleted — reset to defaults so stale overrides don't linger.
            setEloConfig();
            console.log('[EloConfigLoader] elo_config row cleared — reset to DEFAULT_ELO_CONFIG.');
            return;
          }
          applyPartialConfig(next);
          console.log(
            `[EloConfigLoader] Hot-reloaded config (attributionMode=${getEloConfig().attributionMode}).`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[EloConfigLoader] Hot-reload handler failed: ${msg}`);
        }
      }
    )
    .subscribe();

  activeChannel = channel;
  return channel;
}

/**
 * Stop listening for realtime updates. Used by tests and graceful shutdown.
 */
export async function unsubscribeEloConfigChanges(): Promise<void> {
  if (!activeChannel) return;
  try {
    await activeChannel.unsubscribe();
  } finally {
    activeChannel = null;
  }
}

// ---------------------------------------------------------------------------
// Write (admin path)
// ---------------------------------------------------------------------------

/**
 * Persist a partial ELO config override to Supabase. The admin UI calls this
 * via the `/api/admin/elo/config` route.
 *
 * Applies the same partial to the in-memory singleton immediately so the
 * caller sees its own write reflected — the realtime subscription will
 * receive the same change moments later (idempotent re-apply).
 */
export async function persistEloConfigOverride(
  partial: Partial<EloConfig>,
  updatedBy: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Local apply first so the hot path reflects the admin change even if
  // Supabase write is briefly delayed (or test environment has no DB).
  applyPartialConfig(partial);

  if (!isSupabaseReady()) {
    return { ok: false, error: 'Supabase not configured — config change applied in-memory only.' };
  }

  const db = getSupabaseClient();
  if (!db) return { ok: false, error: 'Supabase client unavailable' };

  try {
    // Read-modify-write to preserve existing Phase 1 fields (team baselines,
    // role K weights, etc.) — the admin UI currently only edits attribution
    // fields, but the persisted row holds the full config.
    const { data: existing } = await db
      .from(CONFIG_TABLE)
      .select('config')
      .eq('key', CONFIG_ROW_KEY)
      .maybeSingle<{ config: Partial<EloConfig> | null }>();

    const merged: Partial<EloConfig> = {
      ...(existing?.config ?? {}),
      ...partial,
      // Deep-merge attributionWeights so admins can tweak proposal without
      // wiping outerWhiteInnerBlack.
      ...(partial.attributionWeights
        ? {
            attributionWeights: {
              ...((existing?.config ?? {}).attributionWeights ?? DEFAULT_ELO_CONFIG.attributionWeights),
              ...partial.attributionWeights,
            },
          }
        : {}),
    };

    const row: Pick<EloConfigRow, 'key' | 'config' | 'updated_by'> = {
      key: CONFIG_ROW_KEY,
      config: merged,
      updated_by: updatedBy,
    };
    const { error } = await db.from(CONFIG_TABLE).upsert(row, { onConflict: 'key' });
    if (error) {
      return { ok: false, error: `Supabase upsert failed: ${error.message}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate and apply a `Partial<EloConfig>` to the singleton. Only whitelisted
 * fields are merged to prevent a malicious row from injecting arbitrary keys.
 */
function applyPartialConfig(partial: Partial<EloConfig>): void {
  const safe: Partial<EloConfig> = {};

  if (partial.attributionMode === 'legacy' || partial.attributionMode === 'per_event') {
    safe.attributionMode = partial.attributionMode;
  }
  if (partial.attributionWeights && typeof partial.attributionWeights === 'object') {
    safe.attributionWeights = {
      proposal:
        typeof partial.attributionWeights.proposal === 'number'
          ? partial.attributionWeights.proposal
          : DEFAULT_ELO_CONFIG.attributionWeights.proposal,
      outerWhiteInnerBlack:
        typeof partial.attributionWeights.outerWhiteInnerBlack === 'number'
          ? partial.attributionWeights.outerWhiteInnerBlack
          : DEFAULT_ELO_CONFIG.attributionWeights.outerWhiteInnerBlack,
      information:
        typeof partial.attributionWeights.information === 'number'
          ? partial.attributionWeights.information
          : DEFAULT_ELO_CONFIG.attributionWeights.information,
      misdirection:
        typeof partial.attributionWeights.misdirection === 'number'
          ? partial.attributionWeights.misdirection
          : DEFAULT_ELO_CONFIG.attributionWeights.misdirection,
      seatOrderEnabled:
        typeof partial.attributionWeights.seatOrderEnabled === 'boolean'
          ? partial.attributionWeights.seatOrderEnabled
          : DEFAULT_ELO_CONFIG.attributionWeights.seatOrderEnabled,
    };
  }
  if (typeof partial.baseKFactor === 'number') safe.baseKFactor = partial.baseKFactor;
  if (typeof partial.startingElo === 'number') safe.startingElo = partial.startingElo;
  if (typeof partial.minElo === 'number') safe.minElo = partial.minElo;
  if (partial.teamBaselines) safe.teamBaselines = partial.teamBaselines;
  if (partial.outcomeWeights) safe.outcomeWeights = partial.outcomeWeights;
  if (partial.roleKWeights) safe.roleKWeights = partial.roleKWeights;

  // #54 Phase 3: shadow-mode flags. Validate types before merging so a
  // malformed row cannot flip shadow on/off accidentally.
  if (typeof partial.shadowEnabled === 'boolean') {
    safe.shadowEnabled = partial.shadowEnabled;
  }
  if (partial.shadowStartedAt === null || typeof partial.shadowStartedAt === 'number') {
    safe.shadowStartedAt = partial.shadowStartedAt;
  }
  if (typeof partial.shadowReviewPeriodDays === 'number') {
    safe.shadowReviewPeriodDays = partial.shadowReviewPeriodDays;
  }

  setEloConfig(safe);

  // Sync the shadow writer kill-switch with whatever the active config says
  // AFTER the merge. This lets both boot-load and hot-reload flip the writer
  // in one place; callers never touch setShadowWriterOptions directly.
  const merged = getEloConfig();
  setShadowWriterOptions({ enabled: merged.shadowEnabled });
}
