/**
 * GET /api/reports（網站「回報與修正」頁）：DC 用 mock fetch。只列 bot 自己發的【百科回報…】；不給暱稱、@提及；
 * 狀態行 → 狀態／說明／連結；隱藏的不列；快取 5 分鐘、送出後重讀；沒設 token 503＋空清單。內容與名字都是編的。
 */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportsRouter } from '../routes/reports';
import {
  anonymizeReportText, createReportBoardService, pageOfReport, reportBoardService, setReportBoardServiceForTests, toPublicReport,
} from '../services/reportBoard';
import { formatReportMessage } from '../services/communityReports';
import { formatStatusLine } from '../services/reportStatus';

const SYNC = '1132901301802504242';
const BOT = '800000000000000001';
const HUMAN = '700000000000000009';
const sf = (ms: number): string => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const T = Date.UTC(2026, 10, 18, 12);
const R1 = sf(T);
const R2 = sf(T + 60_000);
const R3 = sf(T + 120_000);
const R4 = sf(T + 180_000);
const R5 = sf(T + 240_000);
const R6 = sf(T + 300_000);
const REPLY = sf(T + 360_000);
const FAKE = sf(T + 420_000);

function msg(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, author: { id: BOT, bot: true }, content, ...extra };
}

function messages() {
  return [
    msg(FAKE, '', {}),
    { id: sf(T + 400_000), author: { id: HUMAN }, content: '【百科回報・錯誤】#R0000099 假冒的回報\n（來自網站）' },
    msg(REPLY, '#R0000006 已處理，謝謝', { message_reference: { message_id: R6 } }),
    msg(R6, '【百科回報・建議】#R0000006 加一個深色模式\n（來自LINE・測試路人）'),
    msg(R5, `${formatReportMessage('R0000005', { kind: 'bug', message: '這段有我的私事', source: 'web', name: '測試甲' }, 'discord')}\n${formatStatusLine({ status: '隱藏', note: '', link: null })}`),
    msg(R4, `${formatReportMessage('R0000004', { kind: 'correction', message: '[更正] S1234\n1家 測試乙｜2家 測試丙', source: 'line', name: '測試丁' }, 'discord')}`),
    msg(R3, `${formatReportMessage('R0000003', { kind: 'content', message: '刺客那篇有錯字', source: 'discord' }, 'discord')}\n${formatStatusLine({ status: '不處理', note: '那是原文用法', link: null })}`, { edited_timestamp: '2026-11-19T02:00:00.000Z' }),
    msg(R2, `${formatReportMessage('R0000002', { kind: 'bug', message: '牌譜頁 *手機* 打不開 <@123456789012345678> @測試戊 幫看', source: 'web', name: '測試己', page: '/#records' }, 'discord')}\n${formatStatusLine({ status: '已修正', note: '表格改成可以左右滑', link: 'https://github.com/example/repo/pull/123' })}`, { edited_timestamp: '2026-11-19T03:00:00.000Z' }),
    msg(R1, `${formatReportMessage('R0000001', { kind: 'bug', message: '排行頁很慢\n暱稱：測試庚', source: 'web', name: '測試辛' }, 'discord')}（已處理）`),
  ];
}

function mockDiscord(list = messages()) {
  const calls: string[] = [];
  const f = vi.fn(async (input: string | URL | Request) => {
    const path = String(input).replace('https://discord.com/api/v10', '');
    calls.push(path);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/users/@me') return ok({ id: BOT });
    if (path.startsWith(`/channels/${SYNC}/messages?`)) return ok(path.includes('before=') ? [] : list);
    return new Response('{}', { status: 404 });
  });
  return { fetchImpl: f as unknown as typeof fetch, calls };
}

function app() {
  const a = express();
  a.use('/api/reports', reportsRouter);
  return a;
}

afterEach(() => setReportBoardServiceForTests(undefined));

describe('GET /api/reports', () => {
  it('沒設 token → 503、ok:false、空清單', async () => {
    setReportBoardServiceForTests(null);
    const res = await request(app()).get('/api/reports');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, reports: [], error: 'reports not configured' });
    expect(reportBoardService({} as NodeJS.ProcessEnv)).toBeNull();
    expect(reportBoardService({ DISCORD_BOT_TOKEN: 't', REPORTS_BOARD: 'off' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('列出、新的在前；狀態、說明、連結；不給暱稱與 @提及；隱藏的、別人發的不列', async () => {
    const dc = mockDiscord();
    setReportBoardServiceForTests(createReportBoardService({ token: 't', channelId: SYNC, fetchImpl: dc.fetchImpl, now: () => T + 86_400_000, log: () => {} }));
    const res = await request(app()).get('/api/reports');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const reports = res.body.reports as Array<Record<string, unknown>>;
    expect(reports.map((r) => [r.id, r.status])).toEqual([
      ['R0000006', '已處理'], ['R0000004', '收到'], ['R0000003', '不處理'], ['R0000002', '已修正'], ['R0000001', '已處理'],
    ]);
    const fixed = reports.find((r) => r.id === 'R0000002')!;
    expect(fixed).toMatchObject({
      kind: 'bug', kindLabel: '錯誤', source: 'web', page: '/#records', status: '已修正',
      text: '牌譜頁 *手機* 打不開 @○○ @○○ 幫看', note: '表格改成可以左右滑', link: 'https://github.com/example/repo/pull/123',
      updatedAt: '2026-11-19T03:00:00.000Z',
    });
    expect(reports.find((r) => r.id === 'R0000003')).toMatchObject({ status: '不處理', note: '那是原文用法', link: null });
    // 牌譜更正只給第一行
    expect(reports.find((r) => r.id === 'R0000004')).toMatchObject({ kindLabel: '牌譜更正', text: '[更正] S1234' });
    expect(reports.find((r) => r.id === 'R0000001')).toMatchObject({ text: '排行頁很慢\n暱稱：○○', note: null, updatedAt: null });
    const all = JSON.stringify(res.body);
    expect(all).not.toMatch(/測試[甲乙丙丁戊己庚辛]|測試路人|私事|假冒|123456789012345678|discord\.com\/channels/);
    expect(Object.keys(fixed).sort()).toEqual(['createdAt', 'id', 'kind', 'kindLabel', 'link', 'note', 'page', 'source', 'status', 'text', 'updatedAt']);
  });

  it('快取 5 分鐘；invalidate 後下一次重讀；DC 失敗時回舊的（stale）', async () => {
    let now = T + 86_400_000;
    let fail = false;
    const dc = mockDiscord();
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => (fail ? new Response('{}', { status: 500 }) : dc.fetchImpl(input, init)));
    const svc = createReportBoardService({ token: 't', channelId: SYNC, fetchImpl: f as unknown as typeof fetch, now: () => now, log: () => {} });
    await svc.listReports();
    const reads = () => f.mock.calls.filter((c) => String(c[0]).includes('/messages?')).length;
    expect(reads()).toBe(1);
    await svc.listReports();
    expect(reads()).toBe(1);
    svc.invalidate();
    await svc.listReports();
    expect(reads()).toBe(2);
    now += 6 * 60_000;
    fail = true;
    const load = await svc.listReports();
    expect(load.ok && load.stale).toBe(true);
    expect(load.ok && load.reports.length).toBe(5);
  });

  it('第一次就讀不到 → 503、ok:false', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 403 }));
    setReportBoardServiceForTests(createReportBoardService({ token: 't', channelId: SYNC, fetchImpl: f as unknown as typeof fetch, log: () => {} }));
    const res = await request(app()).get('/api/reports');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, reports: [] });
  });
});

describe('去名字與頁面', () => {
  it('@提及、DC 提及、名字標籤、最後一行署名換掉；電子郵件不動', () => {
    expect(anonymizeReportText('<@!123> <@&456> <#789> 看這裡')).toBe('@○○ @○○ #頻道 看這裡');
    expect(anonymizeReportText('@everyone 首頁壞了，＠測試甲 也遇到')).toBe('@○○ 首頁壞了，@○○ 也遇到');
    expect(anonymizeReportText('寄到 someone@example.com 沒回')).toBe('寄到 someone@example.com 沒回');
    expect(anonymizeReportText('ID: 測試乙 的戰績少一場\n聯絡：測試丙')).toBe('ID：○○ 的戰績少一場\n聯絡：○○');
    expect(anonymizeReportText('按鈕沒反應\n—測試丁')).toBe('按鈕沒反應');
    expect(anonymizeReportText('按鈕沒反應\nby 測試丁')).toBe('按鈕沒反應');
    expect(anonymizeReportText('手機版 -- 平板也是')).toBe('手機版 -- 平板也是');
    expect(anonymizeReportText('兩個問題：\n- 表格太寬\n- 字太小')).toBe('兩個問題：\n- 表格太寬\n- 字太小');
  });

  it('其他寫法的名字：英文標籤、「ID是／我叫」、有空白的名字、~署名、敬上（名字都是編的）', () => {
    expect(anonymizeReportText('name: Kip Lune\n排行少一場')).toBe('name：○○\n排行少一場');
    expect(anonymizeReportText('Nickname：測試壬 / user: abc_99')).toBe('Nickname：○○ / user：○○');
    expect(anonymizeReportText('@Kip Lune 也遇到，@Bob測試 也是')).toBe('@○○ 也遇到，@○○ 也是');
    expect(anonymizeReportText('@測試甲 abc 頁面也壞')).toBe('@○○ abc 頁面也壞');
    expect(anonymizeReportText('暱稱：Kip Lune 的戰績少一場')).toBe('暱稱：○○ 的戰績少一場');
    expect(anonymizeReportText('我的ID是測試癸，戰績少一場')).toBe('我的ID是○○，戰績少一場');
    expect(anonymizeReportText('你好我叫測試子，牌譜打不開')).toBe('你好我叫○○，牌譜打不開');
    expect(anonymizeReportText('按鈕沒反應\n~測試丑')).toBe('按鈕沒反應');
    expect(anonymizeReportText('按鈕沒反應\n測試丑 敬上')).toBe('按鈕沒反應');
    // 不是署名的最後一行照留
    expect(anonymizeReportText('按鈕沒反應\nbyebye')).toBe('按鈕沒反應\nbyebye');
    expect(anonymizeReportText('這個名字是錯的')).toBe('這個名字是錯的');
  });

  it('舊格式的整則訊息（來自那行有暱稱、加過「（已處理）」再換狀態行、/更正 的來自那行）都不給名字', () => {
    const web = `${formatReportMessage('R0000007', { kind: 'bug', message: '雷達圖空白\n—測試寅', source: 'web', name: 'Kip Lune', page: '/#player=KipLune' }, 'discord')}（已處理）\n${formatStatusLine({ status: '已修正', note: '修好了', link: null })}`;
    const pub = toPublicReport({ id: R1, content: web });
    expect(pub).toMatchObject({ text: '雷達圖空白', page: '/#player', status: '已修正', note: '修好了' });
    const fix = toPublicReport({ id: R2, content: `${formatReportMessage('R0000008', { kind: 'correction', message: '[更正] S2222\n1家 測試卯', source: 'discord', name: '測試辰' }, 'discord')}` });
    expect(fix).toMatchObject({ text: '[更正] S2222', page: null });
    expect(JSON.stringify([pub, fix])).not.toMatch(/Kip|Lune|測試[寅卯辰]/);
  });

  it('頁面只從「來自」那行拿、只認 avalonpediatw.com、只給頁面名稱（#player=名字 的名字不給）', () => {
    expect(pageOfReport('【百科回報・錯誤】#R1 x\n（來自網站・頁面 <https://avalonpediatw.com/#player=KipLune>）')).toBe('/#player');
    expect(pageOfReport('【百科回報・錯誤】#R1 x\n（來自網站・頁面 <https://avalonpediatw.com/#stats?f=1.abc>）')).toBe('/#stats');
    expect(pageOfReport('【百科回報・錯誤】#R1 x\n（來自網站・頁面 <https://avalonpediatw.com/>）')).toBeNull();
    expect(pageOfReport('【百科回報・錯誤】#R1 x\n（來自網站・測試甲・頁面 <https://avalonpediatw.com/#wiki=abc>）')).toBe('/#wiki');
    expect(pageOfReport('【百科回報・錯誤】#R1 x\n（來自網站・頁面 https://avalonpediatw.com/#records）（已處理）')).toBe('/#records');
    expect(pageOfReport('【百科回報・錯誤】#R1 頁面 <https://avalonpediatw.com/#x>\n（來自LINE）')).toBeNull();
    expect(pageOfReport('（來自網站・頁面 <https://evil.example/#x>）')).toBeNull();
  });

  it('不是回報 → null', () => {
    expect(toPublicReport({ id: R1, content: '一般聊天' })).toBeNull();
    expect(toPublicReport({ id: R1, content: '【ID認領】#C1234567 a ← b' })).toBeNull();
  });
});
