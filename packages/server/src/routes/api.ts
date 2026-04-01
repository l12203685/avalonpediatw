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
import { getSelfPlayStatus, buildAgents } from '../ai/SelfPlayScheduler';
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
// Body: { playerCount?: 5-10, games?: 1-100, persist?: boolean, mode?: 'normal'|'hard'|'mixed'|'baseline' }
router.post('/ai/selfplay', adminLimiter, async (req: Request, res: Response) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const playerCount = Math.min(10, Math.max(5, Number(req.body?.playerCount) || 5));
  const games       = Math.min(100, Math.max(1, Number(req.body?.games) || 10));
  const persist     = req.body?.persist !== false;
  const validModes  = ['normal', 'hard', 'mixed', 'baseline'] as const;
  const mode        = validModes.includes(req.body?.mode) ? req.body.mode as typeof validModes[number] : 'normal';

  try {
    const engine = new SelfPlayEngine();
    const agents = buildAgents(playerCount, mode);
    const stats = await engine.runBatch(agents, games, persist);
    return res.json({ ok: true, mode, playerCount, ...stats });
  } catch (err) {
    console.error('[ai/selfplay]', err);
    return res.status(500).json({ error: 'Self-play failed' });
  }
});

// ── GET /api/ai/stats ─────────────────────────────────────────
router.get('/ai/stats', publicLimiter, async (_req: Request, res: Response) => {
  const defaultResponse = {
    totalGames: 0,
    goodWinRate: 0,
    evilWinRate: 0,
    avgRounds: 0,
    roleWinRates: {} as Record<string, { wins: number; total: number; rate: number }>,
    gamesLast7Days: [] as { date: string; count: number }[],
    playerCountBreakdown: {} as Record<string, number>,
    scheduler: getSelfPlayStatus(),
  };

  if (!isSupabaseReady()) {
    return res.json({ ...defaultResponse, message: 'Database not configured' });
  }

  const { getSupabaseClient } = await import('../services/supabase');
  const db = getSupabaseClient();
  if (!db) return res.json(defaultResponse);

  try {
    // ── 1. All AI game records (room_id starts with AI-) ──────────────────
    const { data: records } = await db
      .from('game_records')
      .select('room_id, role, team, won, player_count, created_at')
      .like('room_id', 'AI-%');

    const allRecords = (records ?? []) as {
      room_id: string;
      role: string;
      team: string;
      won: boolean;
      player_count: number;
      created_at: string;
    }[];

    // ── Unique games ───────────────────────────────────────────────────────
    const uniqueRooms = new Set(allRecords.map(r => r.room_id));
    const totalGames = uniqueRooms.size;

    // ── Good/Evil win rates ────────────────────────────────────────────────
    // Determine winner per room: find any record where won=true to learn which team won
    const roomWinTeam = new Map<string, string>();
    for (const r of allRecords) {
      if (r.won && !roomWinTeam.has(r.room_id)) {
        roomWinTeam.set(r.room_id, r.team);
      }
    }
    let goodWins = 0, evilWins = 0;
    for (const team of roomWinTeam.values()) {
      if (team === 'good') goodWins++;
      else if (team === 'evil') evilWins++;
    }
    const goodWinRate = totalGames > 0 ? Math.round((goodWins / totalGames) * 100) : 0;
    const evilWinRate = totalGames > 0 ? Math.round((evilWins / totalGames) * 100) : 0;

    // ── Average rounds per game (quest_resolved events) ───────────────────
    const { data: questEvents } = await db
      .from('game_events')
      .select('room_id')
      .like('room_id', 'AI-%')
      .eq('event_type', 'quest_resolved');

    const roundsPerRoom = new Map<string, number>();
    for (const ev of (questEvents ?? []) as { room_id: string }[]) {
      roundsPerRoom.set(ev.room_id, (roundsPerRoom.get(ev.room_id) ?? 0) + 1);
    }
    const totalRounds = [...roundsPerRoom.values()].reduce((a, b) => a + b, 0);
    const avgRounds = roundsPerRoom.size > 0
      ? Math.round((totalRounds / roundsPerRoom.size) * 10) / 10
      : 0;

    // ── Role win rates ─────────────────────────────────────────────────────
    const roleMap = new Map<string, { wins: number; total: number }>();
    for (const r of allRecords) {
      if (!roleMap.has(r.role)) roleMap.set(r.role, { wins: 0, total: 0 });
      const entry = roleMap.get(r.role)!;
      entry.total++;
      if (r.won) entry.wins++;
    }
    const roleWinRates: Record<string, { wins: number; total: number; rate: number }> = {};
    for (const [role, { wins, total }] of roleMap) {
      roleWinRates[role] = { wins, total, rate: total > 0 ? Math.round((wins / total) * 100) : 0 };
    }

    // ── Games per day for last 7 days ─────────────────────────────────────
    const roomDayMap = new Map<string, Set<string>>();
    for (const r of allRecords) {
      const d = new Date(r.created_at).toISOString().slice(0, 10);
      if (!roomDayMap.has(d)) roomDayMap.set(d, new Set());
      roomDayMap.get(d)!.add(r.room_id);
    }
    const now = new Date();
    const gamesLast7Days: { date: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      gamesLast7Days.push({ date: d, count: roomDayMap.get(d)?.size ?? 0 });
    }

    // ── Player count breakdown ─────────────────────────────────────────────
    const pcRoomMap = new Map<number, Set<string>>();
    for (const r of allRecords) {
      const pc = r.player_count;
      if (!pcRoomMap.has(pc)) pcRoomMap.set(pc, new Set());
      pcRoomMap.get(pc)!.add(r.room_id);
    }
    const playerCountBreakdown: Record<string, number> = {};
    for (const [pc, rooms] of pcRoomMap) {
      playerCountBreakdown[String(pc)] = rooms.size;
    }

    return res.json({
      totalGames,
      goodWinRate,
      evilWinRate,
      avgRounds,
      roleWinRates,
      gamesLast7Days,
      playerCountBreakdown,
      scheduler: getSelfPlayStatus(),
    });
  } catch (err) {
    console.error('[ai/stats]', err);
    return res.status(500).json({ error: 'Failed to fetch AI stats' });
  }
});

export { router as apiRouter };
