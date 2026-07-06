/**
 * EloConfigLoader — Firestore-backed config loader for ELO tuning (#54 Phase 3)
 *
 * Rewrite history: originally Supabase-backed (Phase 2 Day 3). Edward chose
 * path B on 2026-04-22 — drop Supabase, push the entire config plane onto
 * Firebase so the server only talks to one backend. Shadow writes still land
 * on RTDB `rankings_shadow/`; only the *config* doc moved to Firestore.
 *
 * Responsibilities:
 *   1. On server boot, fetch the persisted config doc (if any) and feed it
 *      to `setEloConfig()` so the Phase 1 pipeline picks up Edward's last
 *      choice.
 *   2. Subscribe via Firestore `onSnapshot` so live admin edits hot-reload
 *      without a server restart.
 *   3. Expose a narrow write helper for the admin API route so all persistence
 *      goes through a single validated path.
 *
 * Firestore layout:
 *   collection: `config`
 *   document:   `eloShadow`
 *   fields:     Partial<EloConfig> (exactly the shape stored in Supabase before)
 *
 * To flip the shadow kill-switch manually via Firebase Console:
 *   Firestore → config → eloShadow → set `shadowEnabled = true`.
 *
 * Degradation contract: if Firebase admin is not initialised (no service
 * account / project ID), we log a single warning and keep running on
 * `DEFAULT_ELO_CONFIG`. The admin write endpoint surfaces a 503 instead of
 * silently dropping writes.
 */

import type { Firestore, DocumentReference } from 'firebase-admin/firestore';
import {
  EloConfig,
  DEFAULT_ELO_CONFIG,
  setEloConfig,
  getEloConfig,
} from './EloConfig';
import { setShadowWriterOptions } from './EloShadowWriter';
import { getAdminFirestore, isFirebaseAdminReady } from './firebase';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Firestore collection holding infra-level runtime config. */
const CONFIG_COLLECTION = 'config';
/** Single-doc primary ID — all active ELO config merges into this one doc. */
const CONFIG_DOC_ID = 'eloShadow';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Firestore document shape:
 *   - `config`: the merged `Partial<EloConfig>` (same key as the old Supabase
 *     column so migration from Supabase JSON dumps is a direct copy).
 *   - `updatedAt`: server timestamp written on every upsert (diagnostic only).
 *   - `updatedBy`: admin email or uid that wrote the change.
 */
interface EloConfigDoc {
  config: Partial<EloConfig> | null;
  updatedAt?: number;
  updatedBy?: string | null;
}

export interface EloConfigLoadResult {
  source: 'firestore' | 'default' | 'error';
  appliedPartial: Partial<EloConfig> | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Unsubscribe callback returned by Firestore `onSnapshot`. */
let activeUnsubscribe: (() => void) | null = null;

/**
 * Return the canonical config doc ref, or null if Firestore is not ready.
 * Centralised so tests can mock a single spot.
 */
function getConfigDocRef(): DocumentReference | null {
  if (!isFirebaseAdminReady()) return null;
  let db: Firestore;
  try {
    db = getAdminFirestore();
  } catch {
    return null;
  }
  return db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC_ID);
}

// ---------------------------------------------------------------------------
// Load (boot path)
// ---------------------------------------------------------------------------

/**
 * Load the persisted ELO config from Firestore and apply it to the in-memory
 * singleton via `setEloConfig()`. Called once on server boot.
 *
 * Safe to call without Firebase admin configured — logs and returns
 * {source:'default'}.
 */
export async function loadEloConfigFromFirestore(): Promise<EloConfigLoadResult> {
  const ref = getConfigDocRef();
  if (!ref) {
    console.log(
      '[EloConfigLoader] Firebase admin not ready — using DEFAULT_ELO_CONFIG (attributionMode=legacy).'
    );
    return { source: 'default', appliedPartial: null };
  }

  try {
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(
        '[EloConfigLoader] No elo_shadow config doc yet — using DEFAULT_ELO_CONFIG.'
      );
      return { source: 'default', appliedPartial: null };
    }

    const data = snap.data() as EloConfigDoc | undefined;
    if (!data || !data.config) {
      console.log(
        '[EloConfigLoader] elo_shadow config doc empty — using DEFAULT_ELO_CONFIG.'
      );
      return { source: 'default', appliedPartial: null };
    }

    applyPartialConfig(data.config);
    console.log(
      `[EloConfigLoader] Applied persisted config from Firestore (attributionMode=${getEloConfig().attributionMode}).`
    );
    return { source: 'firestore', appliedPartial: data.config };
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
 * Subscribe to Firestore `onSnapshot` updates on the `config/eloShadow` doc.
 * Any write (including manual edits in Firebase Console) re-applies the
 * merged partial to `setEloConfig()` without a restart.
 *
 * Returns an unsubscribe callback so tests and graceful shutdown can detach
 * the listener; returns null if Firebase admin is not ready.
 */
export function subscribeEloConfigChanges(): (() => void) | null {
  if (activeUnsubscribe) return activeUnsubscribe;

  const ref = getConfigDocRef();
  if (!ref) return null;

  const unsubscribe = ref.onSnapshot(
    (snap) => {
      try {
        if (!snap.exists) {
          setEloConfig();
          setShadowWriterOptions({ enabled: getEloConfig().shadowEnabled });
          console.log('[EloConfigLoader] elo_shadow doc deleted — reset to DEFAULT_ELO_CONFIG.');
          return;
        }
        const data = snap.data() as EloConfigDoc | undefined;
        const next = data?.config ?? null;
        if (!next) {
          setEloConfig();
          setShadowWriterOptions({ enabled: getEloConfig().shadowEnabled });
          console.log('[EloConfigLoader] elo_shadow config cleared — reset to DEFAULT_ELO_CONFIG.');
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
    },
    (err) => {
      console.warn(`[EloConfigLoader] Firestore snapshot error: ${err.message}`);
    }
  );

  activeUnsubscribe = unsubscribe;
  return unsubscribe;
}

/**
 * Stop listening for Firestore snapshot updates. Used by tests and graceful
 * shutdown.
 */
export async function unsubscribeEloConfigChanges(): Promise<void> {
  if (!activeUnsubscribe) return;
  try {
    activeUnsubscribe();
  } finally {
    activeUnsubscribe = null;
  }
}

// ---------------------------------------------------------------------------
// Write (admin path)
// ---------------------------------------------------------------------------

/**
 * Persist a partial ELO config override to Firestore. The admin UI calls this
 * via the `/api/admin/elo/config` route.
 *
 * Applies the same partial to the in-memory singleton immediately so the
 * caller sees its own write reflected — the Firestore snapshot listener will
 * receive the same change moments later (idempotent re-apply).
 */
export async function persistEloConfigOverride(
  partial: Partial<EloConfig>,
  updatedBy: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Local apply first so the hot path reflects the admin change even if
  // Firestore write is briefly delayed (or test environment has no DB).
  applyPartialConfig(partial);

  const ref = getConfigDocRef();
  if (!ref) {
    return {
      ok: false,
      error: 'Firebase admin not ready — config change applied in-memory only.',
    };
  }

  try {
    // Read-modify-write to preserve existing Phase 1 fields (team baselines,
    // role K weights, etc.) — the admin UI currently only edits attribution
    // fields, but the persisted doc holds the full config.
    const existingSnap = await ref.get();
    const existing = existingSnap.exists
      ? ((existingSnap.data() as EloConfigDoc | undefined)?.config ?? null)
      : null;

    const merged: Partial<EloConfig> = {
      ...(existing ?? {}),
      ...partial,
      // Deep-merge attributionWeights so admins can tweak proposal without
      // wiping outerWhiteInnerBlack.
      ...(partial.attributionWeights
        ? {
            attributionWeights: {
              ...((existing ?? {}).attributionWeights ?? DEFAULT_ELO_CONFIG.attributionWeights),
              ...partial.attributionWeights,
            },
          }
        : {}),
    };

    const doc: EloConfigDoc = {
      config: merged,
      updatedAt: Date.now(),
      updatedBy,
    };
    await ref.set(doc);
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
 * fields are merged to prevent a malicious doc from injecting arbitrary keys.
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
  // malformed doc cannot flip shadow on/off accidentally.
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

// ---------------------------------------------------------------------------
// Back-compat aliases (preserve call sites during the Supabase → Firebase
// rewrite landing commit)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `loadEloConfigFromFirestore`. Retained so existing call
 * sites in `index.ts` and tests do not break during the rewrite; will be
 * removed once all callers are renamed.
 */
export const loadEloConfigFromSupabase = loadEloConfigFromFirestore;
