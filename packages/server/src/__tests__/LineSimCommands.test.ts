/**
 * 模擬瓦 on LINE (2026-10-14): /模擬 /派 /區間 /下一步 /公布 /結束, wired like /戰績.
 *
 *   - mirror group: the command text is mirrored (Discord + lobby) like any text, the answer is not;
 *     the answer takes slot 1 of the reply_token (quoting the command) and 4 slots drain the queue;
 *     a failed reply re-queues only the mirror items and does NOT apply the step (commit after delivery);
 *   - a redelivery of an event whose answer already went out gets nothing more; nothing advances or is mirrored twice;
 *   - follow-up commands of an open exercise (/派 /區間 /下一步 /公布 /結束) are not mirrored unless
 *     SIM_MIRROR_FOLLOWUPS=true (2026-10-14 review fix: they flooded Discord without their answers);
 *   - two commands of one person are handled one at a time (compute → reply → commit), even across webhooks;
 *   - a throwing commit never re-queues mirror messages that already went out;
 *   - 1:1: no drain, quick-reply buttons /下一步 /公布 /結束 while the exercise is open; a 模擬 command with
 *     no answer (rate limited) never falls through to the legacy 「未知指令」 handler;
 *   - other groups stay silent unless allow-listed in SIM_LINE_GROUP_IDS (then 模擬 and /指令 only, own token);
 *   - SIM_COMMANDS_ENABLED off → plain chat; /意見 topic counting skips 模擬 commands;
 *   - the bot never echoes what was typed (a name next to a role claim); nothing anyone typed reaches a log.
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
import { CO_ANSWER_MARK, NO_SESSION_TEXT, RATE_LIMITED_TEXT, SIM_HELP_TEXT } from '../bots/simulation/replies';
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
  setReplyDelay: (ms: number) => void;
}

function setup(): Harness {
  const replies: Harness['replies'] = [];
  const discordSent: string[] = [];
  let replyFails = false;
  let replyDelay = 0;
  const client = {
    replyMessage: async (token: string, messages: SentMessage[]) => {
      if (replyDelay) await new Promise((resolve) => setTimeout(resolve, replyDelay));
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
  return { mirror, bot, replies, discordSent, lobby, setReplyFails: (f) => (replyFails = f), setReplyDelay: (ms) => (replyDelay = ms) };
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  delete process.env.SIM_MIRROR_FOLLOWUPS;
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
  delete process.env.SIM_MIRROR_FOLLOWUPS;
  LINE_CONFIG.commandsEnabled = false;
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

  it('a redelivery of an event whose answer already went out gets no second copy and advances nothing', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1', GROUP, { webhookEventId: 'E1', deliveryContext: { isRedelivery: false } }));
    await deliver(h, groupText('/下一步', 'm2', 'rt2', GROUP, { webhookEventId: 'E2', deliveryContext: { isRedelivery: false } }));
    expect(h.replies).toHaveLength(2);
    expect(h.replies[1].messages[0].text).toContain('第 3 局第 4 次');
    await deliver(h, groupText('/下一步', 'm2', 'rt2b', GROUP, { webhookEventId: 'E2', deliveryContext: { isRedelivery: true } }));
    expect(h.replies).toHaveLength(2); // nothing queued, nothing to say: no reply at all
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1b', GROUP, { webhookEventId: 'E1', deliveryContext: { isRedelivery: true } }));
    expect(h.replies).toHaveLength(2);
    // /下一步 of an open exercise is a follow-up: not mirrored (SIM_MIRROR_FOLLOWUPS off).
    expect(h.lobby.map((m) => m.message)).toEqual(['/模擬 忠臣 4']);
    // Still at the R3 decision: the next step goes to the end of the game.
    await deliver(h, groupText('/下一步', 'm3', 'rt3'));
    expect(h.replies.at(-1)?.messages[0].text).toContain('三藍：任務成功三次');
  });

  it('a redelivery still drains the mirror queue on its reply_token (no 模擬 answer in slot 1)', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1', GROUP, { webhookEventId: 'E1', deliveryContext: { isRedelivery: false } }));
    await queueMirrorMessages(h.mirror, 2);
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1b', GROUP, { webhookEventId: 'E1', deliveryContext: { isRedelivery: true } }));
    expect(h.replies.at(-1)?.messages.map((m) => bodyOf(m.text))).toEqual(['msg0', 'msg1']);
  });

  it('two commands from one person in two concurrent webhooks run one at a time: the second reads the committed step', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'm1', 'rt1'));
    h.setReplyDelay(50);
    const first = deliver(h, groupText('/派 469', 'm2', 'rt2'));
    await sleep(5);
    const second = deliver(h, groupText('/下一步', 'm3', 'rt3'));
    await Promise.all([first, second]);
    h.setReplyDelay(0);
    expect(h.replies.map((r) => r.token)).toEqual(['rt1', 'rt2', 'rt3']);
    expect(h.replies[2].messages[0].text).toContain('第 3 局第 4 次');
    // The step really happened: the R3 decision takes 4 seats.
    await deliver(h, groupText('/派 1468', 'm4', 'rt4'));
    expect(h.replies.at(-1)?.messages[0].text).toContain('你派 1468');
  });

  it('follow-ups are mirrored again with SIM_MIRROR_FOLLOWUPS=true; a /派 with no exercise is plain text (mirrored)', async () => {
    const h = setup();
    await deliver(h, groupText('/派 469', 'n0', 'rn0'));
    await deliver(h, groupText('/模擬 忠臣 4', 'n1', 'rn1'), groupText('/派 469', 'n2', 'rn2'));
    expect(h.lobby.map((m) => m.message)).toEqual(['/派 469', '/模擬 忠臣 4']);
    process.env.SIM_MIRROR_FOLLOWUPS = 'true';
    await deliver(h, groupText('/區間 789=2', 'n3', 'rn3'));
    expect(h.lobby.map((m) => m.message)).toEqual(['/派 469', '/模擬 忠臣 4', '/區間 789=2']);
    expect(h.replies.at(-1)?.messages[0].text).toContain('區間】');
  });

  it('a commit that throws after the reply went out never re-queues the drained mirror messages', async () => {
    const h = setup();
    const engine = new SimEngine({ bank: async () => BANK, random: () => () => 0 });
    vi.spyOn(engine, 'handleText').mockResolvedValue({
      text: '模擬回覆', kind: 'start', sessionOpen: true, commit: () => { throw new Error('boom'); },
    });
    __setSimForTests({ engine });
    await queueMirrorMessages(h.mirror, 3);
    await deliver(h, groupText('/模擬', 'x1', 'rx1'));
    expect(h.replies[0].messages.map((m) => bodyOf(m.text))).toEqual(['模擬回覆', 'msg0', 'msg1', 'msg2']);
    expect(h.mirror.lineReplyQueueSize()).toBe(0);
    expect(h.bot.getWebhookStats()).toMatchObject({ replyFailures: 0, simReplies: 1, repliesDrained: 3 });
  });

  it('never echoes what was typed: a malformed /區間 with a name in it gets the group number only', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'e1', 're1'));
    await deliver(h, groupText(typed('/區間 12=1 假名01是梅林'), 'e2', 're2'), groupText(typed('/區間 假名02=紅'), 'e3', 're3'));
    const answers = h.replies.slice(1).map((r) => r.messages[0].text);
    expect(answers).toHaveLength(2);
    for (const a of answers) {
      expect(a).not.toMatch(/假名|梅林/);
      expect(a).toMatch(/^第 \d 組看不懂/);
    }
  });

  it('plain chat, /派西 2, /模擬什麼時候… and /派對 without an exercise get nothing; /派 without one gets the short hint', async () => {
    const h = setup();
    await deliver(
      h,
      groupText(typed('派西是 2 吧'), 'c1', 'rc1'),
      groupText(typed('/派西 2'), 'c2', 'rc2'),
      groupText(typed('/模擬什麼時候可以玩'), 'c4', 'rc4'),
      groupText(typed('/派對 今晚'), 'c5', 'rc5'),
    );
    expect(h.replies).toEqual([]);
    await deliver(h, groupText('/派 469', 'c3', 'rc3'));
    expect(h.replies[0].messages[0].text).toBe(NO_SESSION_TEXT);
  });

  it('a member without an exercise co-answers the newest one in the group (marked 代答, not mirrored); /模擬 說明 lists the commands', async () => {
    const h = setup();
    await deliver(h, groupText('/模擬 忠臣 4', 'k1', 'rk1'));
    const fromU2 = { ...groupText(typed('/派 469'), 'k2', 'rk2'), source: { type: 'group', groupId: GROUP, userId: 'U2' } };
    await deliver(h, fromU2);
    const answer = h.replies.at(-1)?.messages[0].text ?? '';
    expect(answer.split('\n').slice(0, 2)).toEqual([CO_ANSWER_MARK, '【W0000-4・4家忠臣】你派 469']);
    expect(answer).not.toMatch(/U1|U2|LineUser/u); // nobody is named
    expect(h.replies.at(-1)?.messages[0].quoteToken).toBe('q-k2');
    // A co-answer is a follow-up of an open exercise: not mirrored (SIM_MIRROR_FOLLOWUPS off).
    expect(h.lobby.map((m) => m.message)).toEqual(['/模擬 忠臣 4']);
    // The owner continues on the same exercise (now answered).
    await deliver(h, groupText('/公布', 'k3', 'rk3'));
    expect(h.replies.at(-1)?.messages[0].text).toContain('你的派票：469：1 紅（9）✗');

    await deliver(h, groupText('/模擬 說明', 'k4', 'rk4'));
    expect(h.replies.at(-1)?.messages[0].text).toBe(SIM_HELP_TEXT);
    expect(h.lobby.map((m) => m.message)).toEqual(['/模擬 忠臣 4', '/模擬 說明']); // mirrored like /模擬
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
    expect(getFeedbackService().observe('discord', '／模擬 派西 排行')).toEqual([]);
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

  it('another group is silent; an allow-listed practice group answers 模擬 and /指令 only, on its own token', async () => {
    const h = setup();
    await queueMirrorMessages(h.mirror, 3);
    await deliver(h, groupText('/模擬', 'g1', 'rg1', 'Cother'));
    expect(h.replies).toEqual([]);

    process.env.SIM_LINE_GROUP_IDS = 'Cpractice, Cextra';
    const logs = consoleSpies[0]; // console.log
    logs.mockClear();
    await deliver(h, groupText('/模擬 忠臣 4', 'g2', 'rg2', 'Cpractice'), groupText('/排行', 'g3', 'rg3', 'Cpractice'));
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].token).toBe('rg2');
    expect(h.replies[0].messages).toHaveLength(1);
    expect(h.replies[0].messages[0].quoteToken).toBe('q-g2');
    expect(h.replies[0].messages[0].quickReply).toBeUndefined();
    expect(h.mirror.lineReplyQueueSize()).toBe(3);
    expect(h.lobby).toEqual([]);
    // The practice group is not told to become the mirror group.
    expect(logs.mock.calls.flat().join('\n')).not.toContain('LOBBY_MIRROR_LINE_GROUP_ID');

    await deliver(h, groupText('/指令', 'g4', 'rg4', 'Cpractice'));
    expect(h.replies.at(-1)?.messages[0].text).toBe(SIM_HELP_TEXT);
  });

  it('1:1 with the legacy commands on: a rate-limited 模擬 command gets no 「未知指令」', async () => {
    LINE_CONFIG.commandsEnabled = true;
    const loader = new SimBankLoader(() => BANK);
    __setSimForTests({ loader, engine: new SimEngine({ bank: () => loader.get(), random: () => () => 0, rateLimit: { windowMs: 600_000, max: 2 } }) });
    const h = setup();
    for (let i = 0; i < 6; i++) await deliver(h, userText('/結束', `r${i}`, `rr${i}`));
    const texts = h.replies.map((r) => r.messages[0].text);
    expect(texts).toEqual([NO_SESSION_TEXT, NO_SESSION_TEXT, RATE_LIMITED_TEXT]);
    expect(texts.join('\n')).not.toContain('未知指令');
  });
});
