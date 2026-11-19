/**
 * 網站「叫百科AI 補位」⇄ 伺服器 POST /api/seat-filler（packages/server/src/routes/seatFiller.ts）。不用登入。
 */
import { SEAT_FILLER_OFFLINE_TEXT, seatFillerReplyText, seatFillerRequestBody, type SeatFillerForm, type SeatFillerReply } from '../utils/seatFiller';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3001';

/** 送出補位請求；不會丟錯，回傳要顯示的字。 */
export async function requestSeatFiller(form: SeatFillerForm): Promise<SeatFillerReply> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}/api/seat-filler`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(seatFillerRequestBody(form)),
    });
  } catch {
    return { ok: false, text: SEAT_FILLER_OFFLINE_TEXT };
  }
  const body: unknown = await res.json().catch(() => ({}));
  return seatFillerReplyText(res.status, body);
}
