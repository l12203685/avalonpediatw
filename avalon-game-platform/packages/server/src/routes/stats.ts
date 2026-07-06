/**
 * Stats API Routes — 追蹤對戰統計（Watchlist Matchups）
 *
 * 2026-04-23 #98 IA 重整：個人戰績頁瘦身，追蹤列表顯示每個追蹤對象的
 *   - 同贏率: 我贏的場次中，對方同場的比例
 *   - 同敗率: 我輸的場次中，對方同場的比例
 *   - 獨立勝率: 我「不與對方同場」的那批場次中的勝率（= 排除同場後的理論勝率）
 *
 * 純讀 Firestore games 集合，算給前端；不動任何寫入路徑。
 */
import { Router, Request, Response, IRouter } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady } from '../services/firebase';
import { verifyGuestToken } from '../middleware/guestAuth';
import { getSupabaseIdByFirebaseUid } from '../services/supabase';
import { GameHistoryRepository } from '../services/GameHistoryRepository';
import { createHttpRateLimit } from '../middleware/rateLimit';

const router: IRouter = Router();
const JWT_SECRET = process.env.JWT_SECRET as string;

const limiter = createHttpRateLimit(60 * 1000, 60);

// ── Resolve self identity from Authorization header ───────────────────────────
// Downstream callers (GameHistoryRepository.listPlayerGames / pair / pair-batch
// / timeline) key on the Supabase `users.id` UUID. Google-login users' Bearer
// token becomes a Firebase ID token on socket reconnect (see
// `packages/web/src/services/socket.ts` reconnect_attempt handler), so the raw
// Firebase uid MUST be mapped back to a Supabase UUID or their stats pages
// render blank. Mirrors the pattern used in `routes/friends.ts:60-61`.
async function resolveSelfId(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const looksLikeJwt = typeof token === 'string' && token.split('.').length === 3;
  if (looksLikeJwt) {
    // Path 1: custom JWT (password / Discord / LINE) — `sub` is already the
    // Supabase UUID. Guest JWTs verify too but carry a non-users.id sub, so
    // we skip them here and let the guest fallback below handle them.
    try {
      const payload = verify(token, JWT_SECRET) as JwtPayload & { sub?: string; provider?: string };
      if (payload.sub && payload.provider !== 'guest') return payload.sub;
    } catch {
      /* not a custom JWT */
    }
    // Path 2: Firebase ID token (Google / Email) — map firebase_uid → Supabase
    // UUID via the `users.firebase_uid` column. Returns null when no mapping
    // exists (e.g. Firebase user that was never upserted into Supabase).
    if (isFirebaseAdminReady()) {
      try {
        const decoded = await verifyIdToken(token);
        return await getSupabaseIdByFirebaseUid(decoded.uid);
      } catch {
        /* invalid */
      }
    }
  }
  const guest = verifyGuestToken(token);
  if (guest) return guest.uid;
  return null;
}

export interface PairStats {
  /** 對戰對象 user id */
  opponentId: string;
  /** 我的總場次 */
  totalGames: number;
  /** 我與對方同場的場次 */
  sharedGames: number;
  /** 我贏的場次 */
  myWins: number;
  /** 我贏的場次中，對方同場的比例 (0-100) */
  sameWinRate: number;
  /** 我輸的場次中，對方同場的比例 (0-100) */
  sameLossRate: number;
  /**
   * 獨立勝率 (0-100): 我「不與對方同場」的那批場次中的勝率。
   * 排除同場 → 理論上自己一個人的勝率基線。
   * 若 totalGames === sharedGames (沒有獨立場次) → null。
   */
  independentWinRate: number | null;
}

const repo = new GameHistoryRepository();

// ── GET /api/stats/pair/:opponentId ──────────────────────────
// Header: Authorization: Bearer <token>
// 回傳我 (auth) vs opponentId 的同贏率 / 同敗率 / 獨立勝率。
router.get('/pair/:opponentId', limiter, async (req: Request, res: Response) => {
  const selfId = await resolveSelfId(req.headers.authorization);
  if (!selfId) return res.status(401).json({ error: 'Unauthorized' });

  const opponentId = decodeURIComponent(req.params.opponentId || '');
  if (!opponentId || opponentId === selfId) {
    return res.status(400).json({ error: 'Invalid opponentId' });
  }

  try {
    // 拉我近 200 場（覆蓋絕大多數玩家歷史；超過再分頁 later）
    const myGames = await repo.listPlayerGames(selfId, 200);

    let totalGames = 0;
    let myWins = 0;
    let sharedGames = 0;
    let sharedMyWins = 0;
    let sharedMyLosses = 0;
    let indepGames = 0;
    let indepWins = 0;

    for (const g of myGames) {
      const mySlot = g.players.find(p => p.playerId === selfId);
      if (!mySlot) continue;
      totalGames += 1;
      const iWon = mySlot.won === true;
      if (iWon) myWins += 1;

      const opponentShared = g.players.some(p => p.playerId === opponentId);
      if (opponentShared) {
        sharedGames += 1;
        if (iWon) sharedMyWins += 1;
        else sharedMyLosses += 1;
      } else {
        indepGames += 1;
        if (iWon) indepWins += 1;
      }
    }

    const myLosses = totalGames - myWins;
    const sameWinRate  = myWins   > 0 ? (sharedMyWins   / myWins)   * 100 : 0;
    const sameLossRate = myLosses > 0 ? (sharedMyLosses / myLosses) * 100 : 0;
    const independentWinRate = indepGames > 0 ? (indepWins / indepGames) * 100 : null;

    const pair: PairStats = {
      opponentId,
      totalGames,
      sharedGames,
      myWins,
      sameWinRate:  Math.round(sameWinRate  * 10) / 10,
      sameLossRate: Math.round(sameLossRate * 10) / 10,
      independentWinRate: independentWinRate === null
        ? null
        : Math.round(independentWinRate * 10) / 10,
    };
    return res.json({ pair });
  } catch (err) {
    console.error('[stats/pair] error', err);
    return res.status(500).json({ error: 'Failed to compute pair stats' });
  }
});

// ── GET /api/stats/pair-batch?ids=a,b,c ───────────────────────
// 同時查多個追蹤對象；只掃一次 my games，省 Firestore 讀。
router.get('/pair-batch', limiter, async (req: Request, res: Response) => {
  const selfId = await resolveSelfId(req.headers.authorization);
  if (!selfId) return res.status(401).json({ error: 'Unauthorized' });

  const raw = (req.query.ids as string) || '';
  const ids = raw.split(',').map(x => x.trim()).filter(x => x && x !== selfId);
  if (ids.length === 0) return res.json({ pairs: [] as PairStats[] });
  if (ids.length > 50) {
    return res.status(400).json({ error: 'Too many ids (max 50 per request)' });
  }

  try {
    const myGames = await repo.listPlayerGames(selfId, 200);

    let totalGames = 0;
    let myWins = 0;
    // per-opponent accumulators
    const shared = new Map<string, { games: number; myWins: number; myLosses: number }>();
    ids.forEach(id => shared.set(id, { games: 0, myWins: 0, myLosses: 0 }));

    for (const g of myGames) {
      const mySlot = g.players.find(p => p.playerId === selfId);
      if (!mySlot) continue;
      totalGames += 1;
      const iWon = mySlot.won === true;
      if (iWon) myWins += 1;

      const opponentIdsInGame = new Set(g.players.map(p => p.playerId));
      for (const oppId of ids) {
        if (!opponentIdsInGame.has(oppId)) continue;
        const rec = shared.get(oppId)!;
        rec.games += 1;
        if (iWon) rec.myWins += 1; else rec.myLosses += 1;
      }
    }

    const myLosses = totalGames - myWins;
    const pairs: PairStats[] = ids.map(oppId => {
      const s = shared.get(oppId)!;
      const indepGames = totalGames - s.games;
      const indepWins  = myWins - s.myWins;
      const sameWinRate  = myWins   > 0 ? (s.myWins   / myWins)   * 100 : 0;
      const sameLossRate = myLosses > 0 ? (s.myLosses / myLosses) * 100 : 0;
      const independentWinRate = indepGames > 0 ? (indepWins / indepGames) * 100 : null;
      return {
        opponentId: oppId,
        totalGames,
        sharedGames: s.games,
        myWins,
        sameWinRate:  Math.round(sameWinRate  * 10) / 10,
        sameLossRate: Math.round(sameLossRate * 10) / 10,
        independentWinRate: independentWinRate === null
          ? null
          : Math.round(independentWinRate * 10) / 10,
      };
    });

    return res.json({ pairs });
  } catch (err) {
    console.error('[stats/pair-batch] error', err);
    return res.status(500).json({ error: 'Failed to compute pair-batch stats' });
  }
});

// ── GET /api/stats/timeline?limit=50 ──────────────────────────
// 近 N 場 (預設 50) 的勝敗時間序列 — 給個人戰績頁畫 sparkline 用。
router.get('/timeline', limiter, async (req: Request, res: Response) => {
  const selfId = await resolveSelfId(req.headers.authorization);
  if (!selfId) return res.status(401).json({ error: 'Unauthorized' });

  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 200
    ? Math.floor(rawLimit)
    : 50;

  try {
    const games = await repo.listPlayerGames(selfId, limit);
    const timeline = games.map(g => {
      const mySlot = g.players.find(p => p.playerId === selfId);
      return {
        gameId: g.gameId,
        endedAt: g.endedAt,
        won: mySlot?.won === true,
        playerCount: g.playerCount,
        winner: g.winner,
        role: mySlot?.role ?? null,
        team: mySlot?.team ?? null,
      };
    });
    return res.json({ timeline });
  } catch (err) {
    console.error('[stats/timeline] error', err);
    return res.status(500).json({ error: 'Failed to load timeline' });
  }
});

export { router as statsRouter };
