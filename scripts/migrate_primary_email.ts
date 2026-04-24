/**
 * migrate_primary_email.ts — UX Phase 1 backfill (2026-04-24)
 *
 * 目的：為既有 `auth_users` row 補齊 per-provider email 欄位 + 重算 primaryEmail：
 *
 *   - googleEmail   ← row.email 若 row 有 firebase_uid
 *   - discordEmail  ← row.email 若 row 有 discord_id（但沒 firebase_uid — 避免 Google 帳號 email 誤記到 discord）
 *   - lineEmail     ← row.email 若 row 有 line_id 且非 google/discord（通常 null）
 *   - emailOnly     ← row.primaryEmail 若 provider='password'（沒 OAuth 綁定時）
 *
 * 並用 getPrimaryEmail 規則（google > discord > emailOnly）重算 primaryEmail 寫回。
 *
 * 不覆蓋已有的 per-provider email 欄位（idempotent）。dry-run 預設只掃不寫。
 *
 * 使用方式：
 *   export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *   # or export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
 *
 *   npx tsx scripts/migrate_primary_email.ts --dry-run          # 只掃不寫
 *   npx tsx scripts/migrate_primary_email.ts                    # 正式寫
 *   npx tsx scripts/migrate_primary_email.ts --limit 50         # 只處理前 50 個 row
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';

interface AuthUserRow {
  // Identity fields
  firebase_uid?:  string | null;
  discord_id?:    string | null;
  line_id?:       string | null;
  provider?:      string;
  // Legacy + existing email fields
  email?:         string | null;
  primaryEmail?:  string;
  primaryEmailLower?: string;
  emailsVerified?: string[];
  // Per-provider email fields (backfill targets)
  googleEmail?:   string | null;
  discordEmail?:  string | null;
  lineEmail?:     string | null;
  emailOnly?:     string | null;
}

// ── Firebase Admin init ──────────────────────────────────────────────────────

function initAdmin(): void {
  if (admin.apps.length > 0) return;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else if (credsPath) {
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId:  projectId || serviceAccount.project_id,
    });
  } else {
    throw new Error(
      'No Firebase credentials found.\n' +
      'Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }
}

// ── Primary email computation (copy of firestoreAuthAccounts.getPrimaryEmail) ─

function getPrimaryEmail(user: AuthUserRow): string | null {
  const pick = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  return pick(user.googleEmail)
      ?? pick(user.discordEmail)
      ?? pick(user.emailOnly)
      ?? null;
}

// ── Per-row migration logic ──────────────────────────────────────────────────

interface MigrationPatch {
  googleEmail?:       string | null;
  discordEmail?:      string | null;
  lineEmail?:         string | null;
  emailOnly?:         string | null;
  primaryEmail?:      string;
  primaryEmailLower?: string;
  updatedAt?:         number;
}

/**
 * 算出要打的 patch；回傳空物件代表無變化。
 *
 * 規則：
 *   1. googleEmail 已有 → 保留，否則若 firebase_uid 存在 + email 有值 → 寫 email
 *   2. discordEmail 同上，以 discord_id + email 判斷
 *   3. lineEmail 同上（但 LINE email 通常 null，多半不會觸發）
 *   4. emailOnly 已有 → 保留；否則若 provider='password' + primaryEmail 有值 → 寫 primaryEmail
 *   5. 重算 primaryEmail；若不同則寫回
 *
 * 「legacy email 歸屬哪個 provider」採保守規則：
 *   - 只有 firebase_uid → googleEmail
 *   - 只有 discord_id → discordEmail
 *   - 只有 line_id → lineEmail
 *   - 多個同時有 → 按 google > discord > line 順序擇一（避免亂塞所有 slot）
 *   - 都沒有（password 帳號）→ 不寫 per-provider email
 */
function planPatch(row: AuthUserRow): MigrationPatch {
  const patch: MigrationPatch = {};
  const emailTrim = typeof row.email === 'string' && row.email.trim().length > 0
    ? row.email.trim()
    : null;

  const hasGoogle  = typeof row.firebase_uid === 'string' && row.firebase_uid.length > 0;
  const hasDiscord = typeof row.discord_id   === 'string' && row.discord_id.length   > 0;
  const hasLine    = typeof row.line_id      === 'string' && row.line_id.length      > 0;

  // Step 1-3: per-provider email backfill
  if (emailTrim) {
    if (hasGoogle && !row.googleEmail) {
      patch.googleEmail = emailTrim;
    } else if (hasDiscord && !hasGoogle && !row.discordEmail) {
      // 只有當沒 Google 時才把 legacy email 歸屬 discord（避免 Google 帳號 email 誤塞 discord）
      patch.discordEmail = emailTrim;
    } else if (hasLine && !hasGoogle && !hasDiscord && !row.lineEmail) {
      patch.lineEmail = emailTrim;
    }
  }

  // Step 4: emailOnly（純 email 帳號才寫）
  const isPassword = row.provider === 'password';
  if (isPassword && !row.emailOnly) {
    const primary = typeof row.primaryEmail === 'string' && row.primaryEmail.length > 0
      ? row.primaryEmail
      : null;
    if (primary) {
      patch.emailOnly = primary;
    }
  }

  // Step 5: 重算 primaryEmail — 合併 row 現有 + patch
  const merged: AuthUserRow = {
    googleEmail:  patch.googleEmail  ?? row.googleEmail  ?? null,
    discordEmail: patch.discordEmail ?? row.discordEmail ?? null,
    lineEmail:    patch.lineEmail    ?? row.lineEmail    ?? null,
    emailOnly:    patch.emailOnly    ?? row.emailOnly    ?? null,
  };
  const nextPrimary = getPrimaryEmail(merged);
  if (nextPrimary && nextPrimary !== row.primaryEmail) {
    patch.primaryEmail      = nextPrimary;
    patch.primaryEmailLower = nextPrimary.toLowerCase();
  }

  return patch;
}

// ── Runner ───────────────────────────────────────────────────────────────────

interface RunStats {
  scanned:     number;
  needsPatch:  number;
  patched:     number;
  skipped:     number;
  errors:      number;
}

async function run(dryRun: boolean, limit: number): Promise<RunStats> {
  initAdmin();
  const db = admin.firestore();
  const col = db.collection('auth_users');

  const snap = await col.get();
  console.log(`[migrate_primary_email] total auth_users: ${snap.size}`);

  const stats: RunStats = { scanned: 0, needsPatch: 0, patched: 0, skipped: 0, errors: 0 };

  let processed = 0;
  for (const doc of snap.docs) {
    if (processed >= limit) break;
    processed += 1;
    stats.scanned += 1;

    const row = (doc.data() ?? {}) as AuthUserRow;
    const patch = planPatch(row);
    const keys = Object.keys(patch);

    if (keys.length === 0) {
      stats.skipped += 1;
      continue;
    }

    stats.needsPatch += 1;

    console.log(`[migrate] ${doc.id} — patch: ${JSON.stringify(patch)}`);

    if (dryRun) continue;

    try {
      patch.updatedAt = Date.now();
      await doc.ref.update(patch as Record<string, unknown>);
      stats.patched += 1;
    } catch (err) {
      stats.errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] ${doc.id} write error: ${msg}`);
    }
  }

  return stats;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
migrate_primary_email.ts — backfill per-provider email + recompute primaryEmail

Usage:
  npx tsx scripts/migrate_primary_email.ts [--dry-run] [--limit N]

Flags:
  --dry-run    Scan + log planned patches, don't write.
  --limit N    Only process the first N rows (default: all).

Required env:
  FIREBASE_SERVICE_ACCOUNT_JSON  (raw JSON)
  or GOOGLE_APPLICATION_CREDENTIALS  (path to service account file)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 && args[limitIdx + 1]
    ? parseInt(args[limitIdx + 1], 10)
    : Infinity;

  console.log(`[migrate_primary_email] mode: ${dryRun ? 'DRY-RUN' : 'WRITE'}`);
  if (limit !== Infinity) {
    console.log(`[migrate_primary_email] limit: ${limit}`);
  }

  const stats = await run(dryRun, limit);
  console.log(`[migrate_primary_email] done:`, stats);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
