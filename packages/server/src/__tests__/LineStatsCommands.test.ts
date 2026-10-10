/**
 * LINE stats commands (2026-10-10): /戰績 /排行 /默契 /指令 in the lobby-mirror
 * group and in 1:1 chats, with the legacy game commands still disabled.
 *
 * The critical part: in the mirror group a reply_token also drains the
 * Discord→LINE queue, and one reply_token = ONE replyMessage with ≤5
 * messages. The stats answer takes slot 1, queued mirror messages fill the
 * rest; a failed reply re-queues only the drained mirror messages. The
 * command text itself is still mirrored to Discord / the lobby; the answer
 * goes to LINE only.
 *
 * Real ChatMirror + LineReplyQueue + LineBotClient; mocked LINE SDK, Discord
 * channel and analysis cache. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';

const fixture = vi.hoisted(() => {
  const base = {
    positionTheory: 0, red3Red: 0, redMerlinDead: 0, redMerlinAlive: 0, blue3Red: 0, blueMerlinDead: 0,
    blueMerlinAlive: 0, roleWinRates: {}, roleDistribution: {}, redRoleRate: 0, blueRoleRate: 0, seatWinRates: {},
    seatRedWinRates: {}, seatBlueWinRates: {}, rawRoleGames: {}, rawRedWins: 0, rawBlueWins: 0, rawTotalWins: 0,
    rawRedGames: 10, rawBlueGames: 10,
  };
  const players = [
    { ...base, name: 'Sin', totalGames: 1080, winRate: 51.4, roleTheory: 51.3, redWin: 50.2, blueWin: 52.2 },
    { ...base, name: 'HAO', totalGames: 1013, winRate: 59, roleTheory: 59.1, redWin: 56.6, blueWin: 60.5 },
    { ...base, name: 'SIN', totalGames: 3, winRate: 33.3, roleTheory: 30, redWin: 0, blueWin: 50 },
  ];
  const labels = ['SIN', 'HAO'];
  return {
    players,
    overview: {
      totalGames: 2146, totalPlayers: 198, redWinRate: 46.6, blueWinRate: 53.4, merlinKillRate: 43.5,
      outcomeBreakdown: { threeRed: 0, threeBlueDead: 0, threeBlueAlive: 0, threeRedPct: 0, threeBlueDeadPct: 0, threeBlueAlivePct: 0 },
      topPlayersByTheory: [
        { name: 'HAO', roleTheory: 59.1, winRate: 59, games: 1013 },
        { name: 'Sin', roleTheory: 51.3, winRate: 51.4, games: 1080 },
      ],
      topPlayersByGames: [], seatPositionWinRates: [],
    },
    chemistry: {
      coWin: { players: labels, rowLabels: labels, values: [[452, 108], [108, 467]] },
      coLose: { players: labels, rowLabels: labels, values: [[503, 131], [131, 414]] },
      winCorr: { players: labels, values: [] },
      coWinMinusLose: { players: labels, values: [] },
    },
  };
});

vi.mock('../services/sheetsAnalysis', () => ({
  getAllPlayerStats: async () => fixture.players,
  getPlayerByName: async (name: string) => fixture.players.find((pl) => pl.name === name) ?? null,
  getOverview: async () => fixture.overview,
  getChemistry: async () => fixture.chemistry,
  getPlayerArchetype: async () => null,
  getPlayerStrength: async () => null,
  getPlayerPlaystyle: async () => null,
}));

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
import type { LobbyChatMessage } from '../socket/LobbyChatBuffer';

const GROUP = 'Cmirror-group';
const SECRET = 'test-channel-secret';
const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

interface Harness {
  mirror: ChatMirror;
  bot: LineBotClient;
  replies: { token: string; texts: string[] }[];
  discordSent: string[];
  lobby: LobbyChatMessage[];
  setReplyFails: (fails: boolean) => void;
}

function setup(): Harness {
  const replies: { token: string; texts: string[] }[] = [];
  const discordSent: string[] = [];
  let replyFails = false;
  const client = {
    replyMessage: async (token: string, messages: { type: string; text: string }[]) => {
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

function groupText(text: string, id: string, replyToken: string, groupId = GROUP) {
  return { type: 'message', replyToken, source: { type: 'group', groupId, userId: 'U1' }, message: { type: 'text', id, text } };
}

function userText(text: string, id: string, replyToken: string) {
  return { type: 'message', replyToken, source: { type: 'user', userId: 'U7' }, message: { type: 'text', id, text } };
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

const originalStats = LINE_CONFIG.statsCommandsEnabled;
const originalLegacy = LINE_CONFIG.commandsEnabled;

beforeEach(() => {
  __resetChatMirrorForTests();
  process.env.LOBBY_MIRROR_LINE_GROUP_ID = GROUP;
  delete process.env.CHAT_MIRROR_USE_LEGACY_FORMAT;
  LINE_CONFIG.statsCommandsEnabled = true;
  LINE_CONFIG.commandsEnabled = false; // legacy game commands stay disabled
});
afterEach(() => {
  delete process.env.LOBBY_MIRROR_LINE_GROUP_ID;
  LINE_CONFIG.statsCommandsEnabled = originalStats;
  LINE_CONFIG.commandsEnabled = originalLegacy;
});

describe('mirror group: stats answer shares the reply_token with the mirror queue', () => {
  it('/排行 with 7 queued → ONE replyMessage: answer + 4 queued; 3 stay queued', async () => {
    const h = setup();
    await queueMirrorMessages(h.mirror, 7);
    expect(h.mirror.lineReplyQueueSize()).toBe(7);

    expect(await deliver(h, groupText('/排行', 'm1', 'rt1'))).toBe(200);

    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].token).toBe('rt1');
    expect(h.replies[0].texts).toHaveLength(5);
    expect(h.replies[0].texts[0]).toContain('🏆 理論勝率排行 Top 10');
    expect(h.replies[0].texts[0]).toContain('🥇 HAO　59.1%');
    expect(h.replies[0].texts.slice(1).map(bodyOf)).toEqual(['msg0', 'msg1', 'msg2', 'msg3']);
    expect(h.mirror.lineReplyQueueSize()).toBe(3);
    expect(h.bot.getWebhookStats()).toMatchObject({ repliesDrained: 4, statsReplies: 1, replyFailures: 0 });

    // The rest drains on the next reply_token, oldest first.
    await deliver(h, groupText('ok', 'm2', 'rt2'));
    expect(h.replies[1].texts.map(bodyOf)).toEqual(['msg4', 'msg5', 'msg6']);
    expect(h.mirror.lineReplyQueueSize()).toBe(0);
  });

  it('the command text is still mirrored to Discord + lobby; the answer is not', async () => {
    const h = setup();
    await deliver(h, groupText('/戰績 HAO', 'm3', 'rt3'));

    expect(h.lobby.map((m) => m.message)).toEqual(['/戰績 HAO']);
    expect(h.discordSent).toHaveLength(1);
    expect(h.discordSent[0]).toMatch(/\[LINE\]\[LineUser-U1\] \/戰績 HAO$/);
    expect(h.discordSent.join('\n')).not.toContain('的戰績');

    expect(h.replies).toEqual([{ token: 'rt3', texts: [expect.stringContaining('📊 HAO 的戰績')] }]);
    expect(h.mirror.lineReplyQueueSize()).toBe(0); // answer never enters the queue
  });

  it('reply failure re-queues the drained mirror messages exactly (answer is not queued)', async () => {
    const h = setup();
    await queueMirrorMessages(h.mirror, 7);
    h.setReplyFails(true);

    expect(await deliver(h, groupText('/排行', 'm4', 'rt4'))).toBe(200); // webhook still acks
    expect(h.mirror.lineReplyQueueSize()).toBe(7);
    expect(h.bot.getWebhookStats()).toMatchObject({ replyFailures: 1, repliesDrained: 0, statsReplies: 0 });

    h.setReplyFails(false);
    await deliver(h, groupText('again', 'm5', 'rt5'));
    expect(h.replies[0].texts.map(bodyOf)).toEqual(['msg0', 'msg1', 'msg2', 'msg3', 'msg4']);
    expect(h.mirror.lineReplyQueueSize()).toBe(2);
  });

  it('non-command chatter is unchanged: 5 queued messages drained, nothing else', async () => {
    const h = setup();
    await queueMirrorMessages(h.mirror, 7);
    await deliver(h, groupText('大家好', 'm6', 'rt6'));
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].texts.map(bodyOf)).toEqual(['msg0', 'msg1', 'msg2', 'msg3', 'msg4']);
    expect(h.mirror.lineReplyQueueSize()).toBe(2);
    expect(h.lobby.map((m) => m.message)).toEqual(['大家好']);
    expect(h.bot.getWebhookStats().statsReplies).toBe(0);
  });

  it('non-command chatter with an empty queue sends no reply at all', async () => {
    const h = setup();
    await deliver(h, groupText('/help', 'm7', 'rt7'), groupText('hello', 'm8', 'rt8'));
    expect(h.replies).toEqual([]);
  });

  it('LINE_STATS_COMMANDS_ENABLED=false → /排行 is plain chatter', async () => {
    LINE_CONFIG.statsCommandsEnabled = false;
    const h = setup();
    await queueMirrorMessages(h.mirror, 7);
    await deliver(h, groupText('/排行', 'm9', 'rt9'));
    expect(h.replies[0].texts.map(bodyOf)).toEqual(['msg0', 'msg1', 'msg2', 'msg3', 'msg4']);
    expect(h.mirror.lineReplyQueueSize()).toBe(2);
  });

  it('/指令 and /默契 answer too', async () => {
    const h = setup();
    await deliver(h, groupText('/指令', 'a1', 'rtA'), groupText('/默契 Sin HAO', 'a2', 'rtB'));
    expect(h.replies[0]).toEqual({ token: 'rtA', texts: [expect.stringContaining('/默契 名字1 名字2')] });
    expect(h.replies[1].texts[0]).toContain('同隊 239 場');
  });

  it('a digest queued via enqueueLineReplyText goes out on the next reply_token, verbatim', async () => {
    const h = setup();
    expect(h.mirror.enqueueLineReplyText('📅 每週排行（10/12）…')).toBe(true);
    expect(h.discordSent).toEqual([]);
    expect(h.lobby).toEqual([]);
    await deliver(h, groupText('/排行', 'd1', 'rtD'));
    expect(h.replies[0].texts).toHaveLength(2);
    expect(h.replies[0].texts[1]).toBe('📅 每週排行（10/12）…');
  });
});

describe('1:1 chat and other groups', () => {
  it('1:1 /戰績 answers even though legacy commands are disabled, and keeps name case', async () => {
    const h = setup();
    await queueMirrorMessages(h.mirror, 3);
    await deliver(h, userText('/戰績 SIN', 'u1', 'rtU'));
    expect(h.replies).toEqual([{ token: 'rtU', texts: [expect.stringContaining('📊 SIN 的戰績')] }]);
    // A 1:1 reply never drains the group's mirror queue, and nothing is mirrored.
    expect(h.mirror.lineReplyQueueSize()).toBe(3);
    expect(h.lobby).toEqual([]);
  });

  it('1:1 legacy commands stay silent while LINE_BOT_COMMANDS_ENABLED is off', async () => {
    const h = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await deliver(h, userText('/help', 'u2', 'rtH'), userText('hi', 'u3', 'rtI'));
    log.mockRestore();
    expect(h.replies).toEqual([]);
  });

  it('a group that is not the mirror group gets no stats answer', async () => {
    const h = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await deliver(h, groupText('/排行', 'g1', 'rtG', 'Cother-group'));
    log.mockRestore();
    expect(h.replies).toEqual([]);
  });
});
