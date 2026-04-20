// -- Supabase SQL to run manually:
// CREATE TABLE IF NOT EXISTS friendships (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//   following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   UNIQUE(follower_id, following_id)
// );
// CREATE INDEX ON friendships(follower_id);
// CREATE INDEX ON friendships(following_id);

import { Router, Request, Response, IRouter } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import {
  getSupabaseIdByFirebaseUid,
  isSupabaseReady,
  getFriends,
  followUser,
  unfollowUser,
  isFollowing,
  getSupabaseClient,
  searchUsers,
} from '../services/supabase';
import { createHttpRateLimit } from '../middleware/rateLimit';

const router: IRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET as string;

// Rate limiting: 60 requests/min per IP
const publicLimiter = createHttpRateLimit(60 * 1000, 60);

// ── Resolve supabase UUID from Authorization header (same pattern as api.ts) ──
async function resolveSupabaseId(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // Try custom JWT (Discord/Line: sub is the supabase UUID).
  // Guest JWT 也會 verify 成功但 sub 是 server-minted guest uuid（非 users.id），
  // 跳過以免把 guest 當成 Discord/Line 帳號查 friendships。
  try {
    const payload = verify(token, JWT_SECRET) as JwtPayload & { provider?: string };
    if (payload.sub && payload.provider !== 'guest') return payload.sub;
  } catch {
    // not a custom JWT, continue
  }

  // Try Firebase ID Token
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

// Helper: check user exists in Supabase
async function userExists(userId: string): Promise<boolean> {
  const db = getSupabaseClient();
  if (!db) return false;
  const { data } = await db.from('users').select('id').eq('id', userId).single();
  return !!data;
}

// ── GET /api/friends/search?q=<query> ─────────────────────────
// Search users by display_name (ILIKE) or UUID substring.
// Requires login; query <= 60 chars. Excludes self.
router.get('/search', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const supabaseId = await resolveSupabaseId(req.headers.authorization);
  if (!supabaseId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const raw = typeof req.query.q === 'string' ? req.query.q : '';
  const results = await searchUsers(raw, supabaseId, 20);
  return res.json({ results });
});

// ── GET /api/friends ──────────────────────────────────────────
// List users I follow (join friendships → users)
router.get('/', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const supabaseId = await resolveSupabaseId(req.headers.authorization);
  if (!supabaseId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const friends = await getFriends(supabaseId);
  return res.json({ friends });
});

// ── GET /api/friends/check/:targetUserId ─────────────────────
// Returns { following: boolean }
router.get('/check/:targetUserId', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const supabaseId = await resolveSupabaseId(req.headers.authorization);
  if (!supabaseId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { targetUserId } = req.params;
  const following = await isFollowing(supabaseId, targetUserId);
  return res.json({ following });
});

// ── POST /api/friends/:targetUserId ──────────────────────────
// Follow a user
router.post('/:targetUserId', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const supabaseId = await resolveSupabaseId(req.headers.authorization);
  if (!supabaseId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { targetUserId } = req.params;

  if (supabaseId === targetUserId) {
    return res.status(400).json({ error: 'Cannot follow yourself' });
  }

  const exists = await userExists(targetUserId);
  if (!exists) {
    return res.status(404).json({ error: 'User not found' });
  }

  await followUser(supabaseId, targetUserId);
  return res.json({ ok: true });
});

// ── DELETE /api/friends/:targetUserId ────────────────────────
// Unfollow a user
router.delete('/:targetUserId', publicLimiter, async (req: Request, res: Response) => {
  if (!isSupabaseReady()) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const supabaseId = await resolveSupabaseId(req.headers.authorization);
  if (!supabaseId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { targetUserId } = req.params;

  const exists = await userExists(targetUserId);
  if (!exists) {
    return res.status(404).json({ error: 'User not found' });
  }

  await unfollowUser(supabaseId, targetUserId);
  return res.json({ ok: true });
});

export { router as friendsRouter };
