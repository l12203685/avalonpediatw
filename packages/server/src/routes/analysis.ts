/**
 * Analysis API Routes
 *
 * Serves pre-computed Avalon game analysis data from Google Sheets.
 * All endpoints are public and read-only.
 */

import { Router, Request, Response, IRouter } from 'express';
import { createHttpRateLimit } from '../middleware/rateLimit';
import {
  getOverview,
  getAllPlayerStats,
  getPlayerByName,
  getChemistry,
  getMissionAnalysis,
  getLakeAnalysis,
  getRoundsAnalysis,
  invalidateCache,
  isSheetsReady,
} from '../services/sheetsAnalysis';

const router: IRouter = Router();

// Rate limiting: 60 requests/min per IP
const limiter = createHttpRateLimit(60 * 1000, 60);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function ok<T>(res: Response, data: T): Response {
  const body: ApiResponse<T> = { success: true, data };
  return res.json(body);
}

function fail(res: Response, status: number, message: string): Response {
  const body: ApiResponse<never> = { success: false, error: message };
  return res.status(status).json(body);
}

function sheetsGuard(res: Response): boolean {
  if (!isSheetsReady()) {
    fail(res, 503, 'Google Sheets credentials not configured');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/analysis/overview
// Total games, win rates, player count, top players
// ---------------------------------------------------------------------------
router.get('/overview', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const overview = await getOverview();
    return ok(res, overview);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/overview]', msg);
    return fail(res, 500, 'Failed to load overview data');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/players
// Per-player stats array
// ---------------------------------------------------------------------------
router.get('/players', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const players = await getAllPlayerStats();
    return ok(res, { players, total: players.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/players]', msg);
    return fail(res, 500, 'Failed to load player stats');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/players/:name
// Single player radar data
// ---------------------------------------------------------------------------
router.get('/players/:name', limiter, async (req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const player = await getPlayerByName(decodeURIComponent(req.params.name));
    if (!player) {
      return fail(res, 404, 'Player not found');
    }

    // Radar chart dimensions (matching Python radar chart)
    const radar = {
      winRate: player.winRate,
      redWinRate: player.redWin,
      blueMerlinProtect: player.blueMerlinAlive,
      roleTheory: player.roleTheory,
      positionTheory: player.positionTheory,
      redMerlinKillRate: player.redMerlinDead,
      experience: Math.min(player.totalGames / 10, 100),
    };

    return ok(res, { player, radar });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/players/:name]', msg);
    return fail(res, 500, 'Failed to load player data');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/chemistry
// Chemistry matrices (28 players)
// ---------------------------------------------------------------------------
router.get('/chemistry', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const chemistry = await getChemistry();
    return ok(res, chemistry);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/chemistry]', msg);
    return fail(res, 500, 'Failed to load chemistry data');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/missions
// Mission vote patterns, fail distributions
// ---------------------------------------------------------------------------
router.get('/missions', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const missions = await getMissionAnalysis();
    return ok(res, missions);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/missions]', msg);
    return fail(res, 500, 'Failed to load mission analysis');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/lake
// Lady of the Lake analysis data
// ---------------------------------------------------------------------------
router.get('/lake', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const lake = await getLakeAnalysis();
    return ok(res, lake);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/lake]', msg);
    return fail(res, 500, 'Failed to load lake analysis');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/rounds
// Round 1-1 and 1-2 branching data
// ---------------------------------------------------------------------------
router.get('/rounds', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const rounds = await getRoundsAnalysis();
    return ok(res, rounds);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/rounds]', msg);
    return fail(res, 500, 'Failed to load rounds analysis');
  }
});

// ---------------------------------------------------------------------------
// POST /api/analysis/cache/invalidate
// Admin-only: force cache refresh
// ---------------------------------------------------------------------------
router.post('/cache/invalidate', limiter, async (req: Request, res: Response) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return fail(res, 401, 'Unauthorized');
  }
  invalidateCache();
  return ok(res, { message: 'Cache invalidated' });
});

export { router as analysisRouter };
