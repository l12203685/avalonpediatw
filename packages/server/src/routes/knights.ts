/**
 * 統一 AI騎士（B2）HTTP 路由（`/api/knights/*`）。
 *
 * 端點：
 *   - `GET  /api/knights/public`              公開：所有已核准玩家騎士的第 2 層白名單開關與必要公開資訊（絕不洩漏 uid / email / 回饋原文）
 *   - `GET  /api/knights/knobs`               公開：白名單開關清單與預設值
 *   - `GET  /api/knights/fidelity`            公開：查詢指定玩家 ID／騎士的逐動作精準度（`docs/ai/gap/knight_fidelity.json`）
 *   - `GET  /api/knights/me`                  需登入：回傳自己的認領狀態、已核准騎士（第 1 層＋第 2 層＋改動紀錄＋精準度）、官方騎士清單與是否為站長
 *   - `POST /api/knights/claim`               需登入：送出「這個 ID 是我」認領申請（進入 pending，待站長逐筆核准）
 *   - `POST /api/knights/me/adjust/validate`  需登入：檢查並預覽「用你自己的 AI 調整」貼回的 JSON（不寫入）
 *   - `PUT  /api/knights/me/adjust`           需登入且已核准：儲存第 2 層白名單調整與改動紀錄（含私人回饋）
 *   - `GET  /api/knights/admin/claims`        限站長：列出全部認領申請（pending 優先）
 *   - `POST /api/knights/admin/claims/:id/review` 限站長：逐筆核准（approved）或退回（rejected）
 */

import { Router, type IRouter, type Request, type Response } from 'express';
import { DEFAULT_AGENT_TUNING } from '../ai/AgentTuning';
import { ARENA_KNOBS } from '../arena/knobs';
import { DEFAULT_KNIGHT_ID, listKnights, type Knight } from '../arena/knights';
import { createHttpRateLimit } from '../middleware/rateLimit';
import {
  resolveAuthenticatedKnightUser,
  resolveKnightAdminEmail,
  type AuthenticatedKnightUser,
  type KnightAuthDeps,
} from '../services/knightAdminAuth';
import { findKnightFidelity, type KnightFidelitySummary } from '../services/knightFidelity';
import {
  getPlayerKnightsStore,
  normalizePlayerIdKey,
  RESIDUAL_ACTION_KEYS,
  summarizeAdjustDiff,
  validatePlayerKnightAdjust,
  type PlayerKnightsStore,
} from '../services/playerKnightsStore';

export interface KnobMeta {
  key: string;
  kind: 'number' | 'boolean';
  side: 'good' | 'evil' | 'assassin';
  min?: number;
  max?: number;
  defaultValue: number | boolean;
  zh: string;
  en: string;
  zhUp: string;
  zhDown: string;
}

export interface OfficialKnightOption {
  id: string;
  name: string;
  playerId: string;
  tag?: string;
  style: string;
}

export interface KnightsRouterDeps {
  store?: PlayerKnightsStore;
  auth?: KnightAuthDeps;
  listKnights?: () => readonly Knight[];
  findFidelity?: (playerIdOrKnight: string) => KnightFidelitySummary | null;
  disableRateLimit?: boolean;
}

export function buildKnobCatalog(): KnobMeta[] {
  return ARENA_KNOBS.map((k) => {
    const rawDefault = DEFAULT_AGENT_TUNING[k.key];
    const defaultValue = typeof rawDefault === 'boolean' || typeof rawDefault === 'number'
      ? rawDefault
      : k.kind === 'boolean' ? false : 0;
    return {
      key: k.key,
      kind: k.kind,
      side: k.side,
      ...(k.kind === 'number' ? { min: k.min, max: k.max } : {}),
      defaultValue,
      zh: k.zh,
      en: k.en,
      zhUp: k.zhUp,
      zhDown: k.zhDown,
    };
  });
}

/** 從官方騎士 `baseName`（`AI騎士_ED`）抽出玩家 ID（`ED`）。 */
export function extractPlayerIdFromKnight(knight: Knight): string | null {
  if (knight.id === DEFAULT_KNIGHT_ID) return null;
  const fromProfile = (knight.profile as { playerId?: unknown } | null)?.playerId;
  if (typeof fromProfile === 'string' && fromProfile.trim()) return fromProfile.trim();
  const stripped = knight.baseName.replace(/^AI騎士_/i, '').trim();
  return stripped || null;
}

function findOfficialKnightByPlayerId(knights: readonly Knight[], playerId: string): Knight | null {
  const key = normalizePlayerIdKey(playerId);
  for (const k of knights) {
    const pid = extractPlayerIdFromKnight(k);
    if (pid && normalizePlayerIdKey(pid) === key) return k;
  }
  return null;
}

function officialKnightOptions(knights: readonly Knight[]): OfficialKnightOption[] {
  const out: OfficialKnightOption[] = [];
  for (const k of knights) {
    const pid = extractPlayerIdFromKnight(k);
    if (!pid) continue;
    out.push({
      id: k.id,
      name: k.baseName,
      playerId: pid,
      ...(k.tag ? { tag: k.tag } : {}),
      style: k.style,
    });
  }
  return out;
}

/** 將官方騎士第 1 層 profile 轉成給前端顯示／AI 提示用的精簡物件（不含龐大的 residual 權重矩陣）。 */
function summarizeLayer1Profile(knight: Knight | null): {
  id: string;
  name: string;
  tag?: string;
  style: string;
  fit: 'fitted' | 'none';
  hasResidual: boolean;
  overrides?: Record<string, number | boolean>;
  sides?: Record<string, Record<string, number | boolean>>;
  roles?: Record<string, Record<string, number | boolean>>;
} | null {
  if (!knight || !knight.profile) return null;
  const p = knight.profile;
  return {
    id: knight.id,
    name: knight.baseName,
    ...(knight.tag ? { tag: knight.tag } : {}),
    style: knight.style,
    fit: (p as { fit?: string }).fit === 'none' ? 'none' : 'fitted',
    hasResidual: Boolean(p.residual),
    ...(p.overrides ? { overrides: p.overrides as Record<string, number | boolean> } : {}),
    ...(p.sides ? { sides: p.sides as Record<string, Record<string, number | boolean>> } : {}),
    ...(p.roles ? { roles: p.roles as Record<string, Record<string, number | boolean>> } : {}),
  };
}

export function createKnightsRouter(deps: KnightsRouterDeps = {}): IRouter {
  const router: IRouter = Router();
  const getStore = (): PlayerKnightsStore => deps.store ?? getPlayerKnightsStore();
  const getKnights = (): readonly Knight[] => (deps.listKnights ?? listKnights)();
  const getFidelity = (q: string): KnightFidelitySummary | null => (deps.findFidelity ?? findKnightFidelity)(q);

  const publicLimiter = deps.disableRateLimit
    ? (_req: Request, _res: Response, next: () => void): void => next()
    : createHttpRateLimit(60 * 1000, 60);
  const writeLimiter = deps.disableRateLimit
    ? (_req: Request, _res: Response, next: () => void): void => next()
    : createHttpRateLimit(60 * 1000, 20);

  async function requireUser(req: Request, res: Response): Promise<AuthenticatedKnightUser | null> {
    const user = await resolveAuthenticatedKnightUser(req.headers.authorization, deps.auth);
    if (!user) {
      res.status(401).json({ error: '請先登入正式帳號（訪客無法認領或調整騎士）', code: 'unauthorized' });
      return null;
    }
    return user;
  }

  async function requireAdmin(req: Request, res: Response): Promise<{ user: AuthenticatedKnightUser; adminEmail: string } | null> {
    const user = await requireUser(req, res);
    if (!user) return null;
    const adminEmail = await resolveKnightAdminEmail(user, deps.auth);
    if (!adminEmail) {
      res.status(403).json({ error: '此操作僅限站長使用', code: 'forbidden' });
      return null;
    }
    return { user, adminEmail };
  }

  // ── GET /api/knights/public ─────────────────────────────────────────
  // 公開資料：只含已核准騎士的白名單開關、必要公開資訊與官方騎士清單摘要。
  // 絕不洩漏 uid / ownerUid / email / note / feedback / history / pending 或 rejected 認領。
  router.get('/public', publicLimiter, async (_req: Request, res: Response) => {
    const store = getStore();
    await store.ready();
    const pub = store.getPublicPayload();
    const official = officialKnightOptions(getKnights()).map((k) => ({
      id: k.id,
      name: k.name,
      playerId: k.playerId,
      ...(k.tag ? { tag: k.tag } : {}),
      style: k.style,
    }));
    res.json({
      schema: pub.schema,
      updatedAt: pub.updatedAt,
      knights: pub.knights,
      officialKnights: official,
      residualActions: [...RESIDUAL_ACTION_KEYS],
    });
  });

  // ── GET /api/knights/knobs ──────────────────────────────────────────
  router.get('/knobs', publicLimiter, (_req: Request, res: Response) => {
    res.json({
      schema: 1,
      knobs: buildKnobCatalog(),
      residualActions: [...RESIDUAL_ACTION_KEYS],
    });
  });

  // ── GET /api/knights/fidelity ───────────────────────────────────────
  router.get('/fidelity', publicLimiter, (req: Request, res: Response) => {
    const raw = typeof req.query.playerId === 'string'
      ? req.query.playerId
      : typeof req.query.knight === 'string'
        ? req.query.knight
        : '';
    if (!raw.trim()) {
      res.status(400).json({ error: '請提供 playerId 或 knight 查詢參數' });
      return;
    }
    const fidelity = getFidelity(raw);
    res.json({ fidelity });
  });

  // ── GET /api/knights/me ─────────────────────────────────────────────
  router.get('/me', publicLimiter, async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const store = getStore();
    await store.ready();

    const adminEmail = await resolveKnightAdminEmail(user, deps.auth);
    const claims = store.getClaimsByUid(user.uid).map((c) => ({
      id: c.id,
      playerId: c.playerId,
      knightId: c.knightId,
      ...(c.note ? { note: c.note } : {}),
      status: c.status,
      createdAt: c.createdAt,
      ...(c.reviewedAt ? { reviewedAt: c.reviewedAt } : {}),
      ...(c.reviewReason ? { reviewReason: c.reviewReason } : {}),
    }));

    const owned = store.getApprovedKnightByUid(user.uid);
    const allKnights = getKnights();
    const officialMatch = owned ? findOfficialKnightByPlayerId(allKnights, owned.playerId) : null;
    const fidelity = owned ? getFidelity(owned.playerId) : null;

    res.json({
      user: {
        uid: user.uid,
        displayName: user.displayName,
        isAdmin: adminEmail !== null,
      },
      claims,
      knight: owned
        ? {
            playerId: owned.playerId,
            knightId: owned.knightId ?? officialMatch?.id ?? null,
            displayName: officialMatch ? officialMatch.baseName : `AI騎士_${owned.playerId}`,
            layer1: summarizeLayer1Profile(officialMatch),
            adjust: owned.adjust,
            updatedAt: owned.updatedAt,
            history: [...owned.history].reverse().map((h) => ({
              id: h.id,
              at: h.at,
              source: h.source,
              ...(h.note ? { note: h.note } : {}),
              ...(h.feedback ? { feedback: h.feedback } : {}),
              summary: h.summary,
              adjust: h.adjust,
            })),
          }
        : null,
      fidelity,
      knobs: buildKnobCatalog(),
      residualActions: [...RESIDUAL_ACTION_KEYS],
      officialKnights: officialKnightOptions(allKnights),
    });
  });

  // ── POST /api/knights/claim ─────────────────────────────────────────
  router.post('/claim', writeLimiter, async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as { playerId?: unknown; note?: unknown };
    const rawPlayerId = typeof body.playerId === 'string' ? body.playerId : '';
    const officialMatch = rawPlayerId.trim() ? findOfficialKnightByPlayerId(getKnights(), rawPlayerId) : null;

    const store = getStore();
    const result = await store.submitClaim({
      uid: user.uid,
      displayName: user.displayName,
      playerId: rawPlayerId,
      knightId: officialMatch?.id ?? null,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    if (!result.ok) {
      const status = result.code === 'already_claimed' || result.code === 'duplicate_pending' || result.code === 'user_already_has_knight' || result.code === 'already_owned'
        ? 409
        : 400;
      res.status(status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(201).json({
      claim: {
        id: result.data.id,
        playerId: result.data.playerId,
        knightId: result.data.knightId,
        ...(result.data.note ? { note: result.data.note } : {}),
        status: result.data.status,
        createdAt: result.data.createdAt,
      },
    });
  });

  // ── POST /api/knights/me/adjust/validate ────────────────────────────
  router.post('/me/adjust/validate', writeLimiter, async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as { adjust?: unknown };
    const candidate = body.adjust !== undefined ? body.adjust : req.body;
    const result = validatePlayerKnightAdjust(candidate);
    const store = getStore();
    await store.ready();
    const owned = store.getApprovedKnightByUid(user.uid);
    const diffSummary = result.ok && result.adjust
      ? summarizeAdjustDiff(owned?.adjust, result.adjust)
      : null;

    res.json({
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      adjust: result.adjust ?? null,
      diffSummary,
    });
  });

  // ── PUT /api/knights/me/adjust ──────────────────────────────────────
  router.put('/me/adjust', writeLimiter, async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as { adjust?: unknown; feedback?: unknown; source?: unknown };
    const store = getStore();
    const result = await store.saveAdjust({
      uid: user.uid,
      adjust: body.adjust,
      feedback: typeof body.feedback === 'string' ? body.feedback : undefined,
      source: typeof body.source === 'string' ? body.source : 'web',
    });
    if (!result.ok) {
      const status = result.code === 'not_approved' ? 403 : 400;
      res.status(status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({
      ok: true,
      warnings: result.data.warnings,
      adjust: result.data.record.adjust,
      updatedAt: result.data.record.updatedAt,
      history: [...result.data.record.history].reverse().map((h) => ({
        id: h.id,
        at: h.at,
        source: h.source,
        ...(h.note ? { note: h.note } : {}),
        ...(h.feedback ? { feedback: h.feedback } : {}),
        summary: h.summary,
        adjust: h.adjust,
      })),
    });
  });

  // ── GET /api/knights/admin/claims ───────────────────────────────────
  router.get('/admin/claims', publicLimiter, async (req: Request, res: Response) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const store = getStore();
    await store.ready();
    const claims = store.getAllClaims().map((c) => ({
      id: c.id,
      uid: c.uid,
      displayName: c.displayName,
      playerId: c.playerId,
      knightId: c.knightId,
      ...(c.note ? { note: c.note } : {}),
      status: c.status,
      createdAt: c.createdAt,
      ...(c.reviewedAt ? { reviewedAt: c.reviewedAt } : {}),
      ...(c.reviewedBy ? { reviewedBy: c.reviewedBy } : {}),
      ...(c.reviewReason ? { reviewReason: c.reviewReason } : {}),
    }));
    res.json({ claims });
  });

  // ── POST /api/knights/admin/claims/:claimId/review ──────────────────
  router.post('/admin/claims/:claimId/review', writeLimiter, async (req: Request, res: Response) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const claimId = req.params.claimId;
    const body = (req.body ?? {}) as { decision?: unknown; reason?: unknown };
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      res.status(400).json({ error: 'decision 必須是 approved 或 rejected', code: 'invalid_decision' });
      return;
    }
    const store = getStore();
    const knights = getKnights();
    const result = await store.reviewClaim({
      claimId,
      decision: body.decision,
      adminEmail: admin.adminEmail,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      resolveKnightId: (pid) => findOfficialKnightByPlayerId(knights, pid)?.id ?? null,
    });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : result.code === 'already_reviewed' || result.code === 'already_claimed' || result.code === 'user_already_has_knight' ? 409 : 400;
      res.status(status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ claim: result.data });
  });

  return router;
}

export const knightsRouter: IRouter = createKnightsRouter();
