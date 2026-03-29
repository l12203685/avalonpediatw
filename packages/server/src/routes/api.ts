import { Router, Request, Response, IRouter } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import {
  getLeaderboard,
  getDbUserProfile,
  getSupabaseIdByFirebaseUid,
  getGameEvents,
  isSupabaseReady,
} from '../services/supabase';
import { SelfPlayEngine } from '../ai/SelfPlayEngine';
import { RandomAgent } from '../ai/RandomAgent';
import { HeuristicAgent } from '../ai/HeuristicAgent';
import { getSelfPlayStatus } from '../ai/SelfPlayScheduler';
import { createHttpRateLimit } from '../middleware/rateLimit';

const router: IRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'avalon-dev-secret-change-in-prod';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.warn('[SECURITY] JWT_SECRET not set — using insecure default. Set JWT_SECRET in environment!');
}

// Rate limiting: 60 requests/min per IP for public routes, 10/min for admin
const publicLimiter = createHttpRateLimit(60 * 1000, 60);
const adminLimiter  = createHttpRateLimit(60 * 1000, 10);

// ── 工具：從 Authorization header 解析 supabase UUID ─────────
// 支援 Firebase ID Token 和自訂 JWT（Discord/Line）
async function resolveSupabaseId(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // 嘗試自訂 JWT（Discord/Line：sub 就是 supabase UUID）
  try {
    const payload = verify(token, JWT_SECRET) as JwtPayload;
    if (payload.sub) return payload.sub;
  } catch {
    // not a custom JWT, continue
  }

  // 嘗試 Firebase ID Token
  if (isFirebaseAdminReady()) {
    try {
      const decoded = await verifyIdToken(token);
      return await getSupabaseIdByFirebaseUid(decoded.uid);
    } catch {
      // invalid token
    }
  }

  return null;
}

// ── GET /api/leaderboard ──────────────────────────────────────
router.get('/leaderboard', publicLimiter, async (_req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.json({ leaderboard: [], message: 'Database not configured' });
  }
  const leaderboard = await getLeaderboard(50);
  return res.json({ leaderboard });
});

// ── GET /api/profile/me ───────────────────────────────────────
router.get('/profile/me', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const supabaseId = await resolveSupabaseId(req.headers.authorization);
  if (!supabaseId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const profile = await getDbUserProfile(supabaseId);
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  return res.json({ profile });
});

// ── GET /api/profile/:id ──────────────────────────────────────
router.get('/profile/:id', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const profile = await getDbUserProfile(req.params.id);
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  return res.json({ profile });
});

// ── GET /api/replay/:roomId ───────────────────────────────────
router.get('/replay/:roomId', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const events = await getGameEvents(req.params.roomId);
  if (events.length === 0) {
    return res.status(404).json({ error: 'No events found for this room' });
  }
  return res.json({ room_id: req.params.roomId, events });
});

// ── POST /api/ai/selfplay ─────────────────────────────────────
// Admin-only endpoint to trigger self-play data generation
// Body: { playerCount?: 5-10, games?: 1-100, persist?: boolean }
router.post('/ai/selfplay', adminLimiter, async (req: Request, res: Response) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const playerCount = Math.min(10, Math.max(5, Number(req.body?.playerCount) || 5));
  const games       = Math.min(100, Math.max(1, Number(req.body?.games) || 10));
  const persist     = req.body?.persist !== false;
  const agentType   = req.body?.agentType === 'heuristic' ? 'heuristic' : 'random';

  try {
    const engine = new SelfPlayEngine();
    const agents = Array.from({ length: playerCount }, (_, i) =>
      agentType === 'heuristic'
        ? new HeuristicAgent(`AI-${i + 1}`)
        : new RandomAgent(`AI-${i + 1}`)
    );
    const stats = await engine.runBatch(agents, games, persist);
    return res.json({ ok: true, agentType, ...stats });
  } catch (err) {
    console.error('[ai/selfplay]', err);
    return res.status(500).json({ error: 'Self-play failed' });
  }
});

// ── GET /api/ai/stats ─────────────────────────────────────────
router.get('/ai/stats', publicLimiter, async (_req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.json({ message: 'Database not configured', totalGames: 0, totalEvents: 0 });
  }
  // Quick stats from game_events table
  const { getSupabaseClient } = await import('../services/supabase');
  const db = getSupabaseClient();
  if (!db) return res.json({ totalGames: 0, totalEvents: 0 });

  const { count: eventCount } = await db
    .from('game_events')
    .select('*', { count: 'exact', head: true });

  const { count: gameCount } = await db
    .from('game_events')
    .select('room_id', { count: 'exact', head: true })
    .like('room_id', 'AI-%');

  return res.json({
    totalEvents:   eventCount ?? 0,
    aiGames:       gameCount  ?? 0,
    message:       'AI self-play data stats',
    scheduler:     getSelfPlayStatus(),
  });
});

export { router as apiRouter };
