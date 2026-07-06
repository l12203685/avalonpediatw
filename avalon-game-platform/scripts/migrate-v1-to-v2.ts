/**
 * migrate-v1-to-v2.ts
 *
 * 掃 Firestore `games/` collection（V1 戰績）→ 用 `convertV1ToV2` 轉成 V2
 * → 寫 `games_v2/{gameId}`. 冪等（既存 V2 doc 不覆寫，除非 --overwrite）.
 *
 * Phase 2c (2026-04-24).
 *
 * Firebase auth:
 *   FIREBASE_SERVICE_ACCOUNT_JSON 或 GOOGLE_APPLICATION_CREDENTIALS
 *
 * CLI flags:
 *   --dry-run         只印不寫
 *   --limit N         只處理前 N 筆（無 --limit 則全部）
 *   --page-size N     每批讀 N 筆 V1（預設 500）
 *   --batch-size N    每批寫 N 筆 V2（預設 100，Firestore cap 500）
 *   --overwrite       覆寫已存在的 V2 doc（預設跳過）
 *   --start-after ID  從特定 gameId 後開始（支援 resume）
 *
 * 用法:
 *   pnpm tsx scripts/migrate-v1-to-v2.ts --dry-run --limit 10
 *   pnpm tsx scripts/migrate-v1-to-v2.ts
 */

import * as admin from 'firebase-admin';
import {
  convertV1ToV2,
  type V1GameRecordInput,
} from '../packages/shared/src/derived/v1ToV2Converter';
import type { GameRecordV2 } from '../packages/shared/src/types/game_v2';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Cli {
  dryRun: boolean;
  limit: number | null;
  pageSize: number;
  batchSize: number;
  overwrite: boolean;
  startAfter: string | null;
}

function parseCli(argv: string[]): Cli {
  const args = argv.slice(2);
  const cli: Cli = {
    dryRun: false,
    limit: null,
    pageSize: 500,
    batchSize: 100,
    overwrite: false,
    startAfter: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') cli.dryRun = true;
    else if (a === '--overwrite') cli.overwrite = true;
    else if (a.startsWith('--limit=')) cli.limit = parseNum(a.split('=')[1], null);
    else if (a === '--limit') cli.limit = parseNum(args[++i], null);
    else if (a.startsWith('--page-size=')) cli.pageSize = parseNum(a.split('=')[1], 500) ?? 500;
    else if (a === '--page-size') cli.pageSize = parseNum(args[++i], 500) ?? 500;
    else if (a.startsWith('--batch-size=')) cli.batchSize = parseNum(a.split('=')[1], 100) ?? 100;
    else if (a === '--batch-size') cli.batchSize = parseNum(args[++i], 100) ?? 100;
    else if (a.startsWith('--start-after=')) cli.startAfter = a.split('=')[1];
    else if (a === '--start-after') cli.startAfter = args[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: pnpm tsx scripts/migrate-v1-to-v2.ts [flags]
  --dry-run          do not write
  --limit N          cap total V1 docs processed
  --page-size N      Firestore read batch (default 500)
  --batch-size N     V2 write batch (default 100, Firestore cap 500)
  --overwrite        overwrite existing games_v2 docs
  --start-after ID   resume: start after this gameId (lexicographic)
`);
      process.exit(0);
    }
  }
  return cli;
}

function parseNum(raw: string | undefined, fallback: number | null): number | null {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------

function ensureFirebase(): admin.app.App {
  if (admin.apps.length > 0) return admin.app();
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (sa) {
    const creds = JSON.parse(sa) as admin.ServiceAccount;
    return admin.initializeApp({ credential: admin.credential.cert(creds) });
  }
  // falls back to GOOGLE_APPLICATION_CREDENTIALS
  return admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

// ---------------------------------------------------------------------------
// Core migration
// ---------------------------------------------------------------------------

interface MigrateStats {
  scanned: number;
  converted: number;
  written: number;
  skippedExisting: number;
  skippedBadShape: number;
  errors: number;
}

async function runMigration(cli: Cli): Promise<MigrateStats> {
  ensureFirebase();
  const firestore = admin.firestore();

  const stats: MigrateStats = {
    scanned: 0,
    converted: 0,
    written: 0,
    skippedExisting: 0,
    skippedBadShape: 0,
    errors: 0,
  };

  let lastDoc:
    | FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
    | null = null;

  // Start-after handling: bootstrap lastDoc from the provided gameId.
  if (cli.startAfter) {
    const startSnap = await firestore.collection('games').doc(cli.startAfter).get();
    if (startSnap.exists) {
      lastDoc = startSnap as FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>;
      console.log(`[resume] Starting after gameId=${cli.startAfter}`);
    } else {
      console.warn(`[resume] --start-after ${cli.startAfter} not found in games/, starting from beginning`);
    }
  }

  const writeBatchQueue: Array<{ id: string; v2: GameRecordV2 }> = [];

  async function flushBatch(): Promise<void> {
    if (writeBatchQueue.length === 0) return;
    if (cli.dryRun) {
      stats.written += writeBatchQueue.length;
      console.log(`[dry-run] would write ${writeBatchQueue.length} V2 records`);
      writeBatchQueue.length = 0;
      return;
    }
    const batch = firestore.batch();
    for (const item of writeBatchQueue) {
      const ref = firestore.collection('games_v2').doc(item.id);
      batch.set(ref, item.v2);
    }
    await batch.commit();
    stats.written += writeBatchQueue.length;
    console.log(`[write] committed batch of ${writeBatchQueue.length} (total written: ${stats.written})`);
    writeBatchQueue.length = 0;
  }

  // Pre-load existing V2 ids (so we can skip) — only once, lightweight id-only scan.
  const existingV2Ids = new Set<string>();
  if (!cli.overwrite) {
    const existingSnap = await firestore.collection('games_v2').select().get();
    for (const d of existingSnap.docs) existingV2Ids.add(d.id);
    console.log(`[scan] found ${existingV2Ids.size} existing games_v2 docs (will skip)`);
  }

  for (;;) {
    let q = firestore
      .collection('games')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(cli.pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      if (cli.limit !== null && stats.scanned >= cli.limit) break;
      stats.scanned += 1;

      const raw = doc.data() as Record<string, unknown>;
      const v1 = raw as unknown as V1GameRecordInput;

      // Shape sanity
      if (!v1 || typeof v1.gameId !== 'string' || !Array.isArray(v1.players)) {
        stats.skippedBadShape += 1;
        console.warn(`[skip] bad shape: ${doc.id}`);
        continue;
      }

      // Skip existing V2 doc unless overwrite
      if (!cli.overwrite && existingV2Ids.has(doc.id)) {
        stats.skippedExisting += 1;
        if (stats.scanned % 50 === 0) {
          console.log(`[scan ${stats.scanned}] skipped existing V2 doc ${doc.id}`);
        }
        continue;
      }

      let v2: GameRecordV2;
      try {
        v2 = convertV1ToV2(v1);
        stats.converted += 1;
      } catch (err) {
        stats.errors += 1;
        console.error(`[convert-error] ${doc.id}:`, err instanceof Error ? err.message : err);
        continue;
      }

      writeBatchQueue.push({ id: doc.id, v2 });
      if (writeBatchQueue.length >= cli.batchSize) {
        await flushBatch();
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1] ?? lastDoc;

    if (cli.limit !== null && stats.scanned >= cli.limit) break;
    if (snap.docs.length < cli.pageSize) break; // no more pages
  }

  await flushBatch();

  return stats;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const cli = parseCli(process.argv);
  console.log('[migrate-v1-to-v2] starting with', cli);

  const t0 = Date.now();
  const stats = await runMigration(cli);
  const elapsedMs = Date.now() - t0;

  console.log('');
  console.log('====================================');
  console.log(' V1 → V2 migration done');
  console.log('====================================');
  console.log(` scanned         : ${stats.scanned}`);
  console.log(` converted       : ${stats.converted}`);
  console.log(` written         : ${stats.written}${cli.dryRun ? ' (dry-run)' : ''}`);
  console.log(` skipped existing: ${stats.skippedExisting}`);
  console.log(` skipped bad     : ${stats.skippedBadShape}`);
  console.log(` errors          : ${stats.errors}`);
  console.log(` elapsed         : ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log('====================================');
}

main().catch((err) => {
  console.error('[migrate-v1-to-v2] fatal:', err);
  process.exit(1);
});
