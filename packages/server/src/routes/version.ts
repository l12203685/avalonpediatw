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

/**
 * Best-effort parse of BUILD_TIMESTAMP env var into ISO-8601.
 *
 * Accepts:
 *   - ISO-8601 strings (e.g. "2026-04-25T10:35:53Z")
 *   - Unix epoch seconds or milliseconds (numeric string)
 *
 * Falls back to BOOT_AT when value is absent or unparseable, so a malformed
 * BUILD_TIMESTAMP env var never crashes the server at startup.
 *
 * NOTE: Do NOT pre-sanitize via sanitizeVersion() — that strips ISO-8601
 * separators (`:`, `Z`) and turns valid timestamps into garbage that
 * `new Date()` returns as Invalid Date, which then throws RangeError on
 * .toISOString(). Caused 14 failed Cloud Run deploys (revisions 00018-00027,
 * 2026-04-25). Validate the parse result instead of mangling input.
 */
function parseBuiltAt(raw: string | undefined): string {
  if (!raw) return BOOT_AT;

  // Reject obviously injection-y or oversized input before passing to Date()
  // to keep the same security posture sanitizeVersion gave us.
  if (raw.length > 64 || /[\r\n\t]/.test(raw)) return BOOT_AT;

  // Try epoch (seconds or ms) first when value is purely numeric.
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    // Heuristic: < 10^12 → seconds; >= 10^12 → ms.
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString();
    return BOOT_AT;
  }

  // Try string parse (ISO-8601, RFC 2822, etc).
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();
  return BOOT_AT;
}

function resolveVersion(): { version: string; builtAt: string } {
  const envHash =
    sanitizeVersion(process.env.BUILD_HASH) ||
    sanitizeVersion(process.env.RENDER_GIT_COMMIT) ||
    sanitizeVersion(process.env.SOURCE_COMMIT);

  if (envHash) {
    return {
      version: envHash.slice(0, 12),
      builtAt: parseBuiltAt(process.env.BUILD_TIMESTAMP),
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
