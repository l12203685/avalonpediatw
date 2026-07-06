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
import { RandomAgent } from './RandomAgent';
import { AvalonAgent } from './types';
import { isSupabaseReady } from '../services/supabase';

const INTERVAL_MS     = 30 * 60 * 1000; // 30 minutes between batches
const GAMES_PER_BATCH = 5;               // games per batch (keeps each run short)

// Rotate through player counts and population configs for diverse training data
const BATCH_CONFIGS: Array<{ playerCount: number; mode: 'normal' | 'hard' | 'mixed' | 'baseline' }> = [
  { playerCount: 5,  mode: 'normal'   },
  { playerCount: 6,  mode: 'hard'     },
  { playerCount: 7,  mode: 'mixed'    },
  { playerCount: 8,  mode: 'normal'   },
  { playerCount: 5,  mode: 'baseline' }, // heuristic vs random for baseline comparison
  { playerCount: 9,  mode: 'hard'     },
  { playerCount: 10, mode: 'mixed'    },
  { playerCount: 6,  mode: 'baseline' },
];

function buildAgents(playerCount: number, mode: typeof BATCH_CONFIGS[0]['mode']): AvalonAgent[] {
  return Array.from({ length: playerCount }, (_, i) => {
    switch (mode) {
      case 'hard':
        return new HeuristicAgent(`H-${i + 1}`, 'hard');
      case 'mixed':
        // Alternate hard/normal heuristic agents
        return new HeuristicAgent(`H-${i + 1}`, i % 2 === 0 ? 'hard' : 'normal');
      case 'baseline':
        // Even-indexed = heuristic normal, odd-indexed = random (for win-rate baseline)
        return i % 2 === 0
          ? new HeuristicAgent(`H-${i + 1}`, 'normal')
          : new RandomAgent(`R-${i + 1}`);
      default: // 'normal'
        return new HeuristicAgent(`H-${i + 1}`, 'normal');
    }
  });
}

let batchRunning = false;
let batchCount   = 0;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

async function runBatch(): Promise<void> {
  if (batchRunning || !isSupabaseReady()) return;

  batchRunning = true;
  const config = BATCH_CONFIGS[batchCount % BATCH_CONFIGS.length];
  batchCount++;

  try {
    const engine = new SelfPlayEngine();
    const agents = buildAgents(config.playerCount, config.mode);
    const stats  = await engine.runBatch(agents, GAMES_PER_BATCH, true);

    console.log(
      `[SelfPlay] batch #${batchCount} — ${config.playerCount}p×${GAMES_PER_BATCH} [${config.mode}] | ` +
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
export function getSelfPlayStatus(): { enabled: boolean; batchCount: number; batchRunning: boolean; nextConfig: typeof BATCH_CONFIGS[0] } {
  return {
    enabled:    schedulerTimer !== null,
    batchCount,
    batchRunning,
    nextConfig: BATCH_CONFIGS[batchCount % BATCH_CONFIGS.length],
  };
}

/** Exposed for external use (admin API) */
export { buildAgents, BATCH_CONFIGS };
