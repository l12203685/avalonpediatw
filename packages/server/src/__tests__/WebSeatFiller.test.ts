/**
 * 網站「叫百科AI 補位」表單的純函式（packages/web/src/utils/seatFiller.ts；web 沒有測試執行器，在這裡測）與 #seat-filler 深連結。
 */
import { describe, expect, it } from 'vitest';
import {
  SEAT_FILLER_BOT_OPTIONS, SEAT_FILLER_LIMITS_LINE, seatFillerReplyText, seatFillerRequestBody,
} from '../../../web/src/utils/seatFiller';
import { parseStatsHash } from '../../../web/src/utils/statsLinks';
import { parseBots, SEAT_FILLER_LIMITS } from '../services/signagePlayerDispatch';
import { WEB_SEAT_FILLER_IP_LIMIT } from '../routes/seatFiller';

describe('web seat-filler form', () => {
  it('request body: trimmed, default 1 bot, no empty password', () => {
    expect(seatFillerRequestBody({ room: ' 1460 ', bots: '', password: '  ' })).toEqual({ room: '1460', bots: '1' });
    expect(seatFillerRequestBody({ room: '百科陪練', bots: '補滿', password: ' 1234 ' })).toEqual({ room: '百科陪練', bots: '補滿', password: '1234' });
  });

  it('every menu option is accepted by the server parser', () => {
    for (const o of SEAT_FILLER_BOT_OPTIONS) expect(parseBots(o)).not.toBeNull();
    expect(parseBots('補滿')).toBe(9);
  });

  it('the one-line limits match the server', () => {
    expect(SEAT_FILLER_LIMITS_LINE).toContain(`每 ${SEAT_FILLER_LIMITS.cooldownMs / 60000} 分鐘一次`);
    expect(SEAT_FILLER_LIMITS_LINE).toContain(`每天 ${SEAT_FILLER_LIMITS.dailyMax} 次`);
    expect(SEAT_FILLER_LIMITS_LINE).toContain(`同一房 ${SEAT_FILLER_LIMITS.sameRoomMs / 60000} 分鐘`);
    expect(SEAT_FILLER_LIMITS_LINE).toContain(`每小時 ${WEB_SEAT_FILLER_IP_LIMIT.max} 次`);
  });

  it('reply text: the server message as is; status fallbacks otherwise', () => {
    expect(seatFillerReplyText(200, { ok: true, code: 'dispatched', message: '已叫百科AI 到「Room-1460」' })).toEqual({ ok: true, text: '已叫百科AI 到「Room-1460」' });
    expect(seatFillerReplyText(429, { ok: false, message: '補位機器人剛被叫過' })).toEqual({ ok: false, text: '補位機器人剛被叫過' });
    expect(seatFillerReplyText(429, { error: 'Too many requests, please try again later.' }).text).toBe('送太快了，請等一分鐘再試。');
    expect(seatFillerReplyText(503, null).text).toContain('伺服器暫時不能處理');
    expect(seatFillerReplyText(404, {}).text).toContain('HTTP 404');
  });

  it('#seat-filler / #fill / #補位 open the AI games page (the form is at the top)', () => {
    for (const h of ['#seat-filler', '#seatfiller', '#fill', '#補位', '#%E8%A3%9C%E4%BD%8D']) {
      expect(parseStatsHash(h)).toEqual({ kind: 'aiGames', id: null });
    }
    expect(parseStatsHash('#ai-games')).toEqual({ kind: 'aiGames', id: null });
  });
});
