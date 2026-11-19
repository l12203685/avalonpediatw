/**
 * 網站「叫百科AI 補位」表單的純函式（站長 2026-11-19：不在 LINE／DC 群組的人也能叫百科AI 補位）。
 * 伺服器：POST /api/seat-filler（packages/server/src/routes/seatFiller.ts）；驗證、限制、回覆文字都跟 LINE /補位、DC /機器人補位 同一套，
 * 這裡只做表單 → 請求內容、伺服器回應 → 要顯示的字。web 沒有測試執行器，在 server 的 __tests__/WebSeatFiller.test.ts 測。
 */

/** 人數選單：1–9，「補滿」= 補到房間 10 人。 */
export const SEAT_FILLER_BOT_OPTIONS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '補滿'];

/** 限制（跟伺服器一致；LINE／DC／網站共用一份）。 */
export const SEAT_FILLER_LIMITS_LINE = '全站（含 LINE／DC）每 3 分鐘一次、每天 10 次，同一房 15 分鐘內不重複；網站每個網路每小時 3 次。';

export interface SeatFillerForm {
  room: string;
  bots: string;
  password: string;
}

/** 表單 → 請求內容（前後空白去掉；沒填密碼就不送）。 */
export function seatFillerRequestBody(form: SeatFillerForm): { room: string; bots: string; password?: string } {
  const password = form.password.trim();
  return { room: form.room.trim(), bots: form.bots || '1', ...(password ? { password } : {}) };
}

export type SeatFillerReply = { ok: boolean; text: string };

/** 伺服器回應 → 顯示的字。有 message 就照登（伺服器的中文）；沒有就依狀態碼。 */
export function seatFillerReplyText(status: number, body: unknown): SeatFillerReply {
  const b = (body ?? {}) as { ok?: unknown; message?: unknown };
  if (typeof b.message === 'string' && b.message.trim()) {
    return { ok: b.ok === true, text: b.message };
  }
  if (status === 429) return { ok: false, text: '送太快了，請等一分鐘再試。' };
  if (status >= 500) return { ok: false, text: '伺服器暫時不能處理（可能還在喚醒），請稍後再試。' };
  return { ok: false, text: `送出失敗（HTTP ${status}），請稍後再試。` };
}

/** 連不到伺服器時顯示的字。 */
export const SEAT_FILLER_OFFLINE_TEXT = '連不到伺服器（剛喚醒時要等 30–60 秒），請稍後再試。';
