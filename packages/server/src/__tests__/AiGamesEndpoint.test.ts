/**
 * GET /api/ai-games、GET /api/ai-games/:id、POST /api/ai-games/:id/flag（網站「百科AI 對局」頁），DC 用 mock fetch。
 * 只認這個論壇裡標題「百科AI對局」開頭、起始訊息是機器人發的討論串；附件只從 Discord CDN 讀；網站上不顯示真人暱稱；
 * 回饋貼成那篇的回覆；快取 5 分鐘；沒設 token 503。名字都是編的。
 */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiGamesRouter } from '../routes/aiGames';
import { createAiGameService, setAiGameServiceForTests } from '../services/aiGameForum';
import { AI_GAME_FORMAT, AI_GAME_VERSION, type AiGameTrace } from '../services/aiGameTrace';

const FORUM = '1566833113248571514';
const GUILD = '1132682489840812113';
const G1 = '1570000000000000001';
const G2 = '1570000000000000002';
const OTHER = '1570000000000000003'; // 別的論壇
const PLAIN = '1570000000000000004'; // 同論壇但不是百科AI對局
const HUMAN = '1570000000000000005'; // 標題對，但起始訊息是人發的
const EVIL_URL = '1570000000000000006'; // 附件網址不是 Discord CDN

const TRACE: AiGameTrace = {
  format: AI_GAME_FORMAT, version: AI_GAME_VERSION, source: 'signage-cloud',
  room: 'Room-1460', title: '週四練習團', startedAt: '2026-11-05T13:05:00.000Z', endedAt: '2026-11-05T13:40:00.000Z', winner: 'evil',
  seats: [
    { seat: 1, name: '測試玩家1', role: '梅林', team: 'good', ai: false },
    { seat: 2, name: '百科AI_22', role: '刺客', team: 'evil', ai: true },
  ],
  proposals: [], missions: [], lakes: [], assassination: { target: 1, hit: true },
  decisions: [
    { id: 1, at: 1, round: 2, attempt: 3, kind: 'vote', seat: 2, nick: '百科AI_22', role: 'assassin', team: 'evil', action: '反對', detail: { vote: false }, reason: '反對：測試理由。', source: 'agent' },
    { id: 2, at: 2, round: 3, attempt: 0, kind: 'assassinate', seat: 2, nick: '百科AI_22', role: 'assassin', team: 'evil', action: '刺殺 1家', detail: { target: 1 }, reason: '刺 1家。', source: 'agent' },
  ],
  notes: [],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockDiscord() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const thread = (id: string, name: string, parent = FORUM, archived = false) => ({ id, name, parent_id: parent, thread_metadata: { archived } });
  const starter = (id: string, bot = true, url = `https://cdn.discordapp.com/attachments/${id}/1/trace.json?ex=1`) => ({
    id, author: { bot }, attachments: [{ filename: 'trace.txt', url: 'https://cdn.discordapp.com/x/trace.txt' }, { filename: 'trace.json', url, size: 2000 }],
  });
  const threads: Record<string, ReturnType<typeof thread>> = {
    [G1]: thread(G1, '百科AI對局 20261105_2105 週四練習團／Room-1460'),
    [G2]: thread(G2, '百科AI對局 20261104_2230 Room-1417', FORUM, true),
    [OTHER]: thread(OTHER, '百科AI對局 假的', '999'),
    [PLAIN]: thread(PLAIN, '[錯誤] 網站壞了'),
    [HUMAN]: thread(HUMAN, '百科AI對局 有人自己開的'),
    [EVIL_URL]: thread(EVIL_URL, '百科AI對局 怪附件'),
  };
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.endsWith(`/guilds/${GUILD}/threads/active`)) return json(200, { threads: [threads[G1], threads[OTHER], threads[PLAIN], threads[HUMAN]] });
    if (url.includes(`/channels/${FORUM}/threads/archived/public`)) return json(200, { threads: [threads[G2]], has_more: false });
    if (url.startsWith('https://cdn.discordapp.com/attachments/')) return json(200, TRACE);
    const m = /\/channels\/(\d+)(\/messages(?:\/(\d+))?)?$/.exec(url);
    if (m) {
      const [, id, msgs, msgId] = m;
      if (!threads[id]) return json(404, {});
      if (!msgs) return json(200, threads[id]);
      if (msgId) return json(200, id === HUMAN ? starter(id, false) : id === EVIL_URL ? starter(id, true, 'https://evil.example/trace.json') : starter(id));
      if (method === 'POST') return json(200, { id: '1' });
    }
    return json(404, {});
  });
  return { calls, fetchImpl: f as unknown as typeof fetch };
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/api/ai-games', aiGamesRouter);
  return a;
}

function withService(now = (): number => 1_000_000) {
  const dc = mockDiscord();
  const logs: string[] = [];
  setAiGameServiceForTests(createAiGameService({ token: 't', forumId: FORUM, guildId: GUILD, fetchImpl: dc.fetchImpl, now, log: (m) => logs.push(m) }));
  return { dc, logs };
}

afterEach(() => setAiGameServiceForTests(undefined));

describe('GET /api/ai-games', () => {
  it('列出這個論壇裡的百科AI對局（進行中＋已封存，新的在前），其他討論串不列', async () => {
    withService();
    const res = await request(app()).get('/api/ai-games');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.games.map((g: { id: string }) => g.id)).toEqual([HUMAN, G2, G1]);
    expect(res.body.games.find((g: { id: string }) => g.id === G2)).toMatchObject({ archived: true, name: '百科AI對局 20261104_2230 Room-1417' });
    expect(res.body.games[0].createdAt).toMatch(/^20\d\d-/);
  });

  it('快取 5 分鐘：期間內不重打 DC，過期才重讀', async () => {
    let t = 1_000_000;
    const { dc } = withService(() => t);
    await request(app()).get('/api/ai-games');
    const n = dc.calls.length;
    await request(app()).get('/api/ai-games');
    expect(dc.calls.length).toBe(n);
    t += 5 * 60 * 1000 + 1;
    await request(app()).get('/api/ai-games');
    expect(dc.calls.length).toBeGreaterThan(n);
  });

  it('沒設 DISCORD_BOT_TOKEN：503', async () => {
    setAiGameServiceForTests(null);
    const res = await request(app()).get('/api/ai-games');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('AI games not configured');
  });
});

describe('GET /api/ai-games/:id', () => {
  it('讀起始訊息附的 trace.json；網站版拿掉真人暱稱，百科AI 的留著', async () => {
    withService();
    const res = await request(app()).get(`/api/ai-games/${G1}`);
    expect(res.status).toBe(200);
    expect(res.body.trace.decisions).toHaveLength(2);
    expect(res.body.trace.seats).toEqual([
      { seat: 1, name: '', role: '梅林', team: 'good', ai: false },
      { seat: 2, name: '百科AI_22', role: '刺客', team: 'evil', ai: true },
    ]);
    expect(res.body.thread).toEqual({ id: G1, name: '百科AI對局 20261105_2105 週四練習團／Room-1460', url: `https://discord.com/channels/${GUILD}/${G1}` });
  });

  it('不是百科AI對局的討論串、人發的、附件不在 Discord CDN、不存在、id 格式不對 → 404', async () => {
    const { dc } = withService();
    for (const id of [OTHER, PLAIN, HUMAN, EVIL_URL, '1579999999999999999', 'abc']) {
      const res = await request(app()).get(`/api/ai-games/${id}`);
      expect(res.status, id).toBe(404);
    }
    expect(dc.calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
  });

  it('同一局 5 分鐘內只讀一次', async () => {
    const { dc } = withService();
    await request(app()).get(`/api/ai-games/${G1}`);
    const n = dc.calls.length;
    await request(app()).get(`/api/ai-games/${G1}`);
    expect(dc.calls.length).toBe(n);
  });
});

describe('POST /api/ai-games/:id/flag', () => {
  it('貼成那篇討論串的回覆：第幾局第幾次、哪一家、哪個決定、原因、暱稱；不叫人', async () => {
    const { dc } = withService();
    const res = await request(app()).post(`/api/ai-games/${G1}/flag`).send({ decisionId: 1, note: '這隊明明很乾淨 @everyone', name: '測試玩家9' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const post = dc.calls.find((c) => c.method === 'POST' && c.url.endsWith(`/channels/${G1}/messages`))!;
    const body = JSON.parse(post.body!);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain('**【網站回饋】這步怪怪的** — 測試玩家9');
    expect(body.content).toContain('第 2 局第 3 次・2家 刺客 百科AI_22・投票：反對（決定 #1）');
    expect(body.content).toContain('> 這隊明明很乾淨 @everyone');
  });

  it('沒填暱稱＝匿名；決定不存在 400；沒有 decisionId 400；不是百科AI對局 404', async () => {
    const { dc } = withService();
    expect((await request(app()).post(`/api/ai-games/${G1}/flag`).send({ decisionId: 2 })).status).toBe(200);
    const last = dc.calls.filter((c) => c.method === 'POST').pop()!;
    expect(JSON.parse(last.body!).content).toContain('— 匿名');
    expect((await request(app()).post(`/api/ai-games/${G1}/flag`).send({ decisionId: 99, note: 'x' })).status).toBe(400);
    expect((await request(app()).post(`/api/ai-games/${G1}/flag`).send({ note: 'x' })).status).toBe(400);
    expect((await request(app()).post(`/api/ai-games/${PLAIN}/flag`).send({ decisionId: 1 })).status).toBe(404);
  });

  it('同一個 IP 每分鐘最多 10 則（同網站問題回報）', async () => {
    withService();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(app()).post(`/api/ai-games/${G1}/flag`).set('X-Forwarded-For', '203.0.113.9').send({ decisionId: 1, note: `第 ${i} 次` })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
