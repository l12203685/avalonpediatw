/**
 * GET /api/analysis/records（網站「牌譜紀錄」頁籤）：records_cache.json（discord_records_export.py 每天寫）原樣包成
 * { success, data }，預先壓縮、強 ETag / 304；檔案不存在或格式不對 → 503 'Records list not yet generated'。
 * 不需要試算表金鑰。/records/:id/replies：清單裡的貼文才讀、機器人訊息不顯示、快取。虛構的貼文、名字與回覆。
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
import {
  ENV_GAME_DB, ENV_PLAYER_ALIASES, ENV_RECORDS_CACHE, RECORDS_NOT_GENERATED, invalidateRecordsPayload, recordAliases, recordNameRenames,
  renameRecordNames,
} from '../services/recordsList';
import {
  REPLIES_NOT_CONFIGURED,
  REPLIES_TTL_MS,
  REPLIES_UNAVAILABLE,
  BATTLE_REPORT_PREFIX,
  createRepliesService,
  isShownReply,
  setRepliesServiceForTests,
} from '../services/recordsReplies';

const NAMES = 'ABCDEFGHIJ'.split('').map((c) => `玩家${c}`);
const DOC = {
  format: 'avalon-records',
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
let dbFile: string;
let aliasFile: string;
const savedAliasEnv = process.env[ENV_PLAYER_ALIASES];
const savedEnv = process.env[ENV_RECORDS_CACHE];
const savedDbEnv = process.env[ENV_GAME_DB];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'records-endpoint-'));
  file = path.join(dir, 'records_cache.json');
  dbFile = path.join(dir, 'game_db.json');
  process.env[ENV_RECORDS_CACHE] = file;
  process.env[ENV_GAME_DB] = dbFile;
  aliasFile = path.join(dir, 'player_aliases.json');
  process.env[ENV_PLAYER_ALIASES] = aliasFile;
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV_RECORDS_CACHE];
  else process.env[ENV_RECORDS_CACHE] = savedEnv;
  if (savedDbEnv === undefined) delete process.env[ENV_GAME_DB];
  else process.env[ENV_GAME_DB] = savedDbEnv;
  if (savedAliasEnv === undefined) delete process.env[ENV_PLAYER_ALIASES];
  else process.env[ENV_PLAYER_ALIASES] = savedAliasEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(file, JSON.stringify(DOC), 'utf-8');
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(aliasFile, { force: true });
  invalidateRecordsPayload();
});

afterEach(() => invalidateRecordsPayload());

describe('GET /api/analysis/records', () => {
  it('serves the list as { success, data } with an ETag', async () => {
    const res = await request(app).get('/api/analysis/records').set('Accept-Encoding', 'identity');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(DOC);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(res.headers['cache-control']).toContain('max-age=300');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const first = await request(app).get('/api/analysis/records');
    const second = await request(app).get('/api/analysis/records').set('If-None-Match', first.headers.etag);
    expect(second.status).toBe(304);
  });

  it('sends gzip when asked', async () => {
    const res = await request(app)
      .get('/api/analysis/records')
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
    invalidateRecordsPayload();
    const missing = await request(app).get('/api/analysis/records');
    expect(missing.status).toBe(503);
    expect(missing.body.error).toBe(RECORDS_NOT_GENERATED);
    fs.writeFileSync(file, JSON.stringify(DOC), 'utf-8');
    const later = await request(app).get('/api/analysis/records');
    expect(later.status).toBe(200);
  });

  it('still reads the file written before the rename (format avalon-paipu) and answers the old path', async () => {
    fs.writeFileSync(file, JSON.stringify({ ...DOC, format: 'avalon-paipu' }), 'utf-8');
    invalidateRecordsPayload();
    const res = await request(app).get('/api/analysis/paipu').set('Accept-Encoding', 'identity');
    expect(res.status).toBe(200);
    expect(res.body.data.counts.posts).toBe(2);
  });

  it('adds aka (other source ids of the same game, from game_db.json) so old links open the merged post', async () => {
    // 站長 2026-11-19：#records=S1629 打不開（同一局 DC 也有，清單只留 DC 貼文那一篇）
    const db = {
      format: 'avalon-game-db', version: 1,
      games: [
        { id: '1432000000000000001', status: 'ok', sources: [{ src: 'sheet', id: 'S1629' }, { src: 'discord', id: '1432000000000000001' }, { src: 'dc_import', id: 'Dcc028a2b63' }] },
        // 總庫局號不在網站上：轉到第一個在網站上的來源（那一篇）
        { id: 'S77', status: 'error', sources: [{ src: 'sheet', id: 'S77' }, { src: 'discord', id: '1432000000000000002' }] },
        // 網站上沒有任何一個來源：不加
        { id: 'S88', status: 'ok', sources: [{ src: 'sheet', id: 'S88' }] },
      ],
    };
    fs.writeFileSync(dbFile, JSON.stringify(db), 'utf-8');
    invalidateRecordsPayload();
    const res = await request(app).get('/api/analysis/records').set('Accept-Encoding', 'identity');
    expect(res.status).toBe(200);
    const byId = new Map((res.body.data.posts as Array<{ id: string; aka?: string[] }>).map((p) => [p.id, p]));
    expect(byId.get('1432000000000000001')?.aka).toEqual(['S1629', 'Dcc028a2b63']);
    expect(byId.get('1432000000000000002')?.aka).toEqual(['S77']);
    expect(res.body.data.counts).toEqual(DOC.counts);
    // 沒有總庫（或格式不對）→ 原樣
    expect(recordAliases(DOC.posts, null).size).toBe(0);
    expect(recordAliases(DOC.posts, { format: 'other', games: db.games }).size).toBe(0);
    // 已經是網站上一篇的來源 id（同一局貼兩次）不當 aka：那一篇本來就打得開
    const twice = recordAliases(DOC.posts, { format: 'avalon-game-db', games: [{ id: '1432000000000000001', sources: [{ id: '1432000000000000002' }, { id: 'S5' }] }] });
    expect([...twice]).toEqual([['1432000000000000001', ['S5']]]);
  });

  it('shows the official name for a seat written in an old spelling (player_aliases.json)', async () => {
    // 站長 2026-11-25：牌譜上寫成「甲/乙」的那一場其實只有甲在玩 → 別名表「甲/乙 → 甲」，牌譜紀錄也直接顯示甲
    const names = [...NAMES];
    names[2] = '玩家Ｃ/玩家x';
    names[5] = '百科AI_3';
    const doc = { ...DOC, posts: [DOC.posts[0], { ...DOC.posts[1], game: { ...DOC.posts[1].game, names } }] };
    fs.writeFileSync(file, JSON.stringify(doc), 'utf-8');
    fs.writeFileSync(aliasFile, JSON.stringify({ _comment: 'x', aliases: { '玩家C/玩家X': '玩家C', '百科AI_3': '百科AI', 壞掉: 3 } }), 'utf-8');
    invalidateRecordsPayload();
    const res = await request(app).get('/api/analysis/records').set('Accept-Encoding', 'identity');
    expect(res.status).toBe(200);
    const shown = res.body.data.posts[1].game.names as string[];
    expect(shown[2]).toBe('玩家C');
    expect(shown[5]).toBe('百科AI_3'); // 機器人的座位名保留編號
    expect(shown.filter((_, i) => i !== 2)).toEqual(names.filter((_, i) => i !== 2));
    expect(res.body.data.posts[0]).toEqual(DOC.posts[0]); // 沒有牌譜的貼文原樣
    // 沒有別名檔、壞掉的別名檔 → 名字照貼文原樣
    fs.writeFileSync(aliasFile, '{ not json', 'utf-8');
    invalidateRecordsPayload();
    const raw = await request(app).get('/api/analysis/records').set('Accept-Encoding', 'identity');
    expect(raw.body.data.posts[1].game.names).toEqual(names);
    expect(recordNameRenames(null).size).toBe(0);
    expect(recordNameRenames({ aliases: [] }).size).toBe(0);
    const post = doc.posts[1];
    expect(renameRecordNames(post, new Map())).toBe(post);
    expect(renameRecordNames(post, new Map([['沒有這個人', '甲']]))).toBe(post);
  });

  it('is 503 for a file of another format or broken JSON', async () => {
    fs.writeFileSync(file, JSON.stringify({ ...DOC, format: 'avalon-games' }), 'utf-8');
    invalidateRecordsPayload();
    expect((await request(app).get('/api/analysis/records')).status).toBe(503);
    fs.writeFileSync(file, '{"format":', 'utf-8');
    invalidateRecordsPayload();
    expect((await request(app).get('/api/analysis/records')).status).toBe(503);
  });
});

describe('GET /api/analysis/records/:id/replies', () => {
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
    const res = await request(app).get('/api/analysis/records/1432000000000000001/replies');
    expect(res.status).toBe(200);
    expect(res.body.data.replies).toEqual([reply]);
    expect(res.body.data.stale).toBe(false);
    expect(calls).toEqual(['1432000000000000001']);
  });

  it('reads no thread that is not in the list (other channels, simulations)', async () => {
    let called = false;
    setRepliesServiceForTests({ load: async () => { called = true; return { ok: false as const, status: 503, error: 'x' }; } });
    expect((await request(app).get('/api/analysis/records/1432000000000000999/replies')).status).toBe(404);
    expect((await request(app).get('/api/analysis/records/abc/replies')).status).toBe(404);
    expect(called).toBe(false);
  });

  it('is 503 without a bot token, or when Discord cannot be read', async () => {
    setRepliesServiceForTests(null);
    const none = await request(app).get('/api/analysis/records/1432000000000000001/replies');
    expect(none.status).toBe(503);
    expect(none.body.error).toBe(REPLIES_NOT_CONFIGURED);
    setRepliesServiceForTests({ load: async () => ({ ok: false as const, status: 503, error: REPLIES_UNAVAILABLE }) });
    const down = await request(app).get('/api/analysis/records/1432000000000000001/replies');
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

  it('shows the site bot\'s 戰報 replies (and only those bot messages), labelled as the site', async () => {
    const report = msg('1432000000000000107', { author: user('99', 'Importer', true), content: `${BATTLE_REPORT_PREFIX}\n1-5 一句話` });
    expect(isShownReply(report as never, THREAD)).toBe(true);
    expect(isShownReply(msg('1432000000000000108', { author: user('99', 'Importer', true), content: '🤖 牌譜格式檢查' }) as never, THREAD)).toBe(false);
    const fetcher = async (url: string) => (/\/members\//.test(url)
      ? { ok: false, status: 404, json: async () => null }
      : { ok: true, status: 200, json: async () => [report] });
    const load = await createRepliesService({ token: 't', guildId: '1', fetcher }).load(THREAD);
    expect(load.ok && load.replies.map((r) => r.author)).toEqual(['阿瓦隆百科・戰報']);
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
