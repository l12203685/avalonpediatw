import { Router, Request, Response, IRouter } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import {
  getGameEvents,
  isSupabaseReady,
} from '../services/supabase';
import {
  getFirestoreLeaderboard,
  getFirestoreUserProfile,
} from '../services/FirestoreLeaderboard';
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

// ── 工具：從 Authorization header 解析玩家身份 ─────────────────
// 支援 Firebase ID Token、自訂 JWT（Discord/Line）、Guest JSON
// 回傳 { playerId, displayName?, provider? }，以便在 Firestore/Sheets 找不到記錄時
// 仍可回傳空 profile（顯示玩家名稱 + 零遊戲）。
interface ResolvedAuth {
  playerId: string;
  displayName?: string;
  provider?: string;
}

async function resolvePlayerAuth(authHeader: string | undefined): Promise<ResolvedAuth | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // 路徑 1：自訂 JWT（Discord/Line：sub 是 player ID）
  // 僅對看起來像 JWT 的 token（三段 dot-separated）才嘗試 JWT verify。
  const looksLikeJwt = typeof token === 'string' && token.split('.').length === 3;
  if (looksLikeJwt) {
    try {
      const payload = verify(token, JWT_SECRET) as JwtPayload & {
        sub?: string;
        displayName?: string;
        provider?: string;
      };
      if (payload.sub) {
        return {
          playerId:    payload.sub,
          displayName: payload.displayName,
          provider:    payload.provider,
        };
      }
    } catch {
      // not a custom JWT, continue
    }

    // 路徑 2：Firebase ID Token → uid 就是 playerId
    if (isFirebaseAdminReady()) {
      try {
        const decoded = await verifyIdToken(token);
        return {
          playerId:    decoded.uid,
          displayName: decoded.name || (decoded.email?.split('@')[0] ?? undefined),
          provider:    'google',
        };
      } catch {
        // invalid token
      }
    }
  }

  // 路徑 3：Guest JSON { uid, displayName }
  try {
    const parsed = JSON.parse(token) as { uid?: string; displayName?: string };
    if (parsed.uid) {
      return {
        playerId:    parsed.uid,
        displayName: parsed.displayName || 'Guest',
        provider:    'guest',
      };
    }
  } catch {
    // not JSON, give up
  }

  return null;
}

/** @deprecated 保留以防其他呼叫者，內部改用 resolvePlayerAuth */
async function resolvePlayerId(authHeader: string | undefined): Promise<string | null> {
  const auth = await resolvePlayerAuth(authHeader);
  return auth?.playerId ?? null;
}
void resolvePlayerId;

/** 建立空 profile（新登入但尚無遊戲記錄的玩家） */
function emptyProfile(auth: ResolvedAuth): {
  id: string;
  display_name: string;
  photo_url: null;
  provider: string;
  elo_rating: number;
  total_games: number;
  games_won: number;
  games_lost: number;
  badges: string[];
  recent_games: [];
} {
  return {
    id:           auth.playerId,
    display_name: auth.displayName || auth.playerId,
    photo_url:    null,
    provider:     auth.provider || 'guest',
    elo_rating:   1000,
    total_games:  0,
    games_won:    0,
    games_lost:   0,
    badges:       [],
    recent_games: [],
  };
}

// ── GET /api/leaderboard ──────────────────────────────────────
router.get('/leaderboard', publicLimiter, async (_req: Request, res: Response) => {
  try {
    const leaderboard = await getFirestoreLeaderboard(50);
    return res.json({ leaderboard });
  } catch (err) {
    console.error('[api/leaderboard] Firestore error:', err);
    return res.json({ leaderboard: [], message: 'Database not configured' });
  }
});

// ── GET /api/profile/me ───────────────────────────────────────
router.get('/profile/me', publicLimiter, async (req: Request, res: Response) => {
  // Resolve player from auth token
  const auth = await resolvePlayerAuth(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    // 先用 playerId 試查
    let profile = await getFirestoreUserProfile(auth.playerId);
    // 若找不到，再嘗試用 displayName 查（Firestore games 有時用 display name 當 playerId）
    if (!profile && auth.displayName) {
      profile = await getFirestoreUserProfile(auth.displayName);
    }
    // 仍找不到 → 回空 profile（新玩家尚無遊戲記錄）
    if (!profile) {
      return res.json({ profile: emptyProfile(auth) });
    }
    return res.json({ profile });
  } catch (err) {
    console.error('[api/profile/me] Firestore error:', err);
    // 退化成空 profile 而非 503，避免個人資料頁整個壞掉
    return res.json({ profile: emptyProfile(auth) });
  }
});

// ── GET /api/profile/:id ──────────────────────────────────────
router.get('/profile/:id', publicLimiter, async (req: Request, res: Response) => {
  try {
    const profile = await getFirestoreUserProfile(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    return res.json({ profile });
  } catch (err) {
    console.error('[api/profile] Firestore error:', err);
    return res.status(503).json({ error: 'Database not configured' });
  }
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
