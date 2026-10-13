/**
 * LINE ↔ Discord picture sync (2026-10-13), both directions, in-process with
 * the real ChatMirror + LineBotClient + reply queue + relay store and mocked
 * platform SDKs. Synthetic bytes and made-up names only; no network.
 *
 *   LINE picture   → content API download → Discord file upload (prefix + （圖片）)
 *   LINE sticker…  → short text to lobby + Discord
 *   Discord picture → copy in the relay store → LINE image message on the
 *                     reply queue → served from GET /media/relay/<id>.jpg
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { PassThrough, Readable } from 'stream';
import express from 'express';
import request from 'supertest';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import {
  initializeChatMirror,
  __resetChatMirrorForTests,
  discordLeftoverNote,
  discordMediaMarker,
  lobbyDisplayText,
  withMediaMarker,
  type DiscordAdapter,
  type DiscordChannelAdapter,
  type DiscordFile,
} from '../bots/ChatMirror';
import { LineReplyQueue } from '../bots/line/replyQueue';
import { LineBotClient, lineErrorMentionsImage } from '../bots/line/client';
import { handleDiscordMirrorMessage, discordPreviewUrl, type MirrorAttachmentLike, type MirrorMessageLike } from '../bots/discord/mirrorInbound';
import { LINE_PREVIEW_MAX_BYTES, MEDIA_RELAY_PATH, RelayMediaStore, createRelayMediaHandler } from '../bots/media/relayMedia';
import type { LobbyChatMessage } from '../socket/LobbyChatBuffer';
import { buildExportRows, type RawChatMessage } from '../bots/chatExport/rows';
import { buildBotStatus } from '../bots/index';

const GROUP = 'Cmirror-group';
const SECRET = 'test-channel-secret';
const DISCORD_CH = '1132901301802504242';
const BASE = 'https://avalon.example.test';
const MB = 1024 * 1024;

// Made-up speakers / texts; the log check below asserts none of them is logged.
const LINE_NAME = 'LinePal-Q7';
const DC_NAME = 'DcPal-Z3';
const DC_TEXT = 'look-at-this-zq';

function jpeg(size: number): Buffer {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b);
  return b;
}
function png(size: number): Buffer {
  const b = Buffer.alloc(size, 3);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
}

// ─── Mocks ───────────────────────────────────────────────────────────────

interface Upload {
  content: string;
  files: DiscordFile[];
}

function mockDiscord(opts: {
  maxUploadBytes?: number;
  uploadFails?: boolean;
  noFiles?: boolean;
  /** The first upload never settles (a hung Discord request). */
  firstUploadHangs?: boolean;
  noChannel?: boolean;
} = {}): {
  adapter: DiscordAdapter;
  sent: string[];
  uploads: Upload[];
  /** Arrival order on the channel: 'file:<body>' / 'text:<body>'. */
  order: string[];
} {
  const sent: string[] = [];
  const uploads: Upload[] = [];
  const order: string[] = [];
  let uploadCalls = 0;
  const body = (c: string): string => c.split('] ').pop() ?? '';
  const channel: DiscordChannelAdapter = {
    send: async (content: string) => {
      sent.push(content);
      order.push(`text:${body(content)}`);
      return {};
    },
    ...(opts.noFiles
      ? {}
      : {
          sendFiles: async (content: string, files: DiscordFile[]) => {
            uploadCalls += 1;
            if (opts.firstUploadHangs && uploadCalls === 1) return new Promise<never>(() => {});
            if (opts.uploadFails) throw Object.assign(new Error('Missing Permissions'), { name: 'DiscordAPIError', status: 403, code: 50013 });
            uploads.push({ content, files });
            order.push(`file:${body(content)}`);
            return {};
          },
        }),
    ...(opts.maxUploadBytes ? { maxUploadBytes: opts.maxUploadBytes } : {}),
  };
  return { adapter: { fetchChannel: async () => (opts.noChannel ? null : channel) }, sent, uploads, order };
}

type SentLineMessage = { type: string; text?: string; originalContentUrl?: string; previewImageUrl?: string };

function mockLineSdk(opts: {
  content?: Record<string, () => Readable>;
  replyFails?: () => unknown;
} = {}): { client: Client; replies: { token: string; messages: SentLineMessage[] }[]; contentCalls: string[] } {
  const replies: { token: string; messages: SentLineMessage[] }[] = [];
  const contentCalls: string[] = [];
  const client = {
    replyMessage: async (token: string, messages: SentLineMessage[]) => {
      const fail = opts.replyFails?.();
      if (fail) throw fail;
      replies.push({ token, messages });
      return {};
    },
    pushMessage: async () => {
      throw new Error('push must never be used');
    },
    getGroupMemberProfile: async () => ({ displayName: LINE_NAME }),
    getMessageContent: async (id: string) => {
      contentCalls.push(id);
      const make = opts.content?.[id];
      if (!make) throw Object.assign(new Error('Not found'), { name: 'HTTPError', statusCode: 404 });
      return make();
    },
  } as unknown as Client;
  return { client, replies, contentCalls };
}

function lineRequest(body: unknown): { req: Request; res: Response & { statusCode: number } } {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const req = { get: (h: string) => (h === 'X-Line-Signature' ? sig : undefined), body: JSON.parse(raw), rawBody: Buffer.from(raw) } as unknown as Request;
  const fake: { statusCode: number; status(code: number): typeof fake; json(): typeof fake } = {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
  const res = fake as unknown as Response & { statusCode: number };
  return { req, res };
}

function groupEvent(message: Record<string, unknown>, replyToken: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'message', replyToken, source: { type: 'group', groupId: GROUP, userId: 'U1' }, message, ...extra };
}

function imageMsg(id: string, imageSet?: { id: string; index: number; total: number }, provider: 'line' | 'external' = 'line') {
  return { type: 'image', id, contentProvider: { type: provider }, ...(imageSet ? { imageSet } : {}) };
}

/** Records every fetch URL; serves bytes per URL prefix. */
function mockFetch(routes: Record<string, () => globalThis.Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('', { status: 404 });
    return routes[key]();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function bytesResponse(buf: Buffer): globalThis.Response {
  return new Response(new Uint8Array(buf), { status: 200, headers: { 'content-length': String(buf.length) } });
}

function attachment(over: Partial<MirrorAttachmentLike> & { key: string }): MirrorAttachmentLike {
  return {
    name: `${over.key}.jpg`,
    url: `https://cdn.discordapp.com/attachments/1/${over.key}/${over.key}.jpg?ex=1&is=2&hm=3`,
    proxyURL: `https://media.discordapp.net/attachments/1/${over.key}/${over.key}.jpg?ex=1&is=2&hm=3`,
    size: 1000,
    contentType: 'image/jpeg',
    width: 1600,
    height: 1200,
    spoiler: false,
    ...over,
  };
}

function discordMessage(over: Partial<MirrorMessageLike> & { attachmentsList?: MirrorAttachmentLike[]; stickerCount?: number } = {}): MirrorMessageLike {
  const list = over.attachmentsList ?? [];
  return {
    id: 'dm1',
    channelId: DISCORD_CH,
    content: '',
    webhookId: null,
    author: { id: '42', bot: false, globalName: DC_NAME, username: 'dcpal' },
    member: { displayName: DC_NAME },
    attachments: new Map(list.map((a, i) => [String(i), a])),
    stickers: { size: over.stickerCount ?? 0 },
    ...over,
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────

const logged: string[] = [];
const logger = {
  warn: (m: string) => logged.push(m),
  error: (m: string, e?: unknown) => logged.push(`${m} ${e === undefined ? '' : String(e)}`),
  info: (m: string) => logged.push(m),
};

function setup(opts: {
  discord?: Parameters<typeof mockDiscord>[0];
  line?: Parameters<typeof mockLineSdk>[0];
  store?: RelayMediaStore | null;
  rate?: number;
  mediaTimeouts?: { downloadMs?: number; jobMs?: number; textWaitMs?: number };
  /** CHAT_MIRROR_IMAGES=false wiring (bots/index.ts): no picture copied in either direction. */
  imagesOff?: boolean;
  /**
   * ChatMirror's bound on one Discord call (default 75 s). A LINE picture's
   * upload holds the Discord send chain (texts and pictures keep their order,
   * a long text's parts stay together), so a test with a never-settling
   * upload shortens it to see the chain move on.
   */
  discordCallTimeoutMs?: number;
} = {}) {
  __resetChatMirrorForTests(); // each setup() gets its own mirror (the singleton is what the bot reads)
  const discord = mockDiscord(opts.discord);
  const sdk = mockLineSdk(opts.line);
  const store = opts.store === undefined ? new RelayMediaStore() : opts.store;
  const queue = new LineReplyQueue();
  const mirror = initializeChatMirror({
    lineGroupId: GROUP,
    discordChannelId: DISCORD_CH,
    discord: discord.adapter,
    lineReplyQueue: queue,
    lineImageRelay: store && !opts.imagesOff ? { store, publicBaseUrl: BASE } : undefined,
    lineImagesToDiscord: !opts.imagesOff,
    logger,
    inboundRateLimit: { windowMs: 60_000, maxRequests: opts.rate ?? 100 },
    discordCallTimeoutMs: opts.discordCallTimeoutMs,
  });
  const lobby: LobbyChatMessage[] = [];
  mirror.setLobbyIngest((m) => lobby.push(m));
  const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client: sdk.client, mediaTimeouts: opts.mediaTimeouts });
  return { mirror, discord, sdk, bot, lobby, store, queue };
}

async function postLine(bot: LineBotClient, events: Record<string, unknown>[]): Promise<number> {
  const { req, res } = lineRequest({ destination: 'U', events });
  await bot.handleWebhook(req, res);
  await bot.settleMediaRelays();
  return res.statusCode;
}

async function drainOnce(bot: LineBotClient, token: string): Promise<void> {
  await postLine(bot, [groupEvent({ type: 'text', id: `ping-${token}`, text: 'ping' }, token)]);
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  __resetChatMirrorForTests();
  logged.length = 0;
  process.env.LOBBY_MIRROR_LINE_GROUP_ID = GROUP;
  delete process.env.CHAT_MIRROR_USE_LEGACY_FORMAT;
  consoleSpies = (['log', 'warn', 'error', 'info'] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${JSON.stringify(a)}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }),
  );
});
afterEach(() => {
  delete process.env.LOBBY_MIRROR_LINE_GROUP_ID;
  for (const s of consoleSpies) s.mockRestore();
});

/** Nothing identifying in any log line: no names, texts, URLs or relay ids. */
function expectCleanLogs(extra: string[] = []): void {
  for (const line of logged) {
    for (const bad of [LINE_NAME, DC_NAME, DC_TEXT, 'https://', 'cdn.discordapp', '/media/relay/', ...extra]) {
      expect(line).not.toContain(bad);
    }
  }
}

// ─── LINE → Discord ──────────────────────────────────────────────────────

describe('LINE picture → Discord', () => {
  it('downloads the content and uploads it as a file with the speaker prefix + （圖片）; the lobby gets a marker', async () => {
    const pic = jpeg(3000);
    const h = setup({ line: { content: { img1: () => Readable.from([pic.subarray(0, 1000), pic.subarray(1000)]) } } });
    expect(await postLine(h.bot, [groupEvent(imageMsg('img1'), 'rt1')])).toBe(200);

    expect(h.sdk.contentCalls).toEqual(['img1']);
    expect(h.discord.uploads).toHaveLength(1);
    expect(h.discord.uploads[0].content).toMatch(new RegExp(`^\\[\\d{4} \\d{2}:\\d{2}\\]\\[LINE\\]\\[${LINE_NAME}\\] （圖片）$`));
    expect(h.discord.uploads[0].files).toHaveLength(1);
    expect(h.discord.uploads[0].files[0].name).toBe('line-image.jpg');
    expect(Buffer.compare(h.discord.uploads[0].files[0].data, pic)).toBe(0);
    expect(h.discord.sent).toEqual([]);
    expect(h.lobby.map((m) => [m.source, m.message])).toEqual([['line', '（圖片）']]);
    expect(h.mirror.lineReplyQueueSize()).toBe(0); // never back to LINE (no loop)
    expect(h.bot.getWebhookStats()).toMatchObject({ imagesToDiscord: 1, imageNotesToDiscord: 0 });
    expectCleanLogs();
  });

  it('uses .png for a PNG', async () => {
    const h = setup({ line: { content: { p: () => Readable.from([png(500)]) } } });
    await postLine(h.bot, [groupEvent(imageMsg('p'), 'rt')]);
    expect(h.discord.uploads[0].files[0].name).toBe('line-image.png');
  });

  it('over the Discord upload limit → a text note, and the download stops early', async () => {
    let pulled = 0;
    function* big(): Generator<Buffer> {
      for (let i = 0; i < 200; i++) {
        pulled += 1;
        yield i === 0 ? jpeg(1024) : Buffer.alloc(1024);
      }
    }
    const h = setup({ discord: { maxUploadBytes: 8 * 1024 }, line: { content: { big: () => Readable.from(big()) } } });
    await postLine(h.bot, [groupEvent(imageMsg('big'), 'rt')]);
    expect(h.discord.uploads).toEqual([]);
    expect(h.discord.sent).toHaveLength(1);
    expect(h.discord.sent[0]).toMatch(new RegExp(`\\[LINE\\]\\[${LINE_NAME}\\] （圖片太大，請到 LINE 看）$`));
    expect(pulled).toBeLessThan(20);
    expect(h.bot.getWebhookStats()).toMatchObject({ imagesToDiscord: 0, imageNotesToDiscord: 1 });
  });

  it('defaults to a 10 MB limit when the channel does not say', async () => {
    const seen: number[] = [];
    const h = setup();
    const msg: LobbyChatMessage = { id: 'x', playerId: 'line:U', playerName: 'n', message: '（圖片）', timestamp: Date.now(), source: 'line' };
    await h.mirror.postLineImageToDiscord(msg, async (max) => {
      seen.push(max);
      return { ok: true, data: jpeg(10) };
    });
    expect(seen).toEqual([10 * MB]);
  });

  it('download failure, external content and a refused upload each become a text note', async () => {
    const h = setup({ line: { content: {} } });
    await postLine(h.bot, [groupEvent(imageMsg('missing'), 'r1'), groupEvent(imageMsg('ext', undefined, 'external'), 'r2')]);
    expect(h.sdk.contentCalls).toEqual(['missing']); // external content is never fetched
    expect(h.discord.sent).toHaveLength(2);
    for (const s of h.discord.sent) expect(s).toMatch(/（圖片沒有同步過來，請到 LINE 看）$/);

    const refused = setup({ discord: { uploadFails: true }, line: { content: { a: () => Readable.from([jpeg(100)]) } } });
    await postLine(refused.bot, [groupEvent(imageMsg('a'), 'r3')]);
    expect(refused.discord.sent).toEqual([expect.stringMatching(/（圖片沒有同步過來，請到 LINE 看）$/)]);
    expect(logged.some((l) => l.includes('status=403'))).toBe(true);
    expectCleanLogs();
  });

  it('an image set uploads every picture as 1/3, 2/3, 3/3 and puts ONE marker in the lobby', async () => {
    const content = Object.fromEntries(['s1', 's2', 's3'].map((id) => [id, () => Readable.from([jpeg(200)])]));
    const h = setup({ line: { content }, rate: 2 });
    const set = (index: number) => ({ id: 'set-A', index, total: 3 });
    await postLine(h.bot, [groupEvent(imageMsg('s1', set(1)), 'r1'), groupEvent(imageMsg('s2', set(2)), 'r2')]);
    await postLine(h.bot, [groupEvent(imageMsg('s3', set(3)), 'r3')]);
    expect(h.discord.uploads.map((u) => u.content.split('] ').pop())).toEqual(['（圖片 1/3）', '（圖片 2/3）', '（圖片 3/3）']);
    expect(h.lobby.map((m) => m.message)).toEqual(['（圖片 ×3）']);
  });

  it('stickers, video, audio, files and locations relay as a short text (lobby + Discord)', async () => {
    const h = setup();
    await postLine(h.bot, [
      groupEvent({ type: 'sticker', id: 'k1', packageId: '1', stickerId: '2' }, 'r1'),
      groupEvent({ type: 'video', id: 'v1', duration: 1000, contentProvider: { type: 'line' } }, 'r2'),
      groupEvent({ type: 'audio', id: 'a1', duration: 1000, contentProvider: { type: 'line' } }, 'r3'),
      groupEvent({ type: 'file', id: 'f1', fileName: 'private-name.pdf', fileSize: 10 }, 'r4'),
      groupEvent({ type: 'location', id: 'l1', title: 'home', address: 'secret street', latitude: 1, longitude: 2 }, 'r5'),
    ]);
    await new Promise((r) => setImmediate(r));
    const bodies = h.discord.sent.map((s) => s.split('] ').pop());
    expect(bodies).toEqual(['（貼圖）', '（影片，請到 LINE 看）', '（語音訊息，請到 LINE 聽）', '（檔案，請到 LINE 看）', '（位置資訊，請到 LINE 看）']);
    expect(h.lobby.map((m) => m.message)).toEqual(bodies);
    expect(h.sdk.contentCalls).toEqual([]); // nothing but pictures is downloaded
    expect(JSON.stringify(h.discord.sent)).not.toContain('private-name');
    expect(JSON.stringify(h.discord.sent)).not.toContain('secret street');
    expect(h.bot.getWebhookStats().mediaNotesToDiscord).toBe(5);
  });

  it('a LINE redelivery of a picture this process already handled is not uploaded again', async () => {
    const h = setup({ line: { content: { r: () => Readable.from([jpeg(100)]) } } });
    const ev = groupEvent(imageMsg('r'), 'rt', { webhookEventId: 'W1' });
    await postLine(h.bot, [ev]);
    await postLine(h.bot, [{ ...ev, deliveryContext: { isRedelivery: true } }]);
    expect(h.discord.uploads).toHaveLength(1);
    expect(h.lobby).toHaveLength(1);
  });

  it('stickers and pictures do not use up the text limit: every text of a mixed burst reaches Discord', async () => {
    const h = setup({ rate: 3, line: { content: { p1: () => Readable.from([jpeg(100)]) } } });
    const text = (id: string, t: string) => groupEvent({ type: 'text', id, text: t }, `r-${id}`);
    const sticker = (id: string) => groupEvent({ type: 'sticker', id, packageId: '1', stickerId: '2' }, `r-${id}`);
    await postLine(h.bot, [text('t1', 'first'), sticker('k1'), text('t2', 'second'), sticker('k2'), groupEvent(imageMsg('p1'), 'r-p1'), text('t3', 'third')]);
    await new Promise((r) => setImmediate(r));
    const texts = h.discord.sent.map((s) => s.split('] ').pop()).filter((b) => ['first', 'second', 'third'].includes(b ?? ''));
    expect(texts).toEqual(['first', 'second', 'third']);
    expect(h.lobby.map((m) => m.message)).toEqual(['first', '（貼圖）', 'second', '（貼圖）', '（圖片）', 'third']);
  });

  it('Discord keeps the LINE order when the earlier event\'s name lookup is the slow one — picture then text, text then picture', async () => {
    for (const slowFirst of [true, false]) {
      // slowFirst: the picture comes first; otherwise the text does. Either way the first one's lookup is slow.
      const h = setup({ line: { content: { p1: () => Readable.from([jpeg(100)]) } } });
      let call = 0;
      (h.sdk.client as unknown as { getGroupMemberProfile: () => Promise<{ displayName: string }> }).getGroupMemberProfile = async () => {
        call += 1;
        await new Promise((r) => setTimeout(r, call === 1 ? 40 : 0)); // the first event's lookup is the slow one
        return { displayName: LINE_NAME };
      };
      const first = slowFirst ? groupEvent(imageMsg('p1'), 'r1') : groupEvent({ type: 'text', id: 't0', text: 'before-pic' }, 'r1');
      const second = slowFirst ? groupEvent({ type: 'text', id: 't1', text: 'after-pic' }, 'r2') : groupEvent(imageMsg('p1'), 'r2');
      const a = lineRequest({ destination: 'U', events: [first] });
      const b = lineRequest({ destination: 'U', events: [second] });
      const pa = h.bot.handleWebhook(a.req, a.res);
      await new Promise((r) => setTimeout(r, 5));
      const pb = h.bot.handleWebhook(b.req, b.res);
      await Promise.all([pa, pb]);
      await h.bot.settleMediaRelays();
      await new Promise((r) => setTimeout(r, 5));
      expect(h.discord.order).toEqual(slowFirst ? ['file:（圖片）', 'text:after-pic'] : ['text:before-pic', 'file:（圖片）']);
    }
  });

  it('an image set keeps 1/2, 2/2 on Discord although the first picture\'s lookup is slower', async () => {
    const h = setup({ line: { content: { s1: () => Readable.from([jpeg(100)]), s2: () => Readable.from([jpeg(100)]) } } });
    let call = 0;
    (h.sdk.client as unknown as { getGroupMemberProfile: () => Promise<{ displayName: string }> }).getGroupMemberProfile = async () => {
      call += 1;
      await new Promise((r) => setTimeout(r, call === 1 ? 40 : 0));
      return { displayName: LINE_NAME };
    };
    const set = (index: number) => ({ id: 'set-B', index, total: 2 });
    const a = lineRequest({ destination: 'U', events: [groupEvent(imageMsg('s1', set(1)), 'r1')] });
    const b = lineRequest({ destination: 'U', events: [groupEvent(imageMsg('s2', set(2)), 'r2')] });
    const pa = h.bot.handleWebhook(a.req, a.res);
    await new Promise((r) => setTimeout(r, 5));
    const pb = h.bot.handleWebhook(b.req, b.res);
    await Promise.all([pa, pb]);
    await h.bot.settleMediaRelays();
    expect(h.discord.uploads.map((u) => u.content.split('] ').pop())).toEqual(['（圖片 1/2）', '（圖片 2/2）']);
  });

  it('too many pictures waiting: the one not copied still reaches Discord as a note (not silently dropped)', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `w${i}`);
    const content = Object.fromEntries(ids.map((id) => [id, () => Readable.from([jpeg(100)])]));
    const h = setup({ discord: { firstUploadHangs: true }, line: { content }, mediaTimeouts: { jobMs: 300 }, discordCallTimeoutMs: 200 });
    await postLine(h.bot, ids.map((id) => groupEvent(imageMsg(id), `r-${id}`)));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.discord.sent.map((s) => s.split('] ').pop())).toEqual(['（圖片沒有同步過來，請到 LINE 看）']);
    expect(h.discord.uploads).toHaveLength(19); // the first hung (timed out), 2 … 20 uploaded
    expect(h.bot.getWebhookStats()).toMatchObject({ imagesSkipped: 1, imageNotesToDiscord: 1, imageFailures: 1 });
  });

  it('CHAT_MIRROR_IMAGES=false: LINE pictures are not downloaded; Discord gets one note per picture or set', async () => {
    const h = setup({ imagesOff: true, line: { content: { x: () => Readable.from([jpeg(100)]) } } });
    const set = (index: number) => ({ id: 'set-C', index, total: 2 });
    await postLine(h.bot, [groupEvent(imageMsg('x'), 'r1'), groupEvent(imageMsg('y1', set(1)), 'r2'), groupEvent(imageMsg('y2', set(2)), 'r3')]);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.sdk.contentCalls).toEqual([]);
    expect(h.discord.uploads).toEqual([]);
    expect(h.discord.sent.map((s) => s.split('] ').pop())).toEqual(['（圖片，請到 LINE 看）', '（圖片，請到 LINE 看）']);
    expect(h.lobby.map((m) => m.message)).toEqual(['（圖片）', '（圖片 ×2）']);
    expect(h.mirror.lineImageRelay()).toBeNull(); // Discord → LINE off as well
  });

  it('events of other groups do not fill the redelivery memory (only events this process acts on are remembered)', async () => {
    const h = setup();
    const other = (id: string) => ({ ...groupEvent(imageMsg(id), `r-${id}`, { webhookEventId: `E-${id}` }), source: { type: 'group', groupId: 'Cother', userId: 'U9' } });
    await postLine(h.bot, [other('o1'), other('o2'), other('o3')]);
    const seen = (h.bot as unknown as { seenEventIds: Set<string> }).seenEventIds;
    expect(seen.size).toBe(0);
    await postLine(h.bot, [groupEvent({ type: 'text', id: 'm1', text: 'hi' }, 'rt', { webhookEventId: 'E-m1' })]);
    expect(seen.size).toBe(1);
  });

  it('a rate-limited speaker gets no upload (and no download)', async () => {
    const content = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, () => Readable.from([jpeg(100)])]));
    const h = setup({ line: { content }, rate: 2 });
    await postLine(h.bot, [groupEvent(imageMsg('a'), 'r1'), groupEvent(imageMsg('b'), 'r2'), groupEvent(imageMsg('c'), 'r3')]);
    expect(h.discord.uploads).toHaveLength(2);
    expect(h.sdk.contentCalls).toEqual(['a', 'b']);
    expect(h.bot.getWebhookStats().imagesSkipped).toBe(1);
  });

  it('the picture post reaches the weekly export only as a pseudonymised marker (no name, no file, no URL)', () => {
    const content = `[1013 21:35][LINE][${LINE_NAME}] （圖片）`;
    const raw: RawChatMessage = {
      id: '900',
      channelId: DISCORD_CH,
      createdAt: Date.UTC(2026, 9, 13, 13, 35),
      authorId: 'bot',
      authorIsBot: true,
      authorIsSelf: true,
      webhookId: null,
      system: false,
      content,
      attachmentCount: 1,
    };
    const out = buildExportRows([raw], [{ id: DISCORD_CH, name: 'sync', isMirror: true }], '2026-10-12');
    const flat = JSON.stringify(out.rows);
    expect(flat).not.toContain(LINE_NAME);
    expect(flat).not.toContain('line-image');
    expect(flat).not.toContain('https://');
  });
});

// ─── Discord → LINE ──────────────────────────────────────────────────────

describe('Discord picture → LINE (reply queue + relay route)', () => {
  function routeApp(store: RelayMediaStore): express.Express {
    const app = express();
    app.get(`${MEDIA_RELAY_PATH}/:file`, createRelayMediaHandler(store));
    return app;
  }

  it('a small JPEG becomes text line + LINE image message; both URLs are served by the relay route', async () => {
    const pic = jpeg(50_000);
    const h = setup();
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(pic) });
    const outcome = await handleDiscordMirrorMessage(
      discordMessage({ content: DC_TEXT, attachmentsList: [attachment({ key: 'a1', size: pic.length })] }),
      { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl },
    );
    expect(outcome).toBe('media');
    expect(f.calls).toHaveLength(1); // ≤ 1 MB: no separate preview download
    expect(h.lobby.map((m) => m.message)).toEqual([`${DC_TEXT} （圖片）`]);
    expect(h.discord.sent).toEqual([]); // never echoed back to Discord
    expect(h.mirror.lineReplyQueueSize()).toBe(2);

    await drainOnce(h.bot, 'rt1');
    expect(h.sdk.replies).toHaveLength(1);
    const [text, image] = h.sdk.replies[0].messages;
    expect(text).toEqual({ type: 'text', text: expect.stringMatching(new RegExp(`\\[DC\\]\\[${DC_NAME}\\] ${DC_TEXT} （圖片）$`)) });
    expect(image.type).toBe('image');
    expect(image.originalContentUrl).toMatch(new RegExp(`^${BASE}${MEDIA_RELAY_PATH}/[A-Za-z0-9_-]{32}\\.jpg$`));
    expect(image.previewImageUrl).toBe(image.originalContentUrl);
    expect(h.bot.getWebhookStats()).toMatchObject({ imagesToLine: 1, imageNotesToLine: 0, repliesDrained: 2 });

    const res = await request(routeApp(h.store!)).get(new URL(image.originalContentUrl!).pathname).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(res.body as Buffer, pic)).toBe(0);
    expectCleanLogs();
  });

  it('a picture over 1 MB gets a resized ≤ 1 MB preview from the Discord media proxy', async () => {
    const big = jpeg(3 * MB);
    const small = jpeg(80_000);
    const h = setup();
    const f = mockFetch({
      'https://cdn.discordapp.com/': () => bytesResponse(big),
      'https://media.discordapp.net/': () => bytesResponse(small),
    });
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'b', size: big.length, width: 4000, height: 3000 })] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: f.fetchImpl,
    });
    expect(f.calls).toHaveLength(2);
    const preview = new URL(f.calls[1]);
    expect(preview.hostname).toBe('media.discordapp.net');
    expect(preview.searchParams.get('width')).toBe('640');
    expect(preview.searchParams.get('height')).toBe('480');
    expect(preview.searchParams.get('hm')).toBe('3'); // Discord's signature kept

    await drainOnce(h.bot, 'rt');
    const image = h.sdk.replies[0].messages[1];
    expect(image.previewImageUrl).not.toBe(image.originalContentUrl);
    const app = routeApp(h.store!);
    const o = await request(app).get(new URL(image.originalContentUrl!).pathname).buffer(true);
    const p = await request(app).get(new URL(image.previewImageUrl!).pathname).buffer(true);
    expect((o.body as Buffer).length).toBe(big.length);
    expect((p.body as Buffer).length).toBe(small.length);
    expect(h.lobby[0].message).toBe('（圖片）');
  });

  it('no usable preview → the picture goes as a note and its copy is freed', async () => {
    const h = setup();
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(2 * MB)) }); // proxy 404s
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'c', size: 2 * MB })] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: f.fetchImpl,
    });
    expect(h.store!.stats().entries).toBe(0);
    await drainOnce(h.bot, 'rt');
    expect(h.sdk.replies[0].messages.map((m) => m.text)).toEqual([
      expect.stringMatching(/\] （圖片）$/),
      '（Discord 有一張圖片，請到 Discord 看）',
    ]);
  });

  it('webp / gif / heic, spoilers, > 10 MB pictures and non-JPEG bytes become a note; other files a file note', async () => {
    const h = setup();
    const f = mockFetch({ 'https://cdn.discordapp.com/attachments/1/fake/': () => bytesResponse(Buffer.from('<html>not an image</html>')) });
    const list = [
      attachment({ key: 'w', name: 'w.webp', contentType: 'image/webp' }),
      attachment({ key: 'g', name: 'g.gif', contentType: 'image/gif' }),
      attachment({ key: 'h', name: 'h.heic', contentType: 'image/heic' }),
      attachment({ key: 's', name: 'SPOILER_s.jpg', spoiler: true }),
      attachment({ key: 'x', size: 11 * MB }),
      attachment({ key: 'fake' }),
      attachment({ key: 'doc', name: 'notes.pdf', contentType: 'application/pdf' }),
    ];
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: list }), { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl });
    expect(f.calls).toHaveLength(1); // only the declared-JPEG ≤ 10 MB one was fetched (and refused by its bytes)
    expect(h.lobby[0].message).toBe('（圖片 ×6、檔案）');
    await drainOnce(h.bot, 'rt');
    expect(h.sdk.replies[0].messages.map((m) => m.type)).toEqual(['text', 'text']);
    expect(h.sdk.replies[0].messages[1].text).toBe('（Discord 有 6 張圖片、一個檔案，請到 Discord 看）');
    expect(h.store!.stats().entries).toBe(0);
    expect(JSON.stringify(h.sdk.replies)).not.toContain('notes.pdf');
  });

  it('at most 4 pictures per Discord message go to LINE as images; the rest are named in the note', async () => {
    const h = setup();
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    const list = Array.from({ length: 6 }, (_, i) => attachment({ key: `m${i}` }));
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: list }), { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl });
    expect(f.calls).toHaveLength(4);
    await drainOnce(h.bot, 'r1');
    await drainOnce(h.bot, 'r2');
    expect(h.sdk.replies[0].messages.map((m) => m.type)).toEqual(['text', 'image', 'image', 'image', 'image']);
    expect(h.sdk.replies[1].messages).toEqual([{ type: 'text', text: '（Discord 有 2 張圖片，請到 Discord 看）' }]);
  });

  it('Discord stickers relay as （貼圖）', async () => {
    const h = setup();
    await handleDiscordMirrorMessage(discordMessage({ stickerCount: 1 }), { targetChannelId: DISCORD_CH, mirror: h.mirror });
    expect(h.lobby[0].message).toBe('（貼圖）');
    expect(h.mirror.lineReplyQueueSize()).toBe(1);
  });

  it('without the relay (not reply-queue mode / no https base) nothing is downloaded and LINE gets the marker line only', async () => {
    const h = setup({ store: null });
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'n' })] }), { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl });
    expect(f.calls).toEqual([]);
    await drainOnce(h.bot, 'rt');
    expect(h.sdk.replies[0].messages.map((m) => m.text)).toEqual([expect.stringMatching(/\] （圖片）$/), '（Discord 有一張圖片，請到 Discord 看）']);
  });

  it('a copy that expired (or was evicted) before the drain goes out as the text note', async () => {
    let now = 1_800_000_000_000;
    const store = new RelayMediaStore({ now: () => now, ttlMs: 1000 });
    const h = setup({ store });
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'e' })] }), { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl });
    now += 1000;
    await drainOnce(h.bot, 'rt');
    expect(h.sdk.replies[0].messages.map((m) => m.type)).toEqual(['text', 'text']);
    expect(h.sdk.replies[0].messages[1].text).toBe('（Discord 有一張圖片，請到 Discord 看）');
    expect(h.bot.getWebhookStats()).toMatchObject({ imagesToLine: 0, imageNotesToLine: 1 });
  });

  it('sending an image keeps its copy alive ≥ 24 h after the reply', async () => {
    let now = 1_800_000_000_000;
    const store = new RelayMediaStore({ now: () => now, ttlMs: 60 * 60 * 1000 });
    const h = setup({ store });
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'k' })] }), { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl });
    await drainOnce(h.bot, 'rt');
    const id = new URL(h.sdk.replies[0].messages[1].originalContentUrl!).pathname.split('/').pop()!.split('.')[0];
    now += 23 * 60 * 60 * 1000;
    expect(store.has(id)).toBe(true);
  });

  it('batching: mixed texts and pictures keep their order, ≤ 5 objects per reply', async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) {
      await h.mirror.fanout({ id: `l${i}`, playerId: 'p', playerName: 'Web', message: `w${i}`, timestamp: Date.now(), source: 'lobby' });
    }
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    await handleDiscordMirrorMessage(
      discordMessage({ content: 'two', attachmentsList: [attachment({ key: 'p1' }), attachment({ key: 'p2' })] }),
      { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl },
    );
    expect(h.mirror.lineReplyQueueSize()).toBe(6);
    await drainOnce(h.bot, 'r1');
    await drainOnce(h.bot, 'r2');
    const shape = (r: { messages: SentLineMessage[] }) => r.messages.map((m) => (m.type === 'image' ? 'IMG' : m.text!.split('] ').pop()));
    expect(shape(h.sdk.replies[0])).toEqual(['w0', 'w1', 'w2', 'two （圖片 ×2）', 'IMG']);
    expect(shape(h.sdk.replies[1])).toEqual(['IMG']);
  });

  it('a failed reply re-queues texts and pictures in order; a picture failing twice goes as its note', async () => {
    let failing = true;
    const h = setup({ line: { replyFails: () => (failing ? Object.assign(new Error('x'), { name: 'HTTPError', statusCode: 500 }) : null) } });
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    await handleDiscordMirrorMessage(discordMessage({ content: 'hi', attachmentsList: [attachment({ key: 'q' })] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: f.fetchImpl,
    });
    await drainOnce(h.bot, 'r1');
    expect(h.mirror.lineReplyQueueSize()).toBe(2);
    failing = false;
    await drainOnce(h.bot, 'r2');
    expect(h.sdk.replies[0].messages.map((m) => m.type)).toEqual(['text', 'image']);

    // twice in a row → the picture degrades to its note so the queue cannot jam
    failing = true;
    await handleDiscordMirrorMessage(discordMessage({ id: 'dm2', attachmentsList: [attachment({ key: 'q2' })] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: f.fetchImpl,
    });
    await drainOnce(h.bot, 'r3');
    await drainOnce(h.bot, 'r4');
    failing = false;
    await drainOnce(h.bot, 'r5');
    expect(h.sdk.replies[1].messages.map((m) => m.type)).toEqual(['text', 'text']);
    expect(h.sdk.replies[1].messages[1].text).toBe('（Discord 有一張圖片，請到 Discord 看）');
    expect(logged.filter((l) => l.includes('replyMessage failed')).every((l) => /status=500/.test(l))).toBe(true);
    expectCleanLogs();
  });

  it('LINE rejecting an image URL (400 on originalContentUrl) degrades the picture at once', async () => {
    let failing = true;
    const rejection = Object.assign(new Error('Request failed with status code 400'), {
      name: 'HTTPError',
      statusCode: 400,
      originalError: { response: { data: { message: 'The request body has 1 error(s)', details: [{ property: 'messages[1].originalContentUrl', message: 'invalid' }] } } },
    });
    expect(lineErrorMentionsImage(rejection)).toBe(true);
    expect(lineErrorMentionsImage({ status: 400, body: JSON.stringify({ details: [{ property: 'messages[0].previewImageUrl' }] }) })).toBe(true);
    expect(lineErrorMentionsImage({ statusCode: 400, originalError: { response: { data: { message: 'Invalid reply token' } } } })).toBe(false);

    const h = setup({ line: { replyFails: () => (failing ? rejection : null) } });
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'z' })] }), { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl });
    await drainOnce(h.bot, 'r1');
    failing = false;
    await drainOnce(h.bot, 'r2');
    expect(h.sdk.replies[0].messages.map((m) => m.type)).toEqual(['text', 'text']);
    expect(h.store!.stats().entries).toBe(0);
  });

  it('no loop: bot / webhook / [Avalon]-tagged / other-channel messages are ignored and download nothing', async () => {
    const h = setup();
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    const atts = [attachment({ key: 'loop' })];
    const deps = { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl };
    expect(await handleDiscordMirrorMessage(discordMessage({ attachmentsList: atts, author: { id: 'me', bot: true } }), deps)).toBe('ignored');
    expect(await handleDiscordMirrorMessage(discordMessage({ attachmentsList: atts, webhookId: 'w' }), deps)).toBe('ignored');
    expect(await handleDiscordMirrorMessage(discordMessage({ attachmentsList: atts, content: '[Avalon] x: y' }), deps)).toBe('ignored');
    expect(await handleDiscordMirrorMessage(discordMessage({ attachmentsList: atts, channelId: 'other' }), deps)).toBe('ignored');
    expect(f.calls).toEqual([]);
    expect(h.lobby).toEqual([]);
    expect(h.mirror.lineReplyQueueSize()).toBe(0);
  });

  it('a rate-limited speaker downloads nothing and leaves no copies behind', async () => {
    const h = setup({ rate: 1 });
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    const deps = { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl };
    expect(await handleDiscordMirrorMessage(discordMessage({ id: 'dm8', attachmentsList: [attachment({ key: 'q' })] }), deps)).toBe('media');
    expect(f.calls).toHaveLength(1);
    expect(await handleDiscordMirrorMessage(discordMessage({ id: 'dm9', attachmentsList: [attachment({ key: 'r' })] }), deps)).toBe('rate-limited');
    expect(f.calls).toHaveLength(1); // nothing more downloaded
    expect(h.store!.stats().entries).toBe(1); // only the admitted picture's copy
  });

  it('pictures alone do not use up the text limit: five screenshots, then the text still goes through', async () => {
    const h = setup({ rate: 2 });
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    const deps = { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl };
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(await handleDiscordMirrorMessage(discordMessage({ id: `shot${i}`, attachmentsList: [attachment({ key: `s${i}` })] }), deps));
    }
    expect(outcomes).toEqual(['media', 'media', 'rate-limited', 'rate-limited', 'rate-limited']); // pictures: their own limit
    expect(await handleDiscordMirrorMessage(discordMessage({ id: 'txt', content: 'see-above' }), deps)).toBe('text');
    expect(h.lobby.map((m) => m.message).at(-1)).toBe('see-above');
    await drainOnce(h.bot, 'rt');
    expect(JSON.stringify(h.sdk.replies)).toContain('see-above');
  });

  it('push mode (no reply queue): a picture or sticker alone never goes to LINE (quota); text still does', async () => {
    __resetChatMirrorForTests();
    const pushes: unknown[] = [];
    const mirror = initializeChatMirror({
      lineGroupId: GROUP,
      discordChannelId: DISCORD_CH,
      line: { pushMessage: async (_to, m) => void pushes.push(m) },
      logger,
    });
    const lobby: LobbyChatMessage[] = [];
    mirror.setLobbyIngest((m) => lobby.push(m));
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    const deps = { targetChannelId: DISCORD_CH, mirror, fetchImpl: f.fetchImpl };
    expect(await handleDiscordMirrorMessage(discordMessage({ id: 'a', attachmentsList: [attachment({ key: 'a' })] }), deps)).toBe('media');
    expect(await handleDiscordMirrorMessage(discordMessage({ id: 'b', stickerCount: 1 }), deps)).toBe('media');
    expect(pushes).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(lobby.map((m) => m.message)).toEqual(['（圖片）', '（貼圖）']); // the lobby still sees them
    expect(await handleDiscordMirrorMessage(discordMessage({ id: 'c', content: 'hello', attachmentsList: [attachment({ key: 'c' })] }), deps)).toBe('media');
    expect(pushes).toHaveLength(1); // text with a picture: the text line, as before
  });

  it('a website lobby line sent while a Discord picture is downloading reaches LINE after it (the lobby / Discord order)', async () => {
    const h = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const f = mockFetch({
      'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)),
    });
    const slowFetch = (async (input: string | URL) => {
      await gate;
      return f.fetchImpl(input);
    }) as unknown as typeof fetch;
    const d1 = handleDiscordMirrorMessage(discordMessage({ id: 'd1', content: 'D1', attachmentsList: [attachment({ key: 'd1' })] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: slowFetch,
    });
    await new Promise((r) => setTimeout(r, 5)); // D1 is downloading
    const l1 = h.mirror.fanout({ id: 'l1', playerId: 'p', playerName: 'Web', message: 'L1', timestamp: Date.now(), source: 'lobby' });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([d1, l1]);
    await drainOnce(h.bot, 'rt');
    const shape = h.sdk.replies[0].messages.map((m) => (m.type === 'image' ? 'IMG' : m.text!.split('] ').pop()));
    expect(shape).toEqual(['D1 （圖片）', 'IMG', 'L1']);
  });

  it('text-only messages keep the exact pre-image behaviour', async () => {
    const h = setup();
    const observed: string[] = [];
    await handleDiscordMirrorMessage(discordMessage({ content: '  hello there  ' }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      observe: (t) => observed.push(t),
    });
    expect(observed).toEqual(['hello there']);
    expect(h.lobby.map((m) => m.message)).toEqual(['hello there']);
    await drainOnce(h.bot, 'rt');
    expect(h.sdk.replies[0].messages).toEqual([{ type: 'text', text: expect.stringMatching(new RegExp(`\\[DC\\]\\[${DC_NAME}\\] hello there$`)) }]);
  });
});

describe('/api/bots/status', () => {
  it('has a mediaRelay block with a flag and counters only (off until initializeBots wires it)', () => {
    expect(buildBotStatus().mediaRelay).toEqual({ enabled: false, stats: null });
  });
});

describe('marker helpers', () => {
  it('discordMediaMarker / discordLeftoverNote / withMediaMarker', () => {
    expect(discordMediaMarker({ images: 1, files: 0, stickers: 0 })).toBe('（圖片）');
    expect(discordMediaMarker({ images: 2, files: 1, stickers: 1 })).toBe('（圖片 ×2、檔案、貼圖）');
    expect(discordLeftoverNote({ images: 0, files: 0 })).toBeNull();
    expect(discordLeftoverNote({ images: 1, files: 0 })).toBe('（Discord 有一張圖片，請到 Discord 看）');
    expect(discordLeftoverNote({ images: 0, files: 2 })).toBe('（Discord 有 2 個檔案，請到 Discord 看）');
    // 2026-10-13: never cut for the relay; only the lobby's display copy is.
    expect(withMediaMarker('字'.repeat(300), '（圖片）')).toBe(`${'字'.repeat(300)} （圖片）`);
    const lobby = lobbyDisplayText('字'.repeat(300), 'discord', '（圖片）');
    expect(lobby.length).toBeLessThanOrEqual(200);
    expect(lobby.endsWith('…（全文請到 Discord 看） （圖片）')).toBe(true);
    expect(lobbyDisplayText('short', 'line', '（圖片）')).toBe('short （圖片）');
  });

  it('discordPreviewUrl keeps Discord hosts only', () => {
    expect(discordPreviewUrl(attachment({ key: 'a', proxyURL: 'https://evil.test/x.jpg' }), 640)).toBeNull();
    expect(discordPreviewUrl(attachment({ key: 'a', width: null, height: null }), 320)).toContain('width=320');
  });
});


// ─── Review fixes (2026-10-13 round 3) ───────────────────────────────────

/** Fetch mock that records concurrency and answers after `delayMs`. */
function slowFetch(delayMs: number, bytes: () => Buffer): { fetchImpl: typeof fetch; calls: string[]; maxInFlight: () => number } {
  const calls: string[] = [];
  let inFlight = 0;
  let max = 0;
  const fetchImpl = (async (input: string | URL) => {
    calls.push(String(input));
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight -= 1;
    return bytesResponse(bytes());
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, maxInFlight: () => max };
}

describe('LINE → Discord: a hung platform call cannot hold later pictures', () => {
  it('a LINE content stream that never ends times out into a note, is destroyed, and the next picture still uploads', async () => {
    const hang = new PassThrough();
    hang.write(jpeg(100)); // some bytes, then nothing, forever
    const h = setup({
      line: { content: { stuck: () => hang, next: () => Readable.from([jpeg(100)]) } },
      mediaTimeouts: { downloadMs: 30 },
    });
    await postLine(h.bot, [groupEvent(imageMsg('stuck'), 'r1'), groupEvent(imageMsg('next'), 'r2')]);
    expect(h.discord.sent).toEqual([expect.stringMatching(/（圖片沒有同步過來，請到 LINE 看）$/)]);
    expect(h.discord.uploads).toHaveLength(1);
    expect(hang.destroyed).toBe(true);
    expect(h.bot.getWebhookStats()).toMatchObject({ imagesToDiscord: 1, imageNotesToDiscord: 1, imageFailures: 0 });
    expect(logged.some((l) => l.includes('picture download timed out'))).toBe(true);
    expectCleanLogs();
  });

  it('a LINE content request that never answers times out too', async () => {
    const h = setup({
      line: { content: { never: () => new Promise<never>(() => {}) as unknown as Readable, ok: () => Readable.from([jpeg(100)]) } },
      mediaTimeouts: { downloadMs: 30 },
    });
    await postLine(h.bot, [groupEvent(imageMsg('never'), 'r1'), groupEvent(imageMsg('ok'), 'r2')]);
    expect(h.discord.sent).toHaveLength(1);
    expect(h.discord.uploads).toHaveLength(1);
  });

  it('a Discord upload that never settles is cut off by the job timeout (outcome=timeout) and the chain moves on', async () => {
    const content = { a: () => Readable.from([jpeg(100)]), b: () => Readable.from([jpeg(100)]) };
    // The job timeout frees the LINE picture line; the Discord call bound frees the send chain.
    const h = setup({ discord: { firstUploadHangs: true }, line: { content }, mediaTimeouts: { jobMs: 40 }, discordCallTimeoutMs: 60 });
    await postLine(h.bot, [groupEvent(imageMsg('a'), 'r1'), groupEvent(imageMsg('b'), 'r2')]);
    expect(h.discord.uploads).toHaveLength(1);
    expect(h.bot.getWebhookStats()).toMatchObject({ imagesToDiscord: 1, imageFailures: 1 });
    expect(logged.some((l) => l.includes('picture outcome=timeout'))).toBe(true);
  });

  it('no Discord channel → counted under imageFailures (not lost silently)', async () => {
    const h = setup({ discord: { noChannel: true }, line: { content: { a: () => Readable.from([jpeg(100)]) } } });
    await postLine(h.bot, [groupEvent(imageMsg('a'), 'r1')]);
    expect(h.bot.getWebhookStats()).toMatchObject({ imagesToDiscord: 0, imageNotesToDiscord: 0, imageFailures: 1 });
  });
});

describe('message order next to a picture', () => {
  it('LINE: a text right after a picture reaches Discord after that picture', async () => {
    const h = setup({ line: { content: { a: () => Readable.from([jpeg(100)]) } } });
    await postLine(h.bot, [groupEvent(imageMsg('a'), 'r1'), groupEvent({ type: 'text', id: 't1', text: 'caption-after' }, 'r2')]);
    expect(h.discord.order).toEqual(['file:（圖片）', 'text:caption-after']);
    expect(h.lobby.map((m) => m.message)).toEqual(['（圖片）', 'caption-after']);
  });

  it('LINE: the text waits for earlier pictures at most textWaitMs, then goes anyway', async () => {
    const h = setup({
      discord: { firstUploadHangs: true },
      line: { content: { a: () => Readable.from([jpeg(100)]) } },
      mediaTimeouts: { textWaitMs: 20, jobMs: 5_000 },
      discordCallTimeoutMs: 40, // the hung upload holds the Discord send chain at most this long
    });
    const { req, res } = lineRequest({ destination: 'U', events: [groupEvent(imageMsg('a'), 'r1'), groupEvent({ type: 'text', id: 't1', text: 'later' }, 'r2')] });
    await h.bot.handleWebhook(req, res);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.discord.order).toEqual(['text:later']);
  });

  it('LINE: with no picture pending, text goes at once exactly as before', async () => {
    const h = setup();
    const { req, res } = lineRequest({ destination: 'U', events: [groupEvent({ type: 'text', id: 't1', text: 'plain' }, 'r1')] });
    await h.bot.handleWebhook(req, res);
    await new Promise((r) => setImmediate(r));
    expect(h.discord.order).toEqual(['text:plain']);
  });

  it('Discord: a quick text after a slowly downloading picture stays behind it on LINE; the lobby keeps arrival order', async () => {
    const h = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchImpl = (async () => {
      await gate;
      return bytesResponse(jpeg(100));
    }) as unknown as typeof fetch;
    const deps = { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl };
    const first = handleDiscordMirrorMessage(discordMessage({ id: 'm1', content: 'look', attachmentsList: [attachment({ key: 'a' })] }), deps);
    const second = handleDiscordMirrorMessage(discordMessage({ id: 'm2', content: 'second-text' }), deps);
    await new Promise((r) => setImmediate(r));
    expect(h.lobby.map((m) => m.message)).toEqual(['look （圖片）', 'second-text']); // lobby at arrival
    expect(h.mirror.lineReplyQueueSize()).toBe(0); // LINE waits for the picture
    release();
    expect(await first).toBe('media');
    expect(await second).toBe('text');
    const items = h.mirror.drainLineReplies(5).map((i) => (i.image ? 'IMG' : i.text.split('] ').pop()));
    expect(items).toEqual(['look （圖片）', 'IMG', 'second-text']);
  });
});

describe('Discord → LINE: downloads are bounded however many messages arrive at once', () => {
  it('one speaker, 10 simultaneous picture messages, limit 5 → the slot is taken at arrival: 5 relayed, 5 refused, no download for them', async () => {
    const h = setup({ rate: 5 });
    const f = slowFetch(5, () => jpeg(1000));
    const deps = { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl };
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        handleDiscordMirrorMessage(discordMessage({ id: `c${i}`, attachmentsList: [attachment({ key: `k${i}` }), attachment({ key: `j${i}` })] }), deps),
      ),
    );
    expect(outcomes.filter((o) => o === 'media')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'rate-limited')).toHaveLength(5);
    expect(f.calls).toHaveLength(10); // 5 messages × 2 pictures
    expect(f.maxInFlight()).toBe(1);
    expect(h.store!.stats().entries).toBe(10);
  });

  it('many speakers at once → one download at a time; past 10 waiting messages, pictures go as the note', async () => {
    const h = setup();
    const f = slowFetch(2, () => jpeg(500));
    const deps = { targetChannelId: DISCORD_CH, mirror: h.mirror, fetchImpl: f.fetchImpl };
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        handleDiscordMirrorMessage(
          discordMessage({ id: `u${i}`, author: { id: `user-${i}`, bot: false, globalName: DC_NAME }, attachmentsList: [attachment({ key: `p${i}` })] }),
          deps,
        ),
      ),
    );
    expect(outcomes.every((o) => o === 'media')).toBe(true);
    expect(f.maxInFlight()).toBe(1);
    expect(f.calls).toHaveLength(10);
    expect(h.queue.imageCount()).toBe(10);
    const notes = [];
    for (let i = 0; i < 10; i++) notes.push(...h.mirror.drainLineReplies(5));
    expect(notes.filter((n) => n.text === '（Discord 有一張圖片，請到 Discord 看）' && !n.image)).toHaveLength(2);
  });

  it('a message whose download budget is used up sends its pictures as the note instead of waiting', async () => {
    const h = setup();
    const f = mockFetch({ 'https://cdn.discordapp.com/': () => bytesResponse(jpeg(100)) });
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'x' })] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: f.fetchImpl,
      budgetMs: 0,
    });
    expect(f.calls).toEqual([]);
    await drainOnce(h.bot, 'rt');
    expect(h.sdk.replies[0].messages.map((m) => m.text)).toEqual([expect.stringMatching(/\] （圖片）$/), '（Discord 有一張圖片，請到 Discord 看）']);
  });
});

describe('relay copies at drain time', () => {
  it('a picture whose preview copy is gone goes as its note, and its original is freed (not pinned for a day)', async () => {
    const h = setup();
    const f = mockFetch({
      'https://cdn.discordapp.com/': () => bytesResponse(jpeg(2_000_000)),
      'https://media.discordapp.net/': () => bytesResponse(jpeg(50_000)),
    });
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'pv', size: 2_000_000 })] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: f.fetchImpl,
    });
    const queued = h.mirror.drainLineReplies(5);
    const ids = queued.find((i) => i.image)!.image!.mediaIds;
    expect(ids).toHaveLength(2);
    h.store!.delete(ids[1]); // the preview is gone
    const out = h.mirror.lineMessagesFor(queued);
    expect(out).toMatchObject({ images: 0, fallbacks: 1 });
    expect(out.messages[1]).toEqual({ type: 'text', text: '（Discord 有一張圖片，請到 Discord 看）' });
    expect(h.store!.has(ids[0])).toBe(false);
  });

  it('LINE size limits are read as decimal MB: a 1,000,500-byte picture gets its own preview', async () => {
    expect(LINE_PREVIEW_MAX_BYTES).toBe(1_000_000);
    const h = setup();
    const f = mockFetch({
      'https://cdn.discordapp.com/': () => bytesResponse(jpeg(1_000_500)),
      'https://media.discordapp.net/': () => bytesResponse(jpeg(40_000)),
    });
    await handleDiscordMirrorMessage(discordMessage({ attachmentsList: [attachment({ key: 'd', size: 1_000_500 })] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: f.fetchImpl,
    });
    expect(f.calls).toHaveLength(2);
    const image = h.mirror.drainLineReplies(5).find((i) => i.image)!.image!;
    expect(image.previewUrl).not.toBe(image.originalUrl);
  });
});

describe('logs carry no ids', () => {
  it('a rate-limited speaker is logged by platform only', async () => {
    const h = setup({ rate: 1 });
    const deps = { targetChannelId: DISCORD_CH, mirror: h.mirror };
    await handleDiscordMirrorMessage(discordMessage({ id: 'r1', content: 'one' }), deps);
    expect(await handleDiscordMirrorMessage(discordMessage({ id: 'r2', content: 'two' }), deps)).toBe('rate-limited');
    expect(logged).toContain('inbound rate-limited: source=discord');
    expect(logged.join('\n')).not.toContain('discord:42');
  });
});
