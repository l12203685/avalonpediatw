#!/usr/bin/env bash
# daily-recompute.sh — Phase 2c (2026-04-24)
#
# Thin shell wrapper for daily V2 computed_stats recompute.
# Cron: `0 3 * * * /path/to/avalonpediatw/scripts/daily-recompute.sh`
# Requires FIREBASE_SERVICE_ACCOUNT_JSON in env or an .env file sourced above.
#
# Exit non-zero on failure so cron can mail the admin.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${FIREBASE_SERVICE_ACCOUNT_JSON:-}" ] && [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  echo "ERROR: neither FIREBASE_SERVICE_ACCOUNT_JSON nor GOOGLE_APPLICATION_CREDENTIALS set" >&2
  exit 2
fi

pnpm tsx scripts/daily-recompute.ts
