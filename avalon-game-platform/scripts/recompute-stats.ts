/**
 * recompute-stats.ts
 *
 * 從 `games_v2/` 全量拉戰績 → 對每位玩家重算 computed_stats V2 → upsert `computed_stats/`.
 *
 * Edward 2026-04-24 Phase 2b wiring：
 *   - Replicates `ComputedStatsRepositoryV2.recomputeAll()` without going through
 *     `getAdminFirestore()` (which requires full `initializeFirebase()` with client SDK config).
 *   - Uses `admin.firestore()` default app directly with service account credentials.
 *
 * Firebase auth：
 *   FIREBASE_SERVICE_ACCOUNT_JSON 或 GOOGLE_APPLICATION_CREDENTIALS
 *
 * 用法：
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' pnpm tsx scripts/recompute-stats.ts
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import type {
  ComputedPlayerStatsV2,
  GameRecordV2,
  PlayerId,
} from '../packages/shared/src/types/game_v2';
import {
  collectAllPlayerIds,
  computePlayerStatsV2,
} from '../packages/shared/src/derived/gameMetrics';
import { SHEETS_UNKNOWN_PLAYER_ID } from '../packages/server/src/services/sheetsGameRecordParser';

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------

function initAdmin(): void {
  if (admin.apps.length > 0) return;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (serviceAccountJson) {
    const sa = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: projectId || sa.project_id,
    });
  } else if (credsPath) {
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const sa = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: projectId || sa.project_id,
    });
  } else {
    throw new Error(
      'No Firebase credentials found.\n' +
        'Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }
}

// ---------------------------------------------------------------------------
// Games loader (replicates `ComputedStatsRepositoryV2.loadAllGames`)
// ---------------------------------------------------------------------------

async function loadAllGames(
  firestore: admin.firestore.Firestore,
  pageSize: number,
): Promise<GameRecordV2[]> {
  const out: GameRecordV2[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData> | null = null;

  for (;;) {
    let query = firestore
      .collection('games_v2')
      .orderBy('playedAt', 'asc')
      .limit(pageSize);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      out.push(doc.data() as GameRecordV2);
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  return out;
}

/**
 * Firestore doc ID 不能含 `/`；`sheets:<名字>` 直接用，但把 `/` 替換掉。
 */
function encodeId(playerId: PlayerId): string {
  return playerId.replace(/\//g, '_');
}

async function main(): Promise<void> {
  initAdmin();
  const firestore = admin.firestore();

  console.log('[recompute] Loading all games from games_v2/...');
  const games = await loadAllGames(firestore, 500);
  console.log(`[recompute] Loaded ${games.length} games.`);

  // Edward 2026-04-24：`sheets:unknown` 是 aggregate fallback 偽 UUID，
  // 後端不算它的統計 / 不寫 computed_stats doc。前端排行榜有 filter 當防線。
  const playerIds = collectAllPlayerIds(games).filter(
    (pid) => pid !== SHEETS_UNKNOWN_PLAYER_ID,
  );
  console.log(`[recompute] Found ${playerIds.length} unique players (sheets:unknown skipped).`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  const collRef = firestore.collection('computed_stats');

  // Housekeeping: 刪除舊規則寫入過的 computed_stats/sheets:unknown 孤兒 doc（若有）
  try {
    const unknownRef = collRef.doc(encodeId(SHEETS_UNKNOWN_PLAYER_ID));
    const unknownSnap = await unknownRef.get();
    if (unknownSnap.exists) {
      await unknownRef.delete();
      console.log(`[recompute] Deleted orphan computed_stats/${SHEETS_UNKNOWN_PLAYER_ID} doc.`);
    }
  } catch (err) {
    console.error(
      `[recompute] Failed to cleanup unknown doc: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Batch writes for efficiency
  const BATCH_CAP = 400;
  let batch = firestore.batch();
  let inBatch = 0;

  async function flushBatch(): Promise<void> {
    if (inBatch === 0) return;
    try {
      await batch.commit();
      console.log(`  [batch] committed ${inBatch} player stats.`);
    } catch (err) {
      errors += inBatch;
      updated -= inBatch;
      console.error(
        `  [batch-error] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    batch = firestore.batch();
    inBatch = 0;
  }

  for (const pid of playerIds) {
    let stats: ComputedPlayerStatsV2;
    try {
      stats = computePlayerStatsV2(games, pid);
    } catch (err) {
      errors += 1;
      console.error(
        `  [compute-error] playerId=${pid} ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (stats.totalGames === 0) {
      skipped += 1;
      continue;
    }
    const ref = collRef.doc(encodeId(pid));
    batch.set(ref, stats);
    inBatch += 1;
    updated += 1;

    if (inBatch >= BATCH_CAP) {
      await flushBatch();
    }
  }
  await flushBatch();

  console.log(
    `[recompute] Done. players=${playerIds.length} games=${games.length} updated=${updated} skipped=${skipped} errors=${errors}`,
  );
}

main().catch((err: unknown) => {
  console.error('[recompute] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
