/**
 * 網站「叫百科AI 補位」（站長 2026-11-19：「現在 signage 上開局, 如果想補百科AI 只能從 line/dc 補嗎? 有沒有辦法讓不在群組內的人補」）。
 *
 *   POST /api/seat-filler   { room: 房號或房間描述, bots?: 1–9 或「補滿」, password?: 私房密碼 }   不用登入
 *
 * 跟 LINE /補位、DC /機器人補位 用同一個 dispatcher（services/signagePlayerDispatch.ts）：驗證一樣（parseSeatFillerArgs）、
 * 全站限制共用一份（每 3 分鐘一次、每天 10 次、同一房 15 分鐘），回覆文字也一樣（bots/seatFiller/commands.ts）。
 * 網站多一層每個 IP 每小時 3 次（只算真的送出去的；格式錯、被全站限制擋下、GitHub 回錯誤都不算），
 * 外加每個 IP 每分鐘 10 個請求的防洗版。IP 只用雜湊值存在記憶體裡，不寫 log；密碼、token 也不寫。
 *
 * 回應都是 { ok, code, message }，message 就是要顯示給玩家的中文：
 *   200 dispatched │ 400 usage/room/bots/password │ 429 cooldown/daily_cap/duplicate_room/ip_limit
 *   503 not_configured │ 502 github_error（連不到 GitHub 時 202：可能已經送出）
 *
 * docs/BOT_SETUP.md「補位機器人」.
 */
import crypto from 'crypto';
import { Router, type IRouter, type Request, type Response } from 'express';
import { createHttpRateLimit } from '../middleware/rateLimit';
import {
  getSignagePlayerDispatcher,
  parseSeatFillerArgs,
  type SeatFillerOutcome,
} from '../services/signagePlayerDispatch';
import { formatSeatFillerOutcome, formatSeatFillerParseError, formatWait } from '../bots/seatFiller/commands';

/** 網站每個 IP 的補位次數（只算送出去的）。 */
export const WEB_SEAT_FILLER_IP_LIMIT = { max: 3, windowMs: 60 * 60 * 1000 } as const;

/** 防洗版：每個 IP 每分鐘最多 10 個請求（含格式錯的）。 */
const burstLimit = createHttpRateLimit(60_000, 10);

/** 同 middleware/rateLimit.ts 取 IP 的方式；只拿來算雜湊。 */
function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
}

/** 記憶體裡只放 IP 的雜湊（每個程序一把隨機鹽，重啟就換）。 */
const IP_SALT = crypto.randomBytes(16).toString('hex');
function ipKey(req: Request): string {
  return crypto.createHash('sha256').update(`${IP_SALT}:${clientIp(req)}`).digest('hex').slice(0, 32);
}

/** IP 雜湊 → 這一小時內送出的時間（epoch ms）。 */
const ipSends = new Map<string, number[]>();

function recentSends(key: string, now: number): number[] {
  const list = (ipSends.get(key) ?? []).filter((t) => now - t < WEB_SEAT_FILLER_IP_LIMIT.windowMs);
  if (list.length) ipSends.set(key, list);
  else ipSends.delete(key);
  return list;
}

function pruneIpSends(now: number): void {
  for (const key of [...ipSends.keys()]) recentSends(key, now);
}

/** Test-only: forget every IP's count. */
export function __resetSeatFillerIpLimitForTests(): void {
  ipSends.clear();
}

/** body.room 可以是字串或數字（1460）；其他型別當沒填。 */
function asText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

const OUTCOME_STATUS: Record<SeatFillerOutcome['kind'], number> = {
  dispatched: 200,
  not_configured: 503,
  cooldown: 429,
  daily_cap: 429,
  duplicate_room: 429,
  github_error: 502,
};

function reply(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ ok: status === 200, code, message });
}

const router: IRouter = Router();

router.post('/', burstLimit, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { room?: unknown; bots?: unknown; password?: unknown };
  const bots = typeof body.bots === 'number' ? body.bots : asText(body.bots);
  const parsed = parseSeatFillerArgs(asText(body.room) ?? '', bots ?? null, asText(body.password) ?? null);
  if (!parsed.ok) return reply(res, 400, parsed.error, formatSeatFillerParseError(parsed.error, 'web'));

  const dispatcher = getSignagePlayerDispatcher();
  // 全站限制先看（沒設定、今天用完、同房、冷卻）：被擋下的不算進這個 IP 的次數
  const rejected = dispatcher.check(parsed.request);
  if (rejected) return reply(res, OUTCOME_STATUS[rejected.kind], rejected.kind, formatSeatFillerOutcome(rejected));

  const now = Date.now();
  const key = ipKey(req);
  const sends = recentSends(key, now);
  if (sends.length >= WEB_SEAT_FILLER_IP_LIMIT.max) {
    const wait = WEB_SEAT_FILLER_IP_LIMIT.windowMs - (now - sends[0]);
    return reply(res, 429, 'ip_limit', `同一個網路每小時最多從網站叫 ${WEB_SEAT_FILLER_IP_LIMIT.max} 次，請 ${formatWait(wait)}後再試。`);
  }
  // 先佔位（同一個 IP 同時送兩個也只算得到額度內的），GitHub 回錯誤再還
  sends.push(now);
  ipSends.set(key, sends);
  pruneIpSends(now);

  let outcome: SeatFillerOutcome;
  try {
    outcome = await dispatcher.dispatch(parsed.request);
  } catch {
    outcome = { kind: 'github_error', status: null };
  }
  const counted = outcome.kind === 'dispatched' || (outcome.kind === 'github_error' && outcome.status === null);
  if (!counted) {
    const list = ipSends.get(key);
    const i = list?.lastIndexOf(now) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
  }
  const status = outcome.kind === 'github_error' && outcome.status === null ? 202 : OUTCOME_STATUS[outcome.kind];
  reply(res, status, outcome.kind, formatSeatFillerOutcome(outcome));
});

export { router as seatFillerRouter };
