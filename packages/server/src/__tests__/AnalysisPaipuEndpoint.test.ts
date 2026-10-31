/**
 * GET /api/analysis/paipu（網站「牌譜紀錄」頁籤）：paipu_cache.json（discord_paipu_export.py 每天寫）原樣包成
 * { success, data }，預先壓縮、強 ETag / 304；檔案不存在或格式不對 → 503 'Paipu list not yet generated'。
 * 不需要試算表金鑰。/paipu/:id/replies：清單裡的貼文才讀、機器人訊息不顯示、快取。虛構的貼文、名字與回覆。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rateLimit')>();
  return {
    ...actual,
    createHttpRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { analysisRouter } from '../routes/analysis';
import { ENV_PAIPU_CACHE, PAIPU_NOT_GENERATED, invalidatePaipuPayload } from '../services/paipuList';
import {
  REPLIES_NOT_CONFIGURED,
  REPLIES_TTL_MS,
  REPLIES_UNAVAILABLE,
  createRepliesService,
  setRepliesServiceForTests,
} from '../services/paipuReplies';

const NAMES = 'ABCDEFGHIJ'.split('').map((c) => `玩家${c}`);
const DOC = {
  format: 'avalon-paipu',
  version: 1,
  guildId: '1132682489840812113',
  forumId: '1132683080134578276',
  counts: { posts: 2, games: 1, unreadable: 1 },
  posts: [
    {
      id: '1432000000000000002', title: '1026一般場1', tags: ['三紅'], created: '2026-10-26T22:00:00+08:00',
      date: '2026-10-26', game: null, problem: '這一行看不懂', problemLine: 14,
    },
    {
      id: '1432000000000000001', title: '1025一般場6', tags: ['三藍躲刺', '線瓦'], created: '2026-10-25T23:00:00+08:00',
      date: '2026-10-25',
      game: {
        config: '936758', names: NAMES,
        rounds: [
          { proposals: [{ team: '147', votes: [] }], mission: 'ooo' },
          { proposals: [{ team: '5680', votes: ['7+'] }], mission: 'ooox' },
          { proposals: [{ team: '1458', votes: [] }], mission: 'oooo' },
          { proposals: [{ team: '14580', votes: ['5-', '39+'] }], mission: 'ooooo' },
        ],
        lakes: [{ after: 2, holder: '0', target: '8', claim: 'o' }],
        assassination: '3', outcome: '三藍活', category: '線瓦',
      },
    },
  ],
};

const app = express();
app.use('/api/analysis', analysisRouter);

let dir: string;
let file: string;
const savedEnv = process.env[ENV_PAIPU_CACHE];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paipu-endpoint-'));
  file = path.join(dir, 'paipu_cache.json');
  process.env[ENV_PAIPU_CACHE] = file;
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV_PAIPU_CACHE];
  else process.env[ENV_PAIPU_CACHE] = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(file, JSON.stringify(DOC), 'utf-8');
  invalidatePaipuPayload();
});

afterEach(() => invalidatePaipuPayload());

describe('GET /api/analysis/paipu', () => {
  it('serves the list as { success, data } with an ETag', async () => {
    const res = await request(app).get('/api/analysis/paipu').set('Accept-Encoding', 'identity');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(DOC);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(res.headers['cache-control']).toContain('max-age=300');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const first = await request(app).get('/api/analysis/paipu');
    const second = await request(app).get('/api/analysis/paipu').set('If-None-Match', first.headers.etag);
    expect(second.status).toBe(304);
  });

  it('sends gzip when asked', async () => {
    const res = await request(app)
      .get('/api/analysis/paipu')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    // supertest may already have inflated the body; either way it is the same JSON
    const raw = res.body as Buffer;
    const text = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
    expect(JSON.parse(text).data.counts.posts).toBe(2);
  });

  it('is 503 "not yet generated" without the file, and picks the file up once it exists', async () => {
    fs.rmSync(file);
    invalidatePaipuPayload();
    const missing = await request(app).get('/api/analysis/paipu');
    expect(missing.status).toBe(503);
    expect(missing.body.error).toBe(PAIPU_NOT_GENERATED);
    fs.writeFileSync(file, JSON.stringify(DOC), 'utf-8');
    const later = await request(app).get('/api/analysis/paipu');
    expect(later.status).toBe(200);
  });

  it('is 503 for a file of another format or broken JSON', async () => {
    fs.writeFileSync(file, JSON.stringify({ ...DOC, format: 'avalon-games' }), 'utf-8');
    invalidatePaipuPayload();
    expect((await request(app).get('/api/analysis/paipu')).status).toBe(503);
    fs.writeFileSync(file, '{"format":', 'utf-8');
    invalidatePaipuPayload();
    expect((await request(app).get('/api/analysis/paipu')).status).toBe(503);
  });
});

describe('GET /api/analysis/paipu/:id/replies', () => {
  afterEach(() => setRepliesServiceForTests(undefined));

  const reply = {
    id: '1432000000000000101', author: '玩家B', time: '2026-10-25T15:10:00.000Z', edited: false,
    text: '第二輪我應該上車', attachments: [],
  };

  it('serves the replies of a listed post', async () => {
    const calls: string[] = [];
    setRepliesServiceForTests({
      load: async (id: string) => {
        calls.push(id);
        return { ok: true as const, replies: [reply], fetchedAt: Date.UTC(2026, 9, 25, 15, 20), stale: false };
      },
    });
    const res = await request(app).get('/api/analysis/paipu/1432000000000000001/replies');
    expect(res.status).toBe(200);
    expect(res.body.data.replies).toEqual([reply]);
    expect(res.body.data.stale).toBe(false);
    expect(calls).toEqual(['1432000000000000001']);
  });

  it('reads no thread that is not in the list (other channels, simulations)', async () => {
    let called = false;
    setRepliesServiceForTests({ load: async () => { called = true; return { ok: false as const, status: 503, error: 'x' }; } });
    expect((await request(app).get('/api/analysis/paipu/1432000000000000999/replies')).status).toBe(404);
    expect((await request(app).get('/api/analysis/paipu/abc/replies')).status).toBe(404);
    expect(called).toBe(false);
  });

  it('is 503 without a bot token, or when Discord cannot be read', async () => {
    setRepliesServiceForTests(null);
    const none = await request(app).get('/api/analysis/paipu/1432000000000000001/replies');
    expect(none.status).toBe(503);
    expect(none.body.error).toBe(REPLIES_NOT_CONFIGURED);
    setRepliesServiceForTests({ load: async () => ({ ok: false as const, status: 503, error: REPLIES_UNAVAILABLE }) });
    const down = await request(app).get('/api/analysis/paipu/1432000000000000001/replies');
    expect(down.status).toBe(503);
    expect(down.body.error).toBe(REPLIES_UNAVAILABLE);
  });
});

describe('createRepliesService', () => {
  const THREAD = '1432000000000000001';
  const user = (id: string, name: string, bot = false) => ({ id, username: name.toLowerCase(), global_name: name, bot });
  const msg = (id: string, extra: Record<string, unknown>) => ({
    id, type: 0, content: '', timestamp: '2026-10-25T15:00:00.000Z', edited_timestamp: null, attachments: [], mentions: [], ...extra,
  });
  const MESSAGES = [
    msg('1432000000000000105', { author: user('11', 'Alpha'), content: '<@22> 你第三輪那票 <:ok:123>', mentions: [user('22', 'Beta')],
      message_reference: { message_id: '1432000000000000102' }, edited_timestamp: '2026-10-25T16:00:00.000Z' }),
    msg('1432000000000000104', { author: user('99', 'Importer', true), content: '🤖 牌譜格式檢查\n這篇牌譜目前無法自動收錄' }),
    msg('1432000000000000103', { author: user('11', 'Alpha'), type: 18, content: 'thread created' }),
    msg('1432000000000000102', { author: user('22', 'Beta'), content: '補充：首湖其實沒講',
      attachments: [{ filename: 'board.png', url: 'https://cdn.example.test/board.png', content_type: 'image/png' }] }),
    msg('1432000000000000106', { author: user('33', 'Hook'), webhook_id: '5', content: 'mirrored' }),
    msg(THREAD, { author: user('11', 'Alpha'), content: '147\nooo' }),
  ];

  function fakeFetcher(options: { fail?: boolean; nicks?: Record<string, string> } = {}) {
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      if (options.fail) return { ok: false, status: 500, json: async () => null };
      const member = /\/members\/(\d+)$/.exec(url);
      if (member) {
        const nick = options.nicks?.[member[1]];
        return nick ? { ok: true, status: 200, json: async () => ({ nick }) } : { ok: false, status: 404, json: async () => null };
      }
      return { ok: true, status: 200, json: async () => MESSAGES };
    };
    return { fetcher, urls };
  }

  it('keeps people\'s replies in order, drops bots, webhooks, system messages and the record itself', async () => {
    const { fetcher, urls } = fakeFetcher({ nicks: { 22: '玩家B' } });
    const service = createRepliesService({ token: 't', guildId: '1132682489840812113', fetcher });
    const load = await service.load(THREAD);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.replies.map((r) => r.id)).toEqual(['1432000000000000102', '1432000000000000105']);
    const [first, second] = load.replies;
    expect(first).toMatchObject({ author: '玩家B', text: '補充：首湖其實沒講', edited: false });
    expect(first.attachments).toEqual([{ name: 'board.png', url: 'https://cdn.example.test/board.png', image: true }]);
    expect(second).toMatchObject({ author: 'Alpha', text: '@玩家B 你第三輪那票 :ok:', edited: true, replyTo: '1432000000000000102' });
    expect(urls[0]).toContain(`/channels/${THREAD}/messages?limit=100&after=${THREAD}`);
  });

  it('caches per thread, serves stale replies when Discord fails later, and 503 with nothing cached', async () => {
    let t = 0;
    let failing = false;
    const base = fakeFetcher();
    const fetcher = async (url: string) => (failing ? { ok: false, status: 500, json: async () => null } : base.fetcher(url));
    const service = createRepliesService({ token: 't', guildId: '1132682489840812113', fetcher, now: () => t });
    await service.load(THREAD);
    const reads = base.urls.length;
    t = REPLIES_TTL_MS - 1;
    await service.load(THREAD);
    expect(base.urls.length).toBe(reads);
    t = REPLIES_TTL_MS + 1;
    failing = true;
    const stale = await service.load(THREAD);
    expect(stale.ok && stale.stale).toBe(true);
    const fresh = createRepliesService({ token: 't', guildId: '1', fetcher: fakeFetcher({ fail: true }).fetcher });
    const down = await fresh.load(THREAD);
    expect(down).toEqual({ ok: false, status: 503, error: REPLIES_UNAVAILABLE });
  });
});
