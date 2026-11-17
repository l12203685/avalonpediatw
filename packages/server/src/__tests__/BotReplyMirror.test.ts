/**
 * 機器人指令回覆同步 DC↔LINE（Edward 2026-11-17：「在dc/line 輸入機器人指令, line/dc 不會同步另一邊的機器人指令回覆」）。
 *
 *   - ChatMirror.relayBotReply：只送到另一邊、不進網站大廳；LINE → Discord 用 Discord 送出鏈；Discord → LINE 只排進
 *     回覆佇列（或 listen-bot），沒有免費的路就不送（不花 push 額度）；MIRROR_BOT_REPLIES=false 關掉。
 *   - LINE 鏡像群：回覆真的送出之後才同步；回覆失敗、重送的事件不同步；指令那句沒同步過去（模擬後續指令）時附在回覆前面。
 *   - Discord：只同步同步頻道、公開、清單上的指令；拿掉 code block 圍欄與粗體；有附圖加一行說明。
 *   - 不會繞圈：Discord 收到機器人自己的貼文不處理；LINE 的回覆佇列訊息不會產生 webhook 事件。
 * 真的 ChatMirror + LineReplyQueue + LineBotClient；LINE SDK 與 Discord 是假的；題庫是編的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import { MessageFlags } from 'discord.js';
import {
  ChatMirror,
  initializeChatMirror,
  __resetChatMirrorForTests,
  DiscordAdapter,
  DiscordChannelAdapter,
  MIRROR_BOT_NAME,
} from '../bots/ChatMirror';
import { LineReplyQueue } from '../bots/line/replyQueue';
import { LineBotClient } from '../bots/line/client';
import { LINE_CONFIG } from '../bots/line/config';
import { SimBankLoader } from '../bots/simulation/bank';
import { SIM_CONFIG } from '../bots/simulation/config';
import { __setSimForTests } from '../bots/simulation';
import { SimEngine } from '../bots/simulation/session';
import { COMMANDS } from '../bots/discord/config';
import { RELAY_ATTACHMENT_NOTE, plainForLine, relayInteractionReply } from '../bots/discord/replyRelay';
import { handleDiscordMirrorMessage } from '../bots/discord/mirrorInbound';
import type { LobbyChatMessage } from '../socket/LobbyChatBuffer';
import { fixtureBank } from './fixtures/simGames';

const GROUP = 'Cmirror-group';
const SECRET = 'test-channel-secret';
const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
const BANK = fixtureBank();

interface Harness {
  mirror: ChatMirror;
  bot: LineBotClient;
  replies: { token: string; texts: string[] }[];
  pushes: unknown[];
  discordSent: string[];
  lobby: LobbyChatMessage[];
  setReplyFails: (fails: boolean) => void;
}

function setup(opts: { queue?: boolean; linePush?: boolean; discord?: boolean } = {}): Harness {
  const replies: Harness['replies'] = [];
  const pushes: unknown[] = [];
  const discordSent: string[] = [];
  let replyFails = false;
  const client = {
    replyMessage: async (token: string, messages: { text: string }[]) => {
      if (replyFails) throw new Error('reply_token expired');
      replies.push({ token, texts: messages.map((m) => m.text) });
      return {};
    },
    pushMessage: async () => {
      throw new Error('push must never be used');
    },
    getGroupMemberProfile: async (_g: string, userId: string) => ({ displayName: `LineUser-${userId}` }),
  } as unknown as Client;
  const discord: DiscordAdapter = {
    fetchChannel: async (): Promise<DiscordChannelAdapter | null> => ({
      send: async (content: string) => {
        discordSent.push(content);
        return {};
      },
    }),
  };
  const mirror = initializeChatMirror({
    lineGroupId: GROUP,
    discordChannelId: opts.discord === false ? '' : 'D1',
    ...(opts.discord === false ? {} : { discord }),
    ...(opts.queue === false ? {} : { lineReplyQueue: new LineReplyQueue() }),
    ...(opts.linePush ? { line: { pushMessage: async (to: string, m: unknown) => { pushes.push({ to, m }); return {}; } } } : {}),
    logger: silentLogger,
    inboundRateLimit: { windowMs: 60_000, maxRequests: 100 },
  });
  const lobby: LobbyChatMessage[] = [];
  mirror.setLobbyIngest((m) => lobby.push(m));
  const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client });
  return { mirror, bot, replies, pushes, discordSent, lobby, setReplyFails: (f) => (replyFails = f) };
}

function signed(events: unknown[]): { req: Request; res: Response & { statusCode: number } } {
  const raw = JSON.stringify({ destination: 'U', events });
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const req = {
    get: (h: string) => (h === 'X-Line-Signature' ? sig : undefined),
    body: JSON.parse(raw),
    rawBody: Buffer.from(raw),
  } as unknown as Request;
  const res = {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response & { statusCode: number };
  return { req, res };
}

function groupText(text: string, id: string, replyToken: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'message', replyToken, source: { type: 'group', groupId: GROUP, userId: 'U1' },
    message: { type: 'text', id, text, quoteToken: `q-${id}` }, ...extra,
  };
}

async function deliver(h: Harness, ...events: unknown[]): Promise<void> {
  const { req, res } = signed(events);
  await h.bot.handleWebhook(req, res);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const botLines = (h: Harness) => h.discordSent.filter((m) => m.includes(`[${MIRROR_BOT_NAME}]`));

beforeEach(() => {
  __resetChatMirrorForTests();
  process.env.LOBBY_MIRROR_LINE_GROUP_ID = GROUP;
  delete process.env.CHAT_MIRROR_USE_LEGACY_FORMAT;
  delete process.env.SIM_MIRROR_FOLLOWUPS;
  delete process.env.MIRROR_BOT_REPLIES;
  LINE_CONFIG.statsCommandsEnabled = true;
  LINE_CONFIG.commandsEnabled = false;
  SIM_CONFIG.commandsEnabled = true;
  const loader = new SimBankLoader(() => BANK);
  __setSimForTests({ loader, engine: new SimEngine({ bank: () => loader.get(), random: () => () => 0 }) });
});

afterEach(() => {
  delete process.env.LOBBY_MIRROR_LINE_GROUP_ID;
  delete process.env.MIRROR_BOT_REPLIES;
  __setSimForTests({ loader: null, engine: null });
});

describe('ChatMirror.relayBotReply', () => {
  it('LINE origin → Discord only (speaker 百科機器人); never the lobby, never the LINE queue', async () => {
    const h = setup();
    expect(await h.mirror.relayBotReply({ origin: 'line', reply: '📊 戰績' })).toBe(true);
    expect(h.discordSent).toHaveLength(1);
    expect(h.discordSent[0]).toMatch(/\[LINE\]\[百科機器人\] 📊 戰績$/);
    expect(h.lobby).toEqual([]);
    expect(h.mirror.lineReplyQueueSize()).toBe(0);
    expect(h.mirror.botRepliesRelayedCount()).toBe(1);
  });

  it('Discord origin with asker + command → LINE queue gets 「名字 指令」 then the reply; Discord and the lobby get nothing', async () => {
    const h = setup();
    expect(await h.mirror.relayBotReply({ origin: 'discord', reply: '📊 戰績', command: '/戰績 名字:X', asker: 'Amy' })).toBe(true);
    expect(h.mirror.lineReplyQueueSize()).toBe(2);
    expect(h.discordSent).toEqual([]);
    expect(h.lobby).toEqual([]);
    // Drained on the next LINE group message's reply_token, oldest first.
    await deliver(h, groupText('hi', 'm1', 'rt1'));
    expect(h.replies[0].texts).toHaveLength(2);
    expect(h.replies[0].texts[0]).toMatch(/\[DC\]\[Amy\] \/戰績 名字:X$/);
    expect(h.replies[0].texts[1]).toMatch(/\[DC\]\[百科機器人\] 📊 戰績$/);
    expect(h.pushes).toEqual([]);
  });

  it('Discord origin with no free LINE path (no reply queue, no listen-bot) is skipped: never spends push quota', async () => {
    const h = setup({ queue: false, linePush: true });
    expect(await h.mirror.relayBotReply({ origin: 'discord', reply: '📊 戰績' })).toBe(false);
    expect(h.pushes).toEqual([]);
    expect(h.mirror.botRepliesRelayedCount()).toBe(0);
  });

  it('listen-bot configured but failing, no reply queue → the relay is dropped: never pushMessage (Codex P1)', async () => {
    const pushes: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"ok":false}', { status: 500 }));
    try {
      for (const failure of ['status', 'throw'] as const) {
        if (failure === 'throw') fetchSpy.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
        const mirror = new ChatMirror({
          lineGroupId: GROUP,
          line: { pushMessage: async (to: string, m: unknown) => { pushes.push({ to, m }); return {}; } },
          listenBot: { url: 'http://listen.invalid/enqueue/line' },
          logger: silentLogger,
        });
        // The guard lets it through (a listen-bot is configured) …
        await mirror.relayBotReply({ origin: 'discord', reply: '📊 戰績', command: '/戰績', asker: 'Amy' });
        // … but neither the asker line nor the reply falls back to paid push.
        expect(pushes).toEqual([]);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(4); // 2 failure modes × (asker line + reply)
      // Ordinary sync keeps its documented push fallback (unchanged behaviour).
      const mirror = new ChatMirror({
        lineGroupId: GROUP,
        line: { pushMessage: async (to: string, m: unknown) => { pushes.push({ to, m }); return {}; } },
        listenBot: { url: 'http://listen.invalid/enqueue/line' },
        logger: silentLogger,
      });
      await mirror.crossFanout({ id: 'x', playerId: 'discord:1', playerName: 'P', message: 'hi', timestamp: Date.now(), source: 'discord' });
      expect(pushes).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('listen-bot failing but a reply queue exists → the relay falls back to the free queue, still no push', async () => {
    const pushes: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
    try {
      const mirror = new ChatMirror({
        lineGroupId: GROUP,
        line: { pushMessage: async (to: string, m: unknown) => { pushes.push({ to, m }); return {}; } },
        listenBot: { url: 'http://listen.invalid/enqueue/line' },
        lineReplyQueue: new LineReplyQueue(),
        logger: silentLogger,
      });
      expect(await mirror.relayBotReply({ origin: 'discord', reply: '📊 戰績' })).toBe(true);
      expect(mirror.lineReplyQueueSize()).toBe(1);
      expect(pushes).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('LINE origin without Discord configured is skipped', async () => {
    const h = setup({ discord: false });
    expect(await h.mirror.relayBotReply({ origin: 'line', reply: 'x' })).toBe(false);
  });

  it('command without asker → the reply is prefixed with 「（指令）」', async () => {
    const h = setup();
    await h.mirror.relayBotReply({ origin: 'line', reply: '你派 469：2 好 1 壞', command: '/派 469' });
    expect(h.discordSent).toHaveLength(1);
    expect(h.discordSent[0]).toContain('（/派 469）\n你派 469：2 好 1 壞');
  });

  it('MIRROR_BOT_REPLIES=false turns it off; an empty reply is never sent', async () => {
    const h = setup();
    expect(await h.mirror.relayBotReply({ origin: 'line', reply: '   ' })).toBe(false);
    process.env.MIRROR_BOT_REPLIES = 'false';
    expect(await h.mirror.relayBotReply({ origin: 'line', reply: 'x' })).toBe(false);
    expect(h.discordSent).toEqual([]);
  });
});

describe('LINE mirror group → Discord', () => {
  it('/模擬 answer goes to Discord after the reply is delivered (the command was mirrored, so no prefix)', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1'));
    await vi.waitFor(() => expect(botLines(h)).toHaveLength(1));
    expect(botLines(h)[0]).toMatch(/\[百科機器人\] 【模擬瓦 W0000-4】/);
    expect(botLines(h)[0]).not.toContain('（/模擬');
    expect(h.lobby.map((m) => m.message)).toEqual(['/模擬 忠臣 4']);
  });

  it('a follow-up that is not mirrored (/派) carries its command in front of the answer', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1'));
    await deliver(h, groupText('/派 469', 'm2', 'rt2'));
    await vi.waitFor(() => expect(botLines(h)).toHaveLength(2));
    expect(botLines(h)[1]).toMatch(/\[百科機器人\] （\/派 469）\n/);
    expect(h.discordSent.filter((m) => m.includes('[LineUser-U1] /派'))).toEqual([]); // the command line itself stays hidden
  });

  it('a failed reply is not relayed', async () => {
    const h = setup();
    h.setReplyFails(true);
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1'));
    await settle();
    expect(botLines(h)).toEqual([]);
  });

  it('a redelivered event is not relayed a second time', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1', { webhookEventId: 'E1', deliveryContext: { isRedelivery: false } }));
    await vi.waitFor(() => expect(botLines(h)).toHaveLength(1));
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1b', { webhookEventId: 'E1', deliveryContext: { isRedelivery: true } }));
    await settle();
    expect(botLines(h)).toHaveLength(1);
  });

  it('plain chat gets no bot line', async () => {
    const h = setup();
    await deliver(h, groupText('大家好', 'm1', 'rt1'));
    await settle();
    expect(botLines(h)).toEqual([]);
  });
});

describe('Discord interaction → LINE (replyRelay)', () => {
  type Reply = { content: string; ephemeral?: boolean; attachments?: number };
  function interaction(commandName: string, reply: Reply, over: Record<string, unknown> = {}) {
    return {
      commandName,
      channelId: 'D1',
      deferred: false,
      replied: true,
      fetchReply: async () => ({
        content: reply.content,
        flags: { has: (f: number) => Boolean(reply.ephemeral) && f === MessageFlags.Ephemeral },
        attachments: { size: reply.attachments ?? 0 },
      }),
      toString: () => `/${commandName}`,
      user: { username: 'amy_u', globalName: 'Amy' },
      member: null,
      ...over,
    } as unknown as Parameters<typeof relayInteractionReply>[0];
  }
  const fakeMirror = () => {
    const calls: unknown[] = [];
    return { calls, mirror: { relayBotReply: async (p: unknown) => { calls.push(p); return true; } } };
  };

  it('relays a public reply in the sync channel with the asker and the command', async () => {
    const f = fakeMirror();
    expect(await relayInteractionReply(interaction(COMMANDS.STATS, { content: '**📊 HAO**\n```\n場次 10\n```' }), { mirror: f.mirror, channelId: 'D1' })).toBe(true);
    expect(f.calls).toEqual([{ origin: 'discord', reply: '📊 HAO\n場次 10', command: `/${COMMANDS.STATS}`, asker: 'Amy' }]);
  });

  it('skips other channels, ephemeral replies, unlisted commands, unanswered interactions and a missing mirror', async () => {
    const f = fakeMirror();
    const deps = { mirror: f.mirror, channelId: 'D1' };
    expect(await relayInteractionReply(interaction(COMMANDS.STATS, { content: 'x' }, { channelId: 'D2' }), deps)).toBe(false);
    expect(await relayInteractionReply(interaction(COMMANDS.STATS, { content: 'x', ephemeral: true }), deps)).toBe(false);
    expect(await relayInteractionReply(interaction('意見', { content: 'x' }), deps)).toBe(false);
    expect(await relayInteractionReply(interaction(COMMANDS.STATS, { content: 'x' }, { replied: false }), deps)).toBe(false);
    expect(await relayInteractionReply(interaction(COMMANDS.STATS, { content: 'x' }), { mirror: null, channelId: 'D1' })).toBe(false);
    expect(await relayInteractionReply(interaction(COMMANDS.STATS, { content: 'x' }), { mirror: f.mirror, channelId: '' })).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('an attachment (the /排行 chart) becomes a note line; a fetch failure never throws', async () => {
    const f = fakeMirror();
    await relayInteractionReply(interaction(COMMANDS.LEADERBOARD, { content: '排行', attachments: 1 }), { mirror: f.mirror, channelId: 'D1' });
    expect((f.calls[0] as { reply: string }).reply).toBe(`排行\n${RELAY_ATTACHMENT_NOTE}`);
    const broken = interaction(COMMANDS.STATS, { content: 'x' }, { fetchReply: async () => { throw new Error('gone'); } });
    expect(await relayInteractionReply(broken, { mirror: f.mirror, channelId: 'D1' })).toBe(false);
  });

  it('plainForLine strips code fences and bold only', () => {
    expect(plainForLine('```text\na\n```\n**b** c')).toBe('a\nb c');
  });
});

describe('loop guard', () => {
  it('the relayed bot post in the Discord sync channel is ignored (bot author) — nothing goes back to LINE', async () => {
    const h = setup();
    const outcome = await handleDiscordMirrorMessage(
      { channelId: 'D1', content: '[LINE][百科機器人] 📊 戰績', author: { id: 'B', bot: true } } as Parameters<typeof handleDiscordMirrorMessage>[0],
      { targetChannelId: 'D1', mirror: h.mirror } as Parameters<typeof handleDiscordMirrorMessage>[1],
    );
    expect(outcome).toBe('ignored');
    expect(h.mirror.lineReplyQueueSize()).toBe(0);
    expect(h.lobby).toEqual([]);
  });
});
