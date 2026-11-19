/**
 * POST /api/seat-filler（網站「叫百科AI 補位」，站長 2026-11-19）：驗證跟 LINE／DC 一樣、全站限制共用同一個 dispatcher、
 * 每個 IP 每小時 3 次（只算送出去的）、沒設 token 回「還沒設定好」、回應不帶密碼／token。真的 dispatcher，fetch 與時鐘是假的。
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seatFillerRouter, __resetSeatFillerIpLimitForTests } from '../routes/seatFiller';
import {
  SignagePlayerDispatcher,
  __setSignagePlayerDispatcherForTests,
  getSignagePlayerDispatcher,
} from '../services/signagePlayerDispatch';
import { answerSeatFillerTextCommand } from '../bots/seatFiller/commands';

let now = Date.UTC(2026, 10, 19, 4, 0, 0);
let status = 204;
let fetchMock: ReturnType<typeof vi.fn>;
let ipSeq = 0;
let ip = '';

function installDispatcher(env: NodeJS.ProcessEnv = { GITHUB_DISPATCH_TOKEN: 'test-token' }): void {
  fetchMock = vi.fn(async () => ({ status, ok: status >= 200 && status < 300 }));
  __setSignagePlayerDispatcherForTests(
    new SignagePlayerDispatcher({
      fetch: fetchMock,
      now: () => now,
      env: () => env,
      logger: { info: () => undefined, warn: () => undefined },
    }),
  );
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/api/seat-filler', seatFillerRouter);
  return a;
}

function post(body: unknown, from = ip) {
  return request(app()).post('/api/seat-filler').set('X-Forwarded-For', from).send(body as object);
}

/** 跳過全站冷卻（3 分鐘）。 */
function pastCooldown(): void {
  now += 4 * 60_000;
}

beforeEach(() => {
  now = Date.UTC(2026, 10, 19, 4, 0, 0);
  status = 204;
  ipSeq += 1;
  ip = `203.0.113.${ipSeq}`; // 每個測試換一個 IP，防洗版的每分鐘上限才不會跨測試累積
  __resetSeatFillerIpLimitForTests();
  installDispatcher();
});
afterEach(() => {
  __setSignagePlayerDispatcherForTests();
});

describe('POST /api/seat-filler — validation (same as parseSeatFillerArgs)', () => {
  it('missing room, bad room, bad bots, bad password → 400 with the chat wording; nothing is sent', async () => {
    const cases: [unknown, string, string][] = [
      [{}, 'usage', '請填房號或房間描述'],
      [{ room: '   ' }, 'usage', '請填房號或房間描述'],
      [{ room: { x: 1 } }, 'usage', '請填房號或房間描述'],
      [{ room: 'a"b' }, 'room', '房號或房間描述不對'],
      [{ room: 'x'.repeat(41) }, 'room', '房號或房間描述不對'],
      [{ room: '1460', bots: 12 }, 'bots', '人數要是 1–9'],
      [{ room: '1460', bots: '0' }, 'bots', '人數要是 1–9'],
      [{ room: '1460', password: 'a b' }, 'password', '密碼最多 32 個字'],
    ];
    for (const [body, code, text] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code });
      expect(res.body.message).toContain(text);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a number room, 補滿, a description and a password; the password goes to GitHub only', async () => {
    const res = await post({ room: 1460, bots: '補滿', password: 'pw-1234' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      code: 'dispatched',
      message: '已叫百科AI 到「Room-1460」（補到 10 人），約 1–2 分鐘後進房；局數不限，要它走就在房內聊天室打「離開」。',
    });
    expect(JSON.stringify(res.body)).not.toContain('pw-1234');
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.inputs).toEqual({ room: 'Room-1460', bots: '9', password: 'pw-1234' });

    pastCooldown();
    const byTitle = await post({ room: '  百科陪練 ', bots: 2 });
    expect(byTitle.body.message).toBe('已叫百科AI 到「百科陪練」（2 個），約 1–2 分鐘後進房；局數不限，要它走就在房內聊天室打「離開」。');

    pastCooldown();
    const dflt = await post({ room: 'room-77' });
    expect(dflt.body.message).toContain('（1 個）');
  });
});

describe('POST /api/seat-filler — shared limits with LINE／DC', () => {
  it('a web dispatch starts the site-wide cooldown that LINE sees, and vice versa', async () => {
    expect((await post({ room: '1460' })).status).toBe(200);
    now += 50_000;
    expect(await answerSeatFillerTextCommand('/補位 1461')).toBe('補位機器人剛被叫過，請 2 分 10 秒後再試（全站每 3 分鐘最多叫一次）。');

    pastCooldown();
    expect(await answerSeatFillerTextCommand('/補位 1462')).toContain('已叫百科AI');
    const res = await post({ room: '1463' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ ok: false, code: 'cooldown' });
    expect(res.body.message).toContain('補位機器人剛被叫過');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('same room within 15 minutes and the daily cap are the shared ones', async () => {
    await answerSeatFillerTextCommand('/補位 1460');
    pastCooldown();
    const dup = await post({ room: 'Room-1460' });
    expect(dup.status).toBe(429);
    expect(dup.body).toMatchObject({ code: 'duplicate_room', message: 'Room-1460 在 15 分鐘內已經叫過補位機器人了，請 11 分鐘後再試。' });

    installDispatcher();
    const d = getSignagePlayerDispatcher();
    // 用掉今天剩下的次數（不同房、跳過冷卻）
    for (let i = 0; i < 10; i += 1) {
      expect((await d.dispatch({ room: `Room-${2000 + i}`, byTitle: false, bots: 1, password: '' })).kind).toBe('dispatched');
      pastCooldown();
    }
    const cap = await post({ room: '1470' });
    expect(cap.status).toBe(429);
    expect(cap.body).toMatchObject({ code: 'daily_cap', message: '今天的補位次數已經用完（每天最多 10 次，台北時間午夜重置）。' });
  });

  it('no token → 503 「還沒設定好」', async () => {
    installDispatcher({});
    const res = await post({ room: '1460' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, code: 'not_configured', message: '補位機器人還沒設定好（管理者尚未完成設定），暫時不能叫。' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GitHub error → 502, no slot used (shared or per-IP); no answer → 202 and the slot is kept', async () => {
    status = 403;
    const res = await post({ room: '1460' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, code: 'github_error', message: '叫補位機器人失敗（GitHub 回應 403），請稍後再試或告訴管理者。' });
    expect(JSON.stringify(res.body)).not.toContain('test-token');

    // 沒扣：馬上可以再叫同一房
    status = 204;
    expect((await post({ room: '1460' })).status).toBe(200);

    pastCooldown();
    fetchMock.mockImplementationOnce(async () => { throw new Error('timeout'); });
    const lost = await post({ room: '1461' });
    expect(lost.status).toBe(202);
    expect(lost.body.message).toContain('連不到 GitHub');
  });
});

describe('POST /api/seat-filler — per-IP limit', () => {
  it('3 sends per IP per hour; the 4th is refused without touching the shared budget; another IP still works', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await post({ room: `${3000 + i}` })).status).toBe(200);
      pastCooldown();
    }
    const res = await post({ room: '3010' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ip_limit');
    expect(res.body.message).toMatch(/^同一個網路每小時最多從網站叫 3 次，請 .+後再試。$/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect((await post({ room: '3010' }, '198.51.100.7')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('refusals (format, shared limits, GitHub errors) do not use the IP quota', async () => {
    await post({ room: 'a"b' });
    await post({ room: '4000' }); // sent (1)
    await post({ room: '4001' }); // cooldown — not counted
    pastCooldown();
    status = 500;
    await post({ room: '4002' }); // GitHub error — not counted
    status = 204;
    expect((await post({ room: '4003' })).status).toBe(200); // (2)
    pastCooldown();
    expect((await post({ room: '4004' })).status).toBe(200); // (3)
    pastCooldown();
    expect((await post({ room: '4005' })).body.code).toBe('ip_limit');
  });
});
