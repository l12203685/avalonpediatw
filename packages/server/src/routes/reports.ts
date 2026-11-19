/**
 * 網站「回報與修正」頁的 API（站長 2026-11-19：「bug 修正可以直接呈現在百科網站上嗎? (留言功能)」）。
 *
 *   GET /api/reports   最近的百科回報（網站「問題回報」＋LINE／DC 的 /回報、/更正）與處理狀態、說明、連結
 *
 * 資料在 DC #同步閒聊（bot 貼的【百科回報…】與每日例行作業加的狀態行），伺服器用 DISCORD_BOT_TOKEN 讀、記憶體快取 5 分鐘
 * （services/reportBoard.ts）。不給暱稱、帳號或 DC 連結；內容的 @提及與「暱稱：…」換成 ○○。
 * 沒設 token（或 REPORTS_BOARD=off）→ 503 { ok: false, reports: [] }。每個 IP 每分鐘 30 次。log 只寫狀態碼。
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { createHttpRateLimit } from '../middleware/rateLimit';
import { REPORTS_NOT_CONFIGURED, reportBoardService } from '../services/reportBoard';

const router: IRouter = Router();
const readLimit = createHttpRateLimit(60_000, 30);

router.get('/', readLimit, async (_req: Request, res: Response) => {
  const service = reportBoardService();
  if (!service) {
    res.status(503).json({ ok: false, reports: [], error: REPORTS_NOT_CONFIGURED });
    return;
  }
  try {
    const load = await service.listReports();
    if (!load.ok) {
      res.status(load.status).json({ ok: false, reports: [], error: load.error });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, reports: load.reports, fetchedAt: new Date(load.fetchedAt).toISOString(), stale: load.stale });
  } catch {
    console.error('[reports] list: unexpected error');
    res.status(500).json({ ok: false, reports: [], error: 'Failed to load reports' });
  }
});

export { router as reportsRouter };
