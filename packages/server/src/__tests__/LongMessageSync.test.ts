/**
 * Long messages LINE ↔ Discord (2026-10-13 player report: a ~400-character
 * multi-line Discord message reached the LINE group cut off).
 *
 * In-process with the real ChatMirror + LineBotClient + reply queue + relay
 * store and mocked platform SDKs; made-up names and texts only, no network.
 *
 *   - 400 characters, many lines: arrives whole both ways (the website lobby
 *     shows its own cut copy)
 *   - over Discord's 2000 → parts on line boundaries, prefix + 「（續）」
 *   - over LINE's 5000 → parts in one group on the reply queue, spanning
 *     replies, pictures after them, re-queued exactly on a failed reply
 *   - ordering with pictures in both directions; no loop; one rate-limit hit
 *   - the Discord send chain keeps a message's parts together (pictures
 *     and the weekly digest wait their turn); a failed later part leaves a
 *     「（續）（後段沒有同步過來…）」 note
 *   - the chat-log export joins the parts back into one row, exactly
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { Readable } from 'stream';
import express from 'express';
import request from 'supertest';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import {
  ChatMirror,
  DISCORD_MESSAGE_MAX_CHARS,
  DISCORD_SEND_CALL_TIMEOUT_MS,
  LINE_TEXT_MAX_CHARS,
  MIRROR_CONTINUATION_MARKER,
  __resetChatMirrorForTests,
  initializeChatMirror,
  type DiscordAdapter,
  type DiscordChannelAdapter,
  type DiscordFile,
  type LineAdapter,
  discordMissingPartsNote,
} from '../bots/ChatMirror';
import { clampLineText, cutUnits, splitMirrorText } from '../bots/mirrorSplit';
import { LineReplyQueue } from '../bots/line/replyQueue';
import { LineBotClient } from '../bots/line/client';
import { handleDiscordMirrorMessage, type MirrorAttachmentLike, type MirrorMessageLike } from '../bots/discord/mirrorInbound';
import { RelayMediaStore } from '../bots/media/relayMedia';
import { buildExportRows, type RawChatMessage } from '../bots/chatExport/rows';
import { LINE_WEBHOOK_JSON_LIMIT, mountJsonBodyParsers, type RequestWithRawBody } from '../middleware/rawBody';
import { LOBBY_CHAT_MAX_LEN, type LobbyChatMessage } from '../socket/LobbyChatBuffer';

const GROUP = 'Cmirror-group';
const SECRET = 'test-channel-secret';
const DISCORD_CH = '1132901301802504242';
const BASE = 'https://avalon.example.test';
const LINE_NAME = 'LongPal-K4';
const DC_NAME = 'DcLong-M8';
const MARK = MIRROR_CONTINUATION_MARKER;

/** `n` lines like 「第3行：……」, joined with \n, about `perLine` characters each. */
function lines(n: number, perLine: number, tag = '行'): string {
  return Array.from({ length: n }, (_, i) => {
    const head = `第${i + 1}${tag}：`;
    return head + '湖中女神驗了三號所以這局'.repeat(Math.ceil(perLine / 12)).slice(0, Math.max(1, perLine - head.length));
  }).join('\n');
}

/** Body of a relayed message: the text after the `[MMDD hh:mm][TAG][name] ` prefix or the 「（續）」 marker. */
function bodyOf(part: string): string {
  if (part.startsWith(MARK)) return part.slice(MARK.length);
  const m = /^\[\d{4} \d{2}:\d{2}\]\[(?:LINE|DC|AP)\]\[[^\]]*\] ([\s\S]*)$/.exec(part);
  if (!m) throw new Error('not a relayed part');
  return m[1];
}

/** bodyOf() for the mock's order log; a legacy `[Avalon] name: ` post is logged as it is. */
function labelOf(part: string): string {
  try {
    return bodyOf(part);
  } catch {
    return part;
  }
}

/** Parts joined back: the split keeps the line break / space it falls on, so plain concatenation. */
function joinParts(parts: string[]): string {
  return parts.map(bodyOf).join('');
}

function jpeg(size: number): Buffer {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b);
  return b;
}

// ─── Mocks / harness ─────────────────────────────────────────────────────

function mockDiscord(
  opts: { sendDelayMs?: number; failOnCall?: number; hangOnCall?: number; uploadDelayMs?: number; onSend?: (content: string) => void } = {},
): {
  adapter: DiscordAdapter;
  sent: string[];
  order: string[];
} {
  const sent: string[] = [];
  const order: string[] = [];
  let calls = 0;
  const channel: DiscordChannelAdapter = {
    send: async (content: string) => {
      calls += 1;
      if (opts.hangOnCall === calls) return new Promise<never>(() => {});
      if (opts.failOnCall === calls) throw Object.assign(new Error(`Invalid Form Body ${content}`), { name: 'DiscordAPIError', status: 400, code: 50035 });
      if (opts.sendDelayMs) await new Promise((r) => setTimeout(r, opts.sendDelayMs));
      sent.push(content);
      order.push(`text:${content.startsWith(MARK) ? 'cont' : labelOf(content).slice(0, 12)}`);
      opts.onSend?.(content);
      return {};
    },
    sendFiles: async (content: string, _files: DiscordFile[]) => {
      if (opts.uploadDelayMs) await new Promise((r) => setTimeout(r, opts.uploadDelayMs));
      sent.push(content);
      order.push(`file:${bodyOf(content)}`);
      return {};
    },
  };
  return { adapter: { fetchChannel: async () => channel }, sent, order };
}

type SentLineMessage = { type: string; text?: string; originalContentUrl?: string };

function mockLineSdk(opts: { content?: Record<string, () => Readable>; failReplies?: number } = {}): {
  client: Client;
  replies: SentLineMessage[][];
} {
  const replies: SentLineMessage[][] = [];
  let failures = opts.failReplies ?? 0;
  const client = {
    replyMessage: async (_token: string, messages: SentLineMessage[]) => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error('Request failed with status code 500'), { name: 'HTTPError', statusCode: 500 });
      }
      replies.push(messages);
      return {};
    },
    pushMessage: async () => {
      throw new Error('push must never be used');
    },
    getGroupMemberProfile: async () => ({ displayName: LINE_NAME }),
    getMessageContent: async (id: string) => {
      const make = opts.content?.[id];
      if (!make) throw Object.assign(new Error('Not found'), { name: 'HTTPError', statusCode: 404 });
      return make();
    },
  } as unknown as Client;
  return { client, replies };
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
  return { req, res: fake as unknown as Response & { statusCode: number } };
}

function groupEvent(message: Record<string, unknown>, replyToken: string, userId = 'U1'): Record<string, unknown> {
  return { type: 'message', replyToken, source: { type: 'group', groupId: GROUP, userId }, message };
}

const logged: string[] = [];
const logger = {
  warn: (m: string) => logged.push(m),
  error: (m: string, e?: unknown) => logged.push(`${m} ${e === undefined ? '' : String(e)}`),
  info: (m: string) => logged.push(m),
};

function setup(opts: {
  discord?: Parameters<typeof mockDiscord>[0];
  line?: Parameters<typeof mockLineSdk>[0];
  rate?: number;
} = {}) {
  __resetChatMirrorForTests();
  const discord = mockDiscord(opts.discord);
  const sdk = mockLineSdk(opts.line);
  const store = new RelayMediaStore();
  const mirror = initializeChatMirror({
    lineGroupId: GROUP,
    discordChannelId: DISCORD_CH,
    discord: discord.adapter,
    lineReplyQueue: new LineReplyQueue(),
    lineImageRelay: { store, publicBaseUrl: BASE },
    logger,
    inboundRateLimit: { windowMs: 60_000, maxRequests: opts.rate ?? 100 },
  });
  const lobby: LobbyChatMessage[] = [];
  mirror.setLobbyIngest((m) => lobby.push(m));
  const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client: sdk.client });
  return { mirror, discord, sdk, bot, lobby, store };
}

async function postLine(bot: LineBotClient, events: Record<string, unknown>[]): Promise<number> {
  const { req, res } = lineRequest({ destination: 'U', events });
  await bot.handleWebhook(req, res);
  await bot.settleMediaRelays();
  return res.statusCode;
}

/** A sticker from the group: no text to relay, just a reply_token that drains the queue. */
async function drainOnce(bot: LineBotClient, token: string): Promise<void> {
  await postLine(bot, [groupEvent({ type: 'sticker', id: `st-${token}`, packageId: '1', stickerId: '2' }, token, 'U-drain')]);
}

function attachment(key: string): MirrorAttachmentLike {
  return {
    name: `${key}.jpg`,
    url: `https://cdn.discordapp.com/attachments/1/${key}/${key}.jpg?ex=1&is=2&hm=3`,
    proxyURL: `https://media.discordapp.net/attachments/1/${key}/${key}.jpg?ex=1&is=2&hm=3`,
    size: 2000,
    contentType: 'image/jpeg',
    width: 800,
    height: 600,
    spoiler: false,
  };
}

function discordMessage(content: string, over: Partial<MirrorMessageLike> & { pics?: MirrorAttachmentLike[] } = {}): MirrorMessageLike {
  const pics = over.pics ?? [];
  return {
    id: 'dm-long',
    channelId: DISCORD_CH,
    content,
    webhookId: null,
    author: { id: '42', bot: false, globalName: DC_NAME, username: 'dclong' },
    member: { displayName: DC_NAME },
    attachments: new Map(pics.map((a, i) => [String(i), a])),
    stickers: { size: 0 },
    ...over,
  };
}

function fetchJpeg(): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(jpeg(2000)), { status: 200, headers: { 'content-length': '2000' } })) as unknown as typeof fetch;
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  __resetChatMirrorForTests();
  logged.length = 0;
  process.env.LOBBY_MIRROR_LINE_GROUP_ID = GROUP;
  delete process.env.CHAT_MIRROR_USE_LEGACY_FORMAT;
  consoleSpies = (['log', 'warn', 'error', 'info'] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(' '));
    }),
  );
});
afterEach(() => {
  delete process.env.LOBBY_MIRROR_LINE_GROUP_ID;
  for (const s of consoleSpies) s.mockRestore();
  vi.useRealTimers();
});

/** Nothing identifying in any log line: no names or message text. */
function expectCleanLogs(): void {
  for (const line of logged) {
    for (const bad of [LINE_NAME, DC_NAME, '湖中女神', '第1行', 'https://']) expect(line).not.toContain(bad);
  }
}

// ─── splitMirrorText ─────────────────────────────────────────────────────

describe('splitMirrorText', () => {
  it('a text that fits is exactly one message, unchanged', () => {
    expect(splitMirrorText('[p] ', 'hello\nworld', 20)).toEqual(['[p] hello\nworld']);
    expect(splitMirrorText('[p] ', 'x'.repeat(16), 20)).toEqual([`[p] ${'x'.repeat(16)}`]);
  });

  it('splits on line boundaries, prefix first, 「（續）」 after; every part within the limit; nothing lost', () => {
    const text = lines(60, 50);
    const parts = splitMirrorText('[0101 10:00][LINE][A] ', text, 400);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].startsWith('[0101 10:00][LINE][A] 第1行')).toBe(true);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(400);
    // Each later part: the marker, then the line break the split fell on, then the next line.
    for (const p of parts.slice(1)) expect(p.startsWith(`${MARK}\n第`)).toBe(true);
    expect(joinParts(parts)).toBe(text);
  });

  it('without line breaks: a space, then sentence punctuation, then a hard cut that never splits a surrogate pair', () => {
    const spaced = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const bySpace = splitMirrorText('', spaced, 60);
    expect(bySpace.every((p) => p.length <= 60)).toBe(true);
    expect(bySpace.slice(1).every((p) => p.startsWith(`${MARK} word`))).toBe(true);
    expect(bySpace.map((p, i) => (i === 0 ? p : p.slice(MARK.length))).join('')).toBe(spaced);

    const sentences = '今天輸了。'.repeat(40);
    const byPunct = splitMirrorText('', sentences, 52);
    expect(byPunct.every((p) => p.length <= 52)).toBe(true);
    expect(byPunct[0].endsWith('。')).toBe(true);
    expect(byPunct.map((p, i) => (i === 0 ? p : p.slice(MARK.length))).join('')).toBe(sentences);

    const emoji = '😀'.repeat(50); // 100 UTF-16 units
    const byCut = splitMirrorText('', emoji, 33);
    expect(byCut.every((p) => p.length <= 33)).toBe(true);
    expect(byCut.map((p, i) => (i === 0 ? p : p.slice(MARK.length))).join('')).toBe(emoji);
    expect(byCut.join('')).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no lone high surrogate
  });

  it('a pathological prefix never pushes a part over the limit', () => {
    const parts = splitMirrorText('P'.repeat(500), 'b'.repeat(500), 100);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
  });

  it('clampLineText only ever cuts past LINE’s 5000; cutUnits keeps surrogate pairs whole', () => {
    expect(clampLineText('a'.repeat(LINE_TEXT_MAX_CHARS))).toHaveLength(LINE_TEXT_MAX_CHARS);
    const clamped = clampLineText('a'.repeat(LINE_TEXT_MAX_CHARS + 10));
    expect(clamped).toHaveLength(LINE_TEXT_MAX_CHARS);
    expect(clamped.endsWith('…')).toBe(true);
    expect(cutUnits('a😀', 2)).toBe('a');
  });
});

// ─── 400 characters, many lines: whole in both directions ────────────────

describe('a ~400-character multi-line message arrives whole', () => {
  const text = lines(10, 40);

  it('Discord → LINE: the whole text in one LINE message; the website lobby shows its own cut copy', async () => {
    expect(text.length).toBeGreaterThan(390);
    const h = setup();
    expect(await handleDiscordMirrorMessage(discordMessage(text), { targetChannelId: DISCORD_CH, mirror: h.mirror })).toBe('text');
    await drainOnce(h.bot, 'rt-a');
    expect(h.sdk.replies).toHaveLength(1);
    const texts = h.sdk.replies[0].map((m) => m.text ?? '');
    expect(texts).toHaveLength(1);
    expect(bodyOf(texts[0])).toBe(text);
    expect(texts[0]).toContain(`[DC][${DC_NAME}] 第1行`);

    const lobby = h.lobby.find((m) => m.source === 'discord');
    expect(lobby?.message.length).toBeLessThanOrEqual(LOBBY_CHAT_MAX_LEN);
    expect(lobby?.message.endsWith('…（全文請到 Discord 看）')).toBe(true);
    expect(h.discord.sent.some((c) => c.includes('[DC]'))).toBe(false); // never echoed back to Discord
    expectCleanLogs();
  });

  it('LINE → Discord: the whole text in one Discord message, line breaks kept', async () => {
    const h = setup();
    expect(await postLine(h.bot, [groupEvent({ type: 'text', id: 'm400', text }, 'rt-b')])).toBe(200);
    expect(h.discord.sent).toHaveLength(1);
    expect(h.discord.sent[0]).toMatch(new RegExp(`^\\[\\d{4} \\d{2}:\\d{2}\\]\\[LINE\\]\\[${LINE_NAME}\\] 第1行`));
    expect(bodyOf(h.discord.sent[0])).toBe(text);
    expect(h.lobby[0].message.endsWith('…（全文請到 LINE 看）')).toBe(true);
    expect(h.mirror.lineReplyQueueSize()).toBe(0); // never queued back to LINE
    expectCleanLogs();
  });

  it('a Discord message with text AND a picture keeps its whole text before the marker (the lobby copy keeps the marker)', async () => {
    const h = setup();
    await handleDiscordMirrorMessage(discordMessage(text, { pics: [attachment('p1')] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: fetchJpeg(),
    });
    await drainOnce(h.bot, 'rt-c');
    const [first, image] = h.sdk.replies[0];
    expect(bodyOf(first.text ?? '')).toBe(`${text} （圖片）`);
    expect(image.type).toBe('image');
    const lobby = h.lobby.find((m) => m.source === 'discord');
    expect(lobby?.message.length).toBeLessThanOrEqual(LOBBY_CHAT_MAX_LEN);
    expect(lobby?.message.endsWith('…（全文請到 Discord 看） （圖片）')).toBe(true);
  });
});

// ─── Over Discord's 2000: LINE → Discord parts ──────────────────────────

describe('LINE → Discord over 2000 characters', () => {
  it('a 6000-character LINE message becomes ordered parts ≤ 2000, prefix first, 「（續）」 after, nothing lost; one rate-limit hit', async () => {
    const text = lines(100, 59); // ≈ 6000 characters
    expect(text.length).toBeGreaterThanOrEqual(5900);
    const h = setup({ rate: 1 });
    await postLine(h.bot, [groupEvent({ type: 'text', id: 'm6000', text }, 'rt-d')]);
    const parts = h.discord.sent;
    expect(parts.length).toBe(4);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_CHARS);
    expect(parts[0]).toMatch(new RegExp(`^\\[\\d{4} \\d{2}:\\d{2}\\]\\[LINE\\]\\[${LINE_NAME}\\] 第1行`));
    for (const p of parts.slice(1)) expect(p.startsWith(`${MARK}\n第`)).toBe(true);
    expect(joinParts(parts)).toBe(text);
    // The split message used ONE slot of the per-user limit (1 per minute here).
    await postLine(h.bot, [groupEvent({ type: 'text', id: 'm-next', text: 'again' }, 'rt-e')]);
    expect(h.discord.sent).toHaveLength(4);
    expect(h.lobby).toHaveLength(1);
    expectCleanLogs();
  });

  it('a long text and pictures keep the LINE order on Discord (picture → text, text → picture)', async () => {
    const text = lines(60, 59); // ≈ 3600 → 2 parts
    const h = setup({
      line: { content: { pa: () => Readable.from([jpeg(1500)]), pb: () => Readable.from([jpeg(1500)]) } },
    });
    await postLine(h.bot, [
      groupEvent({ type: 'image', id: 'pa', contentProvider: { type: 'line' } }, 'rt-f'),
      groupEvent({ type: 'text', id: 'mt', text }, 'rt-g'),
      groupEvent({ type: 'image', id: 'pb', contentProvider: { type: 'line' } }, 'rt-h'),
    ]);
    expect(h.discord.order).toEqual(['file:（圖片）', 'text:第1行：湖中女神驗了三號', 'text:cont', 'file:（圖片）']);
  });

  it('two long messages posted at once are never interleaved on Discord (one send chain)', async () => {
    const h = setup({ discord: { sendDelayMs: 2 } });
    const a = lines(50, 79, 'A'); // ≈ 4000 → 3 parts
    const b = lines(40, 79, 'B'); // ≈ 3200 → 2 parts
    const ma = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U1', displayName: LINE_NAME, text: a, messageId: 'line:a' });
    const mb = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U2', displayName: LINE_NAME, text: b, messageId: 'line:b' });
    await Promise.all([h.mirror.crossFanout(ma!), h.mirror.crossFanout(mb!)]);
    const heads = h.discord.sent.map((p) => (p.startsWith(MARK) ? MARK : bodyOf(p).slice(0, 3)));
    expect(heads).toEqual(['第1A', MARK, MARK, '第1B', MARK]);
    expect(joinParts(h.discord.sent.slice(0, 3))).toBe(a);
    expect(joinParts(h.discord.sent.slice(3))).toBe(b);
  });

  it('a failed later part stops the rest of that message and leaves a short 「後段沒有同步過來」 note; the next message still goes', async () => {
    const h = setup({ discord: { failOnCall: 2 } });
    const text = lines(50, 79);
    const m1 = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U1', displayName: LINE_NAME, text, messageId: 'line:1' });
    await h.mirror.crossFanout(m1!);
    expect(h.discord.sent).toHaveLength(2);
    expect(h.discord.sent[1]).toBe(discordMissingPartsNote('line'));
    expect(h.discord.sent[1]).toBe(`${MARK}（後段沒有同步過來，請到 LINE 看）`);
    const m2 = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U1', displayName: LINE_NAME, text: 'short one', messageId: 'line:2' });
    await h.mirror.crossFanout(m2!);
    expect(bodyOf(h.discord.sent[2])).toBe('short one');
    expect(logged.some((l) => l.includes('Discord push failed') && l.includes('part 2 of 3'))).toBe(true);
    expectCleanLogs();
  });

  it('a failed FIRST part posts nothing (no note without a start), like a short message that fails', async () => {
    const h = setup({ discord: { failOnCall: 1 } });
    const m1 = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U1', displayName: LINE_NAME, text: lines(50, 79), messageId: 'line:f1' });
    await h.mirror.crossFanout(m1!);
    expect(h.discord.sent).toHaveLength(0);
    expect(logged.some((l) => l.includes('part 1 of 3'))).toBe(true);
  });

  it('a hung call cannot hold the chain: after the per-call bound the next message goes and the stuck one stops', async () => {
    // Longer than discord.js's own give-up (15 s × 4 tries), so the stuck request is abandoned, not landing late.
    expect(DISCORD_SEND_CALL_TIMEOUT_MS).toBeGreaterThan(4 * 15_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup({ discord: { hangOnCall: 2 } });
    const text = lines(50, 79);
    const m1 = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U1', displayName: LINE_NAME, text, messageId: 'line:h1' });
    const m2 = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U2', displayName: LINE_NAME, text: 'after the hang', messageId: 'line:h2' });
    const p1 = h.mirror.crossFanout(m1!);
    const p2 = h.mirror.crossFanout(m2!);
    await vi.advanceTimersByTimeAsync(DISCORD_SEND_CALL_TIMEOUT_MS - 1_000);
    expect(h.discord.sent).toHaveLength(1); // still waiting on part 2: nothing else jumps in
    await vi.advanceTimersByTimeAsync(1_010);
    await Promise.all([p1, p2]);
    expect(h.discord.sent.slice(1).map(bodyOf)).toEqual(['after the hang']);
    expect(logged.some((l) => l.includes('Discord push timed out') && l.includes('part 2 of 3'))).toBe(true);
    expectCleanLogs();
  });

  it('a LINE picture whose upload is ready while a long text is going out waits for all its parts (one send chain)', async () => {
    const h = setup({ discord: { sendDelayMs: 3 } });
    const text = lines(60, 59); // ≈ 3600 → 2 parts
    const m = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U1', displayName: LINE_NAME, text, messageId: 'line:t' });
    const pic: LobbyChatMessage = { id: 'line:p', playerId: 'line:U2', playerName: LINE_NAME, message: '（圖片）', timestamp: Date.now(), source: 'line' };
    const textDone = h.mirror.crossFanout(m!);
    const picDone = h.mirror.postLineImageToDiscord(pic, async () => ({ ok: true, data: jpeg(1200) }));
    await Promise.all([textDone, picDone]);
    expect(await picDone).toBe('uploaded');
    expect(h.discord.order).toEqual(['text:第1行：湖中女神驗了三號', 'text:cont', 'file:（圖片）']);
  });

  it('the weekly digest (runOnDiscordSendChain) waits for a long message’s parts and gets its own result / error', async () => {
    const h = setup({ discord: { sendDelayMs: 3 } });
    const m = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U1', displayName: LINE_NAME, text: lines(60, 59), messageId: 'line:d' });
    const textDone = h.mirror.crossFanout(m!);
    const digest = h.mirror.runOnDiscordSendChain(async () => {
      h.discord.order.push('digest');
      return 'posted';
    });
    await expect(digest).resolves.toBe('posted');
    await textDone;
    expect(h.discord.order).toEqual(['text:第1行：湖中女神驗了三號', 'text:cont', 'digest']);
    await expect(h.mirror.runOnDiscordSendChain(async () => Promise.reject(new Error('gateway down')))).rejects.toThrow('gateway down');
    // The chain still runs after a failed digest.
    await h.mirror.crossFanout({ ...m!, message: 'later' });
    expect(bodyOf(h.discord.sent[h.discord.sent.length - 1])).toBe('later');
  });

  it('legacy format (CHAT_MIRROR_USE_LEGACY_FORMAT=true): `[Avalon] 名字: ` on the first part, 「（續）」 after', async () => {
    process.env.CHAT_MIRROR_USE_LEGACY_FORMAT = 'true';
    const h = setup();
    const text = lines(100, 59);
    const m = h.mirror.ingestInbound({ source: 'line', platformUserId: 'U1', displayName: LINE_NAME, text, messageId: 'line:legacy' });
    await h.mirror.crossFanout(m!);
    const parts = h.discord.sent;
    expect(parts.length).toBe(4);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_CHARS);
    expect(parts[0].startsWith(`[Avalon] ${LINE_NAME}: 第1行`)).toBe(true);
    for (const p of parts.slice(1)) expect(p.startsWith(`${MARK}\n第`)).toBe(true);
    const legacyHead = `[Avalon] ${LINE_NAME}: `;
    expect(parts[0].slice(legacyHead.length) + parts.slice(1).map((p) => p.slice(MARK.length)).join('')).toBe(text);
  });
});

// ─── Over LINE's 5000: Discord → LINE parts on the reply queue ───────────

describe('→ LINE over 5000 characters (reply queue)', () => {
  it('a 12000-character message is queued as parts ≤ 5000, then its pictures; it spans replies in order; a failed reply re-queues exactly', async () => {
    const text = lines(150, 79); // ≈ 12000
    expect(text.length).toBeGreaterThanOrEqual(11_900);
    const h = setup({ line: { failReplies: 1 } });
    await h.mirror.fanout({ id: 'w1', playerId: 'p', playerName: 'WebPal', message: 'before', timestamp: Date.now(), source: 'lobby' });
    await handleDiscordMirrorMessage(discordMessage(text, { id: 'dm-12k', pics: [attachment('q1'), attachment('q2')] }), {
      targetChannelId: DISCORD_CH,
      mirror: h.mirror,
      fetchImpl: fetchJpeg(),
    });
    await handleDiscordMirrorMessage(discordMessage('after', { id: 'dm-after' }), { targetChannelId: DISCORD_CH, mirror: h.mirror });
    // before, 3 text parts, 2 pictures, after
    expect(h.mirror.lineReplyQueueSize()).toBe(7);

    await drainOnce(h.bot, 'rt-fail'); // reply refused → the exact batch goes back to the head
    expect(h.sdk.replies).toHaveLength(0);
    expect(h.mirror.lineReplyQueueSize()).toBe(7);

    await drainOnce(h.bot, 'rt-1');
    await drainOnce(h.bot, 'rt-2');
    expect(h.sdk.replies.map((r) => r.length)).toEqual([5, 2]);
    const all = h.sdk.replies.flat();
    const kinds = all.map((m) => (m.type === 'image' ? 'IMG' : m.text!.startsWith(MARK) ? 'CONT' : bodyOf(m.text!).slice(0, 6)));
    expect(kinds).toEqual(['before', '第1行：湖中', 'CONT', 'CONT', 'IMG', 'IMG', 'after']);
    for (const m of all) if (m.text) expect(m.text.length).toBeLessThanOrEqual(LINE_TEXT_MAX_CHARS);
    expect(all[1].text).toContain(`[DC][${DC_NAME}] 第1行`);
    expect(joinParts(all.slice(1, 4).map((m) => m.text!))).toBe(`${text} （圖片 ×2）`);
    expect(h.mirror.lineReplyQueueSize()).toBe(0);
    expectCleanLogs();
  });

  it('on queue overflow a split message leaves whole (no 「（續）」 part without its speaker line)', () => {
    __resetChatMirrorForTests();
    const queue = new LineReplyQueue(4);
    const mirror = new ChatMirror({ lineGroupId: GROUP, lineReplyQueue: queue, logger });
    mirror.setLobbyIngest(() => undefined);
    const long = mirror.ingestInbound({ source: 'discord', platformUserId: '1', displayName: DC_NAME, text: lines(150, 79), messageId: 'd1' });
    void mirror.crossFanout(long!);
    expect(queue.size()).toBe(3);
    mirror.enqueueLineReplyText('x');
    mirror.enqueueLineReplyText('y'); // over the cap of 4: all three parts go together
    expect(queue.drain().map((i) => i.text)).toEqual(['x', 'y']);
  });

  it('requeueFront: a message cut in two by the tail trim leaves whole, the rescued batch never', () => {
    const q = new LineReplyQueue(5);
    q.enqueue('a');
    q.enqueue('b');
    const batch = q.drain(2);
    q.enqueue('c');
    q.enqueueGroup([
      { text: 'p1', enqueuedAt: 1 },
      { text: 'p2', enqueuedAt: 1 },
      { text: 'p3', enqueuedAt: 1 },
    ]);
    // a b c p1 p2 | p3 → p1 p2 p3 all leave
    expect(q.requeueFront(batch)).toEqual({ dropped: 3, releasedMediaIds: [] });
    expect(q.drain().map((i) => i.text)).toEqual(['a', 'b', 'c']);

    const r = new LineReplyQueue(2);
    r.enqueueGroup([
      { text: 'g1', enqueuedAt: 1 },
      { text: 'g2', enqueuedAt: 1 },
      { text: 'g3', enqueuedAt: 1 },
    ]); // cap 2: the oldest group leaves whole on enqueue
    expect(r.size()).toBe(0);
  });

  it('push mode (LINE_REPLY_DRAIN=false): a split message is ONE push call with its parts', async () => {
    __resetChatMirrorForTests();
    const calls: unknown[] = [];
    const line: LineAdapter = { pushMessage: async (_to, m) => void calls.push(m) };
    const mirror = new ChatMirror({ lineGroupId: GROUP, line, logger });
    mirror.setLobbyIngest(() => undefined);
    const text = lines(150, 79);
    const msg = mirror.ingestInbound({ source: 'discord', platformUserId: '1', displayName: DC_NAME, text, messageId: 'd1' });
    await mirror.crossFanout(msg!);
    expect(calls).toHaveLength(1);
    const objs = calls[0] as { type: string; text: string }[];
    expect(objs).toHaveLength(3);
    expect(joinParts(objs.map((o) => o.text))).toBe(text);
    // A short one is still a single object, as before.
    await mirror.crossFanout({ ...msg!, message: 'short' });
    expect(calls[1]).toMatchObject({ type: 'text' });
  });

  it('the weekly digest over 5000 (enqueueLineReplyText) is queued as one group of parts ≤ 5000', () => {
    __resetChatMirrorForTests();
    const queue = new LineReplyQueue();
    const mirror = new ChatMirror({ lineGroupId: GROUP, lineReplyQueue: queue, logger });
    const digest = lines(150, 79, '名');
    expect(mirror.enqueueLineReplyText(digest)).toBe(true);
    const items = queue.drain();
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.group)).size).toBe(1);
    expect(items[0].group).toBeDefined();
    for (const i of items) expect(i.text.length).toBeLessThanOrEqual(LINE_TEXT_MAX_CHARS);
    expect(items[0].text.startsWith('第1名')).toBe(true);
    expect(items.map((i, n) => (n === 0 ? i.text : i.text.slice(MARK.length))).join('')).toBe(digest);
  });

  it('listen-bot mode gets the WHOLE text as raw fields (it formats on its own)', async () => {
    __resetChatMirrorForTests();
    const bodies: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const mirror = new ChatMirror({ lineGroupId: GROUP, listenBot: { url: 'http://listen.test/enqueue/line' }, logger });
      mirror.setLobbyIngest(() => undefined);
      const text = lines(50, 79); // ≈ 4000, the most Discord (Nitro) can send
      const msg = mirror.ingestInbound({ source: 'discord', platformUserId: '1', displayName: DC_NAME, text, messageId: 'd-lb' });
      await mirror.crossFanout(msg!);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].content).toBe(text);
      expect(bodies[0].source).toBe('DC');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('a queued text that is somehow over 5000 is clamped at drain time instead of jamming the queue', () => {
    __resetChatMirrorForTests();
    const queue = new LineReplyQueue();
    const mirror = new ChatMirror({ lineGroupId: GROUP, lineReplyQueue: queue, logger });
    queue.enqueue('z'.repeat(LINE_TEXT_MAX_CHARS + 50));
    const out = mirror.lineMessagesFor(queue.drain());
    expect((out.messages[0] as { text: string }).text).toHaveLength(LINE_TEXT_MAX_CHARS);
  });

  it('website lobby lines (≤ 200) still go out as one message each, unchanged', async () => {
    const h = setup();
    const msg = 'L'.repeat(LOBBY_CHAT_MAX_LEN);
    await h.mirror.fanout({ id: 'w', playerId: 'p', playerName: 'WebPal', message: msg, timestamp: Date.now(), source: 'lobby' });
    expect(h.discord.sent).toHaveLength(1);
    expect(bodyOf(h.discord.sent[0])).toBe(msg);
    expect(h.mirror.lineReplyQueueSize()).toBe(1);
  });
});

// ─── No loop ─────────────────────────────────────────────────────────────

describe('no loop', () => {
  it('the bot’s own parts in the Discord channel are ignored; a person typing 「（續）」 is relayed as usual', async () => {
    const h = setup();
    const own = discordMessage(`${MARK}第2行：……`, { author: { id: 'bot', bot: true, username: 'avalon-bot' } });
    expect(await handleDiscordMirrorMessage(own, { targetChannelId: DISCORD_CH, mirror: h.mirror })).toBe('ignored');
    expect(h.mirror.lineReplyQueueSize()).toBe(0);
    expect(await handleDiscordMirrorMessage(discordMessage(`${MARK}我補充一下`), { targetChannelId: DISCORD_CH, mirror: h.mirror })).toBe('text');
    expect(h.mirror.lineReplyQueueSize()).toBe(1);
  });

  it('a long LINE message never comes back to LINE; a long Discord message never goes back to Discord', async () => {
    const h = setup();
    await postLine(h.bot, [groupEvent({ type: 'text', id: 'lx', text: lines(100, 59) }, 'rt-x')]);
    expect(h.mirror.lineReplyQueueSize()).toBe(0);
    const before = h.discord.sent.length;
    await handleDiscordMirrorMessage(discordMessage(lines(100, 59), { id: 'dx' }), { targetChannelId: DISCORD_CH, mirror: h.mirror });
    expect(h.discord.sent).toHaveLength(before);
    expect(h.mirror.lineReplyQueueSize()).toBe(2); // 6000 → 2 LINE parts
  });
});

// ─── Chat-log export ─────────────────────────────────────────────────────

describe('chat-log export joins the parts', () => {
  const SELF = 'bot-self';
  const T0 = Date.parse('2026-10-06T12:00:00Z');
  let seq = 0;
  function raw(over: Partial<RawChatMessage>): RawChatMessage {
    seq += 1;
    return {
      id: String(4_000_000_000_000_000_000n + BigInt(seq)),
      channelId: DISCORD_CH,
      createdAt: T0 + seq * 1000,
      authorId: 'u-human',
      authorIsBot: false,
      authorIsSelf: false,
      webhookId: null,
      system: false,
      content: '',
      attachmentCount: 0,
      ...over,
    };
  }
  const bot = (content: string): Partial<RawChatMessage> => ({ authorId: SELF, authorIsBot: true, authorIsSelf: true, content });
  const channels = [{ id: DISCORD_CH, name: '阿瓦隆同步', isMirror: true }];

  it('one LINE row for a split message (a person speaking in between does not break it); a split /意見 stays out; an orphan part is skipped', () => {
    const msgs = [
      raw(bot(`${MARK}orphan tail`)),
      raw(bot(`[1006 20:01][LINE][${LINE_NAME}] first half`)),
      raw({ content: 'a human line' }),
      raw(bot(`${MARK}\nsecond half`)),
      raw(bot(`${MARK}\nthird half`)),
      raw(bot(`[1006 20:05][LINE][${LINE_NAME}] /意見 private`)),
      raw(bot(`${MARK}\nstill private`)),
      raw({ content: `${MARK}a human typed this` }),
    ];
    const out = buildExportRows([...msgs].reverse(), channels, '2026-10-06');
    const contents = out.rows.map((r) => [r[3], r[5]]);
    expect(contents).toEqual([
      ['LINE', 'first half ⏎ second half ⏎ third half'],
      ['Discord', 'a human line'],
      ['Discord', `${MARK}a human typed this`],
    ]);
    expect(out.skipped.command).toBe(2);
    expect(out.skipped.bot).toBe(1);
    expect(JSON.stringify(out.rows)).not.toContain(LINE_NAME);
  });

  it('a picture upload, the digest or a command reply landing between the parts is never taken for the start', () => {
    const msgs = [
      raw(bot(`[1006 21:00][LINE][${LINE_NAME}] part one`)),
      raw({ ...bot(`[1006 21:00][LINE][${LINE_NAME}] （圖片）`), attachmentCount: 1 }),
      raw(bot('本週排行榜：第一名 …')),
      raw(bot(`${MARK}\npart two`)),
    ];
    const out = buildExportRows(msgs, channels, '2026-10-06');
    expect(out.rows.map((r) => r[5])).toEqual(['part one ⏎ part two', '（圖片）〔附件 1〕']);
    expect(out.skipped.bot).toBe(1); // the digest
  });

  it('parts split on a space or inside a line join back without a stray line break; the missing-parts note stays in the row', () => {
    const text = 'word '.repeat(600).trim(); // no line breaks, ≈ 3000 characters
    const parts = splitMirrorText(`[1006 22:00][LINE][${LINE_NAME}] `, text, DISCORD_MESSAGE_MAX_CHARS);
    expect(parts).toHaveLength(2);
    const out = buildExportRows(parts.map((p) => raw(bot(p))), channels, '2026-10-06');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0][5]).toBe(text);
    expect(out.rows[0][5]).not.toContain('⏎');

    const cut = buildExportRows(
      [raw(bot(`[1006 22:05][LINE][${LINE_NAME}] start`)), raw(bot(discordMissingPartsNote('line')))],
      channels,
      '2026-10-06',
    );
    expect(cut.rows.map((r) => r[5])).toEqual(['start（後段沒有同步過來，請到 LINE 看）']);
  });
});

// ─── LINE webhook body size ──────────────────────────────────────────────

describe('LINE webhook JSON limit', () => {
  it(`accepts a delivery of several long texts (up to ${LINE_WEBHOOK_JSON_LIMIT}); other routes keep the default limit`, async () => {
    const app = express();
    mountJsonBodyParsers(app);
    app.post('/webhook/line', (req, res) => {
      res.json({ events: req.body.events.length, raw: (req as RequestWithRawBody).rawBody?.length ?? 0 });
    });
    app.post('/api/other', (_req, res) => res.json({ ok: true }));
    const event = (i: number) => groupEvent({ type: 'text', id: `big${i}`, text: '字'.repeat(5000) }, `rt${i}`);
    const body = JSON.stringify({ destination: 'U', events: Array.from({ length: 8 }, (_, i) => event(i)) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);
    const ok = await request(app).post('/webhook/line').set('Content-Type', 'application/json').send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ events: 8, raw: Buffer.byteLength(body) });
    const other = await request(app).post('/api/other').set('Content-Type', 'application/json').send(body);
    expect(other.status).toBe(413);
  });
});
