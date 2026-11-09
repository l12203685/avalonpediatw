/**
 * 網站「百科AI 對局」頁的 API（Edward 2026-11-05：「只要有百科AI參與的牌局就自動記錄在網站&DC上 我們可以直接針對AI的動作作反饋」）。
 *
 *   GET  /api/ai-games              最近的百科AI對局（DC 論壇 #牌譜紀錄與覆盤、標題「百科AI對局」或「含百科機器人」的討論串）
 *   GET  /api/ai-games/:id          一局的 trace（那篇起始訊息附的 trace.json）
 *   POST /api/ai-games/:id/flag     「這步怪怪的」：{ decisionId, note, name? } → 貼成那篇討論串的回覆（不用登入）
 *
 * 資料都在 DC（scripts/signagePlayer.ts 每局結束後貼），伺服器用 DISCORD_BOT_TOKEN 讀、記憶體快取 5 分鐘（services/aiGameForum.ts）。
 * 沒設 token → 503 'AI games not configured'。網站上不顯示真人暱稱（只有座位與角色；DC 上照房間裡的暱稱）。
 * 回饋的頻率限制每個 IP 每分鐘 10 則，另有全站每小時上限。log 只寫狀態碼。
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { createHttpRateLimit } from '../middleware/rateLimit';
import { AI_GAMES_NOT_CONFIGURED, aiGameService } from '../services/aiGameForum';
import { cleanFlagName, cleanFlagNote, type AiGameTrace } from '../services/aiGameTrace';

const router: IRouter = Router();
const readLimit = createHttpRateLimit(60_000, 60);
const flagLimit = createHttpRateLimit(60_000, 10); // 同 POST /api/feedback：每個 IP 每分鐘 10 則

/** 網站版：真人的暱稱拿掉（只留座位與角色），百科AI 的暱稱留著。 */
export function publicTrace(t: AiGameTrace): AiGameTrace {
  return { ...t, seats: t.seats.map((s) => (s.ai ? s : { ...s, name: '' })) };
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ ok: false, error });
}

router.get('/', readLimit, async (_req: Request, res: Response) => {
  const service = aiGameService();
  if (!service) return fail(res, 503, AI_GAMES_NOT_CONFIGURED);
  try {
    const load = await service.listGames();
    if (!load.ok) return fail(res, load.status, load.error);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, games: load.games, fetchedAt: new Date(load.fetchedAt).toISOString(), stale: load.stale });
  } catch {
    console.error('[ai-games] list: unexpected error');
    fail(res, 500, 'Failed to load AI games');
  }
});

router.get('/:id', readLimit, async (req: Request, res: Response) => {
  const service = aiGameService();
  if (!service) return fail(res, 503, AI_GAMES_NOT_CONFIGURED);
  try {
    const load = await service.getTrace(String(req.params.id));
    if (!load.ok) return fail(res, load.status, load.error);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, trace: publicTrace(load.trace), thread: load.thread });
  } catch {
    console.error('[ai-games] trace: unexpected error');
    fail(res, 500, 'Failed to load the game');
  }
});

router.post('/:id/flag', flagLimit, async (req: Request, res: Response) => {
  const service = aiGameService();
  if (!service) return fail(res, 503, AI_GAMES_NOT_CONFIGURED);
  const body = (req.body ?? {}) as { decisionId?: unknown; note?: unknown; name?: unknown };
  const decisionId = typeof body.decisionId === 'number' ? body.decisionId : Number(body.decisionId);
  if (!Number.isInteger(decisionId) || decisionId < 1) return fail(res, 400, 'decisionId required');
  try {
    const r = await service.flag(String(req.params.id), decisionId, cleanFlagNote(body.note), cleanFlagName(body.name));
    if (!r.ok) return fail(res, r.status, r.error);
    res.json({ ok: true });
  } catch {
    console.error('[ai-games] flag: unexpected error');
    fail(res, 500, 'Failed to send the feedback');
  }
});

export { router as aiGamesRouter };
