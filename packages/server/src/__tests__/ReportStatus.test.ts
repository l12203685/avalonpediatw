/**
 * 百科回報的狀態行（services/reportStatus.ts）與每日例行作業腳本的參數（scripts/listCommunityReports.ts → parseCliArgs）、
 * markCommunityItem 換狀態行。內容都是編的。
 */
import { describe, expect, it, vi } from 'vitest';
import { hasDoneMark, REPORT_DONE_MARK } from '../services/communityReports';
import { markCommunityItem, parseCliArgs, parseReportMessage } from '../services/communityReportsList';
import {
  applyStatus, cleanStatusLink, cleanStatusNote, findStatus, formatStatusLine, parseStatusLine, parseStatusName,
} from '../services/reportStatus';

const ID = '1570000000000000001';
const PR = 'https://github.com/example/repo/pull/42';

describe('腳本參數', () => {
  it('列表：預設 7 天；--days、--channel', () => {
    expect(parseCliArgs([])).toEqual({ cmd: 'list', days: 7 });
    expect(parseCliArgs(['--days', '30', '--channel', '1132901301802504242'])).toEqual({ cmd: 'list', days: 30, channelId: '1132901301802504242' });
    expect(parseCliArgs(['--days', '0']).cmd).toBe('error');
    expect(parseCliArgs(['--days', '91']).cmd).toBe('error');
    expect(parseCliArgs(['--channel', 'abc']).cmd).toBe('error');
  });

  it('--mark-merged／--mark-processed 只給 id ＝ 舊的標記', () => {
    expect(parseCliArgs(['--mark-merged', ID])).toEqual({ cmd: 'mark', messageId: ID, mark: 'merged' });
    expect(parseCliArgs(['--mark-processed', ID])).toEqual({ cmd: 'mark', messageId: ID, mark: 'processed' });
    expect(parseCliArgs(['--mark-processed', 'abc']).cmd).toBe('error');
    expect(parseCliArgs(['--mark-processed']).cmd).toBe('error');
    expect(parseCliArgs(['--mark-merged', ID, '--mark-processed', ID]).cmd).toBe('error');
  });

  it('--note／--link → 狀態行，預設 已修正；「已修正：」開頭會拿掉', () => {
    expect(parseCliArgs(['--mark-processed', ID, '--note', '已修正：表格改成可以左右滑', '--link', PR])).toEqual({
      cmd: 'mark', messageId: ID, mark: 'processed', status: { status: '已修正', note: '表格改成可以左右滑', link: PR },
    });
    expect(parseCliArgs([`--mark-processed=${ID}`, '--status=不處理', '--note=那是原文用法'])).toEqual({
      cmd: 'mark', messageId: ID, mark: 'processed', status: { status: '不處理', note: '那是原文用法', link: null },
    });
    expect(parseCliArgs(['--mark-processed', ID, '--status', 'in-progress'])).toMatchObject({ status: { status: '處理中', note: '' } });
    expect(parseCliArgs(['--mark-processed', ID, '--status', '隱藏'])).toMatchObject({ status: { status: '隱藏' } });
  });

  it('錯誤：已修正／不處理沒寫說明、狀態不認得、網址不是 https、說明太長、狀態參數沒配 --mark-processed', () => {
    expect(parseCliArgs(['--mark-processed', ID, '--link', PR])).toMatchObject({ cmd: 'error', message: expect.stringContaining('--note') });
    expect(parseCliArgs(['--mark-processed', ID, '--status', '不處理']).cmd).toBe('error');
    expect(parseCliArgs(['--mark-processed', ID, '--status', '亂寫', '--note', 'x']).cmd).toBe('error');
    expect(parseCliArgs(['--mark-processed', ID, '--note', 'x', '--link', 'http://example.com']).cmd).toBe('error');
    expect(parseCliArgs(['--mark-processed', ID, '--note', 'x'.repeat(301)]).cmd).toBe('error');
    expect(parseCliArgs(['--note', 'x']).cmd).toBe('error');
    expect(parseCliArgs(['--mark-merged', ID, '--note', 'x']).cmd).toBe('error');
    expect(parseCliArgs(['--whatever', '1']).cmd).toBe('error');
    expect(parseCliArgs(['stray']).cmd).toBe('error');
  });
});

describe('狀態行', () => {
  it('格式與解析來回一致；已修正／不處理／隱藏 帶（已處理）', () => {
    const line = formatStatusLine({ status: '已修正', note: '修好 *粗體* (手機)', link: PR });
    expect(line).toBe(`【處理・已修正】修好 \\*粗體\\* \\(手機\\)｜<${PR}>（已處理）`);
    expect(parseStatusLine(line)).toEqual({ status: '已修正', note: '修好 *粗體* (手機)', link: PR });
    expect(formatStatusLine({ status: '處理中', note: '', link: null })).toBe('【處理・處理中】');
    expect(parseStatusLine('【處理・處理中】')).toEqual({ status: '處理中', note: '', link: null });
    expect(parseStatusLine('一般的一行')).toBeNull();
    expect(hasDoneMark(`x\n${formatStatusLine({ status: '不處理', note: 'y', link: null })}`, REPORT_DONE_MARK)).toBe(true);
    expect(hasDoneMark(`x\n${formatStatusLine({ status: '處理中', note: 'y', link: null })}`, REPORT_DONE_MARK)).toBe(false);
  });

  it('換狀態：舊的狀態行與行尾（已處理）拿掉、加在最後；回報內容讀回來不含狀態行', () => {
    const base = '【百科回報・錯誤】#R0000001 首頁很慢\n（來自網站）（已處理）';
    const a = applyStatus(base, { status: '處理中', note: '查原因中', link: null })!;
    expect(a).toBe('【百科回報・錯誤】#R0000001 首頁很慢\n（來自網站）\n【處理・處理中】查原因中');
    expect(hasDoneMark(a, REPORT_DONE_MARK)).toBe(false);
    const b = applyStatus(a, { status: '已修正', note: '加了快取', link: PR })!;
    expect(b.split('\n')).toHaveLength(3);
    expect(findStatus(b)).toEqual({ status: '已修正', note: '加了快取', link: PR });
    expect(parseReportMessage(b)?.text).toBe('首頁很慢');
    expect(applyStatus('x'.repeat(1990), { status: '已修正', note: '加了快取', link: PR })).toBeNull();
  });

  it('小工具', () => {
    expect(parseStatusName('fixed')).toBe('已修正');
    expect(parseStatusName('WONTFIX')).toBe('不處理');
    expect(parseStatusName('?')).toBeNull();
    expect(cleanStatusLink('https://example.com/a b')).toBeNull();
    expect(cleanStatusLink('javascript:alert(1)')).toBeNull();
    expect(cleanStatusNote('已修正： a｜b \n c', '已修正')).toBe('a／b c');
  });
});

describe('markCommunityItem 換狀態行', () => {
  function dc(content: string) {
    const patches: string[] = [];
    let current = content;
    const f = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        current = JSON.parse(init.body as string).content;
        patches.push(current);
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ id: ID, content: current }) };
    });
    return { fetchImpl: f as unknown as typeof fetch, patches };
  }

  it('加上、一樣的再標一次 → already、換成別的狀態 → edited；認領不吃狀態行', async () => {
    const d = dc('【百科回報・建議】#R0000002 加深色模式\n（來自LINE）');
    const status = { status: '已修正' as const, note: '設定頁可以切換', link: PR };
    expect(await markCommunityItem({ token: 't', channelId: '1', messageId: ID, mark: 'processed', status, fetchImpl: d.fetchImpl })).toBe('edited');
    expect(d.patches[0]).toBe(`【百科回報・建議】#R0000002 加深色模式\n（來自LINE）\n【處理・已修正】設定頁可以切換｜<${PR}>（已處理）`);
    expect(await markCommunityItem({ token: 't', channelId: '1', messageId: ID, mark: 'processed', status, fetchImpl: d.fetchImpl })).toBe('already');
    expect(await markCommunityItem({ token: 't', channelId: '1', messageId: ID, mark: 'processed', status: { status: '不處理', note: '先不做', link: null }, fetchImpl: d.fetchImpl })).toBe('edited');
    expect(d.patches).toHaveLength(2);
    const claim = dc('【ID認領】#C0000001 a ← b\nCLAIM:{"main":"a","others":["b"]}');
    expect(await markCommunityItem({ token: 't', channelId: '1', messageId: ID, mark: 'processed', status, fetchImpl: claim.fetchImpl })).toBe('not_found');
  });

  it('太長 → too_long，不編輯', async () => {
    const d = dc(`【百科回報・錯誤】#R0000003 ${'長'.repeat(1900)}\n（來自網站）`);
    expect(await markCommunityItem({ token: 't', channelId: '1', messageId: ID, mark: 'processed', status: { status: '已修正', note: '說明'.repeat(60), link: PR }, fetchImpl: d.fetchImpl })).toBe('too_long');
    expect(d.patches).toHaveLength(0);
  });
});
