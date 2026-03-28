import { Router, Request, Response, IRouter } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import {
  getLeaderboard,
  getDbUserProfile,
  getSupabaseIdByFirebaseUid,
  isSupabaseReady,
} from '../services/supabase';

const router: IRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'avalon-dev-secret-change-in-prod';

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
router.get('/leaderboard', async (_req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.json({ leaderboard: [], message: 'Database not configured' });
  }
  const leaderboard = await getLeaderboard(50);
  return res.json({ leaderboard });
});

// ── GET /api/profile/me ───────────────────────────────────────
router.get('/profile/me', async (req: Request, res: Response) => {
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
router.get('/profile/:id', async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const profile = await getDbUserProfile(req.params.id);
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  return res.json({ profile });
});

export { router as apiRouter };
