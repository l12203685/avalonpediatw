import { Router, Request, Response } from 'express';
import { getLeaderboard, getFullUserProfile } from '../services/firebase';
import { requireAuth, optionalAuth } from '../middleware/httpAuth';
import { RoomManager } from '../game/RoomManager';
import { Room } from '@avalon/shared';
import { GameHistoryRepository } from '../services/GameHistoryRepository';
import { getWikiContent } from '../services/WikiContentLoader';
import { EloRankingService } from '../services/EloRanking';
import { ReplayService } from '../services/ReplayService';
import { GameAnalytics } from '../services/GameAnalytics';

export function createApiRouter(roomManager: RoomManager): Router {
  const router = Router();
  const gameHistory = new GameHistoryRepository();
  const eloRanking = new EloRankingService();
  const replayService = new ReplayService();
  const analytics = new GameAnalytics();

  /**
   * GET /api/leaderboard
   * Returns top 50 players sorted by ELO rating.
   * Optional ?limit=N to cap results (max 100).
   */
  router.get('/leaderboard', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const entries = await getLeaderboard(limit);
      res.json({ leaderboard: entries });
    } catch (err) {
      console.error('Leaderboard error:', err);
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  /**
   * GET /api/profile/me
   * Returns the authenticated user's full profile + stats.
   * Requires Bearer token.
   */
  router.get('/profile/me', requireAuth, async (req: Request, res: Response) => {
    try {
      const profile = await getFullUserProfile(req.uid!);
      if (!profile) {
        res.status(404).json({ error: 'Profile not found' });
        return;
      }
      res.json({ profile });
    } catch (err) {
      console.error('Profile/me error:', err);
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  });

  /**
   * GET /api/profile/:id
   * Returns a public profile by Firebase UID.
   */
  router.get('/profile/:id', optionalAuth, async (req: Request, res: Response) => {
    try {
      const profile = await getFullUserProfile(req.params.id);
      if (!profile) {
        res.status(404).json({ error: 'Profile not found' });
        return;
      }
      res.json({ profile });
    } catch (err) {
      console.error('Profile/:id error:', err);
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  });

  /**
   * GET /api/replay/:roomId
   * Returns the final state of a completed room (replay snapshot).
   * Active rooms are not returned.
   */
  router.get('/replay/:roomId', async (req: Request, res: Response) => {
    const snapshot = roomManager.getReplay(req.params.roomId);
    if (!snapshot) {
      res.status(404).json({ error: 'Replay not found' });
      return;
    }
    res.json({ replay: snapshot });
  });

  /**
   * GET /api/rooms
   * Returns currently active (non-ended) lobby rooms.
   */
  router.get('/rooms', (_req: Request, res: Response) => {
    const rooms = roomManager.getAllRooms().filter((r: Room) => r.state !== 'ended');
    res.json({
      rooms: rooms.map((r: Room) => ({
        id: r.id,
        name: r.name,
        host: r.host,
        state: r.state,
        playerCount: Object.keys(r.players).length,
        maxPlayers: r.maxPlayers,
        createdAt: r.createdAt,
      })),
    });
  });

  /**
   * GET /api/games/recent
   * Returns recent completed games from Firestore.
   * Optional ?limit=N (max 50).
   */
  router.get('/games/recent', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const games = await gameHistory.listRecentGames(limit);
      res.json({ games });
    } catch (err) {
      console.error('Recent games error:', err);
      res.status(500).json({ error: 'Failed to fetch recent games' });
    }
  });

  /**
   * GET /api/games/:gameId
   * Returns a single completed game record from Firestore.
   */
  router.get('/games/:gameId', async (req: Request, res: Response) => {
    try {
      const record = await gameHistory.getGameRecord(req.params.gameId);
      if (!record) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }
      res.json({ game: record });
    } catch (err) {
      console.error('Game record error:', err);
      res.status(500).json({ error: 'Failed to fetch game record' });
    }
  });

  /**
   * GET /api/games/player/:playerId
   * Returns game history for a specific player.
   * Optional ?limit=N (max 50).
   */
  router.get('/games/player/:playerId', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const games = await gameHistory.listPlayerGames(req.params.playerId, limit);
      res.json({ games });
    } catch (err) {
      console.error('Player games error:', err);
      res.status(500).json({ error: 'Failed to fetch player games' });
    }
  });

  /**
   * GET /api/wiki
   * Returns all wiki categories and articles.
   * Loads from GDrive markdown if WIKI_CONTENT_DIR is set, otherwise returns empty.
   * Optional ?force=1 to bypass cache.
   * Optional ?category=<categoryId> to filter articles.
   */
  router.get('/wiki', (req: Request, res: Response) => {
    try {
      const force = req.query.force === '1';
      const categoryFilter = typeof req.query.category === 'string' ? req.query.category : null;

      const content = getWikiContent({ force });

      const articles = categoryFilter
        ? content.articles.filter((a) => a.category === categoryFilter)
        : content.articles;

      res.json({
        categories: content.categories,
        articles,
        total: articles.length,
        loadedAt: content.loadedAt,
      });
    } catch (err) {
      console.error('Wiki content error:', err);
      res.status(500).json({ error: 'Failed to load wiki content' });
    }
  });

  /**
   * GET /api/wiki/article/:articleId
   * Returns a single wiki article by ID.
   */
  router.get('/wiki/article/:articleId', (req: Request, res: Response) => {
    try {
      const content = getWikiContent();
      const article = content.articles.find((a) => a.id === req.params.articleId);
      if (!article) {
        res.status(404).json({ error: 'Article not found' });
        return;
      }
      res.json({ article });
    } catch (err) {
      console.error('Wiki article error:', err);
      res.status(500).json({ error: 'Failed to load article' });
    }
  });

  // ── Phase 3: Rankings ────────────────────────────────────────────────────

  /**
   * GET /api/elo/leaderboard
   * Returns top N players sorted by ELO rating (role-weighted).
   * Optional ?limit=N (max 100).
   */
  router.get('/elo/leaderboard', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const entries = await eloRanking.getLeaderboard(limit);
      res.json({ leaderboard: entries, total: entries.length });
    } catch (err) {
      console.error('ELO leaderboard error:', err);
      res.status(500).json({ error: 'Failed to fetch ELO leaderboard' });
    }
  });

  /**
   * GET /api/player/:id/stats
   * Returns ELO entry + game history for a specific player.
   */
  router.get('/player/:id/stats', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const [eloEntry, profile, games] = await Promise.all([
        eloRanking.getPlayerEntry(id),
        getFullUserProfile(id),
        gameHistory.listPlayerGames(id, 20),
      ]);

      if (!eloEntry && !profile) {
        res.status(404).json({ error: 'Player not found' });
        return;
      }

      res.json({ playerId: id, elo: eloEntry, profile, recentGames: games });
    } catch (err) {
      console.error('Player stats error:', err);
      res.status(500).json({ error: 'Failed to fetch player stats' });
    }
  });

  // ── Phase 3: Replays ─────────────────────────────────────────────────────

  /**
   * GET /api/replay/:gameId
   * Returns the full timeline replay for a completed game.
   * Falls back to RoomManager in-memory snapshot if Firestore record not found.
   */
  router.get('/replay/:gameId', async (req: Request, res: Response) => {
    try {
      const { gameId } = req.params;

      // Try Firestore-backed full replay first
      const replay = await replayService.getReplay(gameId);
      if (replay) {
        res.json({ replay });
        return;
      }

      // Fall back to in-memory snapshot (final room state only, no timeline)
      const snapshot = roomManager.getReplay(gameId);
      if (snapshot) {
        res.json({ replay: snapshot, source: 'snapshot' });
        return;
      }

      res.status(404).json({ error: 'Replay not found' });
    } catch (err) {
      console.error('Replay error:', err);
      res.status(500).json({ error: 'Failed to fetch replay' });
    }
  });

  /**
   * GET /api/replays/recent
   * Returns metadata for recent completed games with replays.
   * Optional ?limit=N (max 50).
   */
  router.get('/replays/recent', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const replays = await replayService.listRecentReplays(limit);
      // Strip timeline to reduce payload — clients fetch full replay on demand
      const summaries = replays.map(({ timeline: _t, ...meta }) => meta);
      res.json({ replays: summaries, total: summaries.length });
    } catch (err) {
      console.error('Recent replays error:', err);
      res.status(500).json({ error: 'Failed to fetch recent replays' });
    }
  });

  // ── Phase 3: AI Stats ────────────────────────────────────────────────────

  /**
   * GET /api/analytics/overview
   * Returns aggregated win rates, role stats, quest patterns, and assassination stats.
   * Optional ?max=N to control how many games to analyse (default 500).
   */
  router.get('/analytics/overview', async (req: Request, res: Response) => {
    try {
      const maxGames = Math.min(Number(req.query.max) || 500, 2000);
      const overview = await analytics.getOverview(maxGames);
      res.json({ analytics: overview });
    } catch (err) {
      console.error('Analytics overview error:', err);
      res.status(500).json({ error: 'Failed to compute analytics' });
    }
  });

  /**
   * GET /api/analytics/player/:id
   * Returns per-player analytics: win rates by role, faction, game count.
   */
  router.get('/analytics/player/:id', optionalAuth, async (req: Request, res: Response) => {
    try {
      const playerAnalytics = await analytics.getPlayerAnalytics(req.params.id);
      if (!playerAnalytics) {
        res.status(404).json({ error: 'No game records found for this player' });
        return;
      }
      res.json({ analytics: playerAnalytics });
    } catch (err) {
      console.error('Player analytics error:', err);
      res.status(500).json({ error: 'Failed to compute player analytics' });
    }
  });

  /**
   * POST /api/game-invite
   * Triggered by listen-bot or the web platform to post a game invite to Discord.
   * Body: { roomId: string, hostName: string, playerCount?: number, maxPlayers?: number }
   */
  router.post('/game-invite', async (req: Request, res: Response) => {
    try {
      const { postGameInvite } = await import('../bots/discord/invite');
      const { roomId, hostName, playerCount, maxPlayers } = req.body as {
        roomId?: string;
        hostName?: string;
        playerCount?: number;
        maxPlayers?: number;
      };

      if (!roomId || !hostName) {
        res.status(400).json({ error: 'roomId and hostName are required' });
        return;
      }

      const messageId = await postGameInvite({ roomId, hostName, playerCount, maxPlayers });
      res.json({ success: true, messageId });
    } catch (err) {
      console.error('Game invite error:', err);
      res.status(500).json({ error: 'Failed to post game invite' });
    }
  });

  return router;
}
