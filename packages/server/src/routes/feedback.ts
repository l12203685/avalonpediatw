// -- Supabase SQL to run manually:
// CREATE TABLE IF NOT EXISTS feedback (
//   id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   type        TEXT NOT NULL CHECK (type IN ('bug', 'suggestion')),
//   message     TEXT NOT NULL,
//   user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
//   display_name TEXT,
//   game_state  TEXT,
//   created_at  TIMESTAMPTZ DEFAULT NOW()
// );
// CREATE TABLE IF NOT EXISTS error_reports (
//   id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   message     TEXT NOT NULL,
//   stack       TEXT,
//   game_state  TEXT,
//   created_at  TIMESTAMPTZ DEFAULT NOW()
// );

import { Router, Request, Response, IRouter } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { verifyIdToken, isFirebaseAdminReady, getAdminFirestore } from '../services/firebase';
import { getSupabaseClient, isSupabaseReady, getSupabaseIdByFirebaseUid } from '../services/supabase';
import { createHttpRateLimit } from '../middleware/rateLimit';

// 2026-04-24 #supabase-retire Batch 1.1+1.2 (hineko_20260424_1240):
// Dual-write feedback / error_reports to Firestore alongside Supabase.
// Phase 4 (table drop) ETA 2 weeks; Supabase remains the read source for
// admin until then. Each Firestore write is best-effort try/catch — a
// Firestore outage must not break the legacy Supabase path during
// dual-write window.
async function dualWriteFirestore(
  collection: 'feedback' | 'error_reports',
  doc: Record<string, unknown>,
): Promise<void> {
  if (!isFirebaseAdminReady()) return;
  try {
    const fs = getAdminFirestore();
    await fs.collection(collection).add({
      ...doc,
      created_at_ms: Date.now(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${collection}] firestore dual-write error:`, msg);
  }
}

const router: IRouter = Router();
const JWT_SECRET = process.env.JWT_SECRET as string;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

const feedbackLimit = createHttpRateLimit(60_000, 10);  // 10 per min per IP
const errorLimit    = createHttpRateLimit(60_000, 30);  // 30 per min per IP

// Dedup Discord notifications for auto-captured errors (1 hr cooldown per signature)
const errorNotifyCache = new Map<string, number>();
const ERROR_NOTIFY_COOLDOWN = 60 * 60 * 1000;

async function sendDiscord(content: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    });
  } catch (err) {
    console.error('[discord-webhook] failed:', err);
  }
}

async function resolveUser(authHeader: string | undefined): Promise<{ supabaseId: string; displayName: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // Try custom JWT (Discord / Line).
  // Guest JWT 也會 verify 成功但 sub 是 server-minted guest uuid（非 users.id），
  // 跳過以免把 guest 當成 Discord/Line 帳號查 feedback user_id。
  try {
    const payload = verify(token, JWT_SECRET) as JwtPayload & { provider?: string };
    if (payload.sub && payload.displayName && payload.provider !== 'guest') {
      return { supabaseId: payload.sub as string, displayName: payload.displayName as string };
    }
  } catch { /* ignore */ }

  // Try Firebase
  if (isFirebaseAdminReady()) {
    try {
      const decoded = await verifyIdToken(token);
      const supabaseId = await getSupabaseIdByFirebaseUid(decoded.uid);
      return {
        supabaseId: supabaseId || decoded.uid,
        displayName: (decoded.name as string) || (decoded.email as string) || '匿名',
      };
    } catch { /* ignore */ }
  }

  return null;
}

// POST /api/feedback — user-submitted bug report or suggestion
router.post('/', feedbackLimit, async (req: Request, res: Response) => {
  const { type, message, gameState } = req.body as {
    type?: string;
    message?: string;
    gameState?: string;
  };

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message required' });
    return;
  }
  if (type !== 'bug' && type !== 'suggestion') {
    res.status(400).json({ error: 'type must be bug or suggestion' });
    return;
  }

  const user         = await resolveUser(req.headers.authorization);
  const displayName  = user?.displayName || '匿名玩家';
  const trimmedMsg   = message.trim().slice(0, 1000);

  if (isSupabaseReady()) {
    const sb = getSupabaseClient()!;
    await sb.from('feedback').insert({
      type,
      message: trimmedMsg,
      user_id:      user?.supabaseId || null,
      display_name: displayName,
      game_state:   gameState || null,
    }).then(({ error }) => { if (error) console.error('[feedback] db error:', error.message); });
  }

  // 2026-04-24 #supabase-retire dual-write to Firestore (Batch 1.1)
  await dualWriteFirestore('feedback', {
    type,
    message: trimmedMsg,
    user_id:      user?.supabaseId || null,
    display_name: displayName,
    game_state:   gameState || null,
  });

  const emoji    = type === 'bug' ? '🐛' : '💡';
  const label    = type === 'bug' ? 'Bug 回報' : '功能建議';
  const pageInfo = gameState ? ` (頁面: \`${gameState}\`)` : '';
  await sendDiscord(
    `${emoji} **${label}** — ${displayName}${pageInfo}\n>>> ${trimmedMsg.replace(/\n/g, '\n> ')}`
  );

  res.json({ ok: true });
});

// POST /api/feedback/errors — auto-captured frontend errors
router.post('/errors', errorLimit, async (req: Request, res: Response) => {
  const { message, stack, gameState } = req.body as {
    message?: string;
    stack?: string;
    gameState?: string;
  };

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message required' });
    return;
  }

  const trimmedMsg   = message.trim().slice(0, 500);
  const trimmedStack = typeof stack === 'string' ? stack.slice(0, 2000) : undefined;

  if (isSupabaseReady()) {
    const sb = getSupabaseClient()!;
    await sb.from('error_reports').insert({
      message:    trimmedMsg,
      stack:      trimmedStack || null,
      game_state: gameState || null,
    }).then(({ error }) => { if (error) console.error('[error_reports] db error:', error.message); });
  }

  // 2026-04-24 #supabase-retire dual-write to Firestore (Batch 1.2)
  await dualWriteFirestore('error_reports', {
    message:    trimmedMsg,
    stack:      trimmedStack || null,
    game_state: gameState || null,
  });

  // Discord notify with dedup
  const sig         = trimmedMsg.slice(0, 100);
  const now         = Date.now();
  const lastNotified = errorNotifyCache.get(sig) || 0;
  if (now - lastNotified > ERROR_NOTIFY_COOLDOWN) {
    errorNotifyCache.set(sig, now);
    const pageInfo    = gameState ? ` (\`${gameState}\`)` : '';
    const stackPreview = trimmedStack
      ? `\n\`\`\`\n${trimmedStack.slice(0, 800)}\n\`\`\``
      : '';
    await sendDiscord(`⚠️ **自動錯誤${pageInfo}**\n> ${trimmedMsg}${stackPreview}`);
  }

  res.json({ ok: true });
});

export { router as feedbackRouter };
