/**
 * 統一 AI騎士（C）— 站長私人重玩測驗（Replay Quiz）HTTP 路由（`/api/replay-quiz/*`）。
 *
 * 全部端點皆為站長專屬（透過 `knightAdminAuth` 嚴格把關，未登入或訪客回 401，非站長回 403）：
 *   - `GET  /api/replay-quiz/next`    出下一題（30 天以前歷史局，全匿名座位，絕不洩漏真實答案）
 *   - `POST /api/replay-quiz/answer`  送出作答與選填「為什麼」理由，回傳是否與當初一致＋更新後逐動作統計
 *   - `GET  /api/replay-quiz/stats`   取得逐動作一致率統計與最近作答紀錄
 */

import { Router, type IRouter, type Request, type Response } from 'express';
import { createHttpRateLimit } from '../middleware/rateLimit';
import {
  resolveAuthenticatedKnightUser,
  resolveKnightAdminEmail,
  type AuthenticatedKnightUser,
  type KnightAuthDeps,
} from '../services/knightAdminAuth';
import {
  getPlayerKnightsStore,
  validatePlayerId,
  type PlayerKnightsStore,
} from '../services/playerKnightsStore';
import {
  getReplayQuizService,
  isValidQuizAction,
  REPLAY_QUIZ_ACTIONS,
  REPLAY_QUIZ_DEFAULT_PLAYER_ID,
  type ReplayQuizAction,
  type ReplayQuizService,
} from '../services/replayQuizService';

export interface ReplayQuizRouterDeps {
  service?: ReplayQuizService;
  playerKnightsStore?: PlayerKnightsStore;
  auth?: KnightAuthDeps;
  disableRateLimit?: boolean;
}

export function createReplayQuizRouter(deps: ReplayQuizRouterDeps = {}): IRouter {
  const router: IRouter = Router();
  const getService = (): ReplayQuizService => deps.service ?? getReplayQuizService();
  const getKnightsStore = (): PlayerKnightsStore => deps.playerKnightsStore ?? getPlayerKnightsStore();

  const readLimiter = deps.disableRateLimit
    ? (_req: Request, _res: Response, next: () => void): void => next()
    : createHttpRateLimit(60 * 1000, 60);
  const writeLimiter = deps.disableRateLimit
    ? (_req: Request, _res: Response, next: () => void): void => next()
    : createHttpRateLimit(60 * 1000, 30);

  async function requireAdmin(
    req: Request,
    res: Response,
  ): Promise<{ user: AuthenticatedKnightUser; adminEmail: string } | null> {
    const user = await resolveAuthenticatedKnightUser(req.headers.authorization, deps.auth);
    if (!user) {
      res.status(401).json({ error: '請先登入正式帳號（此頁面僅限站長使用）', code: 'unauthorized' });
      return null;
    }
    const adminEmail = await resolveKnightAdminEmail(user, deps.auth);
    if (!adminEmail) {
      res.status(403).json({ error: '此操作僅限站長使用', code: 'forbidden' });
      return null;
    }
    return { user, adminEmail };
  }

  async function resolveTargetPlayerId(uid: string, rawRequested: unknown): Promise<{ ok: true; playerId: string } | { ok: false; error: string }> {
    if (typeof rawRequested === 'string' && rawRequested.trim()) {
      const checked = validatePlayerId(rawRequested);
      if (!checked.ok) return { ok: false, error: checked.error };
      return { ok: true, playerId: checked.playerId };
    }
    const knightsStore = getKnightsStore();
    await knightsStore.ready();
    const owned = knightsStore.getApprovedKnightByUid(uid);
    return { ok: true, playerId: owned?.playerId || REPLAY_QUIZ_DEFAULT_PLAYER_ID };
  }

  // ── GET /api/replay-quiz/next ────────────────────────────────────────
  router.get('/next', readLimiter, async (req: Request, res: Response) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const target = await resolveTargetPlayerId(admin.user.uid, req.query.playerId);
    if (!target.ok) {
      res.status(400).json({ error: target.error, code: 'invalid_player_id' });
      return;
    }

    let action: ReplayQuizAction | undefined;
    if (typeof req.query.action === 'string' && req.query.action.trim()) {
      const rawAction = req.query.action.trim();
      if (!isValidQuizAction(rawAction)) {
        res.status(400).json({
          error: `不認得的動作「${rawAction}」（只接受 ${REPLAY_QUIZ_ACTIONS.join('、')}）`,
          code: 'invalid_action',
        });
        return;
      }
      action = rawAction;
    }

    const result = await getService().getNextQuestion({
      playerId: target.playerId,
      action,
    });

    res.json({
      schema: 1,
      ...result,
    });
  });

  // ── POST /api/replay-quiz/answer ─────────────────────────────────────
  router.post('/answer', writeLimiter, async (req: Request, res: Response) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const body = req.body as {
      questionId?: unknown;
      answer?: unknown;
      reason?: unknown;
      playerId?: unknown;
    } | undefined;

    if (!body || typeof body.questionId !== 'string' || !body.questionId.trim()) {
      res.status(400).json({ error: '缺少題目 ID（questionId）', code: 'missing_question_id' });
      return;
    }

    const target = await resolveTargetPlayerId(admin.user.uid, body.playerId);
    if (!target.ok) {
      res.status(400).json({ error: target.error, code: 'invalid_player_id' });
      return;
    }

    const outcome = await getService().submitAnswer({
      playerId: target.playerId,
      uid: admin.user.uid,
      adminEmail: admin.adminEmail,
      questionId: body.questionId.trim(),
      answer: body.answer,
      reason: body.reason,
    });

    if (!outcome.ok) {
      const status = outcome.code === 'question_not_found' ? 404 : 400;
      res.status(status).json({ error: outcome.error, code: outcome.code });
      return;
    }

    res.json({
      schema: 1,
      matched: outcome.matched,
      actualAnswer: outcome.actualAnswer,
      actualAnswerLabel: outcome.actualAnswerLabel,
      userAnswerLabel: outcome.userAnswerLabel,
      gameDate: outcome.gameDate,
      record: {
        id: outcome.record.id,
        questionId: outcome.record.questionId,
        seat: outcome.record.seat,
        role: outcome.record.role,
        action: outcome.record.action,
        matched: outcome.record.matched,
        ...(outcome.record.reason ? { reason: outcome.record.reason } : {}),
        answeredAt: outcome.record.answeredAt,
      },
      stats: outcome.stats,
    });
  });

  // ── GET /api/replay-quiz/stats ───────────────────────────────────────
  router.get('/stats', readLimiter, async (req: Request, res: Response) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const target = await resolveTargetPlayerId(admin.user.uid, req.query.playerId);
    if (!target.ok) {
      res.status(400).json({ error: target.error, code: 'invalid_player_id' });
      return;
    }

    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    const recentLimit = Number.isFinite(rawLimit) ? rawLimit : 20;

    const result = await getService().getStats({
      playerId: target.playerId,
      recentLimit,
    });

    res.json({
      schema: 1,
      ...result,
    });
  });

  return router;
}

export const replayQuizRouter = createReplayQuizRouter();
