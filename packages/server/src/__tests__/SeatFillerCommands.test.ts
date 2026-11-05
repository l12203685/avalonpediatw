/**
 * 補位機器人 commands (2026-11-03, bots/seatFiller): LINE text parsing and
 * replies, the Discord slash command (registration + handler), help texts,
 * and that the commands are skipped by topic counting and the chat export.
 * The dispatcher is the real one with a mocked fetch and clock. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { MessageFlags } from 'discord.js';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';

import {
  SignagePlayerDispatcher,
  __setSignagePlayerDispatcherForTests,
} from '../services/signagePlayerDispatch';
import {
  answerSeatFillerTextCommand,
  formatSeatFillerOutcome,
  formatWait,
  isSeatFillerCommandText,
  parseSeatFillerText,
  SEAT_FILLER_REDELIVERY_TEXT,
} from '../bots/seatFiller/commands';
import { handleSeatFillerCommand } from '../bots/seatFiller/discordCommand';
import { buildSlashCommands } from '../bots/discord/client';
import { COMMANDS, SEAT_FILLER_OPTIONS } from '../bots/discord/config';
import { formatStatsHelp } from '../bots/stats/statsReplies';
import { FeedbackService } from '../bots/feedback/service';
import { isTypedCommand } from '../bots/chatExport/rows';
import { LineBotClient } from '../bots/line/client';
import { LINE_CONFIG } from '../bots/line/config';
import { __resetChatMirrorForTests } from '../bots/ChatMirror';

const SUCCESS = '已叫百科AI 到「Room-1460」（1 個），約 1–2 分鐘後進房；局數不限，要它走就在房內聊天室打「離開」。';

let now = Date.UTC(2026, 10, 3, 4, 0, 0);
let status = 204;
let fetchMock: ReturnType<typeof vi.fn>;

function installDispatcher(env: NodeJS.ProcessEnv = { GITHUB_DISPATCH_TOKEN: 'test-token' }): void {
  fetchMock = vi.fn(async () => ({ status, ok: status >= 200 && status < 300 }));
  __setSignagePlayerDispatcherForTests(
    new SignagePlayerDispatcher({
      fetch: fetchMock,
      now: () => now,
      env: () => env,
      logger: { info: () => undefined, warn: () => undefined },
    }),
  );
}

beforeEach(() => {
  now = Date.UTC(2026, 10, 3, 4, 0, 0);
  status = 204;
  installDispatcher();
});
afterEach(() => {
  __setSignagePlayerDispatcherForTests();
});

describe('LINE text parsing', () => {
  it('accepts /補位 and /機器人補位, full-width slash, bare numbers, description, 補滿, 密碼', () => {
    expect(parseSeatFillerText('/補位 Room-1460')).toEqual({ room: 'Room-1460', extra: false });
    expect(parseSeatFillerText('/機器人補位 Room-1460 2')).toEqual({ room: 'Room-1460', bots: '2', extra: false });
    expect(parseSeatFillerText('／補位　1460')).toEqual({ room: '1460', extra: false });
    expect(parseSeatFillerText('/補位1460')).toEqual({ room: '1460', extra: false });
    expect(parseSeatFillerText('/補位')).toEqual({ room: '', extra: false });
    expect(parseSeatFillerText('/補位 百科陪練 補滿 密碼:1234')).toEqual({ room: '百科陪練', bots: '補滿', password: '1234', extra: false });
    expect(parseSeatFillerText('/補位 「百科 陪練」 3人 pw：99')).toEqual({ room: '百科 陪練', bots: '3人', password: '99', extra: false });
    expect(parseSeatFillerText('/補位 1 2 3')).toMatchObject({ extra: true });
  });

  it('leaves ordinary text alone', () => {
    for (const t of ['補位 1460', '/補位置', '/戰績 補位', 'hello', '/機器人', '']) {
      expect(parseSeatFillerText(t)).toBeNull();
      expect(isSeatFillerCommandText(t)).toBe(false);
    }
  });
});

describe('LINE replies', () => {
  it('success dispatches once with the exact wording', async () => {
    expect(await answerSeatFillerTextCommand('/補位 Room-1460')).toBe(SUCCESS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('format errors never dispatch', async () => {
    expect(await answerSeatFillerTextCommand('/補位')).toContain('用法：/補位 房號或房間描述');
    expect(await answerSeatFillerTextCommand('/補位 a"b')).toContain('房號或房間描述不對');
    expect(await answerSeatFillerTextCommand('/補位 1460 12')).toContain('人數要是 1–9');
    expect(await answerSeatFillerTextCommand('/補位 1460 1 1')).toContain('用法');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cooldown reply carries the remaining time', async () => {
    await answerSeatFillerTextCommand('/補位 1460');
    now += 50_000;
    expect(await answerSeatFillerTextCommand('/補位 1461')).toBe(
      '補位機器人剛被叫過，請 2 分 10 秒後再試（全站每 3 分鐘最多叫一次）。',
    );
  });

  it('same room within 15 minutes, daily cap, not configured, GitHub error', async () => {
    await answerSeatFillerTextCommand('/補位 1460');
    now += 4 * 60_000;
    expect(await answerSeatFillerTextCommand('/補位 Room-1460')).toBe(
      'Room-1460 在 15 分鐘內已經叫過補位機器人了，請 11 分鐘後再試。',
    );
    expect(formatSeatFillerOutcome({ kind: 'daily_cap', max: 10 })).toBe('今天的補位次數已經用完（每天最多 10 次，台北時間午夜重置）。');

    installDispatcher({});
    expect(await answerSeatFillerTextCommand('/補位 1460')).toBe('補位機器人還沒設定好（管理者尚未完成設定），暫時不能叫。');

    installDispatcher();
    status = 403;
    expect(await answerSeatFillerTextCommand('/補位 1460')).toBe('叫補位機器人失敗（GitHub 回應 403），請稍後再試或告訴管理者。');
  });

  it('a LINE redelivery is answered without a second dispatch', async () => {
    expect(await answerSeatFillerTextCommand('/補位 1460', 'line', { redelivery: true })).toBe(SEAT_FILLER_REDELIVERY_TEXT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formatWait', () => {
    expect(formatWait(45_000)).toBe('45 秒');
    expect(formatWait(44_001)).toBe('45 秒');
    expect(formatWait(120_000)).toBe('2 分鐘');
    expect(formatWait(125_000)).toBe('2 分 5 秒');
  });
});

describe('LINE webhook (1:1 chat)', () => {
  const SECRET = 'test-channel-secret';
  const originalStats = LINE_CONFIG.statsCommandsEnabled;
  const originalLegacy = LINE_CONFIG.commandsEnabled;
  beforeEach(() => {
    __resetChatMirrorForTests();
    LINE_CONFIG.statsCommandsEnabled = true;
    LINE_CONFIG.commandsEnabled = false;
  });
  afterEach(() => {
    LINE_CONFIG.statsCommandsEnabled = originalStats;
    LINE_CONFIG.commandsEnabled = originalLegacy;
  });

  function deliver(bot: LineBotClient, events: unknown[]): Promise<void> {
    const raw = JSON.stringify({ destination: 'U', events });
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
    const req = { get: (h: string) => (h === 'X-Line-Signature' ? sig : undefined), body: JSON.parse(raw), rawBody: Buffer.from(raw) } as unknown as Request;
    const res = { status() { return this; }, json() { return this; } } as unknown as Response;
    return bot.handleWebhook(req, res);
  }

  it('/補位 in a 1:1 chat replies once and dispatches once; a redelivery does not dispatch again', async () => {
    const replies: string[][] = [];
    const client = {
      replyMessage: async (_t: string, messages: { text: string }[]) => {
        replies.push(messages.map((m) => m.text));
        return {};
      },
    } as unknown as Client;
    const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client });
    const event = { type: 'message', replyToken: 'rt1', webhookEventId: 'ev1', source: { type: 'user', userId: 'U7' }, message: { type: 'text', id: 'm1', text: '/補位 Room-1460' } };
    await deliver(bot, [event]);
    expect(replies).toEqual([[SUCCESS]]);
    await deliver(bot, [{ ...event, replyToken: 'rt2', deliveryContext: { isRedelivery: true } }]);
    expect(replies[1]).toEqual([SEAT_FILLER_REDELIVERY_TEXT]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bot.getWebhookStats()).toMatchObject({ seatFillerReplies: 2, statsReplies: 0, simReplies: 0 });
  });
});

describe('Discord /機器人補位', () => {
  function interaction(room: string, bots: string | null, password: string | null = null) {
    const fake = {
      commandName: COMMANDS.SEAT_FILLER,
      options: {
        getString: (name: string) =>
          name === SEAT_FILLER_OPTIONS.ROOM ? room : name === SEAT_FILLER_OPTIONS.BOTS ? bots : name === SEAT_FILLER_OPTIONS.PASSWORD ? password : null,
      },
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };
    return fake;
  }

  it('is registered with a required room-or-description and optional 人數 / 密碼', () => {
    const json = buildSlashCommands().map((c) => c.toJSON());
    const cmd = json.find((c) => c.name === '機器人補位') as { options: { name: string; required?: boolean; choices?: { value: string }[] }[] };
    expect(cmd).toBeDefined();
    expect(cmd.options.map((o) => o.name)).toEqual(['房號或描述', '人數', '密碼']);
    expect(cmd.options[0].required).toBe(true);
    expect(cmd.options[1].required).toBe(false);
    expect(cmd.options[1].choices?.map((c) => c.value)).toEqual(['補滿', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(cmd.options[2].required).toBe(false);
  });

  it('success: public deferred reply with the dispatch result', async () => {
    const i = interaction('Room-1460', null);
    await handleSeatFillerCommand(i as never);
    expect(i.reply).not.toHaveBeenCalled();
    expect(i.deferReply).toHaveBeenCalledWith();
    expect(i.editReply).toHaveBeenCalledWith({ content: SUCCESS, allowedMentions: { parse: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('format error and limits: ephemeral, no dispatch', async () => {
    const bad = interaction('a"b', '1');
    await handleSeatFillerCommand(bad as never);
    expect(bad.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect((bad.reply.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain('房號或房間描述不對');

    await handleSeatFillerCommand(interaction('1460', '2') as never);
    const again = interaction('1461', '1');
    await handleSeatFillerCommand(again as never);
    expect((again.reply.mock.calls[0] as unknown as [{ content: string; flags: number }])[0]).toMatchObject({
      flags: MessageFlags.Ephemeral,
      content: expect.stringContaining('剛被叫過'),
    });
    expect(again.deferReply).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('not configured: ephemeral explanation', async () => {
    installDispatcher({});
    const i = interaction('1460', null);
    await handleSeatFillerCommand(i as never);
    expect((i.reply.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain('還沒設定好');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('help, topic counting, chat export', () => {
  it('help texts list the platform syntax', () => {
    expect(formatStatsHelp('line')).toContain('/補位 房號或房間描述');
    expect(formatStatsHelp('discord')).toContain('/機器人補位 房號或描述');
  });

  it('observe() does not count the command as a topic', () => {
    const svc = new FeedbackService({ logger: { warn: () => undefined, error: () => undefined } });
    expect(svc.observe('line', '/補位 Room-1460')).toEqual([]);
    expect(svc.observe('discord', '/機器人補位 1460 2')).toEqual([]);
  });

  it('chat export treats it as a typed command', () => {
    expect(isTypedCommand('/ 補位 1460')).toBe(true);
    expect(isTypedCommand('／機器人補位 Room-1460')).toBe(true);
  });
});
