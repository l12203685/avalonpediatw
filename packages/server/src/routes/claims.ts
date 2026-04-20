/**
 * Claim routes — player-facing + admin-facing endpoints for binding
 * historical game records to user accounts.
 *
 * Player endpoints (require any signed-in caller):
 *   GET    /api/claims/mine           — my claim history
 *   POST   /api/claims                — submit a new claim request
 *   GET    /api/claims/auto-match     — system-suggested candidate records
 *   POST   /api/claims/search-manual  — fuzzy search by old nickname
 *
 * Admin endpoints (require email on whitelist):
 *   GET    /api/admin/claims/pending       — queue of pending claims
 *   POST   /api/admin/claims/:id/approve   — approve (optionally a subset)
 *   POST   /api/admin/claims/:id/reject    — reject with reason
 *   GET    /api/admin/claims/:id/records   — hydrated record details
 *   GET    /api/admin/admins               — list admin emails
 *   POST   /api/admin/admins               — add an admin email
 *   DELETE /api/admin/admins/:email        — remove an admin email
 *   GET    /api/admin/audit                — audit log (latest 100)
 *   GET    /api/admin/me                   — { isAdmin, email }
 */

import { Router, Request, Response, IRouter } from 'express';
import { createHttpRateLimit } from '../middleware/rateLimit';
import { requireClaimAuth, requireAdminAuth } from '../middleware/claimAuth';
import {
  createClaim,
  listMyClaims,
  listPendingClaims,
  autoMatchCandidates,
  searchRecordsByName,
  hydrateClaimRecords,
  approveClaim,
  rejectClaim,
  listAuditLog,
  writeAudit,
} from '../services/ClaimService';
import {
  isAdmin,
  listAdmins,
  addAdmin,
  removeAdmin,
} from '../services/AdminService';

const router: IRouter = Router();

// Rate limits: normal users 30/min, admins 60/min (more forgiving)
const userLimiter  = createHttpRateLimit(60 * 1000, 30);
const adminLimiter = createHttpRateLimit(60 * 1000, 60);

// ---------------------------------------------------------------------------
// Envelope helpers
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

// ---------------------------------------------------------------------------
// Player routes
// ---------------------------------------------------------------------------

// GET /api/claims/mine
router.get('/claims/mine', userLimiter, requireClaimAuth, async (req: Request, res: Response) => {
  try {
    const auth = req.claimAuth!;
    const claims = await listMyClaims(auth.uid);
    return ok(res, { claims });
  } catch (err) {
    console.error('[claims/mine]', err);
    return fail(res, 500, 'Failed to load claims');
  }
});

// POST /api/claims
// body: { targetRecordIds: string[], evidenceNote?: string, autoMatched?: boolean }
router.post('/claims', userLimiter, requireClaimAuth, async (req: Request, res: Response) => {
  const auth = req.claimAuth!;
  const body = req.body as {
    targetRecordIds?: string[];
    evidenceNote?: string;
    autoMatched?: boolean;
  };

  const targetRecordIds = Array.isArray(body.targetRecordIds) ? body.targetRecordIds : [];
  if (targetRecordIds.length === 0) {
    return fail(res, 400, '請至少勾選一場戰績');
  }
  if (targetRecordIds.length > 500) {
    return fail(res, 400, '單次申請上限 500 場');
  }

  try {
    const claim = await createClaim({
      uid: auth.uid,
      email: auth.email,
      displayName: auth.displayName,
      targetRecordIds,
      evidenceNote: body.evidenceNote ?? '',
      autoMatched: !!body.autoMatched,
    });
    return ok(res, { claim });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[claims/create]', msg);
    return fail(res, 400, msg);
  }
});

// GET /api/claims/auto-match
router.get('/claims/auto-match', userLimiter, requireClaimAuth, async (req: Request, res: Response) => {
  try {
    const auth = req.claimAuth!;
    const records = await autoMatchCandidates({
      uid: auth.uid,
      email: auth.email,
      displayName: auth.displayName,
    });
    return ok(res, { records });
  } catch (err) {
    console.error('[claims/auto-match]', err);
    return fail(res, 500, 'Failed to auto-match records');
  }
});

// POST /api/claims/search-manual
// body: { oldNickname: string, since?: number, until?: number }
router.post('/claims/search-manual', userLimiter, requireClaimAuth, async (req: Request, res: Response) => {
  const body = req.body as { oldNickname?: string; since?: number; until?: number };
  const query = (body.oldNickname ?? '').trim();
  if (!query) return fail(res, 400, '請輸入舊暱稱');

  try {
    const records = await searchRecordsByName(query, {
      since: typeof body.since === 'number' ? body.since : undefined,
      until: typeof body.until === 'number' ? body.until : undefined,
    });
    return ok(res, { records });
  } catch (err) {
    console.error('[claims/search-manual]', err);
    return fail(res, 500, 'Failed to search records');
  }
});

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

// GET /api/admin/me — tell the frontend whether the caller is an admin.
// Uses requireClaimAuth (not requireAdminAuth) so even non-admins get a
// clear response instead of 403.
router.get('/admin/me', userLimiter, requireClaimAuth, async (req: Request, res: Response) => {
  const auth = req.claimAuth!;
  const adminFlag = auth.email ? await isAdmin(auth.email) : false;
  return ok(res, {
    isAdmin: adminFlag,
    email: auth.email,
    displayName: auth.displayName,
    provider: auth.provider,
  });
});

// GET /api/admin/claims/pending
router.get('/admin/claims/pending', adminLimiter, requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const claims = await listPendingClaims();
    // Hydrate each claim's targetRecordIds so admins see full record details
    const enriched = await Promise.all(claims.map(async claim => ({
      claim,
      records: await hydrateClaimRecords(claim.targetRecordIds),
    })));
    return ok(res, { pending: enriched });
  } catch (err) {
    console.error('[admin/claims/pending]', err);
    return fail(res, 500, 'Failed to load pending claims');
  }
});

// GET /api/admin/claims/:id/records — hydrate a specific claim's records on demand
router.get('/admin/claims/:id/records', adminLimiter, requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const claims = await listPendingClaims();
    const claim = claims.find(c => c.id === id);
    if (!claim) return fail(res, 404, 'Claim not found or already reviewed');
    const records = await hydrateClaimRecords(claim.targetRecordIds);
    return ok(res, { claim, records });
  } catch (err) {
    console.error('[admin/claims/records]', err);
    return fail(res, 500, 'Failed to load records');
  }
});

// POST /api/admin/claims/:id/approve
// body: { approvedRecordIds: string[] }
router.post('/admin/claims/:id/approve', adminLimiter, requireAdminAuth, async (req: Request, res: Response) => {
  const auth = req.claimAuth!;
  const { id } = req.params;
  const body = req.body as { approvedRecordIds?: string[] };
  const approvedIds = Array.isArray(body.approvedRecordIds) ? body.approvedRecordIds : [];
  if (approvedIds.length === 0) {
    return fail(res, 400, '請至少勾選一場要核准');
  }
  try {
    const claim = await approveClaim(id, auth.email ?? 'unknown', approvedIds);
    return ok(res, { claim });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[admin/claims/approve]', msg);
    return fail(res, 400, msg);
  }
});

// POST /api/admin/claims/:id/reject
// body: { reason: string }
router.post('/admin/claims/:id/reject', adminLimiter, requireAdminAuth, async (req: Request, res: Response) => {
  const auth = req.claimAuth!;
  const { id } = req.params;
  const body = req.body as { reason?: string };
  const reason = (body.reason ?? '').trim();
  if (!reason) return fail(res, 400, '請填寫否決理由');
  try {
    const claim = await rejectClaim(id, auth.email ?? 'unknown', reason);
    return ok(res, { claim });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[admin/claims/reject]', msg);
    return fail(res, 400, msg);
  }
});

// GET /api/admin/admins
router.get('/admin/admins', adminLimiter, requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const emails = await listAdmins();
    return ok(res, { emails });
  } catch (err) {
    console.error('[admin/admins/list]', err);
    return fail(res, 500, 'Failed to load admins');
  }
});

// POST /api/admin/admins
// body: { email: string }
router.post('/admin/admins', adminLimiter, requireAdminAuth, async (req: Request, res: Response) => {
  const auth = req.claimAuth!;
  const body = req.body as { email?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return fail(res, 400, '請輸入合法 email');
  }
  try {
    const emails = await addAdmin(email);
    await writeAudit({
      action: 'addAdmin',
      adminEmail: auth.email ?? 'unknown',
      details: `added=${email}`,
    });
    return ok(res, { emails });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[admin/admins/add]', msg);
    return fail(res, 400, msg);
  }
});

// DELETE /api/admin/admins/:email
router.delete('/admin/admins/:email', adminLimiter, requireAdminAuth, async (req: Request, res: Response) => {
  const auth = req.claimAuth!;
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();
  if (!email) return fail(res, 400, '請輸入合法 email');
  try {
    const emails = await removeAdmin(email);
    await writeAudit({
      action: 'removeAdmin',
      adminEmail: auth.email ?? 'unknown',
      details: `removed=${email}`,
    });
    return ok(res, { emails });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[admin/admins/remove]', msg);
    return fail(res, 400, msg);
  }
});

// GET /api/admin/audit
router.get('/admin/audit', adminLimiter, requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const entries = await listAuditLog(100);
    return ok(res, { entries });
  } catch (err) {
    console.error('[admin/audit]', err);
    return fail(res, 500, 'Failed to load audit log');
  }
});

export { router as claimsRouter };
