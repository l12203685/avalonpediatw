/**
 * daily-recompute.ts
 *
 * Phase 2c (2026-04-24): 每日全量重算 `computed_stats/{playerId}`.
 *
 * 原則：
 *   - 現場對局結束時已做該局玩家的增量重算（GameServer.persistGameToFirestore）.
 *   - 此腳本每日跑一次補全（防增量 skip / schema 變更）.
 *   - 冪等，可任意時機跑.
 *
 * 用法（cron / systemd timer / WSL task）:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *   pnpm tsx scripts/daily-recompute.ts
 *
 * Cron 建議（每日 03:00 +08，台北時區）:
 *   0 3 * * * cd /path/to/avalonpediatw && \
 *     FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *     pnpm tsx scripts/daily-recompute.ts >> /var/log/avalonpediatw/daily-recompute.log 2>&1
 *
 * TODO（Edward 2026-04-24 Phase 2c 延後）:
 *   - 部署到 Cloud Scheduler / Render cron job / WSL systemd timer；
 *     目前先留 script，由 ops 綁定排程.
 */

import * as admin from 'firebase-admin';
import { ComputedStatsRepositoryV2 } from '../packages/server/src/services/ComputedStatsRepositoryV2';

function ensureFirebase(): void {
  if (admin.apps.length > 0) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (sa) {
    const creds = JSON.parse(sa) as admin.ServiceAccount;
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    return;
  }
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

async function main(): Promise<void> {
  ensureFirebase();

  const t0 = Date.now();
  const repo = new ComputedStatsRepositoryV2();
  console.log('[daily-recompute] starting recomputeAll at', new Date().toISOString());

  const result = await repo.recomputeAll();

  const elapsedMs = Date.now() - t0;
  console.log('');
  console.log('====================================');
  console.log(' Daily recompute done');
  console.log('====================================');
  console.log(` players : ${result.players}`);
  console.log(` games   : ${result.games}`);
  console.log(` updated : ${result.updated}`);
  console.log(` elapsed : ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log('====================================');
}

main().catch((err) => {
  console.error('[daily-recompute] fatal:', err);
  process.exit(1);
});
