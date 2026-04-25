/**
 * Admin game-import routes — /api/admin/games/import/{sheets,json}
 *
 * Task: hineko_20260424_1035_admin_import_button
 *
 *   POST /api/admin/games/import/json
 *     body: { dryRun: boolean, limit?: number, jsonData: unknown[] }
 *     auth: admin only
 *     response: ImportResult
 *
 *   POST /api/admin/games/import/sheets
 *     body: { dryRun: boolean, limit?: number, sheetId?: string }
 *     auth: admin only
 *     status: 501 (CLI-only for now — see GameImportService stub)
 *
 * Rate limit: 60 calls per admin per 60s (defensive; Sheets quota isn't
 * hit here because the endpoint is stubbed, but the JSON path walks
 * Firestore once per record so it's also O(n) reads).
 */

import { Router, Request, Response, IRouter } from 'express';
import { createHttpRateLimit } from '../middleware/rateLimit';
import { requireAdminAuth } from '../middleware/claimAuth';
import {
  importFromJson,
  importFromSheets,
  GameImportNotImplementedError,
  type ImportResult,
} from '../services/GameImportService';

const router: IRouter = Router();
const adminLimiter = createHttpRateLimit(60 * 1000, 60);

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

// ---------------------------------------------------------------------------
// POST /api/admin/games/import/json
// ---------------------------------------------------------------------------

router.post(
  '/admin/games/import/json',
  adminLimiter,
  requireAdminAuth,
  async (req: Request, res: Response) => {
    const body = req.body as {
      dryRun?: unknown;
      limit?: unknown;
      jsonData?: unknown;
    };

    if (typeof body.dryRun !== 'boolean') {
      return fail(res, 400, 'dryRun (boolean) is required');
    }
    if (!Array.isArray(body.jsonData)) {
      return fail(res, 400, 'jsonData must be an array of game records');
    }
    const limit =
      typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
        ? body.limit
        : undefined;

    try {
      const result: ImportResult = await importFromJson({
        dryRun: body.dryRun,
        limit,
        jsonData: body.jsonData,
      });
      return ok(res, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[admin/games/import/json]', msg);
      return fail(res, 500, msg);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/games/import/sheets
// ---------------------------------------------------------------------------

router.post(
  '/admin/games/import/sheets',
  adminLimiter,
  requireAdminAuth,
  async (req: Request, res: Response) => {
    const body = req.body as {
      dryRun?: unknown;
      limit?: unknown;
      sheetId?: unknown;
    };

    if (typeof body.dryRun !== 'boolean') {
      return fail(res, 400, 'dryRun (boolean) is required');
    }
    const limit =
      typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
        ? body.limit
        : undefined;
    const sheetId = typeof body.sheetId === 'string' && body.sheetId ? body.sheetId : undefined;

    try {
      const result = await importFromSheets({
        dryRun: body.dryRun,
        limit,
        sheetId,
      });
      return ok(res, result);
    } catch (err) {
      if (err instanceof GameImportNotImplementedError) {
        return fail(res, 501, err.message);
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[admin/games/import/sheets]', msg);
      return fail(res, 500, msg);
    }
  },
);

export { router as adminImportRouter };
