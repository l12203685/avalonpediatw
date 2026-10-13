/**
 * Community feedback (2026-10-12) — the pure parts: ISO-week bucketing in
 * +08, keyword → topic counting with 8-week retention, /意見 parsing, the
 * forwarded line's format + 500-char cut, and FeedbackService.submit with a
 * mocked Discord sender. No network, no discord.js runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'util';
import {
  DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID,
  DEFAULT_TOPICS,
  FEEDBACK_ACK_TEXT,
  FEEDBACK_CONFIG,
  FEEDBACK_CONTENT_MAX_CHARS,
  FEEDBACK_USAGE_TEXT,
  FeedbackDiscordForwarder,
  FeedbackForwardPayload,
  FeedbackService,
  OPINION_TOPIC_ID,
  TopicCounter,
  describeError,
  formatFeedbackForward,
  isoWeekKey,
  matchTopics,
  parseFeedbackCommand,
  truncateFeedbackContent,
} from '../bots/feedback';

const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

describe('isoWeekKey (+08 ISO weeks)', () => {
  it('2026-10-12 (Monday) is 2026-W42', () => {
    expect(isoWeekKey(utc(2026, 10, 12, 4))).toBe('2026-W42');
  });

  it('bucketing follows the +08 date, not UTC: Sunday 23:59 +08 vs Monday 00:00 +08', () => {
    expect(isoWeekKey(utc(2026, 10, 11, 15, 59))).toBe('2026-W41'); // 2026-10-11 23:59 +08 (Sunday)
    expect(isoWeekKey(utc(2026, 10, 11, 16, 0))).toBe('2026-W42'); // 2026-10-12 00:00 +08 (Monday)
  });

  it('year boundaries follow ISO 8601 (the week belongs to its Thursday)', () => {
    expect(isoWeekKey(utc(2026, 1, 1, 4))).toBe('2026-W01'); // Thu 2026-01-01
    expect(isoWeekKey(utc(2027, 1, 1, 4))).toBe('2026-W53'); // Fri 2027-01-01 → 2026 has 53 weeks
    expect(isoWeekKey(utc(2024, 12, 30, 4))).toBe('2025-W01'); // Mon 2024-12-30 → W01 of 2025
    expect(isoWeekKey(utc(2021, 1, 3, 4))).toBe('2020-W53'); // Sun 2021-01-03
  });

  it('keys sort chronologically as strings', () => {
    const keys = [utc(2026, 12, 31), utc(2026, 1, 5), utc(2025, 12, 29), utc(2026, 10, 12)].map((t) => isoWeekKey(t));
    expect([...keys].sort()).toEqual(['2026-W01', '2026-W02', '2026-W42', '2026-W53']); // 2026-01-05 is the Monday of W02
  });
});

describe('matchTopics', () => {
  it('one hit per topic, in topic order, several topics per message', () => {
    expect(matchTopics('排行榜的排名怪怪的，戰績也錯了')).toEqual(['排行', '戰績', '問題']);
  });

  it('latin keywords match case-insensitively', () => {
    expect(matchTopics('這個 Bot 有 BUG')).toEqual(['機器人', '問題']);
  });

  it('counts nothing for unrelated chatter or empty text', () => {
    expect(matchTopics('今晚八點開局')).toEqual([]);
    expect(matchTopics('')).toEqual([]);
  });

  it('the 意見 topic has no keywords — only the command bumps it', () => {
    expect(DEFAULT_TOPICS.find((t) => t.id === OPINION_TOPIC_ID)?.keywords).toEqual([]);
    expect(matchTopics('我有意見')).not.toContain(OPINION_TOPIC_ID);
  });

  it('praise containing 不錯 (and the agreement 沒錯) is not a 問題', () => {
    expect(matchTopics('這網站不錯')).toEqual(['網站', '稱讚']);
    expect(matchTopics('排行榜不錯')).toEqual(['排行', '稱讚']);
    expect(matchTopics('沒錯')).toEqual([]);
    // Another 錯 / 壞 in the same sentence still counts.
    expect(matchTopics('不錯，但排行錯了')).toEqual(['排行', '問題', '稱讚']);
    expect(matchTopics('沒錯，戰績壞了')).toEqual(['戰績', '問題']);
  });
});

describe('TopicCounter', () => {
  it('buckets per ISO week and per platform; a message counts ≤1 per topic', () => {
    const c = new TopicCounter();
    const w42 = utc(2026, 10, 13, 4);
    c.observe('line', '排行 排行 排名', w42);
    c.observe('line', '網站好用', w42);
    c.observe('discord', '湖中 湖', w42);
    c.observe('discord', '刺殺', utc(2026, 10, 20, 4)); // W43

    const snap = c.snapshot();
    expect(snap.map((w) => w.week)).toEqual(['2026-W42', '2026-W43']);
    expect(snap[0].line).toMatchObject({ 排行: 1, 網站: 1, 稱讚: 1, 湖: 0 });
    expect(snap[0].discord).toMatchObject({ 湖: 1, 排行: 0 });
    expect(snap[1].discord).toMatchObject({ 刺殺: 1 });
    expect(snap[1].line.刺殺).toBe(0);
    // Every topic is present as a number — the status page needs a stable table.
    for (const w of snap) {
      expect(Object.keys(w.line)).toEqual(DEFAULT_TOPICS.map((t) => t.id));
      expect(Object.values(w.discord).every((n) => Number.isInteger(n))).toBe(true);
    }
  });

  it('keeps only the newest 8 weeks', () => {
    const c = new TopicCounter();
    for (let i = 0; i < 10; i++) c.observe('line', '排行', utc(2026, 1, 5, 4) + i * 7 * 24 * 60 * 60 * 1000);
    const weeks = c.snapshot().map((w) => w.week);
    expect(weeks).toHaveLength(8);
    expect(weeks[0]).toBe('2026-W04'); // W02 and W03 were pruned
    expect(weeks[7]).toBe('2026-W11');
  });

  it('bump() increments an explicit topic and ignores unknown ids', () => {
    const c = new TopicCounter();
    c.bump('discord', OPINION_TOPIC_ID, utc(2026, 10, 13, 4));
    c.bump('discord', '不存在的主題', utc(2026, 10, 13, 4));
    const [w] = c.snapshot();
    expect(w.discord[OPINION_TOPIC_ID]).toBe(1);
    expect(w.discord).not.toHaveProperty('不存在的主題');
  });
});

describe('parseFeedbackCommand', () => {
  it.each([
    ['/意見 排行榜希望加上場次', '排行榜希望加上場次'],
    ['／意見 排行榜希望加上場次', '排行榜希望加上場次'],
    ['/意見排行壞了', '排行壞了'],
    ['  /意見   多個空白  ', '多個空白'],
    ['/意見', ''],
    ['／意見   ', ''],
  ])('%s → content %j', (text, content) => {
    expect(parseFeedbackCommand(text)).toEqual({ content });
  });

  it('is not triggered by other commands or chatter', () => {
    for (const t of ['/戰績 HAO', '意見 沒有斜線', '/help', '大家好', '']) expect(parseFeedbackCommand(t)).toBeNull();
  });
});

describe('formatFeedbackForward', () => {
  it('names the platform, never a person', () => {
    expect(formatFeedbackForward('line', '排行榜希望加上場次')).toBe('📮 意見（LINE）：排行榜希望加上場次');
    expect(formatFeedbackForward('discord', '  好用  ')).toBe('📮 意見（Discord）：好用');
  });

  it('cuts the content to 500 characters (code points) ending with …', () => {
    const long = '字'.repeat(FEEDBACK_CONTENT_MAX_CHARS + 40);
    const out = formatFeedbackForward('line', long);
    const body = out.slice('📮 意見（LINE）：'.length);
    expect(Array.from(body)).toHaveLength(FEEDBACK_CONTENT_MAX_CHARS);
    expect(body.endsWith('…')).toBe(true);
    // Exactly 500 is kept untouched; emoji are not split in half.
    expect(truncateFeedbackContent('字'.repeat(500))).toBe('字'.repeat(500));
    expect(truncateFeedbackContent('😀'.repeat(501)).endsWith('😀…')).toBe(true);
  });
});

// ─── FeedbackService.submit ───────────────────────────────────────────────

interface Sent {
  channelId: string;
  payload: FeedbackForwardPayload;
}

function mockForwarder(opts: { ok?: boolean; throws?: boolean } = {}): { forwarder: FeedbackDiscordForwarder; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    forwarder: {
      send: async (channelId, payload) => {
        if (opts.throws) throw new Error('gateway down');
        sent.push({ channelId, payload });
        return opts.ok ?? true;
      },
    },
  };
}

const silent = { warn: vi.fn(), error: vi.fn() };

describe('FeedbackService.submit', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.FEEDBACK_DISCORD_CHANNEL_ID;
    delete process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('forwards to FEEDBACK_DISCORD_CHANNEL_ID with no mentions allowed, counts the opinion and its topics', async () => {
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-feedback';
    process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID = 'C-mirror';
    const { forwarder, sent } = mockForwarder();
    const svc = new FeedbackService({ discord: forwarder, logger: silent, now: () => utc(2026, 10, 13, 4) });

    const r = await svc.submit('line', '排行榜希望加上場次 @everyone');
    expect(r).toMatchObject({ accepted: true, reply: FEEDBACK_ACK_TEXT });
    expect(await r.forwarded).toBe('sent');
    expect(sent).toEqual([
      { channelId: 'C-feedback', payload: { content: '📮 意見（LINE）：排行榜希望加上場次 @everyone', allowedMentions: { parse: [] } } },
    ]);

    const snap = svc.snapshot();
    expect(snap.opinions).toEqual({ line: 1, discord: 0 });
    expect(snap.weeks).toHaveLength(1);
    expect(snap.weeks[0].week).toBe('2026-W42');
    expect(snap.weeks[0].line).toMatchObject({ [OPINION_TOPIC_ID]: 1, 排行: 1, 建議: 1 });
  });

  it('FEEDBACK_DISCORD_CHANNEL_ID unset → the admin channel 大劍管理員, never the public lobby mirror channel', async () => {
    process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID = 'C-mirror';
    const { forwarder, sent } = mockForwarder();
    const svc = new FeedbackService({ discord: forwarder, logger: silent });
    const r = await svc.submit('discord', 'bot 很讚');
    expect(r).toMatchObject({ accepted: true, reply: FEEDBACK_ACK_TEXT });
    expect(await r.forwarded).toBe('sent');
    expect(sent.map((x) => x.channelId)).toEqual([DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID]);
    expect(svc.snapshot().opinions.discord).toBe(1);
  });

  it('still acknowledges (and counts) when forwarding is off (FEEDBACK_DISCORD_CHANNEL_ID=off) or Discord fails', async () => {
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'off';
    const { forwarder, sent } = mockForwarder();
    const none = new FeedbackService({ discord: forwarder, logger: silent });
    const r0 = await none.submit('line', '沒有頻道');
    expect(r0).toMatchObject({ accepted: true, reply: FEEDBACK_ACK_TEXT });
    expect(await r0.forwarded).toBe('skipped');
    expect(sent).toEqual([]);
    expect(none.snapshot().opinions.line).toBe(1);

    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-feedback';
    const unavailable = new FeedbackService({ discord: mockForwarder({ ok: false }).forwarder, logger: silent });
    expect(await (await unavailable.submit('line', 'x')).forwarded).toBe('failed');
    const throwing = new FeedbackService({ discord: mockForwarder({ throws: true }).forwarder, logger: silent });
    const r2 = await throwing.submit('discord', 'y');
    expect(r2).toMatchObject({ accepted: true, reply: FEEDBACK_ACK_TEXT });
    expect(await r2.forwarded).toBe('failed');
    // Nothing the person typed ends up in the log line (any argument).
    expect(inspect([...silent.warn.mock.calls, ...silent.error.mock.calls], { depth: 10 })).not.toMatch(/沒有頻道|'x'|'y'/);
  });

  it('empty content → usage hint, nothing counted or forwarded', async () => {
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-feedback';
    const { forwarder, sent } = mockForwarder();
    const svc = new FeedbackService({ discord: forwarder, logger: silent });
    const r = await svc.submit('line', '   ');
    expect(r).toMatchObject({ accepted: false, reply: FEEDBACK_USAGE_TEXT });
    expect(await r.forwarded).toBe('none');
    expect(sent).toEqual([]);
    expect(svc.snapshot()).toEqual({ weeks: [], opinions: { line: 0, discord: 0 } });
  });

  it('caps forwards per rolling hour (ack and counts continue)', async () => {
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-feedback';
    let now = utc(2026, 10, 13, 4);
    const { forwarder, sent } = mockForwarder();
    const svc = new FeedbackService({ discord: forwarder, logger: silent, maxForwardsPerHour: 2, now: () => now });
    expect(await (await svc.submit('line', '1')).forwarded).toBe('sent');
    expect(await (await svc.submit('line', '2')).forwarded).toBe('sent');
    const r3 = await svc.submit('line', '3');
    expect(r3).toMatchObject({ accepted: true, reply: FEEDBACK_ACK_TEXT });
    expect(await r3.forwarded).toBe('throttled');
    expect(sent).toHaveLength(2);
    expect(svc.snapshot().opinions.line).toBe(3);
    now += 61 * 60 * 1000;
    expect(await (await svc.submit('line', '4')).forwarded).toBe('sent');
  });

  it('a forward that returns false or throws gives its hourly slot back (a Discord outage cannot lock the next hour)', async () => {
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-feedback';
    let mode: 'ok' | 'unavailable' | 'throw' = 'unavailable';
    const sent: Sent[] = [];
    const forwarder: FeedbackDiscordForwarder = {
      send: async (channelId, payload) => {
        if (mode === 'throw') throw new Error('gateway down');
        if (mode === 'unavailable') return false;
        sent.push({ channelId, payload });
        return true;
      },
    };
    const svc = new FeedbackService({ discord: forwarder, logger: silent, maxForwardsPerHour: 1 });
    expect(await (await svc.submit('line', 'a')).forwarded).toBe('failed');
    mode = 'throw';
    expect(await (await svc.submit('line', 'b')).forwarded).toBe('failed');
    mode = 'ok';
    expect(await (await svc.submit('line', 'c')).forwarded).toBe('sent');
    expect(await (await svc.submit('line', 'd')).forwarded).toBe('throttled');
    expect(sent.map((s) => s.payload.content)).toEqual(['📮 意見（LINE）：c']);
    expect(svc.snapshot().opinions.line).toBe(4);
  });

  it('the reply never waits for Discord: submit resolves while the send is still pending', async () => {
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-feedback';
    let release: (ok: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const svc = new FeedbackService({ discord: { send: () => gate }, logger: silent });

    const r = await svc.submit('line', '排行壞了');
    expect(r).toMatchObject({ accepted: true, reply: FEEDBACK_ACK_TEXT });
    expect(svc.snapshot().opinions.line).toBe(1);

    let settled: string | null = null;
    void r.forwarded.then((o) => {
      settled = o;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeNull();

    release(true);
    expect(await r.forwarded).toBe('sent');
  });

  it('a Discord API error carrying the request body never reaches the log (default and injected logger)', async () => {
    process.env.FEEDBACK_DISCORD_CHANNEL_ID = 'C-feedback';
    const secret = '這句意見不可以出現在log';
    // Shape of discord.js' DiscordAPIError: own enumerable requestBody = { files, json: body }.
    class FakeDiscordAPIError extends Error {
      code = 50013;
      status = 403;
      method = 'POST';
      requestBody = { files: undefined, json: { content: `📮 意見（LINE）：${secret}`, allowed_mentions: { parse: [] } } };
      rawError = { message: 'Missing Permissions', code: 50013 };
      constructor() {
        super('Missing Permissions');
        this.name = 'DiscordAPIError[50013]';
      }
    }
    const forwarder: FeedbackDiscordForwarder = {
      send: async () => {
        throw new FakeDiscordAPIError();
      },
    };

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const svc = new FeedbackService({ discord: forwarder }); // production wiring: default logger
      expect(await (await svc.submit('line', secret)).forwarded).toBe('failed');
      const printed = inspect([...consoleError.mock.calls, ...consoleWarn.mock.calls], { depth: 10 });
      expect(printed).not.toContain(secret);
      expect(printed).toContain('DiscordAPIError[50013]');
      expect(printed).toContain('code=50013');
      expect(printed).toContain('status=403');
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }

    const custom = { warn: vi.fn(), error: vi.fn() };
    const svc2 = new FeedbackService({ discord: forwarder, logger: custom });
    expect(await (await svc2.submit('discord', secret)).forwarded).toBe('failed');
    expect(inspect([...custom.warn.mock.calls, ...custom.error.mock.calls], { depth: 10 })).not.toContain(secret);
  });
});

describe('describeError', () => {
  it('keeps name / code / status / message only, never other properties', () => {
    const err = Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403, requestBody: { json: { content: '原文' } } });
    const out = describeError(err);
    expect(out).toBe('Error code=50013 status=403 Missing Permissions');
    expect(out).not.toContain('原文');
    expect(describeError(null)).toBe('object');
    expect(describeError('boom')).toBe('string');
    expect(describeError(new Error('x'.repeat(500)))).toHaveLength('Error '.length + 200);
  });
});

describe('FeedbackService.observe', () => {
  const original = FEEDBACK_CONFIG.commandEnabled;
  afterEach(() => {
    FEEDBACK_CONFIG.commandEnabled = original;
  });

  it('skips the stats commands on both platforms — usage is not a reaction', () => {
    const svc = new FeedbackService({ logger: silent });
    for (const t of ['/排行', '／排行榜', '/戰績 HAO', '/默契 A B', '/指令']) {
      expect(svc.observe('line', t)).toEqual([]);
      expect(svc.observe('discord', t)).toEqual([]);
    }
    expect(svc.snapshot().weeks).toEqual([]);
    expect(svc.observe('line', '排行壞了')).toEqual(['排行', '問題']);
  });

  it('a typed /意見 is left to submit() on LINE, but is ordinary chatter on Discord (only the slash command submits)', () => {
    FEEDBACK_CONFIG.commandEnabled = true;
    const svc = new FeedbackService({ logger: silent });
    expect(svc.observe('line', '/意見 排行壞了')).toEqual([]);
    expect(svc.observe('discord', '／意見 排行壞了')).toEqual(['排行', '問題']);
    expect(svc.observe('discord', '/ 意見 排行壞了')).toEqual(['排行', '問題']);
    const [w] = svc.snapshot().weeks;
    expect(w.line).toMatchObject({ 排行: 0, 問題: 0, [OPINION_TOPIC_ID]: 0 });
    expect(w.discord).toMatchObject({ 排行: 2, 問題: 2, [OPINION_TOPIC_ID]: 0 });
    expect(svc.snapshot().opinions).toEqual({ line: 0, discord: 0 });
  });

  it('with the command off a typed /意見 is chatter on both platforms', () => {
    FEEDBACK_CONFIG.commandEnabled = false;
    const svc = new FeedbackService({ logger: silent });
    expect(svc.observe('line', '/意見 排行壞了')).toEqual(['排行', '問題']);
    expect(svc.observe('discord', '/意見 排行壞了')).toEqual(['排行', '問題']);
  });
});
