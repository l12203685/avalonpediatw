/**
 * Daily chat-log export — the pure parts:
 *
 *   rows    — relay parsing (LINE / lobby / legacy), bot / webhook / system /
 *             command / attachment-only exclusion, per-day pseudonyms (no
 *             names or ids in the rows), mention rewriting, long-message
 *             clipping, one row per message in time order with the six
 *             columns 日期 / 時間（+08） / 頻道 / 來源 / 發言者代號 / 內容,
 *             forum threads shown as 「論壇名／貼文標題」
 *   window  — the day window across +08 midnight, the 04:30 run time, the
 *             last 7 complete days, the oldest day kept
 *   config  — defaults (the 阿瓦隆百科 sheet, publicSheet), CHAT_EXPORT_*
 *             and the old COMMUNITY_DIGEST_* names, 大劍管理員 always
 *             excluded, CHAT_EXPORT_ALLOW_PUBLIC_SHEET=0 (or any value that
 *             is not a yes) refuses the public stats sheet, the private
 *             sheet still chosen with CHAT_EXPORT_SHEET_ID
 */
import { describe, expect, it } from 'vitest';

import {
  SOURCE_LABEL,
  buildExportRows,
  classifyMessage,
  clipMessageText,
  isTypedCommand,
  maskRelayMediaLinks,
  parseRelayLine,
  type ChatChannel,
  type RawChatMessage,
} from '../bots/chatExport/rows';
import {
  dayWindow,
  isChatExportRunTime,
  isDayKey,
  lastCompleteDays,
  oldestKeptDay,
  previousDay,
  taipeiIso,
  taipeiMidnight,
  taipeiStamp,
} from '../bots/chatExport/window';
import { formatOutgoingUnified, formatOutgoingLegacy } from '../bots/ChatMirror';
import {
  AVALONPEDIA_DISCORD_GUILD_ID,
  CHAT_EXPORT_HEADER,
  CHAT_EXPORT_LOG_HEADER,
  CHAT_EXPORT_LOG_TAB,
  CHAT_EXPORT_RETAIN_DAYS,
  CHAT_EXPORT_TAB,
  DEFAULT_CHAT_EXPORT_SHEET_ID,
  PRIVATE_CHAT_EXPORT_SHEET_ID,
  PUBLIC_STATS_SHEET_ID,
  STATS_WORKBOOK_TABS,
  readChatExportConfig,
  spreadsheetIdFrom,
} from '../bots/chatExport/config';
import { DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID } from '../bots/feedback/config';
import { parseFeedbackCommand } from '../bots/feedback/commands';

const SELF = 'bot-self';
const MIRROR = '1132901301802504242';
const GENERAL = '2000000000000000001';
const T0 = Date.parse('2026-10-06T12:00:00Z'); // Tue 20:00 +08
const DAY = '2026-10-06';

const channels: ChatChannel[] = [
  { id: MIRROR, name: '阿瓦隆同步', isMirror: true },
  { id: GENERAL, name: '一般聊天', isMirror: false },
];

let seq = 0;
function msg(over: Partial<RawChatMessage>): RawChatMessage {
  seq += 1;
  return {
    id: String(3_000_000_000_000_000_000n + BigInt(seq)),
    channelId: GENERAL,
    createdAt: T0 + seq * 60_000,
    authorId: 'u-alice',
    authorIsBot: false,
    authorIsSelf: false,
    webhookId: null,
    system: false,
    content: '',
    attachmentCount: 0,
    ...over,
  };
}

/** A LINE line exactly as ChatMirror relays it into Discord (authored by the bot). */
function lineRelay(name: string, text: string, at: number): RawChatMessage {
  const content = formatOutgoingUnified({ id: 'x', playerId: 'line:u', playerName: name, message: text, timestamp: at, source: 'line' });
  return msg({ channelId: MIRROR, authorId: SELF, authorIsBot: true, authorIsSelf: true, content, createdAt: at });
}

describe('relay parsing (how LINE shows up in Discord)', () => {
  it('reads the unified ChatMirror format for LINE, lobby and DC echoes', () => {
    const at = Date.parse('2026-10-05T13:35:00Z');
    const line = formatOutgoingUnified({ id: '1', playerId: 'line:u1', playerName: '小明', message: '我也看到了', timestamp: at, source: 'line' });
    expect(line).toBe('[1005 21:35][LINE][小明] 我也看到了');
    expect(parseRelayLine(line)).toEqual({ tag: 'LINE', name: '小明', body: '我也看到了' });
    const lobby = formatOutgoingUnified({ id: '2', playerId: 'p', playerName: '阿華', message: '網站看得到', timestamp: at, source: 'lobby' });
    expect(parseRelayLine(lobby)).toEqual({ tag: 'AP', name: '阿華', body: '網站看得到' });
    expect(parseRelayLine('[1005 21:35][DC][Bob] hi')?.tag).toBe('DC');
    const legacy = formatOutgoingLegacy({ id: '3', playerId: 'p', playerName: 'Ann', message: 'old: style', timestamp: at });
    expect(parseRelayLine(legacy)).toEqual({ tag: 'legacy', name: 'Ann', body: 'old: style' });
    expect(parseRelayLine('[1005 21:35][LINE][小明]')).toEqual({ tag: 'LINE', name: '小明', body: '' }); // Discord trims the trailing space
    expect(parseRelayLine('📊 本週排行 Top 10')).toBeNull();
    expect(parseRelayLine('📮 意見（LINE）：排行希望加場次')).toBeNull();
  });

  it('a LINE name containing "]" stays whole (no name leaks into the body, no merged speakers)', () => {
    const at = T0;
    const a = formatOutgoingUnified({ id: '1', playerId: 'line:a', playerName: '[TW]小明', message: '今天打嗎', timestamp: at, source: 'line' });
    expect(parseRelayLine(a)).toEqual({ tag: 'LINE', name: '[TW]小明', body: '今天打嗎' });
    expect(parseRelayLine('[1005 21:35][LINE][小明]] hi')).toEqual({ tag: 'LINE', name: '小明]', body: 'hi' });
    expect(parseRelayLine('[1005 21:35][LINE][A]B] hello')).toEqual({ tag: 'LINE', name: 'A]B', body: 'hello' });
    // A body that itself contains "] " is untouched.
    expect(parseRelayLine('[1005 21:35][LINE][小明] [規則] 湖中可以驗自己嗎')).toEqual({ tag: 'LINE', name: '小明', body: '[規則] 湖中可以驗自己嗎' });
    const t = buildExportRows([lineRelay('[TW]小明', '今天打嗎', at + 1000), lineRelay('[TW]阿華', '我可以', at + 2000)], channels, DAY);
    expect(t.speakers).toBe(2);
    expect(t.rows.map((r) => [r[3], r[4], r[5]])).toEqual([
      ['LINE', '成員1', '今天打嗎'],
      ['LINE', '成員2', '我可以'],
    ]);
    for (const leaked of ['小明', '阿華', '[TW']) expect(JSON.stringify(t.rows)).not.toContain(leaked);
  });

  it('keeps relayed LINE / lobby lines with their own speaker; skips the bot’s other posts, DC echoes and system notices', () => {
    const at = T0;
    expect(classifyMessage(lineRelay('小明', '排行壞了', at))).toMatchObject({ kind: 'keep', platform: 'line', speakerKey: 'line:小明', text: '排行壞了' });
    const lobby = msg({ authorIsBot: true, authorIsSelf: true, content: '[1006 20:01][AP][阿華] 網站好用' });
    expect(classifyMessage(lobby)).toMatchObject({ kind: 'keep', platform: 'lobby', speakerKey: 'lobby:阿華' });
    expect(classifyMessage(msg({ authorIsBot: true, authorIsSelf: true, content: '[1006 20:01][AP][system] 有人加入' }))).toMatchObject({ kind: 'skip', reason: 'system' });
    expect(classifyMessage(msg({ authorIsBot: true, authorIsSelf: true, content: '[1006 20:01][DC][Bob] hi' }))).toMatchObject({ kind: 'skip', reason: 'relay-echo' });
    // The bot's own non-relay posts: weekly stats digest, command replies, /意見 forwards.
    for (const content of ['📊 本週排行（10/12）', '📮 意見（Discord）：加場次', '🎲 對局已改到 signage-cloud']) {
      expect(classifyMessage(msg({ authorIsBot: true, authorIsSelf: true, content }))).toMatchObject({ kind: 'skip', reason: 'bot' });
    }
    // Another bot posting something relay-shaped is still another bot.
    expect(classifyMessage(msg({ authorIsBot: true, content: '[1006 20:01][LINE][x] y' }))).toMatchObject({ kind: 'skip', reason: 'bot' });
  });

  it('skips webhooks, system messages, typed commands (also relayed from LINE) and empty messages; counts attachment-only ones', () => {
    expect(classifyMessage(msg({ webhookId: 'wh', content: '網站回饋表單' }))).toMatchObject({ kind: 'skip', reason: 'webhook' });
    expect(classifyMessage(msg({ system: true, content: '' }))).toMatchObject({ kind: 'skip', reason: 'system' });
    expect(classifyMessage(msg({ content: '/戰績 小明' }))).toMatchObject({ kind: 'skip', reason: 'command' });
    expect(classifyMessage(msg({ content: '／意見 加場次' }))).toMatchObject({ kind: 'skip', reason: 'command' });
    expect(classifyMessage(lineRelay('小明', '/排行', T0))).toMatchObject({ kind: 'skip', reason: 'command' });
    expect(classifyMessage(msg({ content: '   ' }))).toMatchObject({ kind: 'skip', reason: 'empty' });
    expect(classifyMessage(msg({ content: '', attachmentCount: 2 }))).toMatchObject({ kind: 'skip', reason: 'attachment-only', attachments: 2 });
    expect(isTypedCommand('/ 笑死')).toBe(false);
    expect(isTypedCommand('!avalon help')).toBe(true);
    expect(isTypedCommand('https://example.org')).toBe(false);
  });

  it('every /意見 form the /意見 parser forwards privately is skipped too — spaces, a full-width space or a newline after the slash', () => {
    for (const text of ['/ 意見 排行想加場次', '／　意見 排行想加場次', '/\n意見 排行想加場次', '／ \t 意見']) {
      expect(parseFeedbackCommand(text)).not.toBeNull(); // forwarded to 大劍管理員 as an opinion …
      expect(isTypedCommand(text)).toBe(true); // … so never in the sheet
      expect(classifyMessage(msg({ content: text }))).toMatchObject({ kind: 'skip', reason: 'command' });
      expect(classifyMessage(lineRelay('小明', text, T0))).toMatchObject({ kind: 'skip', reason: 'command' });
    }
    // The stats commands the LINE parser accepts with a space are commands as well.
    expect(isTypedCommand('/ 戰績 小明')).toBe(true);
    expect(isTypedCommand('／ 排行')).toBe(true);
    // A slash, a space and ordinary words stay conversation.
    expect(isTypedCommand('/ 我覺得意見不錯')).toBe(false);
  });
});

describe('buildExportRows', () => {
  const at = (min: number): number => T0 + min * 60_000;
  const messages = (): RawChatMessage[] => [
    msg({ createdAt: at(1), authorId: '111111111111111111', content: '這週排行怎麼沒更新 <@222222222222222222> 你知道嗎 <#2000000000000000001> <:pepe:123456> <@&555>' }),
    lineRelay('小明', '我也看到了', at(3)),
    msg({ createdAt: at(4), authorId: '222222222222222222', content: '應該是快取\n明天再看', attachmentCount: 1 }),
    msg({ createdAt: at(5), authorId: '111111111111111111', content: '好' }),
    msg({ createdAt: at(6), authorIsBot: true, authorIsSelf: true, content: '📊 本週排行' }),
    msg({ createdAt: at(7), content: '/戰績 小明' }),
    msg({ createdAt: at(8), content: '', attachmentCount: 3 }),
    msg({ createdAt: at(9), webhookId: 'w', content: 'webhook' }),
    msg({ createdAt: at(10), channelId: MIRROR, authorIsBot: true, authorIsSelf: true, content: '[1006 20:10][AP][阿華] 網站好用' }),
  ];

  it('one six-column row per conversation message, oldest first, no names or ids', () => {
    const t = buildExportRows(messages().reverse(), channels, DAY); // input order does not matter
    expect(t.rows).toEqual([
      [DAY, '2026-10-06 20:01', '一般聊天', 'Discord', '成員1', '這週排行怎麼沒更新 @成員2 你知道嗎 #一般聊天 :pepe: @某身分組'],
      [DAY, '2026-10-06 20:03', '阿瓦隆同步', 'LINE', '成員3', '我也看到了'],
      [DAY, '2026-10-06 20:04', '一般聊天', 'Discord', '成員2', '應該是快取 ⏎ 明天再看〔附件 1〕'],
      [DAY, '2026-10-06 20:05', '一般聊天', 'Discord', '成員1', '好'],
      [DAY, '2026-10-06 20:10', '阿瓦隆同步', '網站', '成員4', '網站好用'],
    ]);
    for (const row of t.rows) expect(row).toHaveLength(CHAT_EXPORT_HEADER.length);
    expect(t.channels).toBe(2);
    expect(t.speakers).toBe(4);
    expect(t.skipped).toMatchObject({ bot: 1, command: 1, 'attachment-only': 1, webhook: 1 });
    expect(t.byPlatform).toEqual({ discord: 3, line: 1, lobby: 1, relay: 0 });
    // Pseudonymized: no LINE name, no Discord id, no bot posts, no commands.
    const all = JSON.stringify(t.rows);
    for (const leaked of ['小明', '阿華', '111111111111111111', '222222222222222222', 'u-alice', '📊', '/戰績', 'webhook', '<@']) {
      expect(all).not.toContain(leaked);
    }
  });

  it('the 來源 column is Discord / LINE / 網站 (and 同步 for the legacy relay format)', () => {
    expect(SOURCE_LABEL).toEqual({ discord: 'Discord', line: 'LINE', lobby: '網站', relay: '同步' });
    const legacy = formatOutgoingLegacy({ id: '3', playerId: 'p', playerName: 'Ann', message: '舊格式', timestamp: T0 });
    const t = buildExportRows([msg({ channelId: MIRROR, authorIsBot: true, authorIsSelf: true, content: legacy })], channels, DAY);
    expect(t.rows[0].slice(3)).toEqual(['同步', '成員1', '舊格式']);
  });

  it('times are +08 regardless of host TZ; the 日期 column is the given day', () => {
    const late = Date.parse('2026-10-05T16:30:00Z'); // 10/06 00:30 +08
    const t = buildExportRows([msg({ content: '半夜還在打', createdAt: late })], channels, DAY);
    expect(t.rows[0].slice(0, 2)).toEqual([DAY, '2026-10-06 00:30']);
  });

  it('a forum thread is shown as 「論壇名／貼文標題」 and counted as a thread', () => {
    const thread = '3333333333333333333';
    const chans: ChatChannel[] = [...channels, { id: thread, name: '討論區／湖中規則', isMirror: false, isThread: true }];
    const t = buildExportRows(
      [msg({ channelId: thread, content: '同意' }), msg({ channelId: thread, content: '+1' }), msg({ content: '一般' })],
      chans,
      DAY,
    );
    expect(t.rows.map((r) => r[2])).toEqual(['討論區／湖中規則', '討論區／湖中規則', '一般聊天']);
    expect(t.channels).toBe(2);
    expect(t.threads).toBe(1);
  });

  it('pseudonyms are per export (per day): the same speaker keeps one label; LINE and Discord namesakes stay distinct', () => {
    const t = buildExportRows(
      [
        msg({ createdAt: T0 + 1_000, authorId: 'd-1', content: 'a' }),
        lineRelay('d-1', 'b', T0 + 2_000),
        msg({ createdAt: T0 + 3_000, authorId: 'd-1', content: 'c' }),
      ],
      channels,
      DAY,
    );
    expect(t.rows.map((r) => r[4])).toEqual(['成員1', '成員2', '成員1']);
    // The next day's export starts numbering again: the labels do not link days together.
    const next = buildExportRows([lineRelay('d-1', 'x', T0 + 9_000)], channels, '2026-10-07');
    expect(next.rows[0][4]).toBe('成員1');
  });

  it('a message read twice is exported once; an unknown channel is shown as 某頻道', () => {
    const m = msg({ channelId: '9999999999999999999', content: 'hi' });
    const t = buildExportRows([m, { ...m }], channels, DAY);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][2]).toBe('某頻道');
  });

  it('formula-looking text stays as typed (the sheet is written with RAW input)', () => {
    const t = buildExportRows([msg({ content: '=HYPERLINK("x")' })], channels, DAY);
    expect(t.rows[0][5]).toBe('=HYPERLINK("x")');
  });

  it('a link to the server’s picture relay (/media/relay/…) never reaches the sheet; other links stay', () => {
    const relay = 'https://example.onrender.com/media/relay/AbCdEf0123456789AbCdEf0123456789.jpg';
    expect(maskRelayMediaLinks(`看這張 ${relay} 對吧`)).toBe('看這張 〔圖片連結〕 對吧');
    const t = buildExportRows(
      [msg({ content: `圖 ${relay}` }), lineRelay('小明', `轉貼 ${relay.replace('https', 'HTTP')}`, T0 + 60_000), msg({ content: 'https://example.com/page' })],
      channels,
      DAY,
    );
    expect(t.rows.map((r) => r[5]).sort()).toEqual(['https://example.com/page', '圖 〔圖片連結〕', '轉貼 〔圖片連結〕'].sort());
    expect(JSON.stringify(t.rows)).not.toContain('/media/relay/');
  });

  it('relay links are masked in every spelling: no scheme, "/./" segments, full-width letters, an encoded slash, inside <…>', () => {
    const id = 'AbCdEf0123456789AbCdEf0123456789';
    for (const link of [
      `example.onrender.com/media/relay/${id}.jpg`,
      `https://example.onrender.com/media/./relay/${id}.jpg`,
      `https://example.onrender.com/media/././relay/${id}.png`,
      `ｈｔｔｐｓ：／／example.onrender.com／media／relay／${id}.jpg`,
      `https://example.onrender.com/media%2Frelay%2F${id}.jpg`,
      `<https://example.onrender.com/media/relay/${id}.jpg>`,
      `看這張https://example.onrender.com/media/relay/${id}.jpg`,
    ]) {
      const out = maskRelayMediaLinks(`前 ${link} 後`);
      expect(out).toContain('〔圖片連結〕');
      expect(out).not.toContain(id);
      expect(out.startsWith('前 ')).toBe(true);
      expect(out.endsWith(' 後')).toBe(true);
    }
    expect(maskRelayMediaLinks('https://example.com/media/photos/relayed.jpg')).toBe('https://example.com/media/photos/relayed.jpg');
  });

  it('clips one long message to 4000 characters', () => {
    expect(Array.from(clipMessageText('長'.repeat(5000)))).toHaveLength(4000 + '…（後略）'.length);
    expect(clipMessageText('短')).toBe('短');
    expect(clipMessageText('a\r\n  b')).toBe('a ⏎ b');
  });

  it('nothing to export → no rows', () => {
    const t = buildExportRows([msg({ content: '/排行' }), msg({ content: '', attachmentCount: 1 })], channels, DAY);
    expect(t.rows).toEqual([]);
    expect(t.channels).toBe(0);
    expect(t.skipped['attachment-only']).toBe(1);
  });
});

describe('window (+08)', () => {
  it('a day is 00:00 → 24:00 +08, whatever the host TZ (UTC 16:00 is the +08 midnight)', () => {
    const w = dayWindow('2026-10-12');
    expect(new Date(w.start).toISOString()).toBe('2026-10-11T16:00:00.000Z');
    expect(new Date(w.end).toISOString()).toBe('2026-10-12T16:00:00.000Z');
    expect(w.dayKey).toBe('2026-10-12');
    // Across the year end too.
    expect(new Date(dayWindow('2027-01-01').start).toISOString()).toBe('2026-12-31T16:00:00.000Z');
  });

  it('the previous day just after +08 midnight is the day that just ended (not the UTC date)', () => {
    // 00:05 +08 on 10/13 is still 10/12 in UTC.
    const justAfter = Date.parse('2026-10-12T16:05:00Z');
    expect(previousDay(justAfter).dayKey).toBe('2026-10-12');
    expect(previousDay(Date.parse('2026-10-12T15:59:59Z')).dayKey).toBe('2026-10-11'); // 23:59:59 +08 on 10/12
    expect(new Date(taipeiMidnight(justAfter)).toISOString()).toBe('2026-10-12T16:00:00.000Z');
    expect(previousDay(Date.parse('2027-01-01T00:00:00Z')).dayKey).toBe('2026-12-31'); // 08:00 +08 on New Year's Day
  });

  it('a message at 23:59:59 +08 belongs to that day, one at 00:00:00 +08 to the next', () => {
    const w = dayWindow('2026-10-12');
    const last = Date.parse('2026-10-12T15:59:59.999Z');
    const next = Date.parse('2026-10-12T16:00:00.000Z');
    expect(last >= w.start && last < w.end).toBe(true);
    expect(next >= w.start && next < w.end).toBe(false);
    expect(taipeiStamp(last)).toBe('2026-10-12 23:59');
    expect(taipeiStamp(next)).toBe('2026-10-13 00:00');
  });

  it('the daily run starts at 04:30 +08 and lasts until 23:59 the same day', () => {
    expect(isChatExportRunTime(Date.parse('2026-10-12T20:29:59Z'))).toBe(false); // 04:29:59 +08
    expect(isChatExportRunTime(Date.parse('2026-10-12T20:30:00Z'))).toBe(true); // 04:30 +08
    expect(isChatExportRunTime(Date.parse('2026-10-13T01:00:00Z'))).toBe(true); // 09:00 +08
    expect(isChatExportRunTime(Date.parse('2026-10-13T15:59:59Z'))).toBe(true); // 23:59:59 +08
    expect(isChatExportRunTime(Date.parse('2026-10-13T16:00:00Z'))).toBe(false); // 00:00 +08 next day
    expect(isChatExportRunTime(Date.parse('2026-10-12T16:30:00Z'))).toBe(false); // 00:30 +08
  });

  it('the last 7 complete days, oldest first, end with yesterday; the oldest kept is today − 7', () => {
    const now = Date.parse('2026-10-13T02:00:00Z'); // Tue 10/13 10:00 +08
    expect(CHAT_EXPORT_RETAIN_DAYS).toBe(7);
    expect(lastCompleteDays(now)).toEqual([
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
    expect(oldestKeptDay(now)).toBe('2026-10-06');
    expect(lastCompleteDays(Date.parse('2027-01-02T01:00:00Z'), 3)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    // At 00:30 +08 the day that just ended is already complete.
    expect(lastCompleteDays(Date.parse('2026-10-12T16:30:00Z')).at(-1)).toBe('2026-10-12');
  });

  it('export-log time: +08 with seconds, parsed back to the same instant; 日期 cells', () => {
    const t = Date.parse('2026-12-31T16:05:07Z');
    expect(taipeiIso(t)).toBe('2027-01-01T00:05:07+08:00');
    expect(Date.parse(taipeiIso(t))).toBe(t);
    expect(isDayKey('2026-10-05')).toBe(true);
    for (const v of ['日期', '週次', '', '2026/10/05', 20261005, null, '2026-10-05 x']) expect(isDayKey(v)).toBe(false);
  });
});

describe('config', () => {
  const PUB = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';
  const PRIV = '1k-ZNYqCnnS__Oc-NLX_ciVmaHOnBwilHbFjXeE5orx8';
  const creds = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' });

  it('defaults: on, the 阿瓦隆百科 sheet (publicSheet), tabs 聊天紀錄 / 匯出紀錄 keyed by 日期, the /意見 channel excluded', () => {
    const cfg = readChatExportConfig({});
    expect(cfg).toMatchObject({
      enabled: true,
      sheetId: PUB,
      retentionSheetId: PUB,
      sheetIdFromRetiredName: false,
      sheetIdRefused: false,
      publicSheet: true,
      sheetCredentialsUsable: false,
      sourceChannelIds: [],
      // One server only, also without DISCORD_GUILD_ID: the 阿瓦隆百科 server.
      guildId: AVALONPEDIA_DISCORD_GUILD_ID,
    });
    expect(AVALONPEDIA_DISCORD_GUILD_ID).toBe('1132682489840812113');
    expect(readChatExportConfig({ DISCORD_GUILD_ID: ' 123456789012345678 ' }).guildId).toBe('123456789012345678');
    expect(cfg.excludeChannelIds).toEqual([DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID]);
    // Owner 2026-10-13: the 阿瓦隆百科 sheet, not the private one any more.
    expect(DEFAULT_CHAT_EXPORT_SHEET_ID).toBe(PUB);
    expect(PUBLIC_STATS_SHEET_ID).toBe(PUB);
    expect(PRIVATE_CHAT_EXPORT_SHEET_ID).toBe(PRIV);
    expect(CHAT_EXPORT_TAB).toBe('聊天紀錄');
    expect(CHAT_EXPORT_LOG_TAB).toBe('匯出紀錄');
    expect([...CHAT_EXPORT_HEADER]).toEqual(['日期', '時間（+08）', '頻道', '來源', '發言者代號', '內容']);
    expect([...CHAT_EXPORT_LOG_HEADER]).toEqual(['日期', '狀態', '列數', '頻道數', '時間（+08）', '執行代號']);
  });

  it('the chat tabs are never one of the tabs the records importer / cache refresh use in the stats workbook', () => {
    for (const tab of [CHAT_EXPORT_TAB, CHAT_EXPORT_LOG_TAB]) expect(STATS_WORKBOOK_TABS as readonly string[]).not.toContain(tab);
  });

  it('switches, sheet id (new and old name), credentials check', () => {
    expect(readChatExportConfig({ CHAT_EXPORT_ENABLED: 'false' }).enabled).toBe(false);
    expect(readChatExportConfig({ CHAT_EXPORT_ENABLED: 'off' }).enabled).toBe(false);
    expect(readChatExportConfig({ CHAT_EXPORT_ENABLED: 'true' }).enabled).toBe(true);
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'off' }).sheetId).toBe('');
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'abc' }).sheetId).toBe('abc');
    expect(readChatExportConfig({ COMMUNITY_DIGEST_SHEET_ID: 'old-id' }).sheetId).toBe('old-id');
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'new-id', COMMUNITY_DIGEST_SHEET_ID: 'old-id' }).sheetId).toBe('new-id');
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: '', COMMUNITY_DIGEST_SHEET_ID: 'none' }).sheetId).toBe('');
    // The retired name deciding the target is flagged (warned at start); the new name or the default is not.
    expect(readChatExportConfig({ COMMUNITY_DIGEST_SHEET_ID: 'old-id' }).sheetIdFromRetiredName).toBe(true);
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'new-id', COMMUNITY_DIGEST_SHEET_ID: 'old-id' }).sheetIdFromRetiredName).toBe(false);
    expect(readChatExportConfig({}).sheetIdFromRetiredName).toBe(false);
    // Sheet credentials count only when they parse as a service-account key.
    expect(readChatExportConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: 'not-json-at-all' }).sheetCredentialsUsable).toBe(false);
    expect(readChatExportConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }).sheetCredentialsUsable).toBe(false);
    expect(readChatExportConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: creds }).sheetCredentialsUsable).toBe(true);
    expect(readChatExportConfig({ CHAT_EXPORT_SOURCE_CHANNEL_IDS: '123456789012345678, bad ,223456789012345678' }).sourceChannelIds).toEqual([
      '123456789012345678',
      '223456789012345678',
    ]);
    // 大劍管理員 is always left out, also when /意見 is turned off or goes elsewhere.
    expect(readChatExportConfig({ FEEDBACK_DISCORD_CHANNEL_ID: 'off' }).excludeChannelIds).toEqual(['1145513360545296574']);
    expect(readChatExportConfig({ FEEDBACK_DISCORD_CHANNEL_ID: '123456789012345678' }).excludeChannelIds).toEqual([
      '1145513360545296574',
      '123456789012345678',
    ]);
  });

  it('CHAT_EXPORT_ALLOW_PUBLIC_SHEET=0 refuses the 阿瓦隆百科 spreadsheet, the default included (not configured)', () => {
    const refused = readChatExportConfig({ CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '0', GOOGLE_SERVICE_ACCOUNT_JSON: creds });
    expect(refused).toMatchObject({ sheetId: '', sheetIdRefused: true, publicSheet: false, sheetCredentialsUsable: true });
    // Rows already written there are still pruned (retention only).
    expect(refused.retentionSheetId).toBe(PUB);
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'off' }).retentionSheetId).toBe('');
    // Set explicitly, under the old variable name, as a pasted URL, or as the AVALON_STATS_SHEET_ID override: refused too.
    const url = `https://docs.google.com/spreadsheets/d/${PUB}/edit#gid=0`;
    for (const env of [
      { CHAT_EXPORT_SHEET_ID: PUB },
      { COMMUNITY_DIGEST_SHEET_ID: PUB },
      { CHAT_EXPORT_SHEET_ID: url },
      { CHAT_EXPORT_SHEET_ID: 'another-public-sheet-id-1234', AVALON_STATS_SHEET_ID: 'another-public-sheet-id-1234' },
    ]) {
      expect(readChatExportConfig({ ...env, CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '0' })).toMatchObject({
        sheetId: '',
        sheetIdRefused: true,
        publicSheet: false,
      });
    }
    // Every "no", and any value that is not a yes (a typo must never publish chat), refuses.
    for (const v of ['0', 'false', 'off', 'no', 'none', ' OFF ', 'maybe', 'refuse']) {
      expect(readChatExportConfig({ CHAT_EXPORT_ALLOW_PUBLIC_SHEET: v })).toMatchObject({ sheetId: '', sheetIdRefused: true, publicSheet: false });
      expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: PUB, CHAT_EXPORT_ALLOW_PUBLIC_SHEET: v }).sheetIdRefused).toBe(true);
    }
    // The switch refuses public sheets only: the private sheet, other ids and off are untouched by it.
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: PRIV, CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '0' })).toMatchObject({
      sheetId: PRIV,
      sheetIdRefused: false,
      publicSheet: false,
    });
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'abc', CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '0' }).sheetId).toBe('abc');
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'off', CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '0' })).toMatchObject({ sheetId: '', sheetIdRefused: false });
  });

  it('unset, empty or a yes keeps the 阿瓦隆百科 sheet (publicSheet: true; set explicitly, old name, a pasted URL)', () => {
    for (const v of [undefined, '', '  ', '1', 'true', 'yes', 'on', ' TRUE ']) {
      const env = v === undefined ? {} : { CHAT_EXPORT_ALLOW_PUBLIC_SHEET: v };
      expect(readChatExportConfig(env)).toMatchObject({ sheetId: PUB, sheetIdRefused: false, publicSheet: true });
      expect(readChatExportConfig({ ...env, CHAT_EXPORT_SHEET_ID: PUB })).toMatchObject({ sheetId: PUB, publicSheet: true });
    }
    const url = `https://docs.google.com/spreadsheets/d/${PUB}/edit#gid=0`;
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: url })).toMatchObject({ sheetId: PUB, publicSheet: true });
    expect(spreadsheetIdFrom(url)).toBe(PUB);
    expect(spreadsheetIdFrom('abc')).toBe('abc');
    // A URL copied while signed in to a second Google account (…/spreadsheets/u/1/d/<id>/…).
    for (const u of [`https://docs.google.com/spreadsheets/u/0/d/${PUB}/edit`, `https://docs.google.com/spreadsheets/u/1/d/${PUB}/edit#gid=5`]) {
      expect(spreadsheetIdFrom(u)).toBe(PUB);
      expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: u })).toMatchObject({ sheetId: PUB, publicSheet: true });
    }
    // The old variable name too.
    expect(readChatExportConfig({ COMMUNITY_DIGEST_SHEET_ID: PUB }).publicSheet).toBe(true);
    // The AVALON_STATS_SHEET_ID override counts as public as well.
    expect(
      readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'another-public-sheet-id-1234', AVALON_STATS_SHEET_ID: 'another-public-sheet-id-1234' }).publicSheet,
    ).toBe(true);
  });

  it('CHAT_EXPORT_SHEET_ID still picks the private sheet (or any other): not public, not refused; a pasted URL works', () => {
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: PRIV })).toMatchObject({ sheetId: PRIV, sheetIdRefused: false, publicSheet: false });
    expect(readChatExportConfig({ COMMUNITY_DIGEST_SHEET_ID: PRIV })).toMatchObject({ sheetId: PRIV, publicSheet: false });
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: `https://docs.google.com/spreadsheets/d/${PRIV}/edit` })).toMatchObject({
      sheetId: PRIV,
      publicSheet: false,
    });
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'abc' })).toMatchObject({ sheetId: 'abc', publicSheet: false });
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'off' })).toMatchObject({ sheetId: '', sheetIdRefused: false, publicSheet: false });
  });
});
