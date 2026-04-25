/**
 * /api/health/deep — Dependency probe endpoint (Plan v2 R0-C)
 *
 * Checks four downstream services in parallel with a 2-second timeout each:
 *   • Supabase   — SELECT 1 via REST
 *   • Firestore  — list a single document in the `games` collection
 *   • Sheets     — cache file readability (static-cache model; no live API call)
 *   • Firebase Auth (Admin SDK) — listUsers(1) to confirm credential validity
 *
 * Response shape:
 *   {
 *     overall:  "ok" | "degraded" | "down",
 *     services: {
 *       supabase:     { ok: boolean, latency_ms: number, error?: string },
 *       firestore:    { ok: boolean, latency_ms: number, error?: string },
 *       sheets:       { ok: boolean, latency_ms: number, error?: string },
 *       firebaseAuth: { ok: boolean, latency_ms: number, error?: string },
 *     },
 *     ts: string  // ISO-8601 UTC
 *   }
 *
 * Security: no credentials, tokens, or PII are ever included in the response.
 * Isolation: this endpoint is intentionally NOT wired to Render's liveness path
 * (/health). A degraded response here should not kill the container.
 */

import { Router, Request, Response, IRouter } from 'express';
import { getSupabaseClient, isSupabaseReady } from '../services/supabase';
import { isFirebaseAdminReady, getAdminAuth, getAdminFirestore } from '../services/firebase';
import { isSheetsReady } from '../services/sheetsAnalysis';

const router: IRouter = Router();

const PROBE_TIMEOUT_MS = 2000;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Resolve or reject after `ms` ms — used to race against a slow probe. */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
  );
}

interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

/** Wrap a probe fn; absorbs throws and enforces PROBE_TIMEOUT_MS. */
async function probe(fn: () => Promise<void>): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await Promise.race([fn(), timeout(PROBE_TIMEOUT_MS)]);
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Strip any potential credential leakage (URLs, keys) — keep only the short reason.
    const safeMsg = msg.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 120);
    return { ok: false, latency_ms: Date.now() - start, error: safeMsg };
  }
}

// ── Probes ─────────────────────────────────────────────────────────────────

async function probeSupabase(): Promise<void> {
  if (!isSupabaseReady()) throw new Error('not configured');
  const db = getSupabaseClient();
  if (!db) throw new Error('client unavailable');
  // Lightest possible read: single row from a system table equivalent
  const { error } = await db.from('users').select('id').limit(1);
  if (error) throw new Error(error.message);
}

async function probeFirestore(): Promise<void> {
  if (!isFirebaseAdminReady()) throw new Error('admin sdk not initialised');
  const fs = getAdminFirestore();
  // Fetch at most one document — avoids reading any game data
  await fs.collection('games').limit(1).get();
}

async function probeSheets(): Promise<void> {
  // sheetsAnalysis uses a pre-generated static cache file.
  // isSheetsReady() attempts to load + parse it — sufficient as a liveness check.
  if (!isSheetsReady()) throw new Error('cache file missing or unreadable');
}

async function probeFirebaseAuth(): Promise<void> {
  if (!isFirebaseAdminReady()) throw new Error('admin sdk not initialised');
  // listUsers(1) is the cheapest Admin Auth call — confirms credential validity
  await getAdminAuth().listUsers(1);
}

// ── Route ──────────────────────────────────────────────────────────────────

router.get('/health/deep', async (_req: Request, res: Response) => {
  const [supabase, firestore, sheets, firebaseAuth] = await Promise.allSettled([
    probe(probeSupabase),
    probe(probeFirestore),
    probe(probeSheets),
    probe(probeFirebaseAuth),
  ]);

  const extract = (r: PromiseSettledResult<ProbeResult>): ProbeResult =>
    r.status === 'fulfilled'
      ? r.value
      : { ok: false, latency_ms: 0, error: 'probe threw unexpectedly' };

  const services = {
    supabase:     extract(supabase),
    firestore:    extract(firestore),
    sheets:       extract(sheets),
    firebaseAuth: extract(firebaseAuth),
  };

  const allOk      = Object.values(services).every(s => s.ok);
  const noneOk     = Object.values(services).every(s => !s.ok);
  const overall    = allOk ? 'ok' : noneOk ? 'down' : 'degraded';

  // HTTP 200 even when degraded/down — Render must not kill the container based
  // on this endpoint. Callers inspect `overall` to determine action.
  res.status(200).json({ overall, services, ts: new Date().toISOString() });
});

export { router as healthDeepRouter };
