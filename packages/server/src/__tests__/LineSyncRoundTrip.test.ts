/**
 * LINE ↔ lobby ↔ Discord round-trip smoke (`pnpm test:line-sync`).
 *
 * This is the "Layer 3" check named in tree_registry/architecture/avalon_line_sync.md:
 * every leg of the three-way sync is exercised in-process with the real
 * ChatMirror + LineBotClient and mocked platform SDKs. No network.
 *
 *   lobby   → fanout        → Discord send + LINE reply queue
 *   LINE    → webhook       → lobby ingest + Discord cross-push + queue drain via reply_token
 *   Discord → ingestInbound → lobby ingest + LINE reply queue
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import {
  ChatMirror,
  initializeChatMirror,
  __resetChatMirrorForTests,
  DiscordAdapter,
  DiscordChannelAdapter,
} from '../bots/ChatMirror';
import { LineReplyQueue } from '../bots/line/replyQueue';
import { LineBotClient } from '../bots/line/client';
import type { LobbyChatMessage } from '../socket/LobbyChatBuffer';

const GROUP = 'Cmirror-group';
const SECRET = 'test-channel-secret';
const DISCORD_CH = '1132901301802504242';

const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

function mockDiscord(): { adapter: DiscordAdapter; sent: string[] } {
  const sent: string[] = [];
  return {
    adapter: {
      fetchChannel: async (): Promise<DiscordChannelAdapter | null> => ({
        send: async (content: string) => {
          sent.push(content);
          return {};
        },
      }),
    },
    sent,
  };
}

function mockLineSdk(opts: { replyFails?: boolean } = {}): {
  client: Client;
  replies: { token: string; texts: string[] }[];
  pushes: unknown[];
} {
  const replies: { token: string; texts: string[] }[] = [];
  const pushes: unknown[] = [];
  const client = {
    replyMessage: async (token: string, messages: { type: string; text: string }[]) => {
      if (opts.replyFails) throw new Error('reply_token expired');
      replies.push({ token, texts: messages.map((m) => m.text) });
      return {};
    },
    pushMessage: async (to: string, m: unknown) => {
      pushes.push({ to, m });
      return {};
    },
    getGroupMemberProfile: async (_g: string, userId: string) => ({ displayName: `LineUser-${userId}` }),
  } as unknown as Client;
  return { client, replies, pushes };
}

/** Build a signed LINE webhook request. `raw` is the exact body LINE sends. */
function lineRequest(raw: string, opts: { badSignature?: boolean; keepRawBody?: boolean } = {}): {
  req: Request;
  res: Response & { statusCode: number; payload: unknown };
} {
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const headers: Record<string, string> = { 'X-Line-Signature': opts.badSignature ? 'AAAA' : sig };
  const req = {
    get: (h: string) => headers[h],
    body: JSON.parse(raw),
    ...(opts.keepRawBody === false ? {} : { rawBody: Buffer.from(raw) }),
  } as unknown as Request;
  const res = {
    statusCode: 0,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
  } as unknown as Response & { statusCode: number; payload: unknown };
  return { req, res };
}

function groupTextEvent(text: string, id: string, replyToken: string, userId = 'U1'): Record<string, unknown> {
  return {
    type: 'message',
    replyToken,
    source: { type: 'group', groupId: GROUP, userId },
    message: { type: 'text', id, text },
  };
}

function setup(opts: { replyFails?: boolean } = {}): {
  mirror: ChatMirror;
  discord: ReturnType<typeof mockDiscord>;
  sdk: ReturnType<typeof mockLineSdk>;
  bot: LineBotClient;
  lobby: LobbyChatMessage[];
} {
  const discord = mockDiscord();
  const sdk = mockLineSdk(opts);
  const mirror = initializeChatMirror({
    lineGroupId: GROUP,
    discordChannelId: DISCORD_CH,
    discord: discord.adapter,
    lineReplyQueue: new LineReplyQueue(),
    // No `line` adapter on purpose: the queue path must never need push.
    logger: silentLogger,
    inboundRateLimit: { windowMs: 60_000, maxRequests: 100 },
  });
  const lobby: LobbyChatMessage[] = [];
  mirror.setLobbyIngest((m) => lobby.push(m));
  const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client: sdk.client });
  return { mirror, discord, sdk, bot, lobby };
}

beforeEach(() => {
  __resetChatMirrorForTests();
  process.env.LOBBY_MIRROR_LINE_GROUP_ID = GROUP;
  delete process.env.CHAT_MIRROR_USE_LEGACY_FORMAT;
});
afterEach(() => {
  delete process.env.LOBBY_MIRROR_LINE_GROUP_ID;
});

describe('lobby → LINE queue + Discord', () => {
  it('fanout sends to Discord immediately and queues for LINE (no push)', async () => {
    const { mirror, discord } = setup();
    await mirror.fanout({
      id: 'l1',
      playerId: 'p1',
      playerName: 'Alice',
      message: '大家好',
      timestamp: Date.UTC(2026, 9, 8, 1, 2),
      source: 'lobby',
    });
    expect(discord.sent).toEqual(['[1008 09:02][AP][Alice] 大家好']);
    expect(mirror.lineReplyQueueSize()).toBe(1);
    expect(mirror.isLineReplyQueueEnabled()).toBe(true);
  });
});

describe('LINE webhook → lobby + Discord, with reply_token drain', () => {
  it('rejects a bad signature with 401 and ingests nothing', async () => {
    const { bot, lobby, discord } = setup();
    const raw = JSON.stringify({ destination: 'U', events: [groupTextEvent('hi', 'm1', 'rt1')] });
    const { req, res } = lineRequest(raw, { badSignature: true });
    await bot.handleWebhook(req, res);
    expect(res.statusCode).toBe(401);
    expect(lobby).toEqual([]);
    expect(discord.sent).toEqual([]);
    expect(bot.getWebhookStats().signatureFailures).toBe(1);
  });

  it('verifies the signature over the RAW bytes, not a re-serialised body', async () => {
    const { bot, lobby } = setup();
    // Pretty-printed body: JSON.stringify(req.body) would NOT reproduce these bytes.
    const raw = JSON.stringify({ destination: 'U', events: [groupTextEvent('raw ok', 'm2', 'rt2')] }, null, 2);
    const { req, res } = lineRequest(raw);
    expect(JSON.stringify(req.body)).not.toBe(raw);
    await bot.handleWebhook(req, res);
    expect(res.statusCode).toBe(200);
    expect(lobby.map((m) => m.message)).toEqual(['raw ok']);
  });

  it('bridges a mirror-group text into the lobby and cross-pushes to Discord', async () => {
    const { bot, lobby, discord } = setup();
    const raw = JSON.stringify({ destination: 'U', events: [groupTextEvent('從 LINE 來', 'm3', 'rt3', 'U9')] });
    const { req, res } = lineRequest(raw);
    await bot.handleWebhook(req, res);
    expect(res.statusCode).toBe(200);
    expect(lobby).toHaveLength(1);
    expect(lobby[0]).toMatchObject({
      source: 'line',
      playerId: 'line:U9',
      playerName: 'LineUser-U9',
      message: '從 LINE 來',
      id: 'line:m3',
    });
    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0]).toMatch(/^\[\d{4} \d{2}:\d{2}\]\[LINE\]\[LineUser-U9\] 從 LINE 來$/);
  });

  it('drains queued outbound texts (≤5, oldest first) with the event reply_token', async () => {
    const { bot, mirror, sdk } = setup();
    for (let i = 0; i < 7; i++) {
      await mirror.fanout({
        id: `l${i}`,
        playerId: 'p',
        playerName: 'Bob',
        message: `msg${i}`,
        timestamp: Date.now(),
        source: 'lobby',
      });
    }
    expect(mirror.lineReplyQueueSize()).toBe(7);

    const raw = JSON.stringify({ destination: 'U', events: [groupTextEvent('ping', 'm4', 'rt4')] });
    const { req, res } = lineRequest(raw);
    await bot.handleWebhook(req, res);

    expect(sdk.replies).toHaveLength(1);
    expect(sdk.replies[0].token).toBe('rt4');
    expect(sdk.replies[0].texts.map((t) => t.split('] ').pop())).toEqual(['msg0', 'msg1', 'msg2', 'msg3', 'msg4']);
    expect(mirror.lineReplyQueueSize()).toBe(2);
    expect(sdk.pushes).toEqual([]); // never falls back to push
    expect(bot.getWebhookStats().repliesDrained).toBe(5);
  });

  it('uses a reply_token from a non-text mirror-group event too (sticker/join)', async () => {
    const { bot, mirror, sdk, lobby } = setup();
    await mirror.fanout({ id: 'l', playerId: 'p', playerName: 'C', message: 'hey', timestamp: Date.now(), source: 'lobby' });
    const raw = JSON.stringify({
      destination: 'U',
      events: [
        {
          type: 'message',
          replyToken: 'rt5',
          source: { type: 'group', groupId: GROUP, userId: 'U2' },
          message: { type: 'sticker', id: 's1', packageId: '1', stickerId: '2' },
        },
      ],
    });
    const { req, res } = lineRequest(raw);
    await bot.handleWebhook(req, res);
    expect(lobby).toEqual([]); // stickers are not bridged as text
    expect(sdk.replies).toEqual([{ token: 'rt5', texts: [expect.stringContaining('hey')] }]);
    expect(mirror.lineReplyQueueSize()).toBe(0);
  });

  it('a failed reply re-queues the exact batch at the head; the next reply_token re-sends it', async () => {
    const failing = setup({ replyFails: true });
    await failing.mirror.fanout({ id: 'a', playerId: 'p', playerName: 'D', message: 'first', timestamp: Date.now(), source: 'lobby' });
    await failing.mirror.fanout({ id: 'b', playerId: 'p', playerName: 'D', message: 'second', timestamp: Date.now(), source: 'lobby' });

    const r1 = lineRequest(JSON.stringify({ destination: 'U', events: [groupTextEvent('x', 'm6', 'rt6')] }));
    await failing.bot.handleWebhook(r1.req, r1.res);
    expect(r1.res.statusCode).toBe(200); // webhook still acks
    expect(failing.mirror.lineReplyQueueSize()).toBe(2);
    expect(failing.bot.getWebhookStats().replyFailures).toBe(1);

    // Same queue, now with a working SDK: order preserved.
    const working = mockLineSdk();
    const bot2 = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client: working.client });
    const r2 = lineRequest(JSON.stringify({ destination: 'U', events: [groupTextEvent('y', 'm7', 'rt7')] }));
    await bot2.handleWebhook(r2.req, r2.res);
    expect(working.replies[0].texts.map((t) => t.split('] ').pop())).toEqual(['first', 'second']);
    expect(failing.mirror.lineReplyQueueSize()).toBe(0);
  });

  it('ignores groups other than the mirror group (no ingest, no drain)', async () => {
    const { bot, mirror, lobby, sdk } = setup();
    await mirror.fanout({ id: 'l', playerId: 'p', playerName: 'E', message: 'queued', timestamp: Date.now(), source: 'lobby' });
    const ev = groupTextEvent('other', 'm8', 'rt8');
    (ev.source as { groupId: string }).groupId = 'Csomewhere-else';
    const { req, res } = lineRequest(JSON.stringify({ destination: 'U', events: [ev] }));
    await bot.handleWebhook(req, res);
    expect(lobby).toEqual([]);
    expect(sdk.replies).toEqual([]);
    expect(mirror.lineReplyQueueSize()).toBe(1);
  });

  it('logs each non-mirror group id once so the operator can find it', async () => {
    const { bot } = setup();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ev = groupTextEvent('hello', 'm9', 'rt9');
    (ev.source as { groupId: string }).groupId = 'Cunknown-group';
    for (let i = 0; i < 3; i++) {
      const { req, res } = lineRequest(JSON.stringify({ destination: 'U', events: [ev] }));
      await bot.handleWebhook(req, res);
    }
    const hits = logSpy.mock.calls.filter((c) => String(c[0]).includes('Cunknown-group'));
    expect(hits).toHaveLength(1);
    expect(String(hits[0][0])).toContain('LOBBY_MIRROR_LINE_GROUP_ID=Cunknown-group');
    logSpy.mockRestore();
  });

  it('LINE console "Verify" (empty events) is acked 200', async () => {
    const { bot } = setup();
    const { req, res } = lineRequest(JSON.stringify({ destination: 'U', events: [] }));
    await bot.handleWebhook(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('Discord → lobby + LINE queue', () => {
  it('ingestInbound + crossFanout lands in lobby and queues for LINE only', async () => {
    const { mirror, lobby, discord } = setup();
    const msg = mirror.ingestInbound({
      source: 'discord',
      platformUserId: '42',
      displayName: 'Zed',
      text: '來自 DC',
      messageId: 'discord:9',
    });
    expect(msg).not.toBeNull();
    await mirror.crossFanout(msg!);
    expect(lobby).toHaveLength(1);
    expect(lobby[0]).toMatchObject({ source: 'discord', playerId: 'discord:42', playerName: 'Zed' });
    expect(discord.sent).toEqual([]); // never echoes back to Discord
    expect(mirror.lineReplyQueueSize()).toBe(1);
  });
});

describe('loop safety across the three legs', () => {
  it('a LINE-origin message is never queued back to LINE', async () => {
    const { mirror } = setup();
    const msg = mirror.ingestInbound({
      source: 'line',
      platformUserId: 'U1',
      displayName: 'L',
      text: 'loop?',
      messageId: 'line:1',
    });
    await mirror.crossFanout(msg!);
    await mirror.fanout(msg!);
    expect(mirror.lineReplyQueueSize()).toBe(0);
  });
});
