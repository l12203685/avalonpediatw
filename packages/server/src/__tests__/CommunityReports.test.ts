/**
 * 百科回報／ID 認領（2026-11-09，services/communityReports.ts、communityReportsList.ts、bots/reports）：
 * 驗證、編號、訊息格式、貼到 DC 同步閒聊＋LINE 群組（mock fetch、mock LINE client）、LINE／DC 指令、網站路由、
 * 每日例行作業的列表（mock ✅）與標記、說明、主題計數與聊天匯出。名字都是虛構的，不連網路。
 */
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { MessageFlags } from 'discord.js';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rateLimit')>();
  return {
    ...actual,
    createHttpRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import {
  CLAIM_LINE_PREFIX,
  CLAIM_MAX_OTHERS,
  DEFAULT_SYNC_DISCORD_CHANNEL_ID,
  SUBMIT_LIMITS,
  __resetSubmitLimitsForTests,
  __resetSyncLinePushesForTests,
  claimLine,
  cleanClaimName,
  cleanPage,
  formatClaimMessage,
  formatReportMessage,
  isItemId,
  makeItemId,
  parseIdClaim,
  postToSyncTargets,
  registerSyncLinePusher,
  resolveSyncDiscordChannelId,
  submitReport,
  type IdClaim,
} from '../services/communityReports';
import {
  listCommunityItems,
  markCommunityItem,
  parseAdminIds,
  parseClaimMessage,
  parseReportMessage,
} from '../services/communityReportsList';
import {
  CLAIM_RECEIVED_TEXT,
  REPORT_RECEIVED_TEXT,
  SUBMIT_RATE_LIMITED_TEXT,
  SUBMIT_REDELIVERY_TEXT,
  SUBMIT_UNAVAILABLE_TEXT,
  answerCommunityTextCommand,
  isCommunityCommandText,
  parseClaimText,
  parseReportText,
  splitClaimNames,
} from '../bots/reports/commands';
import { handleClaimCommand, handleReportCommand } from '../bots/reports/discordCommand';
import { buildSlashCommands } from '../bots/discord/client';
import { CLAIM_OPTIONS, COMMANDS, REPORT_OPTIONS } from '../bots/discord/config';
import { formatStatsHelp } from '../bots/stats/statsReplies';
import { FeedbackService } from '../bots/feedback/service';
import { isTypedCommand } from '../bots/chatExport/rows';
import { feedbackRouter } from '../routes/feedback';
import { LineBotClient } from '../bots/line/client';
import { LINE_CONFIG } from '../bots/line/config';
import { LineReplyQueue } from '../bots/line/replyQueue';
import { __resetChatMirrorForTests, initializeChatMirror, type DiscordAdapter } from '../bots/ChatMirror';

const SYNC = '1132901301802504242';
const NOW = Date.UTC(2026, 10, 9, 4, 0, 0);
const fixedRand = (): number => 0.5;

function claimOf(body: unknown): IdClaim {
  const r = parseIdClaim(body);
  if (!r.ok) throw new Error(r.error);
  return r.claim;
}

/** 假的 DC：POST 訊息回 id；記下每一次呼叫。 */
function fakeDc(status = 200) {
  const posts: { url: string; body: { content: string; allowed_mentions: unknown; flags: number } }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(init.body as string) });
    return { ok: status >= 200 && status < 300, status, json: async () => ({ id: `90000000000000000${posts.length}` }) };
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, spy: fetchImpl, posts };
}

/** 假的 ChatMirror：記下 LINE 佇列與 DC 發文順序。 */
function fakeMirror(queueOn = true) {
  const queued: string[] = [];
  let chained = 0;
  return {
    queued,
    chained: () => chained,
    mirror: () => ({
      enqueueLineReplyText: (t: string) => { if (!queueOn) return false; queued.push(t); return true; },
      runOnDiscordSendChain: <T>(post: () => Promise<T>) => { chained += 1; return post(); },
    }),
  };
}

const ENV = { DISCORD_BOT_TOKEN: 't', LOBBY_MIRROR_DISCORD_CHANNEL_ID: SYNC, LOBBY_MIRROR_LINE_GROUP_ID: 'Cgroup' };

beforeEach(() => {
  __resetSubmitLimitsForTests();
  __resetSyncLinePushesForTests();
});

describe('ID 認領：驗證（同網站 ID 認領頁）', () => {
  it('收字串或 {name, games}；至少一個、最多 CLAIM_MAX_OTHERS 個其他 ID', () => {
    const c = claimOf({ main: { name: ' 星野路 ', games: 120 }, others: ['小路', { name: 'Kip Lune', games: 3.5 }] });
    expect(c.main).toEqual({ name: '星野路', games: 120 });
    expect(c.others).toEqual([{ name: '小路' }, { name: 'Kip Lune' }]);
    expect(parseIdClaim({ main: '星野路', others: [] })).toEqual({ ok: false, error: 'at least one other id required' });
    expect(parseIdClaim({ others: ['小路'] })).toEqual({ ok: false, error: 'main id required' });
    const many = Array.from({ length: CLAIM_MAX_OTHERS + 1 }, (_, i) => `分身${i}`);
    expect(parseIdClaim({ main: '星野路', others: many }).ok).toBe(false);
  });

  it('其他 ID 跟主 ID 相同（大小寫／全半形）不收；名字清理；頁面只收站內路徑', () => {
    expect(parseIdClaim({ main: 'Kip', others: ['ｋｉｐ'] })).toEqual({ ok: false, error: 'other id same as main id' });
    expect(claimOf({ main: 'Kip', others: ['Lune', 'lune'] }).others).toEqual([{ name: 'Lune' }]);
    expect(cleanClaimName('阿\u0000丙‮')).toBe('阿 丙');
    expect(cleanClaimName('x'.repeat(41))).toBe('');
    expect(cleanPage('/wiki#刺客')).toBe('/wiki#刺客');
    expect(cleanPage('https://evil.example')).toBe('');
  });

  it('CLAIM 行是合法 JSON，反引號不出現', () => {
    const line = claimLine({ main: { name: 'a`b' }, others: [{ name: '"q"' }] });
    expect(line).not.toContain('`');
    expect(JSON.parse(line.slice(CLAIM_LINE_PREFIX.length))).toEqual({ main: 'a`b', others: ['"q"'] });
  });
});

describe('編號與訊息格式', () => {
  it('編號：R／C＋時間 6 碼＋亂數 2 碼（Crockford base32，沒有 I L O U），同樣輸入同樣結果', () => {
    const id = makeItemId('R', NOW, fixedRand);
    expect(id).toMatch(/^R[0-9A-Z]{8}$/);
    expect(isItemId(id)).toBe(true);
    expect(id).not.toMatch(/[ILOU]/);
    expect(isItemId('R1234567')).toBe(false);
    expect(makeItemId('R', NOW, fixedRand)).toBe(id);
    expect(makeItemId('C', NOW, fixedRand).slice(1)).toBe(id.slice(1));
    expect(makeItemId('R', NOW + 1000, fixedRand)).not.toBe(id);
  });

  it('回報：類型、編號、內容、來源與暱稱；DC 跳脫 markdown、LINE 照原字', () => {
    const r = { kind: 'bug' as const, message: '牌譜頁 *手機* 上表格超出畫面 @everyone', source: 'web' as const, name: ' 小明 ', page: '/#records' };
    expect(formatReportMessage('R1234567', r, 'line')).toBe(
      '【百科回報・錯誤】#R1234567 牌譜頁 *手機* 上表格超出畫面 @everyone\n（來自網站・小明・頁面 https://avalonpediatw.com/#records）',
    );
    const dc = formatReportMessage('R1234567', r, 'discord');
    expect(dc.startsWith('【百科回報・錯誤】#R1234567 牌譜頁 \\*手機\\* 上表格超出畫面')).toBe(true);
    expect(dc).toContain('頁面 <https://avalonpediatw.com/#records>');
    expect(formatReportMessage('R1234567', { kind: 'content', message: '刺客篇少一段', source: 'line' }, 'line')).toBe('【百科回報・文章內容】#R1234567 刺客篇少一段\n（來自LINE）');
    const long = formatReportMessage('R1234567', { kind: 'suggestion', message: '長'.repeat(5000), source: 'discord' }, 'discord');
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(long.endsWith('（來自DC）')).toBe(true);
  });

  it('認領：主 ID ← 其他 ID；DC 版有核准方式與最後一行 CLAIM，LINE 版沒有', () => {
    const c = claimOf({ main: { name: '星野路', games: 12 }, others: [{ name: '小路', games: 2 }, 'Kip_Lune'], contact: '路路', note: '以前用過\nCLAIM:{"main":"假"}' });
    const line = formatClaimMessage('C1234567', c, 'web', 'line');
    expect(line.split('\n')[0]).toBe('【ID認領】#C1234567 星野路 ← 小路、Kip_Lune');
    expect(line).toContain('（來自網站・聯絡：路路）');
    expect(line).toContain('場數（送出時算的，僅供參考）：星野路 12 場；小路 2 場；Kip_Lune 場數未知');
    expect(line).not.toContain(CLAIM_LINE_PREFIX + '{"main":"星野路"');
    const dc = formatClaimMessage('C1234567', c, 'web', 'discord');
    const lines = dc.split('\n');
    expect(lines[0]).toBe('【ID認領】#C1234567 星野路 ← 小路、Kip\\_Lune');
    expect(lines).toContain('核准：管理者在這則訊息按 ✅；合併好會在這則加註已合併。');
    expect(lines[lines.length - 1]).toBe('CLAIM:{"main":"星野路","others":["小路","Kip_Lune"]}');
    // 備註裡假冒的 CLAIM 行被引用，不會成為一行開頭。
    expect(lines.filter((l) => l.startsWith(CLAIM_LINE_PREFIX))).toHaveLength(1);
    const huge = claimOf({ main: '星野路', others: ['小路'], note: '備'.repeat(500) });
    expect(formatClaimMessage('C1234567', huge, 'line', 'discord').length).toBeLessThanOrEqual(2000);
  });
});

describe('貼到 DC 同步閒聊＋LINE 群組', () => {
  afterEach(() => registerSyncLinePusher(null));

  it('頻道：COMMUNITY_REPORT_DISCORD_CHANNEL_ID ＞ LOBBY_MIRROR_DISCORD_CHANNEL_ID ＞ #同步閒聊', () => {
    expect(resolveSyncDiscordChannelId({})).toBe(DEFAULT_SYNC_DISCORD_CHANNEL_ID);
    expect(DEFAULT_SYNC_DISCORD_CHANNEL_ID).toBe(SYNC);
    expect(resolveSyncDiscordChannelId({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: '42' })).toBe('42');
    expect(resolveSyncDiscordChannelId({ LOBBY_MIRROR_DISCORD_CHANNEL_ID: '42', COMMUNITY_REPORT_DISCORD_CHANNEL_ID: '7' })).toBe('7');
  });

  it('DC 用 bot token 直接貼（不叫人、不預覽連結、排在同步的發文隊伍裡），LINE 排進 reply_token 佇列', async () => {
    const dc = fakeDc();
    const m = fakeMirror();
    const r = await postToSyncTargets({ discord: 'dc 版', line: 'line 版' }, { env: ENV, fetchImpl: dc.fetchImpl, mirror: m.mirror });
    expect(r).toEqual({ discord: { outcome: 'sent', status: 200, messageId: '900000000000000001' }, line: 'queued' });
    expect(dc.posts).toEqual([{ url: `https://discord.com/api/v10/channels/${SYNC}/messages`, body: { content: 'dc 版', allowed_mentions: { parse: [] }, flags: 4 } }]);
    expect((dc.spy.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bot t');
    expect(m.queued).toEqual(['line 版']);
    expect(m.chained()).toBe(1);
  });

  it('沒有佇列 → 用 LINE client push 到群組，每天有上限', async () => {
    const pushed: { to: string; messages: unknown }[] = [];
    const pusher = { pushMessage: vi.fn(async (to: string, messages: unknown) => { pushed.push({ to, messages }); return {}; }) };
    const deps = { env: { ...ENV, COMMUNITY_REPORT_LINE_PUSH_MAX_PER_DAY: '2' }, fetchImpl: fakeDc().fetchImpl, mirror: fakeMirror(false).mirror, linePusher: () => pusher, now: () => NOW };
    expect((await postToSyncTargets({ discord: 'a', line: 'b' }, deps)).line).toBe('pushed');
    expect(pushed[0]).toEqual({ to: 'Cgroup', messages: { type: 'text', text: 'b' } });
    expect((await postToSyncTargets({ discord: 'a', line: 'c' }, deps)).line).toBe('pushed');
    expect((await postToSyncTargets({ discord: 'a', line: 'd' }, deps)).line).toBe('skipped');
    expect(pusher.pushMessage).toHaveBeenCalledTimes(2);
    // 隔天重新算。
    expect((await postToSyncTargets({ discord: 'a', line: 'e' }, { ...deps, now: () => NOW + 86_400_000 })).line).toBe('pushed');
  });

  it('登記的 LINE client 也會用到；push 失敗只記錯誤名稱', async () => {
    const logs: string[] = [];
    registerSyncLinePusher(() => ({ pushMessage: async () => { throw new TypeError('秘密內容'); } }));
    const r = await postToSyncTargets({ discord: 'a', line: 'b' }, { env: ENV, fetchImpl: fakeDc().fetchImpl, mirror: () => null, log: (x) => logs.push(x) });
    expect(r.line).toBe('failed');
    expect(logs).toEqual(['LINE push 失敗：TypeError']);
  });

  it('DC 貼不出去 → LINE 也不放（例行作業只掃 DC）；沒有 token → skipped；log 只有狀態碼', async () => {
    const logs: string[] = [];
    const m = fakeMirror();
    const bad = await postToSyncTargets({ discord: '秘密內容', line: '秘密內容' }, { env: ENV, fetchImpl: fakeDc(403).fetchImpl, mirror: m.mirror, log: (x) => logs.push(x) });
    expect(bad).toEqual({ discord: { outcome: 'failed', status: 403 }, line: 'skipped' });
    expect(m.queued).toEqual([]);
    expect(logs).toEqual(['DC 發文失敗：HTTP 403']);
    const none = await postToSyncTargets({ discord: 'a', line: 'b' }, { env: { LOBBY_MIRROR_LINE_GROUP_ID: 'Cgroup' }, mirror: m.mirror });
    expect(none).toEqual({ discord: { outcome: 'skipped' }, line: 'skipped' });
  });

  it('沒設 LINE 群組 → LINE skipped', async () => {
    const r = await postToSyncTargets({ discord: 'a', line: 'b' }, { env: { DISCORD_BOT_TOKEN: 't' }, fetchImpl: fakeDc().fetchImpl, mirror: fakeMirror().mirror });
    expect(r.line).toBe('skipped');
  });

  it('送出有頻率限制（每人 10 分鐘 5 筆）', async () => {
    const deps = { env: ENV, fetchImpl: fakeDc().fetchImpl, mirror: fakeMirror().mirror, now: () => NOW, userKey: 'line:U1' };
    for (let i = 0; i < SUBMIT_LIMITS.perUser; i += 1) {
      expect((await submitReport({ kind: 'bug', message: `第 ${i} 則`, source: 'line' }, deps)).ok).toBe(true);
    }
    expect(await submitReport({ kind: 'bug', message: 'x', source: 'line' }, deps)).toEqual({ ok: false, error: 'rate_limited' });
    expect((await submitReport({ kind: 'bug', message: 'x', source: 'line' }, { ...deps, userKey: 'line:U2' })).ok).toBe(true);
  });
});

describe('指令解析', () => {
  it('/回報：類型可省略（＝錯誤），全形斜線也可以', () => {
    expect(parseReportText('/回報 建議 加一個深色模式')).toEqual({ kind: 'suggestion', message: '加一個深色模式' });
    expect(parseReportText('／回報　文章內容 刺客篇少一段')).toEqual({ kind: 'content', message: '刺客篇少一段' });
    expect(parseReportText('/回報 首頁打不開\n第二行')).toEqual({ kind: 'bug', message: '首頁打不開\n第二行' });
    expect(parseReportText('/ 回報 錯誤 ')).toEqual({ kind: 'bug', message: '' });
    expect(parseReportText('/回報')).toEqual({ kind: 'bug', message: '' });
    for (const t of ['回報 x', '/回報一下', '/戰績 回報', '', 'hello']) expect(parseReportText(t)).toBeNull();
  });

  it('/認領：第一個是主 ID；「」包住的名字可以有空白；、 , ← 都可以隔開', () => {
    expect(parseClaimText('/認領 星野路 小路 「Kip Lune」')).toEqual({ names: ['星野路', '小路', 'Kip Lune'] });
    expect(parseClaimText('／認領 星野路 ← 小路、路路,阿路')).toEqual({ names: ['星野路', '小路', '路路', '阿路'] });
    expect(parseClaimText('/認領')).toEqual({ names: [] });
    expect(splitClaimNames('『A B』 C')).toEqual(['A B', 'C']);
    for (const t of ['認領 x', '/認領我', '']) expect(parseClaimText(t)).toBeNull();
    expect(isCommunityCommandText('/回報 x')).toBe(true);
    expect(isCommunityCommandText('/認領 a b')).toBe(true);
    expect(isCommunityCommandText('/戰績 a')).toBe(false);
  });
});

describe('LINE／文字指令的回覆', () => {
  const deps = () => ({ env: ENV, fetchImpl: fakeDc().fetchImpl, mirror: fakeMirror().mirror, now: () => NOW, rand: fixedRand });

  it('/回報 → 「已收到，會在每天的處理裡看」＋編號；內容空的 → 用法', async () => {
    const d = fakeDc();
    const m = fakeMirror();
    const text = await answerCommunityTextCommand('/回報 建議 加一個深色模式', { platform: 'line', userId: 'U1', deps: { env: ENV, fetchImpl: d.fetchImpl, mirror: m.mirror, now: () => NOW } });
    expect(text).toMatch(new RegExp(`^${REPORT_RECEIVED_TEXT}（編號 #R[0-9A-Z]{8}）$`));
    const id = /#(R[0-9A-Z]{8})/.exec(text as string)?.[1];
    expect(d.posts[0].body.content).toBe(`【百科回報・建議】#${id} 加一個深色模式\n（來自LINE）`);
    expect(m.queued).toEqual([`【百科回報・建議】#${id} 加一個深色模式\n（來自LINE）`]);
    expect(await answerCommunityTextCommand('/回報 錯誤', { platform: 'line', deps: deps() })).toContain('用法：/回報');
    expect(await answerCommunityTextCommand('今天天氣好', { platform: 'line', deps: deps() })).toBeNull();
  });

  it('/認領 → 「已送出，等管理者核准」；格式錯誤用中文說明、不發文', async () => {
    const d = fakeDc();
    const text = await answerCommunityTextCommand('/認領 星野路 小路 Kip', { platform: 'line', userId: 'U1', deps: { ...deps(), fetchImpl: d.fetchImpl } });
    expect(text).toMatch(new RegExp(`^${CLAIM_RECEIVED_TEXT}（編號 #C[0-9A-Z]{8}）$`));
    expect(d.posts[0].body.content.split('\n')[0]).toMatch(/^【ID認領】#C[0-9A-Z]{8} 星野路 ← 小路、Kip$/);
    const bad = fakeDc();
    const ctx = { platform: 'line' as const, deps: { ...deps(), fetchImpl: bad.fetchImpl } };
    expect(await answerCommunityTextCommand('/認領', ctx)).toContain('用法：/認領 主ID 其他ID');
    expect(await answerCommunityTextCommand('/認領 星野路', ctx)).toContain('至少要一個其他 ID');
    expect(await answerCommunityTextCommand('/認領 Kip ｋｉｐ', ctx)).toContain('不能跟主 ID 一樣');
    expect(await answerCommunityTextCommand(`/認領 星野路 ${'x'.repeat(41)}`, ctx)).toContain('最多 40 個字');
    expect(await answerCommunityTextCommand(`/認領 星野路 ${Array.from({ length: 11 }, (_, i) => `分身${i}`).join(' ')}`, ctx)).toContain('最多 10 個');
    expect(bad.posts).toEqual([]);
  });

  it('DC 連不上 → 請稍後再試；太頻繁 → 請過幾分鐘；LINE 重送 → 不再送一次', async () => {
    expect(await answerCommunityTextCommand('/回報 x', { platform: 'line', deps: { ...deps(), fetchImpl: fakeDc(500).fetchImpl } })).toBe(SUBMIT_UNAVAILABLE_TEXT);
    const d = fakeDc();
    expect(await answerCommunityTextCommand('/回報 x', { platform: 'line', redelivery: true, deps: { ...deps(), fetchImpl: d.fetchImpl } })).toBe(SUBMIT_REDELIVERY_TEXT);
    expect(d.posts).toEqual([]);
    for (let i = 0; i < SUBMIT_LIMITS.perUser; i += 1) await answerCommunityTextCommand('/回報 x', { platform: 'line', userId: 'U9', deps: deps() });
    expect(await answerCommunityTextCommand('/回報 x', { platform: 'line', userId: 'U9', deps: deps() })).toBe(SUBMIT_RATE_LIMITED_TEXT);
  });
});

describe('LINE 同步群組裡打 /回報', () => {
  const SECRET = 'test-channel-secret';
  const GROUP = 'Cgroup';
  const originalStats = LINE_CONFIG.statsCommandsEnabled;
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    __resetChatMirrorForTests();
    LINE_CONFIG.statsCommandsEnabled = true;
    vi.stubEnv('LOBBY_MIRROR_LINE_GROUP_ID', GROUP);
    vi.stubEnv('LOBBY_MIRROR_DISCORD_CHANNEL_ID', SYNC);
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: '900000000000000001' }) }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    LINE_CONFIG.statsCommandsEnabled = originalStats;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetChatMirrorForTests();
  });

  it('同一個 reply 送出確認＋那則【百科回報】；原始指令不同步到 DC（bot 已經直接貼了），不重複', async () => {
    const replies: { text: string; quoteToken?: string }[][] = [];
    const mirrored: string[] = [];
    const client = {
      replyMessage: async (_t: string, messages: { text: string; quoteToken?: string }[]) => { replies.push(messages); return {}; },
      pushMessage: async () => { throw new Error('push must not be used'); },
      getGroupMemberProfile: async () => ({ displayName: '虛構甲' }),
    } as unknown as Client;
    const discord: DiscordAdapter = { fetchChannel: async () => ({ send: async (c: string) => { mirrored.push(c); return {}; } }) };
    initializeChatMirror({ lineGroupId: GROUP, discordChannelId: SYNC, discord, lineReplyQueue: new LineReplyQueue(), logger: { warn: () => undefined, error: () => undefined } });
    const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client });
    const event = { type: 'message', replyToken: 'rt1', webhookEventId: 'ev1', source: { type: 'group', groupId: GROUP, userId: 'U1' }, message: { type: 'text', id: 'm1', text: '/回報 牌譜頁打不開', quoteToken: 'q1' } };
    const raw = JSON.stringify({ destination: 'U', events: [event] });
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
    const req = { get: (h: string) => (h === 'X-Line-Signature' ? sig : undefined), body: JSON.parse(raw), rawBody: Buffer.from(raw) } as unknown as Request;
    const res = { status() { return this; }, json() { return this; } } as unknown as Response;
    await bot.handleWebhook(req, res);
    await new Promise((r) => setTimeout(r, 20));

    expect(replies).toHaveLength(1);
    expect(replies[0][0].text).toMatch(new RegExp(`^${REPORT_RECEIVED_TEXT}（編號 #R`));
    expect(replies[0][0].quoteToken).toBe('q1');
    expect(replies[0][1].text).toMatch(/^【百科回報・錯誤】#R[0-9A-Z]{8} 牌譜頁打不開\n（來自LINE）$/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`https://discord.com/api/v10/channels/${SYNC}/messages`);
    expect(mirrored).toEqual([]);
    expect(bot.getWebhookStats()).toMatchObject({ reportReplies: 1 });
  });
});

describe('Discord /回報、/認領', () => {
  beforeEach(() => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    vi.stubEnv('LOBBY_MIRROR_DISCORD_CHANNEL_ID', SYNC);
    vi.stubEnv('LOBBY_MIRROR_LINE_GROUP_ID', '');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: '900000000000000001' }) })));
    __resetChatMirrorForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function interaction(values: Record<string, string | null>) {
    return {
      user: { id: 'D1' },
      options: { getString: (name: string) => values[name] ?? null },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(),
    };
  }

  it('註冊：/回報 內容（必填）＋類型選單；/認領 主id＋其他id（必填）', () => {
    const json = buildSlashCommands().map((c) => c.toJSON());
    const report = json.find((c) => c.name === COMMANDS.REPORT) as { options: { name: string; required?: boolean; choices?: { name: string; value: string }[] }[] };
    expect(COMMANDS.REPORT).toBe('回報');
    expect(report.options.map((o) => [o.name, o.required ?? false])).toEqual([['內容', true], ['類型', false]]);
    expect(report.options[1].choices).toEqual([{ name: '錯誤', value: 'bug' }, { name: '建議', value: 'suggestion' }, { name: '文章內容', value: 'content' }]);
    const claim = json.find((c) => c.name === COMMANDS.CLAIM) as { options: { name: string; required?: boolean }[] };
    expect(COMMANDS.CLAIM).toBe('認領');
    expect(claim.options.map((o) => [o.name, o.required ?? false])).toEqual([['主id', true], ['其他id', true]]);
  });

  it('回覆只有自己看得到；大家看的那則 bot 直接貼到同步閒聊', async () => {
    const i = interaction({ [REPORT_OPTIONS.CONTENT]: '首頁打不開', [REPORT_OPTIONS.KIND]: 'suggestion' });
    await handleReportCommand(i as never);
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const arg = (i.editReply.mock.calls[0] as unknown as [{ content: string }])[0];
    expect(arg.content).toMatch(new RegExp(`^${REPORT_RECEIVED_TEXT}（編號 #R`));
    const body = JSON.parse(((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string }).body);
    expect(body.content).toMatch(/^【百科回報・建議】#R[0-9A-Z]{8} 首頁打不開\n（來自DC）$/);

    const c = interaction({ [CLAIM_OPTIONS.MAIN]: 'Kip Lune', [CLAIM_OPTIONS.OTHERS]: '小路、「路 路」' });
    await handleClaimCommand(c as never);
    expect((c.editReply.mock.calls[0] as unknown as [{ content: string }])[0].content).toMatch(new RegExp(`^${CLAIM_RECEIVED_TEXT}（編號 #C`));
    const claimBody = JSON.parse(((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as { body: string }).body);
    expect(claimBody.content.split('\n').pop()).toBe('CLAIM:{"main":"Kip Lune","others":["小路","路 路"]}');
  });
});

describe('網站路由改貼同步閒聊＋LINE', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', feedbackRouter);
  let pushed: { to: string; messages: { text: string } }[] = [];

  beforeEach(() => {
    __resetChatMirrorForTests();
    pushed = [];
    registerSyncLinePusher(() => ({ pushMessage: async (to: string, messages: unknown) => { pushed.push({ to, messages: messages as { text: string } }); return {}; } }));
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    vi.stubEnv('LOBBY_MIRROR_DISCORD_CHANNEL_ID', SYNC);
    vi.stubEnv('LOBBY_MIRROR_LINE_GROUP_ID', 'Cgroup');
  });
  afterEach(() => {
    registerSyncLinePusher(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('POST /api/feedback → 同步閒聊一則【百科回報】、LINE 群組一則；回傳編號', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: '900000000000000001' }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await request(app).post('/api/feedback').send({ type: 'content', message: '刺客篇少一段', name: '小明', page: '/#wiki' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, posted: true, id: expect.stringMatching(/^R[0-9A-Z]{8}$/) });
    const calls = fetchSpy.mock.calls as unknown as [string, { body: string }][];
    expect(calls.map((c) => c[0])).toEqual([`https://discord.com/api/v10/channels/${SYNC}/messages`]);
    expect(JSON.parse(calls[0][1].body).content).toBe(`【百科回報・文章內容】#${res.body.id} 刺客篇少一段\n（來自網站・小明・頁面 <https://avalonpediatw.com/#wiki>）`);
    expect(pushed).toEqual([{ to: 'Cgroup', messages: { type: 'text', text: `【百科回報・文章內容】#${res.body.id} 刺客篇少一段\n（來自網站・小明・頁面 https://avalonpediatw.com/#wiki）` } }]);
  });

  it('POST /api/feedback：類型不對 → 400；DC 失敗 → 仍 ok，但 posted:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect((await request(app).post('/api/feedback').send({ type: 'other', message: 'x' })).status).toBe(400);
    const res = await request(app).post('/api/feedback').send({ type: 'bug', message: 'x' });
    expect(res.body).toEqual({ ok: true, posted: false });
    expect(pushed).toEqual([]);
  });

  it('POST /api/feedback/claim → 同步閒聊一則【ID認領】（最後一行 CLAIM）＋LINE；格式不對 400；DC 不通 503', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: '900000000000000002' }) }));
    vi.stubGlobal('fetch', fetchSpy);
    expect((await request(app).post('/api/feedback/claim').send({ main: '星野路', others: ['星野路'] })).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    const res = await request(app).post('/api/feedback/claim').send({ main: { name: '星野路', games: 12 }, others: [{ name: '小路', games: 2 }], page: '/#id-claim' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: expect.stringMatching(/^C[0-9A-Z]{8}$/) });
    const calls = fetchSpy.mock.calls as unknown as [string, { body: string }][];
    expect(calls[0][0]).toBe(`https://discord.com/api/v10/channels/${SYNC}/messages`);
    const content = JSON.parse(calls[0][1].body).content as string;
    expect(content.split('\n')[0]).toBe(`【ID認領】#${res.body.id} 星野路 ← 小路`);
    expect(content.split('\n').pop()).toBe('CLAIM:{"main":"星野路","others":["小路"]}');
    expect(pushed[0].messages.text.split('\n')[0]).toBe(`【ID認領】#${res.body.id} 星野路 ← 小路`);

    vi.stubEnv('DISCORD_BOT_TOKEN', '');
    expect((await request(app).post('/api/feedback/claim').send({ main: '星野路', others: ['小路'] })).status).toBe(503);
  });
});

describe('每日例行作業的列表（mock ✅）與標記', () => {
  const BOT = '800000000000000001';
  const OWNER = '700000000000000001';
  const ADMIN = '700000000000000002';
  const STRANGER = '700000000000000003';
  const GUILD = '1132682489840812113';
  // 2026-11-08 左右的 snowflake（id 大＝新）。
  const sf = (ms: number): string => ((BigInt(ms) - 1420070400000n) << 22n).toString();
  const T = Date.UTC(2026, 10, 8, 12);
  const C1 = sf(T);
  const C2 = sf(T + 60_000);
  const C3 = sf(T + 120_000);
  const R1 = sf(T + 180_000);
  const R2 = sf(T + 240_000);
  const REPLY = sf(T + 300_000);
  const OLD = sf(T - 30 * 86_400_000);

  function dcWithMessages() {
    const claim = (id: string, main: string, others: string[], extra = ''): string =>
      `【ID認領】#${id} ${main} ← ${others.join('、')}\n（來自網站）\n核准：管理者在這則訊息按 ✅；合併好會在這則加註已合併。${extra}\nCLAIM:${JSON.stringify({ main, others })}`;
    const messages = [
      { id: REPLY, author: { id: BOT, bot: true }, content: '#R0000002 已處理，謝謝', message_reference: { message_id: R2 } },
      { id: R2, author: { id: BOT }, content: '【百科回報・建議】#R0000002 加一個深色模式\n（來自LINE）' },
      { id: R1, author: { id: BOT }, content: '【百科回報・錯誤】#R0000001 牌譜頁 \\*手機\\* 打不開\n（來自網站・小明）（已處理）' },
      { id: C3, author: { id: BOT }, content: claim('C0000003', '阿丙', ['丙丙'], '（已合併）'), reactions: [{ emoji: { name: '✅' }, count: 1 }] },
      { id: C2, author: { id: BOT }, content: claim('C0000002', 'Kip', ['Lune']), reactions: [{ emoji: { name: '✅' }, count: 1 }] },
      { id: C1, author: { id: BOT }, content: claim('C0000001', '星野路', ['小路', '路路']), reactions: [{ emoji: { name: '✅' }, count: 2 }, { emoji: { name: '👍' }, count: 1 }] },
      { id: sf(T - 1000), author: { id: STRANGER }, content: '【ID認領】#C9999999 假冒 ← 別人\nCLAIM:{"main":"假冒","others":["別人"]}' },
      { id: OLD, author: { id: BOT }, content: '【百科回報・錯誤】#R0000000 很久以前\n（來自網站）' },
    ];
    const reactions: Record<string, { id: string }[]> = { [C1]: [{ id: STRANGER }, { id: OWNER }], [C2]: [{ id: STRANGER }], [C3]: [{ id: ADMIN }] };
    const calls: string[] = [];
    const patches: { url: string; content: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const path = url.replace('https://discord.com/api/v10', '');
      calls.push(path);
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (init?.method === 'PATCH') { patches.push({ url: path, content: JSON.parse(init.body as string).content }); return ok({}); }
      if (path === '/users/@me') return ok({ id: BOT });
      if (path === `/channels/${SYNC}`) return ok({ id: SYNC, guild_id: GUILD });
      if (path === `/guilds/${GUILD}`) return ok({ id: GUILD, owner_id: OWNER });
      if (path.startsWith(`/channels/${SYNC}/messages?`)) return ok(path.includes('before=') ? [] : messages);
      const r = /^\/channels\/\d+\/messages\/(\d+)\/reactions\/%E2%9C%85\?limit=100$/.exec(path);
      if (r) return ok(reactions[r[1]] ?? []);
      const one = /^\/channels\/\d+\/messages\/(\d+)$/.exec(path);
      if (one) {
        const m = messages.find((x) => x.id === one[1]);
        return m ? ok(m) : { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, patches };
  }

  it('ID認領：只有擁有者或 ADMIN_DISCORD_IDS 的 ✅ 算核准；（已合併）＝處理完；別人發的、太舊的不列', async () => {
    const dc = dcWithMessages();
    const logs: string[] = [];
    const out = await listCommunityItems({ token: 't', channelId: SYNC, days: 7, adminIds: parseAdminIds(`${ADMIN}, abc`), fetchImpl: dc.fetchImpl, now: () => T + 86_400_000, log: (m) => logs.push(m) });
    expect(out.claims.map((c) => [c.id, c.main, c.others, c.approved, c.approvedBy, c.merged])).toEqual([
      ['C0000001', '星野路', ['小路', '路路'], true, ['owner'], false],
      ['C0000002', 'Kip', ['Lune'], false, [], false],
      ['C0000003', '阿丙', ['丙丙'], true, ['admin'], true],
    ]);
    expect(out.claims[0].url).toBe(`https://discord.com/channels/${GUILD}/${SYNC}/${C1}`);
    expect(out.claims[0].source).toBe('web');
    expect(out.reports.map((r) => [r.id, r.kind, r.text, r.source, r.processed])).toEqual([
      ['R0000001', 'bug', '牌譜頁 *手機* 打不開', 'web', true],
      ['R0000002', 'suggestion', '加一個深色模式', 'line', true],
    ]);
    // ✅ 只查有 ✅ 的訊息。
    expect(dc.calls.filter((c) => c.includes('/reactions/'))).toHaveLength(3);
    // log 只有數量，沒有名字。
    expect(logs.join('\n')).not.toMatch(/星野路|小路|Kip|深色/);
  });

  it('解析：回報與認領訊息；不是的 → null', () => {
    expect(parseReportMessage('【百科回報・文章內容】#R1234567 第一行\n第二行\n（來自DC）')).toEqual({ id: 'R1234567', kind: 'content', text: '第一行\n第二行', source: 'discord' });
    expect(parseClaimMessage('【ID認領】#C1234567 a ← b\nCLAIM:{"main":"a","others":["b"]}')).toEqual({ id: 'C1234567', main: 'a', others: ['b'], source: null });
    expect(parseClaimMessage('【ID認領】#C1234567 a ← b')).toBeNull();
    expect(parseReportMessage('一般聊天')).toBeNull();
  });

  it('標記：認領在 CLAIM 行前一行加（已合併）；回報在最後加（已處理）；已經有就不動', async () => {
    const dc = dcWithMessages();
    expect(await markCommunityItem({ token: 't', channelId: SYNC, messageId: C1, mark: 'merged', fetchImpl: dc.fetchImpl })).toBe('edited');
    const lines = dc.patches[0].content.split('\n');
    expect(lines[lines.length - 2].endsWith('（已合併）')).toBe(true);
    expect(lines[lines.length - 1]).toBe('CLAIM:{"main":"星野路","others":["小路","路路"]}');
    expect(await markCommunityItem({ token: 't', channelId: SYNC, messageId: R2, mark: 'processed', fetchImpl: dc.fetchImpl })).toBe('edited');
    expect(dc.patches[1].content).toBe('【百科回報・建議】#R0000002 加一個深色模式\n（來自LINE）（已處理）');
    expect(await markCommunityItem({ token: 't', channelId: SYNC, messageId: C3, mark: 'merged', fetchImpl: dc.fetchImpl })).toBe('already');
    expect(await markCommunityItem({ token: 't', channelId: SYNC, messageId: R2, mark: 'merged', fetchImpl: dc.fetchImpl })).toBe('not_found');
    expect(await markCommunityItem({ token: 't', channelId: SYNC, messageId: '1', mark: 'merged', fetchImpl: dc.fetchImpl })).toBe('not_found');
  });
});

describe('說明、主題計數、聊天匯出', () => {
  it('說明列出 /回報 與 /認領', () => {
    expect(formatStatsHelp('line')).toContain('/回報 [錯誤｜建議｜文章內容] 內容');
    expect(formatStatsHelp('line')).toContain('/認領 主ID 其他ID…');
    expect(formatStatsHelp('discord')).toContain('/回報 類型 內容');
  });

  it('不算意見主題、聊天匯出當成指令', () => {
    const svc = new FeedbackService({ logger: { warn: () => undefined, error: () => undefined } });
    expect(svc.observe('line', '/回報 首頁打不開')).toEqual([]);
    expect(svc.observe('line', '/認領 a b')).toEqual([]);
    expect(isTypedCommand('/ 回報 x')).toBe(true);
    expect(isTypedCommand('／認領 a b')).toBe(true);
  });
});
