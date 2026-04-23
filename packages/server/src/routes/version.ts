/**
 * /api/version — Build version endpoint (P0 2026-04-23 guest connection stabilize)
 *
 * Returns the current server build identifier so the web client can detect
 * deploys and prompt users to refresh stale PWA/browser caches instead of
 * silently running an incompatible bundle.
 *
 * Build identifier resolution order (first hit wins):
 *   1. `BUILD_HASH` env var (set by CI / Render / Dockerfile)
 *   2. `RENDER_GIT_COMMIT` env var (Render auto-populates)
 *   3. `SOURCE_COMMIT` env var (Dockerfile convention)
 *   4. First 7 chars of `BUILD_TIMESTAMP` env var
 *   5. Server boot timestamp (dev fallback — stable for the process lifetime)
 *
 * Response shape (stable contract — do not break without coordinating a web
 * client release):
 *   {
 *     version: string,       // short hash or boot id, always present
 *     builtAt: string,       // ISO-8601 UTC, best-effort
 *     bootAt:  string,       // ISO-8601 UTC, process start time
 *   }
 *
 * Security: no credentials, env values, or PII leaked. Version string is
 * sanitized to alphanumerics + dash/underscore and truncated to 40 chars.
 */

import { Router, Request, Response, IRouter } from 'express';

const router: IRouter = Router();

// Process boot time is stable across all requests handled by this instance.
// Used as the ultimate fallback when no build metadata is available (dev mode).
const BOOT_AT = new Date().toISOString();

/** Sanitize build identifier to prevent header/log injection or oversized strings. */
function sanitizeVersion(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^a-zA-Z0-9_\-.]/g, '').slice(0, 40);
  return cleaned.length > 0 ? cleaned : null;
}

function resolveVersion(): { version: string; builtAt: string } {
  const envHash =
    sanitizeVersion(process.env.BUILD_HASH) ||
    sanitizeVersion(process.env.RENDER_GIT_COMMIT) ||
    sanitizeVersion(process.env.SOURCE_COMMIT);

  if (envHash) {
    const envBuiltAt = sanitizeVersion(process.env.BUILD_TIMESTAMP);
    return {
      version: envHash.slice(0, 12),
      builtAt: envBuiltAt ? new Date(Number(envBuiltAt) || envBuiltAt).toISOString() : BOOT_AT,
    };
  }

  // Dev fallback: use boot timestamp. Stable within a single `pnpm dev` run,
  // changes when the dev server restarts — useful for local HMR testing too.
  return {
    version: `dev-${BOOT_AT.replace(/[^0-9]/g, '').slice(0, 12)}`,
    builtAt: BOOT_AT,
  };
}

// Cache resolution for the process lifetime — the build hash never changes
// within a single running instance and the guest version-check poll runs once
// per minute per tab.
const CACHED = resolveVersion();

router.get('/version', (_req: Request, res: Response) => {
  // No-cache: the whole point of this endpoint is to detect new deploys, so
  // any intermediate proxy cache would defeat it.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({
    version: CACHED.version,
    builtAt: CACHED.builtAt,
    bootAt: BOOT_AT,
  });
});

export { router as versionRouter };
