/**
 * Community feedback (2026-10-12) wired into the bots:
 *
 *   LINE    — mirror-group text is topic-counted; "/意見 …" (also ／意見)
 *             takes slot 1 of the reply_token and the mirror queue drains
 *             behind it; empty content → usage hint; 1:1 chats answer too;
 *             FEEDBACK_COMMAND_ENABLED=false → plain chatter.
 *   Discord — slash command 意見 registered with the 內容 option; the
 *             handler acks ephemerally and forwards "📮 意見（Discord）：…".
 *   Status  — /api/bots/status carries feedback: { weeks, opinions } (numbers).
 *   Robustness (2026-10-12 review) — the LINE reply / 200 never waits for the
 *             Discord forward; a LINE redelivery is answered but not counted,
 *             mirrored or forwarded twice; without FEEDBACK_DISCORD_CHANNEL_ID
 *             the text goes to the admin channel 大劍管理員 (never the public
 *             mirror channel); FEEDBACK_DISCORD_CHANNEL_ID=off forwards nothing;
 *             typed stats commands are not topic-counted.
 *
 * Real ChatMirror + LineReplyQueue + LineBotClient; mocked LINE SDK, Discord
 * sender and interaction. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import { MessageFlags } from 'discord.js';

import { ChatMirror, initializeChatMirror, __resetChatMirrorForTests, DiscordAdapter, DiscordChannelAdapter } from '../bots/ChatMirror';
import { LineReplyQueue } from '../bots/line/replyQueue';
import { LineBotClient } from '../bots/line/client';
import { LINE_CONFIG } from '../bots/line/config';
import type { LobbyChatMessage } from '../socket/LobbyChatBuffer';
import {
  DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID,
  FEEDBACK_ACK_TEXT,
  FEEDBACK_CONFIG,
  FEEDBACK_DISABLED_TEXT,
  FEEDBACK_USAGE_TEXT,
  FeedbackForwardPayload,
  OPINION_TOPIC_ID,
  __resetFeedbackForTests,
  getFeedbackService,
} from '../bots/feedback';
import { handleFeedbackCommand } from '../bots/feedback/discordCommand';
import { buildSlashCommands } from '../bots/discord/client';
import { COMMANDS, FEEDBACK_OPTIONS } from '../bots/discord/config';
import { buildBotStatus } from '../bots/index';

const GROUP = 'Cmirror-group';
const SECRET = 'test-channel-secret';
const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

interface Forwarded {
  channelId: string;
  payload: FeedbackForwardPayload;
}

/** Point the singleton at a mock Discord sender and return what it receives. */
function captureForwards(): Forwarded[] {
  const forwarded: Forwarded[] = [];
  getFeedbackService().setDiscordForwarder({
    send: async (channelId, payload) => {
      forwarded.push({ channelId, payload });
      return true;
    },
  });
  return forwarded;
}

/** A Discord sender that does not resolve until `release()` is called (simulates a stalled REST call). */
function gatedForwarder(): { contents: string[]; release: (ok: boolean) => void } {
  const contents: string[] = [];
  let release: (ok: boolean) => void = () => {};
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  getFeedbackService().setDiscordForwarder({
    send: (_channelId, payload) => {
      contents.push(payload.content);
      return gate;
    },
  });
  return { contents, release: (ok) => release(ok) };
}

/** A LINE event with the redelivery metadata LINE attaches (same webhookEventId on the re-send). */
const withDelivery = <T extends object>(event: T, webhookEventId: string, isRedelivery: boolean): T => ({
  ...event,
  webhookEventId,
  deliveryContext: { isRedelivery },
});

interface Harness {
  mirror: ChatMirror;
  bot: LineBotClient;
  replies: { token: string; texts: string[] }[];
  discordSent: string[];
  lobby: LobbyChatMessage[];
}

function setup(): Harness {
  const replies: { token: string; texts: string[] }[] = [];
  const discordSent: string[] = [];
  const client = {
    replyMessage: async (token: string, messages: { type: string; text: string }[]) => {
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
    discordChannelId: 'D1',
    discord,
    lineReplyQueue: new LineReplyQueue(),
    logger: silentLogger,
    inboundRateLimit: { windowMs: 60_000, maxRequests: 100 },
  });
  const lobby: LobbyChatMessage[] = [];
  mirror.setLobbyIngest((m) => lobby.push(m));
  const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client });
  return { mirror, bot, replies, discordSent, lobby };
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

const groupText = (text: string, id: string, replyToken: string, groupId = GROUP) => ({
  type: 'message',
  replyToken,
  source: { type: 'group', groupId, userId: 'U1' },
  message: { type: 'text', id, text },
});

const userText = (text: string, id: string, replyToken: string) => ({
  type: 'message',
  replyToken,
  source: { type: 'user', userId: 'U7' },
  message: { type: 'text', id, text },
});

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

const originalEnabled = FEEDBACK_CONFIG.commandEnabled;
const originalStats = LINE_CONFIG.statsCommandsEnabled;
const originalLegacy = LINE_CONFIG.commandsEnabled;
const env = { ...process.env };

beforeEach(() => {
  __resetChatMirrorForTests();
  __resetFeedbackForTests();
  process.env.LOBBY_MIRROR_LINE_GROUP_ID = GROUP;
  process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-feedback';
  delete process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID;
  delete process.env.CHAT_MIRROR_USE_LEGACY_FORMAT;
  FEEDBACK_CONFIG.commandEnabled = true;
  LINE_CONFIG.statsCommandsEnabled = true;
  LINE_CONFIG.commandsEnabled = false;
});
afterEach(() => {
  process.env = { ...env };
  FEEDBACK_CONFIG.commandEnabled = originalEnabled;
  LINE_CONFIG.statsCommandsEnabled = originalStats;
  LINE_CONFIG.commandsEnabled = originalLegacy;
});

// ─── LINE ─────────────────────────────────────────────────────────────────

describe('LINE mirror group: /意見', () => {
  it('acks in slot 1 of the reply_token, drains the mirror queue behind it, forwards to Discord without names', async () => {
    const h = setup();
    const forwarded = captureForwards();
    await queueMirrorMessages(h.mirror, 7);

    expect(await deliver(h, groupText('/意見 排行榜希望加上場次', 'm1', 'rt1'))).toBe(200);

    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].token).toBe('rt1');
    expect(h.replies[0].texts).toHaveLength(5);
    expect(h.replies[0].texts[0]).toBe(FEEDBACK_ACK_TEXT);
    expect(h.replies[0].texts.slice(1).map(bodyOf)).toEqual(['msg0', 'msg1', 'msg2', 'msg3']);
    expect(h.mirror.lineReplyQueueSize()).toBe(3);
    expect(h.bot.getWebhookStats()).toMatchObject({ repliesDrained: 4, feedbackReplies: 1, statsReplies: 0, replyFailures: 0 });

    expect(forwarded).toEqual([
      { channelId: 'C-feedback', payload: { content: '📮 意見（LINE）：排行榜希望加上場次', allowedMentions: { parse: [] } } },
    ]);
    expect(forwarded[0].payload.content).not.toContain('LineUser');
    expect(forwarded[0].payload.content).not.toContain('U1');

    // Like a stats command, the typed text is still mirrored; the ack is not.
    expect(h.lobby.map((m) => m.message)).toEqual(['/意見 排行榜希望加上場次']);
    const fromLine = h.discordSent.filter((t) => t.includes('[LINE]')); // the other 7 are the lobby fanout
    expect(fromLine).toHaveLength(1);
    expect(fromLine[0]).toMatch(/\[LINE\]\[LineUser-U1\] \/意見 排行榜希望加上場次$/);
    expect(h.discordSent.join('\n')).not.toContain(FEEDBACK_ACK_TEXT);
  });

  it('accepts the full-width slash and no space', async () => {
    const h = setup();
    const forwarded = captureForwards();
    await deliver(h, groupText('／意見網站很好用', 'm2', 'rt2'));
    expect(h.replies).toEqual([{ token: 'rt2', texts: [FEEDBACK_ACK_TEXT] }]);
    expect(forwarded.map((f) => f.payload.content)).toEqual(['📮 意見（LINE）：網站很好用']);
  });

  it('/意見 with no content → usage hint, nothing forwarded or counted as an opinion', async () => {
    const h = setup();
    const forwarded = captureForwards();
    await deliver(h, groupText('/意見', 'm3', 'rt3'), groupText('／意見   ', 'm4', 'rt4'));
    expect(h.replies.map((r) => r.texts)).toEqual([[FEEDBACK_USAGE_TEXT], [FEEDBACK_USAGE_TEXT]]);
    expect(forwarded).toEqual([]);
    expect(getFeedbackService().snapshot().opinions).toEqual({ line: 0, discord: 0 });
  });

  it('counts topics of every mirror-group text (≤1 per topic per message) and 意見 for the command', async () => {
    const h = setup();
    captureForwards();
    await deliver(
      h,
      groupText('排行 排名 都怪怪的', 'c1', 'rc1'),
      groupText('今晚開局', 'c2', 'rc2'),
      groupText('/意見 bot 回覆格式可以加場次', 'c3', 'rc3'),
    );
    const snap = getFeedbackService().snapshot();
    expect(snap.opinions).toEqual({ line: 1, discord: 0 });
    expect(snap.weeks).toHaveLength(1);
    expect(snap.weeks[0].line).toMatchObject({ 排行: 1, 問題: 1, 機器人: 1, 格式: 1, 建議: 1, [OPINION_TOPIC_ID]: 1, 戰績: 0 });
    expect(snap.weeks[0].discord[OPINION_TOPIC_ID]).toBe(0);
    // Numbers only — no text, no ids anywhere in the snapshot.
    expect(JSON.stringify(snap)).not.toMatch(/排名 都怪怪的|今晚開局|U1|LineUser/);
  });

  it('FEEDBACK_COMMAND_ENABLED=false → /意見 is plain chatter (mirrored, keyword-counted, no ack, no forward)', async () => {
    FEEDBACK_CONFIG.commandEnabled = false;
    const h = setup();
    const forwarded = captureForwards();
    await queueMirrorMessages(h.mirror, 2);
    await deliver(h, groupText('/意見 排行停用中', 'm5', 'rt5'));
    expect(h.replies[0].texts.map(bodyOf)).toEqual(['msg0', 'msg1']);
    expect(forwarded).toEqual([]);
    expect(h.lobby.map((m) => m.message)).toEqual(['/意見 排行停用中']);
    const snap = getFeedbackService().snapshot();
    expect(snap.opinions).toEqual({ line: 0, discord: 0 });
    expect(snap.weeks[0].line).toMatchObject({ 排行: 1, [OPINION_TOPIC_ID]: 0 });
  });

  it('a group that is not the mirror group gets no ack and is not counted', async () => {
    const h = setup();
    const forwarded = captureForwards();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await deliver(h, groupText('/意見 別的群', 'g1', 'rtG', 'Cother-group'), groupText('排行', 'g2', 'rtH', 'Cother-group'));
    log.mockRestore();
    expect(h.replies).toEqual([]);
    expect(forwarded).toEqual([]);
    expect(getFeedbackService().snapshot()).toEqual({ weeks: [], opinions: { line: 0, discord: 0 } });
  });

  it('stats commands still win slot 1 and are booked under statsReplies, not feedbackReplies', async () => {
    const h = setup();
    captureForwards();
    await deliver(h, groupText('/指令', 'a1', 'rtA'));
    expect(h.replies[0].texts[0]).toContain('/意見 文字');
    expect(h.bot.getWebhookStats()).toMatchObject({ statsReplies: 1, feedbackReplies: 0 });
  });

  it('typed stats commands are usage, not reactions: /排行 /戰績 /默契 /指令 do not bump their topics', async () => {
    const h = setup();
    captureForwards();
    await deliver(
      h,
      groupText('/排行', 's1', 'rtS1'),
      groupText('／戰績 HAO', 's2', 'rtS2'),
      groupText('/默契 A B', 's3', 'rtS3'),
      groupText('/指令', 's4', 'rtS4'),
      groupText('排行榜不錯', 's5', 'rtS5'),
    );
    const [w] = getFeedbackService().snapshot().weeks;
    expect(w.line).toMatchObject({ 排行: 1, 戰績: 0, 默契: 0, 問題: 0, 稱讚: 1 });
    // They are still mirrored like any other text.
    expect(h.lobby.map((m) => m.message)).toEqual(['/排行', '／戰績 HAO', '/默契 A B', '/指令', '排行榜不錯']);
  });

  it('replies and returns 200 before the Discord forward finishes — the reply_token never waits for Discord REST', async () => {
    const h = setup();
    const gate = gatedForwarder();
    await queueMirrorMessages(h.mirror, 2);

    expect(await deliver(h, groupText('/意見 排行壞了', 'm9', 'rt9'))).toBe(200);

    // The send was started (and is still pending) but the ack + drained batch already went out.
    expect(gate.contents).toEqual(['📮 意見（LINE）：排行壞了']);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].texts).toHaveLength(3);
    expect(h.replies[0].texts[0]).toBe(FEEDBACK_ACK_TEXT);
    expect(h.bot.getWebhookStats()).toMatchObject({ feedbackReplies: 1, repliesDrained: 2, replyFailures: 0 });
    expect(getFeedbackService().snapshot().opinions.line).toBe(1);
    gate.release(true);
  });

  it('a LINE redelivery of an already handled /意見 is answered again but not counted, mirrored or forwarded twice', async () => {
    const h = setup();
    const forwarded = captureForwards();
    const first = withDelivery(groupText('/意見 排行壞了', 'm10', 'rt10'), '01EV-feedback', false);
    expect(await deliver(h, first)).toBe(200);
    expect(await deliver(h, withDelivery(first, '01EV-feedback', true))).toBe(200);

    expect(forwarded.map((f) => f.payload.content)).toEqual(['📮 意見（LINE）：排行壞了']);
    const snap = getFeedbackService().snapshot();
    expect(snap.opinions).toEqual({ line: 1, discord: 0 });
    expect(snap.weeks[0].line).toMatchObject({ [OPINION_TOPIC_ID]: 1, 排行: 1, 問題: 1 });
    // Answered both times (the first reply may never have gone out), mirrored once.
    expect(h.replies.map((r) => r.texts)).toEqual([[FEEDBACK_ACK_TEXT], [FEEDBACK_ACK_TEXT]]);
    expect(h.lobby).toHaveLength(1);
    expect(h.discordSent.filter((t) => t.includes('[LINE]'))).toHaveLength(1);
    expect(h.bot.getWebhookStats()).toMatchObject({ feedbackReplies: 2, mirrorGroupEvents: 2 });
  });

  it('a redelivery that is the first copy we ever see (original lost to a cold start) is handled normally', async () => {
    const h = setup();
    const forwarded = captureForwards();
    expect(await deliver(h, withDelivery(groupText('/意見 排行壞了', 'm11', 'rt11'), '01EW-only', true))).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(getFeedbackService().snapshot().opinions.line).toBe(1);
    expect(h.lobby).toHaveLength(1);
  });

  it('plain chatter redelivered twice is topic-counted once; without the flag the same id is not treated as a duplicate', async () => {
    const h = setup();
    captureForwards();
    const chat = withDelivery(groupText('排行壞了', 'm12', 'rt12'), '01EX-chat', false);
    await deliver(h, chat);
    await deliver(h, withDelivery(chat, '01EX-chat', true));
    expect(getFeedbackService().snapshot().weeks[0].line).toMatchObject({ 排行: 1, 問題: 1 });
    expect(h.lobby).toHaveLength(1);
    // Not flagged as a redelivery → not deduped (ids are only trusted together with the flag).
    await deliver(h, groupText('排行壞了', 'm13', 'rt13'), groupText('排行壞了', 'm13', 'rt13b'));
    expect(getFeedbackService().snapshot().weeks[0].line).toMatchObject({ 排行: 3, 問題: 3 });
  });

  it('without FEEDBACK_DISCORD_CHANNEL_ID the text goes to the admin channel 大劍管理員 — never to the lobby mirror channel', async () => {
    delete process.env.FEEDBACK_DISCORD_CHANNEL_ID;
    process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID = 'D1';
    const h = setup();
    const forwarded = captureForwards();
    await deliver(h, groupText('/意見 匿名文字', 'm13b', 'rt13b'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.map((f) => f.channelId)).toEqual([DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID]);
    expect(h.discordSent.join('\n')).not.toContain('📮');
  });

  it('FEEDBACK_DISCORD_CHANNEL_ID=off → nothing is forwarded, but the ack and the counts still happen', async () => {
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'off';
    process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID = 'D1';
    const h = setup();
    const forwarded = captureForwards();
    await deliver(h, groupText('/意見 匿名文字', 'm14', 'rt14'));
    expect(h.replies).toEqual([{ token: 'rt14', texts: [FEEDBACK_ACK_TEXT] }]);
    expect(forwarded).toEqual([]);
    expect(h.discordSent.join('\n')).not.toContain('📮');
    const snap = getFeedbackService().snapshot();
    expect(snap.opinions).toEqual({ line: 1, discord: 0 });
    expect(snap.weeks[0].line).toMatchObject({ [OPINION_TOPIC_ID]: 1 });
  });
});

describe('LINE 1:1 chat: /意見', () => {
  it('answers with the ack, forwards, and never touches the mirror queue', async () => {
    const h = setup();
    const forwarded = captureForwards();
    await queueMirrorMessages(h.mirror, 3);
    await deliver(h, userText('/意見 私訊的意見', 'u1', 'rtU'));
    expect(h.replies).toEqual([{ token: 'rtU', texts: [FEEDBACK_ACK_TEXT] }]);
    expect(forwarded.map((f) => f.payload.content)).toEqual(['📮 意見（LINE）：私訊的意見']);
    expect(h.mirror.lineReplyQueueSize()).toBe(3);
    expect(h.lobby).toEqual([]);
    expect(h.bot.getWebhookStats().feedbackReplies).toBe(1);
    // 1:1 chatter is not topic-counted (only the mirror group is).
    expect(getFeedbackService().snapshot().weeks[0].line).toMatchObject({ [OPINION_TOPIC_ID]: 1 });
    await deliver(h, userText('排行壞了', 'u2', 'rtV'));
    expect(getFeedbackService().snapshot().weeks[0].line).toMatchObject({ 排行: 0, 問題: 0 });
  });

  it('empty /意見 in 1:1 → usage hint', async () => {
    const h = setup();
    captureForwards();
    await deliver(h, userText('/意見', 'u3', 'rtW'));
    expect(h.replies).toEqual([{ token: 'rtW', texts: [FEEDBACK_USAGE_TEXT] }]);
  });

  it('a redelivered 1:1 /意見 is acked again but forwarded and counted once', async () => {
    const h = setup();
    const forwarded = captureForwards();
    const first = withDelivery(userText('/意見 私訊的意見', 'u9', 'rtU9'), '01EY-dm', false);
    await deliver(h, first);
    await deliver(h, withDelivery(first, '01EY-dm', true));
    expect(forwarded).toHaveLength(1);
    expect(getFeedbackService().snapshot().opinions.line).toBe(1);
    expect(h.replies.map((r) => r.texts)).toEqual([[FEEDBACK_ACK_TEXT], [FEEDBACK_ACK_TEXT]]);
  });

  it('the 1:1 reply does not wait for the Discord forward either', async () => {
    const h = setup();
    const gate = gatedForwarder();
    expect(await deliver(h, userText('/意見 慢的 Discord', 'u10', 'rtU10'))).toBe(200);
    expect(h.replies).toEqual([{ token: 'rtU10', texts: [FEEDBACK_ACK_TEXT] }]);
    expect(gate.contents).toEqual(['📮 意見（LINE）：慢的 Discord']);
    gate.release(false);
  });
});

// ─── Discord ──────────────────────────────────────────────────────────────

function makeInteraction(options: Record<string, string> = {}) {
  const fake = {
    commandName: COMMANDS.FEEDBACK,
    user: { id: 'u-1', username: 'user-1' },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async (_opts?: unknown) => {
      fake.deferred = true;
    }),
    editReply: vi.fn(async (_payload: unknown) => {}),
    reply: vi.fn(async (_payload: unknown) => {
      fake.replied = true;
    }),
    followUp: vi.fn(async (_payload: unknown) => {}),
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        const v = options[name];
        if (v === undefined && required) throw new Error(`missing option ${name}`);
        return v ?? null;
      }),
    },
  };
  return fake;
}

describe('Discord slash command 意見', () => {
  it('is registered with a required 內容 option and passes discord.js validation', () => {
    const json = buildSlashCommands().map((c) => c.toJSON());
    const cmd = json.find((c) => c.name === COMMANDS.FEEDBACK);
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('意見');
    expect(cmd!.description.length).toBeLessThanOrEqual(100);
    expect(cmd!.options).toEqual([expect.objectContaining({ name: FEEDBACK_OPTIONS.CONTENT, required: true, max_length: 500 })]);
    // Still next to the stats commands.
    expect(json.map((c) => c.name)).toEqual(expect.arrayContaining(['戰績', '排行', '默契', '意見']));
  });

  it('acks ephemerally and forwards "📮 意見（Discord）：…" with no mentions allowed', async () => {
    const forwarded = captureForwards();
    const it1 = makeInteraction({ [FEEDBACK_OPTIONS.CONTENT]: '刺殺的提示可以加一點 @everyone' });

    await handleFeedbackCommand(it1 as never);

    expect(it1.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(it1.editReply).toHaveBeenCalledWith({ content: FEEDBACK_ACK_TEXT, allowedMentions: { parse: [] } });
    expect(it1.reply).not.toHaveBeenCalled();
    expect(forwarded).toEqual([
      { channelId: 'C-feedback', payload: { content: '📮 意見（Discord）：刺殺的提示可以加一點 @everyone', allowedMentions: { parse: [] } } },
    ]);
    expect(forwarded[0].payload.content).not.toContain('user-1');
    const snap = getFeedbackService().snapshot();
    expect(snap.opinions).toEqual({ line: 0, discord: 1 });
    expect(snap.weeks[0].discord).toMatchObject({ [OPINION_TOPIC_ID]: 1, 刺殺: 1, 建議: 1 });
  });

  it('waits for the (detached) forward before editing the deferred reply, so the 📮 post lands first', async () => {
    const gate = gatedForwarder();
    const it1 = makeInteraction({ [FEEDBACK_OPTIONS.CONTENT]: '慢' });
    const done = handleFeedbackCommand(it1 as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(it1.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(it1.editReply).not.toHaveBeenCalled();
    expect(gate.contents).toEqual(['📮 意見（Discord）：慢']);
    gate.release(true);
    await done;
    expect(it1.editReply).toHaveBeenCalledWith({ content: FEEDBACK_ACK_TEXT, allowedMentions: { parse: [] } });
  });

  it('cuts a long 內容 to 500 characters before forwarding', async () => {
    const forwarded = captureForwards();
    const it1 = makeInteraction({ [FEEDBACK_OPTIONS.CONTENT]: '長'.repeat(900) });
    await handleFeedbackCommand(it1 as never);
    const body = forwarded[0].payload.content.replace('📮 意見（Discord）：', '');
    expect(Array.from(body)).toHaveLength(500);
    expect(body.endsWith('…')).toBe(true);
  });

  it('whitespace-only 內容 → usage hint, nothing forwarded', async () => {
    const forwarded = captureForwards();
    const it1 = makeInteraction({ [FEEDBACK_OPTIONS.CONTENT]: '   ' });
    await handleFeedbackCommand(it1 as never);
    expect(it1.editReply).toHaveBeenCalledWith({ content: FEEDBACK_USAGE_TEXT, allowedMentions: { parse: [] } });
    expect(forwarded).toEqual([]);
  });

  it('FEEDBACK_COMMAND_ENABLED=false → ephemeral "disabled" reply, nothing forwarded', async () => {
    FEEDBACK_CONFIG.commandEnabled = false;
    const forwarded = captureForwards();
    const it1 = makeInteraction({ [FEEDBACK_OPTIONS.CONTENT]: '停用' });
    await handleFeedbackCommand(it1 as never);
    expect(it1.reply).toHaveBeenCalledWith({ content: FEEDBACK_DISABLED_TEXT, flags: MessageFlags.Ephemeral });
    expect(it1.deferReply).not.toHaveBeenCalled();
    expect(forwarded).toEqual([]);
  });
});

// ─── /api/bots/status ─────────────────────────────────────────────────────

describe('/api/bots/status → feedback', () => {
  it('exposes weeks + opinions as numbers (and the command flag), nothing else', async () => {
    captureForwards();
    getFeedbackService().observe('line', '排行怪怪的');
    await getFeedbackService().submit('discord', '牌譜格式');

    const { feedback } = buildBotStatus();
    expect(feedback.commandEnabled).toBe(true);
    expect(feedback.opinions).toEqual({ line: 0, discord: 1 });
    expect(feedback.weeks).toHaveLength(1);
    const [w] = feedback.weeks;
    expect(w.week).toMatch(/^\d{4}-W\d{2}$/);
    expect(w.line).toMatchObject({ 排行: 1, 問題: 1 });
    expect(w.discord).toMatchObject({ 牌譜: 1, 格式: 1, [OPINION_TOPIC_ID]: 1 });
    for (const platform of [w.line, w.discord]) {
      for (const n of Object.values(platform)) expect(Number.isInteger(n)).toBe(true);
    }
    expect(Object.keys(feedback).sort()).toEqual(['commandEnabled', 'opinions', 'weeks']);
    expect(JSON.stringify(feedback)).not.toMatch(/排行怪怪的|牌譜格式|u-1/);
  });

  it('is present (empty) when nothing has been heard yet', () => {
    const { feedback } = buildBotStatus();
    expect(feedback).toEqual({ commandEnabled: true, weeks: [], opinions: { line: 0, discord: 0 } });
  });
});
