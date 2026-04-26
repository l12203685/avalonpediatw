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
  getSeatOrderAnalysis,
  getCaptainAnalysis,
  getPlayerArchetype,
  getPlayerStrength,
  getPlayerPlaystyle,
  invalidateCache,
  isSheetsReady,
} from '../services/sheetsAnalysis';
import fs from 'fs';
import path from 'path';

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
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[analysis/overview]', msg, stack);
    return fail(res, 500, `Failed to load overview data: ${msg}`);
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
// GET /api/analysis/seat-order
// Percival/Merlin/Morgana seat order permutation analysis
// ---------------------------------------------------------------------------
router.get('/seat-order', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const seatOrder = await getSeatOrderAnalysis();
    return ok(res, seatOrder);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/seat-order]', msg);
    return fail(res, 500, 'Failed to load seat order analysis');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/captain
// Captain faction vs mission outcome analysis
// ---------------------------------------------------------------------------
router.get('/captain', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const captainData = await getCaptainAnalysis();
    return ok(res, captainData);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/captain]', msg);
    return fail(res, 500, 'Failed to load captain analysis');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/profile/:name/archetype
// Panel A — 4-axis archetype radar (誠實 / 一致 / 專精 / 浮動) + percentile
// `:name` = analysis-cache display name (e.g. "Sin", "HAO"). Resolve from the
// auth profile's display_name on the frontend before calling.
// ---------------------------------------------------------------------------
router.get('/profile/:name/archetype', limiter, async (req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const name = decodeURIComponent(req.params.name);
    const data = await getPlayerArchetype(name);
    if (!data) {
      return fail(res, 404, 'Player not tracked in analysis cache');
    }
    return ok(res, data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/profile/archetype]', msg);
    return fail(res, 500, 'Failed to load archetype');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/profile/:name/strength
// Panel B — Strength signature (per-role winrate × cohort z-score)
// ---------------------------------------------------------------------------
router.get('/profile/:name/strength', limiter, async (req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const name = decodeURIComponent(req.params.name);
    const data = await getPlayerStrength(name);
    if (!data) {
      return fail(res, 404, 'Player not tracked in analysis cache');
    }
    return ok(res, data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/profile/strength]', msg);
    return fail(res, 500, 'Failed to load strength signature');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/profile/:name/playstyle
// Panel C — 對戰風格快照 (R3+ 強硬度 / 刺客目標座位 / 隊長 stickiness)
// ---------------------------------------------------------------------------
router.get('/profile/:name/playstyle', limiter, async (req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const name = decodeURIComponent(req.params.name);
    const data = await getPlayerPlaystyle(name);
    if (!data) {
      return fail(res, 404, 'Player not tracked in analysis cache');
    }
    return ok(res, data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/profile/playstyle]', msg);
    return fail(res, 500, 'Failed to load playstyle snapshot');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/wiki
// Serve wiki articles from wiki_data.json
// ---------------------------------------------------------------------------
let wikiCache: unknown[] | null = null;

function loadWikiData(): unknown[] {
  if (wikiCache) return wikiCache;
  const wikiPaths = [
    path.resolve(__dirname, '..', '..', 'wiki_data.json'),
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'wiki_data.json'),
  ];
  for (const p of wikiPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      wikiCache = JSON.parse(raw) as unknown[];
      return wikiCache;
    }
  }
  return [];
}

router.get('/wiki', limiter, (_req: Request, res: Response) => {
  try {
    const articles = loadWikiData();
    return ok(res, { articles, total: articles.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/wiki]', msg);
    return fail(res, 500, 'Failed to load wiki data');
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
