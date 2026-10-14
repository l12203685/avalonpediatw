/**
 * 模擬瓦 on LINE (2026-10-14): /模擬 /派 /區間 /下一步 /公布 /結束, wired like /戰績.
 *
 *   - mirror group: the command text is mirrored (Discord + lobby) like any text, the answer is not;
 *     the answer takes slot 1 of the reply_token (quoting the command) and 4 slots drain the queue;
 *     a failed reply re-queues only the mirror items and does NOT apply the step (commit after delivery);
 *   - a redelivery of the same event re-sends the same answer, nothing advances or is mirrored twice;
 *   - 1:1: no drain, quick-reply buttons /下一步 /公布 /結束 while the exercise is open;
 *   - other groups stay silent unless allow-listed in SIM_LINE_GROUP_IDS (then 模擬 only, own token);
 *   - SIM_COMMANDS_ENABLED off → plain chat; /意見 topic counting skips 模擬 commands;
 *   - nothing anyone typed reaches a log.
 * Real ChatMirror + LineReplyQueue + LineBotClient; mocked LINE SDK and Discord; invented bank.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { LINE_CONFIG } from '../bots/line/config';
import { SimBankLoader } from '../bots/simulation/bank';
import { SIM_CONFIG } from '../bots/simulation/config';
import { __setSimForTests } from '../bots/simulation';
import { SimEngine } from '../bots/simulation/session';
import { __resetFeedbackForTests, getFeedbackService } from '../bots/feedback/service';
import type { LobbyChatMessage } from '../socket/LobbyChatBuffer';
import { fixtureBank } from './fixtures/simGames';

const GROUP = 'Cmirror-group';
const SECRET = 'test-channel-secret';
const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
const BANK = fixtureBank();

interface SentMessage { type: string; text: string; quoteToken?: string; quickReply?: { items: { action: { text: string } }[] } }

interface Harness {
  mirror: ChatMirror;
  bot: LineBotClient;
  replies: { token: string; messages: SentMessage[] }[];
  discordSent: string[];
  lobby: LobbyChatMessage[];
  setReplyFails: (fails: boolean) => void;
}

function setup(): Harness {
  const replies: Harness['replies'] = [];
  const discordSent: string[] = [];
  let replyFails = false;
  const client = {
    replyMessage: async (token: string, messages: SentMessage[]) => {
      if (replyFails) throw new Error('reply_token expired');
      replies.push({ token, messages });
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
    discordChannelId: 'D1',
    discord,
    lineReplyQueue: new LineReplyQueue(),
    logger: silentLogger,
    inboundRateLimit: { windowMs: 60_000, maxRequests: 100 },
  });
  const lobby: LobbyChatMessage[] = [];
  mirror.setLobbyIngest((m) => lobby.push(m));
  const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client });
  return { mirror, bot, replies, discordSent, lobby, setReplyFails: (f) => (replyFails = f) };
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

function groupText(text: string, id: string, replyToken: string, groupId = GROUP, extra: Record<string, unknown> = {}) {
  return {
    type: 'message', replyToken, source: { type: 'group', groupId, userId: 'U1' },
    message: { type: 'text', id, text, quoteToken: `q-${id}` }, ...extra,
  };
}

function userText(text: string, id: string, replyToken: string) {
  return { type: 'message', replyToken, source: { type: 'user', userId: 'U7' }, message: { type: 'text', id, text, quoteToken: `q-${id}` } };
}

async function deliver(h: Harness, ...events: unknown[]): Promise<number> {
  const { req, res } = signed(events);
  await h.bot.handleWebhook(req, res);
  return res.statusCode;
}

async function queueMirrorMessages(mirror: ChatMirror, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await mirror.fanout({ id: `q${i}`, playerId: 'p', playerName: 'Bob', message: `msg${i}`, timestamp: Date.now(), source: 'lobby' });
  }
}

const bodyOf = (t: string) => t.split('] ').pop();
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
const TYPED: string[] = [];

beforeEach(() => {
  __resetChatMirrorForTests();
  __resetFeedbackForTests();
  process.env.LOBBY_MIRROR_LINE_GROUP_ID = GROUP;
  delete process.env.CHAT_MIRROR_USE_LEGACY_FORMAT;
  delete process.env.SIM_LINE_GROUP_IDS;
  LINE_CONFIG.statsCommandsEnabled = true;
  LINE_CONFIG.commandsEnabled = false;
  SIM_CONFIG.commandsEnabled = true;
  const loader = new SimBankLoader(() => BANK);
  __setSimForTests({ loader, engine: new SimEngine({ bank: () => loader.get(), random: () => () => 0 }) });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  TYPED.length = 0;
});

afterEach(() => {
  // Whatever was logged, nothing anyone typed is in it.
  const logged = consoleSpies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
  for (const t of TYPED) expect(logged).not.toContain(t);
  for (const s of consoleSpies) s.mockRestore();
  delete process.env.LOBBY_MIRROR_LINE_GROUP_ID;
  delete process.env.SIM_LINE_GROUP_IDS;
  __setSimForTests({ loader: null, engine: null });
});

const typed = (t: string): string => { TYPED.push(t); return t; };

describe('mirror group', () => {
  it('/模擬 with 7 queued → ONE replyMessage: answer (quoting the command) + 4 queued; text mirrored, answer not', async () => {
    const h = setup();
    await queueMirrorMessages(h.mirror, 7);
    expect(await deliver(h, groupText(typed('/模擬 忠臣 4'), 'm1', 'rt1'))).toBe(200);

    expect(h.replies).toHaveLength(1);
    const [lead, ...rest] = h.replies[0].messages;
    expect(lead.text.split('\n')[0]).toBe('【模擬瓦 W0000-4】你是 4家・忠臣（沒有額外資訊）');
    expect(lead.quoteToken).toBe('q-m1');
    expect(lead.quickReply).toBeUndefined(); // never in groups (the last slot is a mirror line)
    expect(rest.map((m) => bodyOf(m.text))).toEqual(['msg0', 'msg1', 'msg2', 'msg3']);
    expect(h.mirror.lineReplyQueueSize()).toBe(3);
    expect(h.bot.getWebhookStats()).toMatchObject({ simReplies: 1, statsReplies: 0, repliesDrained: 4 });

    expect(h.lobby.map((m) => m.message)).toEqual(['/模擬 忠臣 4']);
    const fromLine = h.discordSent.filter((m) => m.includes('[LINE]'));
    expect(fromLine).toHaveLength(1);
    expect(fromLine[0]).toMatch(/\[LINE\]\[LineUser-U1\] \/模擬 忠臣 4$/);
    expect(h.discordSent.join('\n')).not.toContain('模擬瓦 W0000');
  });

  it('a failed reply re-queues only the mirror items and does not apply the step', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1'));
    await queueMirrorMessages(h.mirror, 7);
    h.setReplyFails(true);
    await deliver(h, groupText(typed('/派 469'), 'm2', 'rt2'));
    expect(h.mirror.lineReplyQueueSize()).toBe(7);
    expect(h.bot.getWebhookStats()).toMatchObject({ replyFailures: 1, simReplies: 1 });

    h.setReplyFails(false);
    await deliver(h, groupText('/公布', 'm3', 'rt3'));
    expect(h.replies.at(-1)?.messages[0].text).toContain('你這題沒有作答。');
  });

  it('a redelivery of the same event re-sends the same answer and advances nothing', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1', GROUP, { webhookEventId: 'E1', deliveryContext: { isRedelivery: false } }));
    await deliver(h, groupText('/下一步', 'm2', 'rt2', GROUP, { webhookEventId: 'E2', deliveryContext: { isRedelivery: false } }));
    await deliver(h, groupText('/下一步', 'm2', 'rt2b', GROUP, { webhookEventId: 'E2', deliveryContext: { isRedelivery: true } }));
    const texts = h.replies.map((r) => r.messages[0].text);
    expect(texts[2]).toBe(texts[1]);
    expect(texts[1]).toContain('第 3 局第 4 次');
    expect(h.lobby.map((m) => m.message)).toEqual(['/模擬 忠臣 4', '/下一步']); // mirrored once
    // Still at the R3 decision: the next step goes to the end of the game.
    await deliver(h, groupText('/下一步', 'm3', 'rt3'));
    expect(h.replies.at(-1)?.messages[0].text).toContain('三藍：任務成功三次');
  });

  it('plain chat and /派西 2 without an exercise get nothing; /派 without one gets the short hint', async () => {
    const h = setup();
    await deliver(h, groupText(typed('派西是 2 吧'), 'c1', 'rc1'), groupText(typed('/派西 2'), 'c2', 'rc2'));
    expect(h.replies).toEqual([]);
    await deliver(h, groupText('/派 469', 'c3', 'rc3'));
    expect(h.replies[0].messages[0].text).toBe('你目前沒有進行中的模擬，輸入 /模擬 開一題（30 分鐘沒動作會自動結束）');
  });

  it('SIM_COMMANDS_ENABLED off → /模擬 is plain chat', async () => {
    SIM_CONFIG.commandsEnabled = false;
    const h = setup();
    await deliver(h, groupText('/模擬', 'f1', 'rf1'));
    expect(h.replies).toEqual([]);
    expect(h.lobby.map((m) => m.message)).toEqual(['/模擬']);
  });

  it('/意見 topic counting skips 模擬 commands', () => {
    expect(getFeedbackService().observe('line', '/派 469')).toEqual([]);
    expect(getFeedbackService().observe('line', '/區間 789=2 排行')).toEqual([]);
    expect(getFeedbackService().observe('discord', '／模擬 排行榜')).toEqual([]);
  });
});

describe('1:1 and other groups', () => {
  it('1:1: no drain, quick replies while the exercise is open, none after /公布', async () => {
    const h = setup();
    await queueMirrorMessages(h.mirror, 3);
    await deliver(h, userText(typed('/模擬 派西 2'), 'u1', 'ru1'));
    const msg = h.replies[0].messages;
    expect(msg).toHaveLength(1);
    expect(msg[0].text).toContain('你是 2家・派西維爾');
    expect(msg[0].quickReply?.items.map((i) => i.action.text)).toEqual(['/下一步', '/公布', '/結束']);
    expect(h.mirror.lineReplyQueueSize()).toBe(3);
    expect(h.lobby).toEqual([]);

    await deliver(h, userText('/公布', 'u2', 'ru2'));
    expect(h.replies[1].messages[0].text).toContain('【W0000-2 公布】');
    expect(h.replies[1].messages[0].quickReply).toBeUndefined();
  });

  it('another group is silent; an allow-listed practice group answers 模擬 only, on its own token', async () => {
    const h = setup();
    await queueMirrorMessages(h.mirror, 3);
    await deliver(h, groupText('/模擬', 'g1', 'rg1', 'Cother'));
    expect(h.replies).toEqual([]);

    process.env.SIM_LINE_GROUP_IDS = 'Cpractice, Cextra';
    await deliver(h, groupText('/模擬 忠臣 4', 'g2', 'rg2', 'Cpractice'), groupText('/排行', 'g3', 'rg3', 'Cpractice'));
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].token).toBe('rg2');
    expect(h.replies[0].messages).toHaveLength(1);
    expect(h.replies[0].messages[0].quoteToken).toBe('q-g2');
    expect(h.replies[0].messages[0].quickReply).toBeUndefined();
    expect(h.mirror.lineReplyQueueSize()).toBe(3);
    expect(h.lobby).toEqual([]);
  });
});
