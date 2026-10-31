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
  getPlayerAliases,
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
  getFeatureStudies,
  getLeaderboard,
  getRatingBoard,
  getPlayerRating,
  invalidateCache,
  isSheetsReady,
  assassinationWinRates,
  playerOutcomeBlocks,
} from '../services/sheetsAnalysis';
import { invalidateGamesPayload, loadGamesPayload, pickEncoding } from '../services/gamesDataset';
import { invalidatePaipuPayload, loadPaipuPayload } from '../services/paipuList';
import { REPLIES_NOT_CONFIGURED, repliesService } from '../services/paipuReplies';
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

/**
 * Express has already percent-decoded `req.params`; the extra
 * decodeURIComponent is kept for clients that double-encode, but a name that
 * merely contains "%" (e.g. "100%") must not turn into a URIError → 500.
 */
function nameParam(req: Request): string {
  const raw = req.params.name;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 預先壓縮好的 JSON 回應：強 ETag、If-None-Match → 304、依 Accept-Encoding 回 br / gzip / 原文。 */
function sendPrecompressed(
  req: Request,
  res: Response,
  payload: { identity: Buffer; gzip: Buffer; br: Buffer; etag: string },
): Response | void {
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  res.setHeader('ETag', payload.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  const match = req.headers['if-none-match'];
  if (typeof match === 'string' && match.split(',').some((tag) => tag.trim().replace(/^W\//, '') === payload.etag)) {
    return res.status(304).end();
  }
  const encoding = pickEncoding(req.headers['accept-encoding']);
  const body = encoding === 'br' ? payload.br : encoding === 'gzip' ? payload.gzip : payload.identity;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (encoding !== 'identity') res.setHeader('Content-Encoding', encoding);
  res.setHeader('Content-Length', String(body.length));
  return res.status(200).end(body);
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
// Per-player stats array; `aliases` = the cache's players.aliases (old spelling → official
// name, player_aliases.json), so the website search finds a player by an old name.
// ---------------------------------------------------------------------------
router.get('/players', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const [players, aliases] = await Promise.all([getAllPlayerStats(), getPlayerAliases()]);
    return ok(res, { players, total: players.length, aliases });
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
    const player = await getPlayerByName(nameParam(req));
    if (!player) {
      return fail(res, 404, 'Player not found');
    }

    // Radar axes per docs/stats/two_stage_outcome.md: winRate / redWinRate are
    // the FINAL-outcome rates (紅勝 = 三紅 + 三藍死, 藍勝 = 三藍活); the legacy
    // 任務結算 rate is exposed as missionWinRate. roleTheory / positionTheory are
    // the owner's definitions over the player's career (theory.career, Edward
    // 2026-10-13) — null on a cache written before them, never the legacy
    // player.roleTheory. excessWinRate stays for older web builds (null when the
    // cache cannot provide it); the site no longer plots it.
    // Edward 2026-10-14「三藍死(紅方) 應該是 刺殺成功 / 我是紅方且三藍」— and likewise for blue:
    // redMerlinKillRate / blueMerlinProtect are the conditional 刺殺結果 of the red / blue games,
    // 三藍死 / (三藍死 + 三藍活) and 三藍活 / (三藍死 + 三藍活) (assassinationWinRates), not 三藍死 / all
    // red games (player.redMerlinDead) or 三藍活 / all blue games (player.blueMerlinAlive, which is the
    // blue 遊戲結果 = finalBlueWinRate); null when the player never reached 三藍 on that side. A row
    // without raw counts gets the same ratio from the per-side rates, never the unconditional one.
    // outcomeBlocks carries the three blocks (任務結果 / 刺殺結果 / 遊戲結果, each with its n) of the red
    // games, the blue games and (schemaVersion 4) every role.
    const career = player.theory?.career;
    const outcomeBlocks = playerOutcomeBlocks(player);
    const assassination = assassinationWinRates(player, outcomeBlocks);
    const radar = {
      winRate: player.finalWinRate ?? player.winRate,
      redWinRate: player.finalRedWinRate ?? player.redWin,
      blueMerlinProtect: assassination.blue,
      missionWinRate: player.missionWinRate ?? player.winRate,
      excessWinRate: player.excessWinRate ?? null,
      redMerlinKillRate: assassination.red,
      experience: Math.min(player.totalGames / 10, 100),
      roleTheory: typeof career?.roleTheory === 'number' ? career.roleTheory : null,
      positionTheory: typeof career?.positionTheory === 'number' ? career.positionTheory : null,
      outcomeBlocks,
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
// :name 是分析快取的玩家顯示名稱，由別名與正規化規則解析。
// auth profile's display_name on the frontend before calling.
// ---------------------------------------------------------------------------
router.get('/profile/:name/archetype', limiter, async (req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const name = nameParam(req);
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
    const name = nameParam(req);
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
    const name = nameParam(req);
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
// GET /api/analysis/feature-studies
// 特徵研究 — 5 個高訊號 v7 features (湖宣告真假率 / 言行一致 / 刺座偏好 / 翻轉率 / R3 forced)
// 給 AnalyticsPage 第三 tab 「特徵研究」用。Cache 缺則回 503。
// ---------------------------------------------------------------------------
router.get('/feature-studies', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const data = await getFeatureStudies();
    if (!data) {
      return fail(res, 503, 'Feature studies cache not yet generated');
    }
    return ok(res, data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/feature-studies]', msg);
    return fail(res, 500, 'Failed to load feature studies');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/leaderboard
// 排行榜（schemaVersion 4：main 角色理論〔各角色近 10 場、忠臣近 40 場〕、position 位置理論
// 〔近 100 場〕、overall 整體理論〔生涯〕、improved、assassin、newcomers、roleTitles；schemaVersion 3
// 的快取是 main / last50〔各人最近 N 場〕）— boards computed by generate_cache.py
// (LEADERBOARD_CONFIG), served as-is. Cache predating the section → 503, like feature-studies.
// ---------------------------------------------------------------------------
router.get('/leaderboard', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const data = await getLeaderboard();
    if (!data) {
      return fail(res, 503, 'Leaderboard not yet generated');
    }
    return ok(res, data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/leaderboard]', msg);
    return fail(res, 500, 'Failed to load leaderboard');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/rating
// 團隊 Elo（網站唯一的 Elo；generate_cache.py compute_rating / RATING_CONFIG，Edward 2026-10-30）：每位玩家目前的
// Elo、±1σ、場數、模型理論勝率，加上排行的 asOf（網站預設只列近 activeDays 天有出賽者）。每人的走勢在
// /rating/:name。快取還沒有這一段 → 503，跟 leaderboard 一樣。依對局順序而定，不隨複合篩選重算。
// ---------------------------------------------------------------------------
router.get('/rating', limiter, async (_req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const data = await getRatingBoard();
    if (!data) {
      return fail(res, 503, 'Rating not yet generated');
    }
    return ok(res, data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/rating]', msg);
    return fail(res, 500, 'Failed to load rating');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/rating/:name
// 一位玩家的 Elo 與走勢（每個出賽日最後一局後的 [日期, Elo, ±1σ, 累計場數]）；名字比對同其他玩家路由。
// 沒有計入 Elo 的局 → 404；快取還沒有這一段 → 503。
// ---------------------------------------------------------------------------
router.get('/rating/:name', limiter, async (req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const data = await getPlayerRating(nameParam(req));
    if (data === undefined) {
      return fail(res, 503, 'Rating not yet generated');
    }
    if (!data) {
      return fail(res, 404, 'Player not rated');
    }
    return ok(res, data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/rating/:name]', msg);
    return fail(res, 500, 'Failed to load rating');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/games
// 複合篩選（Edward 2026-10-14）：每局資料集 games_cache.json + context（快取的 asOf、gamesKey、設定），
// 網站的計算引擎（@avalon/shared/stats）在瀏覽器重算篩選後的區塊。兩檔不同批、檔案不存在或執行期
// 一致性檢查失敗 → 503（網站顯示「篩選暫時無法使用」，預設畫面不受影響）。預先壓縮、強 ETag、304。
// ---------------------------------------------------------------------------
router.get('/games', limiter, (req: Request, res: Response) => {
  if (!sheetsGuard(res)) return;
  try {
    const load = loadGamesPayload();
    if (!load.ok) return fail(res, load.status, load.error);
    return sendPrecompressed(req, res, load.payload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/games]', msg);
    return fail(res, 500, 'Failed to load the games dataset');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/paipu
// 網站「牌譜紀錄」頁籤（Edward 2026-10-30）：Discord 論壇 #牌譜紀錄與覆盤 的貼文清單（每篇 = 一局：標題、
// 標籤、發文時間、解析後的牌譜），每天由 refresh-analysis-cache.yml 寫進 paipu_cache.json。不需要試算表金鑰，
// 執行期也不連 Discord。檔案還沒產生 → 503 'Paipu list not yet generated'。預先壓縮、強 ETag、304。
// ---------------------------------------------------------------------------
router.get('/paipu', limiter, (req: Request, res: Response) => {
  try {
    const load = loadPaipuPayload();
    if (!load.ok) return fail(res, load.status, load.error);
    return sendPrecompressed(req, res, load.payload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/paipu]', msg);
    return fail(res, 500, 'Failed to load the paipu list');
  }
});

// ---------------------------------------------------------------------------
// GET /api/analysis/paipu/:id/replies
// 那篇貼文討論串裡的回覆（Edward 2026-10-30：「DC 討論串的回覆可以顯示」）。只讀 paipu_cache.json 清單裡的貼文；
// 執行期用 DISCORD_BOT_TOKEN 讀、快取在記憶體（不進 repo），機器人訊息不顯示。見 services/paipuReplies.ts。
// ---------------------------------------------------------------------------
router.get('/paipu/:id/replies', limiter, async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const load = loadPaipuPayload();
    if (!load.ok) return fail(res, load.status, load.error);
    if (!/^\d{15,22}$/.test(id) || !load.payload.ids.has(id)) return fail(res, 404, 'Post not found');
    const service = repliesService(load.payload.guildId);
    if (!service) return fail(res, 503, REPLIES_NOT_CONFIGURED);
    const replies = await service.load(id);
    if (!replies.ok) return fail(res, replies.status, replies.error);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return ok(res, {
      replies: replies.replies,
      fetchedAt: new Date(replies.fetchedAt).toISOString(),
      stale: replies.stale,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analysis/paipu replies]', msg);
    return fail(res, 500, 'Failed to load the thread replies');
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
  invalidateGamesPayload();
  invalidatePaipuPayload();
  return ok(res, { message: 'Cache invalidated' });
});

export { router as analysisRouter };
