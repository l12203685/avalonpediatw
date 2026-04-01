/**
 * SelfPlayScheduler — Background self-play game generator
 *
 * Runs batches of AI self-play games periodically to accumulate
 * training data in the Supabase game_events table.
 *
 * Only runs when:
 * - Supabase is configured (SUPABASE_URL + SUPABASE_SERVICE_KEY set)
 * - NODE_ENV is production (or SELFPLAY_ENABLED=true for dev override)
 * - Not already running a batch
 */

import { SelfPlayEngine } from './SelfPlayEngine';
import { HeuristicAgent } from './HeuristicAgent';
import { isSupabaseReady } from '../services/supabase';

const INTERVAL_MS      = 30 * 60 * 1000; // 30 minutes between batches
const GAMES_PER_BATCH  = 5;               // games per batch (keeps each run short)
const PLAYER_COUNTS    = [5, 6, 7, 8];   // rotate through common player counts

let batchRunning = false;
let batchCount   = 0;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

async function runBatch(): Promise<void> {
  if (batchRunning || !isSupabaseReady()) return;

  batchRunning = true;
  const playerCount = PLAYER_COUNTS[batchCount % PLAYER_COUNTS.length];
  batchCount++;

  try {
    const engine = new SelfPlayEngine();
    const agents = Array.from({ length: playerCount }, (_, i) => new HeuristicAgent(`H-${i + 1}`));
    const stats  = await engine.runBatch(agents, GAMES_PER_BATCH, true);

    console.log(
      `[SelfPlay] batch #${batchCount} — ${playerCount}p × ${GAMES_PER_BATCH} games | ` +
      `good ${stats.goodWins}/${stats.total}, evil ${stats.evilWins}/${stats.total}, ` +
      `avgRounds ${stats.avgRounds}`
    );
  } catch (err) {
    console.error('[SelfPlay] batch error:', err);
  } finally {
    batchRunning = false;
  }
}

/**
 * Start the background scheduler.
 * Safe to call multiple times — only one scheduler runs at a time.
 */
export function startSelfPlayScheduler(): void {
  const enabled =
    process.env.SELFPLAY_ENABLED === 'true' ||
    process.env.NODE_ENV === 'production';

  if (!enabled || !isSupabaseReady()) {
    console.log('[SelfPlay] Scheduler disabled (set SELFPLAY_ENABLED=true or NODE_ENV=production with Supabase)');
    return;
  }

  if (schedulerTimer) return; // already running

  console.log(`[SelfPlay] Scheduler started — ${GAMES_PER_BATCH} games every ${INTERVAL_MS / 60000} min`);

  // Run first batch after a short delay to let the server warm up
  setTimeout(() => { runBatch().catch(() => {}); }, 60_000);

  schedulerTimer = setInterval(() => { runBatch().catch(() => {}); }, INTERVAL_MS);
}

/**
 * Stop the scheduler (for graceful shutdown / testing).
 */
export function stopSelfPlayScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[SelfPlay] Scheduler stopped');
  }
}

/** Returns current scheduler status (for health checks). */
export function getSelfPlayStatus(): { enabled: boolean; batchCount: number; batchRunning: boolean } {
  return { enabled: schedulerTimer !== null, batchCount, batchRunning };
}
