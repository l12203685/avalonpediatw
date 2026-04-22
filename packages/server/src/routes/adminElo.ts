/**
 * Admin ELO config routes — #54 Phase 2 Day 3
 *
 *   GET  /api/admin/elo/config    — return current in-memory EloConfig + source info
 *   POST /api/admin/elo/config    — upsert partial override (admin only)
 *
 * Admin auth reuses `requireAdminAuth` (same whitelist as claims admin).
 * Writes go through `persistEloConfigOverride` which upserts to Supabase
 * and applies in-memory immediately.
 */

import { Router, Request, Response, IRouter } from 'express';
import { createHttpRateLimit } from '../middleware/rateLimit';
import { requireAdminAuth } from '../middleware/claimAuth';
import {
  EloConfig,
  EloAttributionMode,
  getEloConfig,
} from '../services/EloConfig';
import { persistEloConfigOverride } from '../services/EloConfigLoader';
import { isSupabaseReady } from '../services/supabase';

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
// GET /api/admin/elo/config
// ---------------------------------------------------------------------------

router.get(
  '/admin/elo/config',
  adminLimiter,
  requireAdminAuth,
  async (_req: Request, res: Response) => {
    try {
      const config = getEloConfig();
      return ok(res, {
        config,
        supabaseReady: isSupabaseReady(),
      });
    } catch (err) {
      console.error('[admin/elo/config GET]', err);
      return fail(res, 500, 'Failed to read ELO config');
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/admin/elo/config
//   body: { attributionMode?: 'legacy'|'per_event', attributionWeights?: {...} }
//
// Day 3 scope: only attribution_mode + weights are editable here. Deeper
// tuning (outcomeWeights, roleKWeights) reserved for Phase 2.5.
// ---------------------------------------------------------------------------

router.post(
  '/admin/elo/config',
  adminLimiter,
  requireAdminAuth,
  async (req: Request, res: Response) => {
    const auth = req.claimAuth!;
    const body = req.body as {
      attributionMode?: EloAttributionMode;
      attributionWeights?: Partial<EloConfig['attributionWeights']>;
    };

    const partial: Partial<EloConfig> = {};

    if (body.attributionMode !== undefined) {
      if (body.attributionMode !== 'legacy' && body.attributionMode !== 'per_event') {
        return fail(res, 400, "attributionMode must be 'legacy' or 'per_event'");
      }
      partial.attributionMode = body.attributionMode;
    }

    if (body.attributionWeights !== undefined) {
      if (typeof body.attributionWeights !== 'object' || body.attributionWeights === null) {
        return fail(res, 400, 'attributionWeights must be an object');
      }
      const w = body.attributionWeights;
      if (w.proposal !== undefined && typeof w.proposal !== 'number') {
        return fail(res, 400, 'attributionWeights.proposal must be a number');
      }
      if (
        w.outerWhiteInnerBlack !== undefined &&
        typeof w.outerWhiteInnerBlack !== 'number'
      ) {
        return fail(res, 400, 'attributionWeights.outerWhiteInnerBlack must be a number');
      }
      // Phase 2.5 fields
      if (w.information !== undefined && typeof w.information !== 'number') {
        return fail(res, 400, 'attributionWeights.information must be a number');
      }
      if (w.misdirection !== undefined && typeof w.misdirection !== 'number') {
        return fail(res, 400, 'attributionWeights.misdirection must be a number');
      }
      if (
        w.seatOrderEnabled !== undefined &&
        typeof w.seatOrderEnabled !== 'boolean'
      ) {
        return fail(res, 400, 'attributionWeights.seatOrderEnabled must be a boolean');
      }
      partial.attributionWeights = {
        ...getEloConfig().attributionWeights,
        ...w,
      };
    }

    if (Object.keys(partial).length === 0) {
      return fail(res, 400, 'No recognised fields in request body');
    }

    const result = await persistEloConfigOverride(partial, auth.email ?? auth.uid);
    const config = getEloConfig();

    if (!result.ok) {
      // In-memory applied but Supabase persistence failed — surface warning
      // so the admin knows the change will not survive a restart.
      return res.status(207).json({
        success: true,
        data: { config, supabaseReady: isSupabaseReady() },
        warning: result.error,
      });
    }

    return ok(res, { config, supabaseReady: isSupabaseReady() });
  }
);

export const adminEloRouter = router;
