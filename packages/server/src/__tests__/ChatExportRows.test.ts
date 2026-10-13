/**
 * Weekly chat-log export (2026-10-13) — the pure parts:
 *
 *   rows    — relay parsing (LINE / lobby / legacy), bot / webhook / system /
 *             command / attachment-only exclusion, per-week pseudonyms (no
 *             names or ids in the rows), mention rewriting, long-message
 *             clipping, one row per message in time order with the six
 *             columns 週次 / 時間（+08） / 頻道 / 來源 / 發言者代號 / 內容
 *   window  — Monday 09:00–12:00 +08 run window, previous-week window, week
 *             key, the oldest week kept
 *   config  — defaults, CHAT_EXPORT_* and the old COMMUNITY_DIGEST_* names,
 *             大劍管理員 always excluded, the public stats sheet refused
 */
import { describe, expect, it } from 'vitest';

import {
  SOURCE_LABEL,
  buildExportRows,
  classifyMessage,
  clipMessageText,
  isTypedCommand,
  parseRelayLine,
  type ChatChannel,
  type RawChatMessage,
} from '../bots/chatExport/rows';
import {
  isChatExportRunWindow,
  isWeekKey,
  oldestKeptWeek,
  scheduledWindow,
  taipeiIso,
  taipeiMondayStart,
  taipeiStamp,
} from '../bots/chatExport/window';
import { formatOutgoingUnified, formatOutgoingLegacy } from '../bots/ChatMirror';
import {
  CHAT_EXPORT_HEADER,
  CHAT_EXPORT_TAB,
  DEFAULT_CHAT_EXPORT_SHEET_ID,
  PUBLIC_STATS_SHEET_ID,
  readChatExportConfig,
} from '../bots/chatExport/config';
import { DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID } from '../bots/feedback/config';

const SELF = 'bot-self';
const MIRROR = '1132901301802504242';
const GENERAL = '2000000000000000001';
const T0 = Date.parse('2026-10-06T12:00:00Z'); // Tue 20:00 +08
const WEEK = '2026-10-05';

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
    const t = buildExportRows([lineRelay('[TW]小明', '今天打嗎', at + 1000), lineRelay('[TW]阿華', '我可以', at + 2000)], channels, WEEK);
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
    const t = buildExportRows(messages().reverse(), channels, WEEK); // input order does not matter
    expect(t.rows).toEqual([
      [WEEK, '2026-10-06 20:01', '一般聊天', 'Discord', '成員1', '這週排行怎麼沒更新 @成員2 你知道嗎 #一般聊天 :pepe: @某身分組'],
      [WEEK, '2026-10-06 20:03', '阿瓦隆同步', 'LINE', '成員3', '我也看到了'],
      [WEEK, '2026-10-06 20:04', '一般聊天', 'Discord', '成員2', '應該是快取 ⏎ 明天再看〔附件 1〕'],
      [WEEK, '2026-10-06 20:05', '一般聊天', 'Discord', '成員1', '好'],
      [WEEK, '2026-10-06 20:10', '阿瓦隆同步', '網站', '成員4', '網站好用'],
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
    const t = buildExportRows([msg({ channelId: MIRROR, authorIsBot: true, authorIsSelf: true, content: legacy })], channels, WEEK);
    expect(t.rows[0].slice(3)).toEqual(['同步', '成員1', '舊格式']);
  });

  it('times are +08 regardless of host TZ; the week column is the given Monday', () => {
    const late = Date.parse('2026-10-05T16:30:00Z'); // 10/06 00:30 +08
    const t = buildExportRows([msg({ content: '半夜還在打', createdAt: late })], channels, WEEK);
    expect(t.rows[0].slice(0, 2)).toEqual([WEEK, '2026-10-06 00:30']);
  });

  it('pseudonyms are per export (per week): the same speaker keeps one label; LINE and Discord namesakes stay distinct', () => {
    const t = buildExportRows(
      [
        msg({ createdAt: T0 + 1_000, authorId: 'd-1', content: 'a' }),
        lineRelay('d-1', 'b', T0 + 2_000),
        msg({ createdAt: T0 + 3_000, authorId: 'd-1', content: 'c' }),
      ],
      channels,
      WEEK,
    );
    expect(t.rows.map((r) => r[4])).toEqual(['成員1', '成員2', '成員1']);
    // A new export starts numbering again: the labels do not link weeks together.
    const next = buildExportRows([lineRelay('d-1', 'x', T0 + 9_000)], channels, '2026-10-12');
    expect(next.rows[0][4]).toBe('成員1');
  });

  it('a message read twice is exported once; an unknown channel is shown as 某頻道', () => {
    const m = msg({ channelId: '9999999999999999999', content: 'hi' });
    const t = buildExportRows([m, { ...m }], channels, WEEK);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][2]).toBe('某頻道');
  });

  it('formula-looking text stays as typed (the sheet is written with RAW input)', () => {
    const t = buildExportRows([msg({ content: '=HYPERLINK("x")' })], channels, WEEK);
    expect(t.rows[0][5]).toBe('=HYPERLINK("x")');
  });

  it('clips one long message to 4000 characters', () => {
    expect(Array.from(clipMessageText('長'.repeat(5000)))).toHaveLength(4000 + '…（後略）'.length);
    expect(clipMessageText('短')).toBe('短');
    expect(clipMessageText('a\r\n  b')).toBe('a ⏎ b');
  });

  it('nothing to export → no rows', () => {
    const t = buildExportRows([msg({ content: '/排行' }), msg({ content: '', attachmentCount: 1 })], channels, WEEK);
    expect(t.rows).toEqual([]);
    expect(t.channels).toBe(0);
    expect(t.skipped['attachment-only']).toBe(1);
  });
});

describe('window (+08)', () => {
  it('runs only Monday 09:00–11:59 +08 (start + catch-up)', () => {
    expect(isChatExportRunWindow(Date.parse('2026-10-12T01:00:00Z'))).toBe(true); // Mon 09:00
    expect(isChatExportRunWindow(Date.parse('2026-10-12T01:10:00Z'))).toBe(true); // Mon 09:10
    expect(isChatExportRunWindow(Date.parse('2026-10-12T03:59:59Z'))).toBe(true); // Mon 11:59:59
    expect(isChatExportRunWindow(Date.parse('2026-10-12T04:00:00Z'))).toBe(false); // Mon 12:00
    expect(isChatExportRunWindow(Date.parse('2026-10-12T00:59:59Z'))).toBe(false);
    expect(isChatExportRunWindow(Date.parse('2026-10-13T01:05:00Z'))).toBe(false); // Tuesday
    expect(isChatExportRunWindow(Date.parse('2026-10-11T17:05:00Z'))).toBe(false); // Mon 01:05 +08
  });

  it('exports the previous Monday 00:00 → Sunday 24:00; the week key is that Monday', () => {
    const w = scheduledWindow(Date.parse('2026-10-12T01:03:00Z'));
    expect(new Date(w.start).toISOString()).toBe('2026-10-04T16:00:00.000Z'); // Mon 10/05 00:00 +08
    expect(new Date(w.end).toISOString()).toBe('2026-10-11T16:00:00.000Z'); // Mon 10/12 00:00 +08
    expect(w.weekKey).toBe('2026-10-05');
    // Monday 00:30 +08 is still Monday, not the previous Sunday.
    expect(new Date(taipeiMondayStart(Date.parse('2026-10-11T16:30:00Z'))).toISOString()).toBe('2026-10-11T16:00:00.000Z');
    expect(taipeiStamp(Date.parse('2026-12-31T16:05:00Z'))).toBe('2027-01-01 00:05');
    // Export-log time: +08 with seconds, parsed back to the same instant.
    const t = Date.parse('2026-12-31T16:05:07Z');
    expect(taipeiIso(t)).toBe('2027-01-01T00:05:07+08:00');
    expect(Date.parse(taipeiIso(t))).toBe(t);
  });

  it('8 weeks kept = the exported week and the 7 before it (across a year end)', () => {
    expect(oldestKeptWeek('2026-10-05', 8)).toBe('2026-08-17');
    expect(oldestKeptWeek('2027-01-04', 8)).toBe('2026-11-16');
    expect(oldestKeptWeek('2026-10-05', 1)).toBe('2026-10-05');
    expect(isWeekKey('2026-10-05')).toBe(true);
    for (const v of ['週次', '', '2026/10/05', 20261005, null, '2026-10-05 x']) expect(isWeekKey(v)).toBe(false);
  });
});

describe('config', () => {
  it('defaults: on, the private sheet, tab 聊天紀錄, the /意見 channel excluded', () => {
    const cfg = readChatExportConfig({});
    expect(cfg).toMatchObject({ enabled: true, sheetId: DEFAULT_CHAT_EXPORT_SHEET_ID, sheetCredentialsUsable: false, sourceChannelIds: [] });
    expect(cfg.excludeChannelIds).toEqual([DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID]);
    expect(DEFAULT_CHAT_EXPORT_SHEET_ID).toBe('1k-ZNYqCnnS__Oc-NLX_ciVmaHOnBwilHbFjXeE5orx8');
    expect(CHAT_EXPORT_TAB).toBe('聊天紀錄');
    expect([...CHAT_EXPORT_HEADER]).toEqual(['週次', '時間（+08）', '頻道', '來源', '發言者代號', '內容']);
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
    // Sheet credentials count only when they parse as a service-account key.
    expect(readChatExportConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: 'not-json-at-all' }).sheetCredentialsUsable).toBe(false);
    expect(readChatExportConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }).sheetCredentialsUsable).toBe(false);
    expect(
      readChatExportConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' }) })
        .sheetCredentialsUsable,
    ).toBe(true);
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

  it('refuses the public 阿瓦隆百科 spreadsheet as the export target (chat would become public)', () => {
    const pub = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';
    const creds = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' });
    expect(PUBLIC_STATS_SHEET_ID).toBe(pub);
    const refused = readChatExportConfig({ CHAT_EXPORT_SHEET_ID: pub, GOOGLE_SERVICE_ACCOUNT_JSON: creds });
    expect(refused).toMatchObject({ sheetId: '', sheetIdRefused: true, sheetCredentialsUsable: true });
    // Old variable name, a pasted URL, and the AVALON_STATS_SHEET_ID override are refused too.
    expect(readChatExportConfig({ COMMUNITY_DIGEST_SHEET_ID: pub }).sheetIdRefused).toBe(true);
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: `https://docs.google.com/spreadsheets/d/${pub}/edit#gid=0` }).sheetId).toBe('');
    expect(
      readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'another-public-sheet-id-1234', AVALON_STATS_SHEET_ID: 'another-public-sheet-id-1234' })
        .sheetIdRefused,
    ).toBe(true);
    // The private default and other ids are fine.
    expect(readChatExportConfig({})).toMatchObject({ sheetId: DEFAULT_CHAT_EXPORT_SHEET_ID, sheetIdRefused: false });
    expect(readChatExportConfig({ CHAT_EXPORT_SHEET_ID: 'off' })).toMatchObject({ sheetId: '', sheetIdRefused: false });
  });
});
