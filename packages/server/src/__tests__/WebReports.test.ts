/**
 * 網站「回報與修正」頁的純函式（packages/web/src/utils/reports.ts；web 沒有測試執行器，在這裡測）與 #reports 深連結。
 * 網站的型別要跟伺服器的 PublicReport 對得上：這裡直接拿伺服器格式的資料餵網站函式。內容是編的。
 */
import { describe, expect, it } from 'vitest';
import {
  addMyReport, countByStatus, feedbackPage, filterCount, filterReports, isReportsHash, pageLabel, parseMyReports, reportDateText,
  reportLinkText, sortNewest, type PublicReport as WebReport,
} from '../../../web/src/utils/reports';
import { PUBLIC_STATS_STATES, parseStatsHash } from '../../../web/src/utils/statsLinks';
import type { PublicReport } from '../services/reportBoard';

const base: PublicReport = {
  id: 'R0000001', createdAt: '2026-11-18T12:00:00.000Z', kind: 'bug', kindLabel: '錯誤', source: 'web', page: '/#records',
  text: '表格超出畫面', status: '收到', note: null, link: null, updatedAt: null,
};
const REPORTS: WebReport[] = [
  base,
  { ...base, id: 'R0000002', createdAt: '2026-11-19T01:00:00.000Z', status: '已修正', note: '改成可以左右滑', link: 'https://github.com/example/repo/pull/12' },
  { ...base, id: 'R0000003', createdAt: '2026-11-17T01:00:00.000Z', status: '處理中' },
  { ...base, id: 'R0000004', createdAt: '2026-11-16T01:00:00.000Z', status: '不處理', note: '先不做' },
  { ...base, id: 'R0000005', createdAt: '2026-11-01T01:00:00.000Z', status: '已處理' },
];

describe('回報與修正：純函式', () => {
  it('新的在前；篩選與數字', () => {
    expect(sortNewest(REPORTS).map((r) => r.id)).toEqual(['R0000002', 'R0000001', 'R0000003', 'R0000004', 'R0000005']);
    expect(filterReports(REPORTS, 'all')).toHaveLength(5);
    expect(filterReports(REPORTS, 'open').map((r) => r.id)).toEqual(['R0000001', 'R0000003']);
    expect(filterReports(REPORTS, '已修正').map((r) => r.id)).toEqual(['R0000002']);
    const counts = countByStatus(REPORTS);
    expect(counts).toEqual({ 收到: 1, 處理中: 1, 已修正: 1, 已處理: 1, 不處理: 1 });
    expect(filterCount(counts, 'all')).toBe(5);
    expect(filterCount(counts, 'open')).toBe(2);
    expect(filterCount(counts, '不處理')).toBe(1);
  });

  it('日期（台北）、頁面名稱、連結字', () => {
    const now = Date.UTC(2026, 10, 19);
    expect(reportDateText('2026-11-18T17:00:00.000Z', now)).toBe('11/19'); // 台北已經是 19 號
    expect(reportDateText('2025-03-02T00:00:00.000Z', now)).toBe('2025/3/2');
    expect(reportDateText('壞的', now)).toBe('');
    expect(pageLabel('/#records=1570000000000000001')).toBe('牌譜紀錄');
    expect(pageLabel('/#wiki=merlin-basics')).toBe('百科攻略');
    expect(pageLabel('/#analytics')).toBe('戰績排行');
    expect(pageLabel('/#aiGames')).toBe('百科AI 對局');
    expect(pageLabel('/#idClaim')).toBe('ID 認領');
    expect(pageLabel('/')).toBe('');
    expect(pageLabel(null)).toBe('');
    expect(pageLabel('/#something')).toBe('#something');
    expect(reportLinkText('https://github.com/example/repo/pull/12')).toBe('PR #12');
    expect(reportLinkText('https://example.com/x')).toBe('example.com');
  });

  it('回報帶的頁面：有 # 用 #，沒有就用現在的頁面', () => {
    expect(feedbackPage('/', '#wiki=abc', 'wiki')).toBe('/#wiki=abc');
    expect(feedbackPage('/', '', 'records')).toBe('/#records');
    expect(feedbackPage('/', '', 'home')).toBe('/');
  });

  it('自己送過的編號', () => {
    expect(parseMyReports('["R0000001","bad",3]')).toEqual(['R0000001']);
    expect(parseMyReports('not json')).toEqual([]);
    expect(addMyReport(['R0000001'], 'R0000002')).toEqual(['R0000002', 'R0000001']);
    expect(addMyReport(['R0000001'], 'R0000001')).toEqual(['R0000001']);
    expect(addMyReport([], 'C0000001')).toEqual([]);
    expect(addMyReport(Array.from({ length: 50 }, (_, i) => `R${String(i).padStart(7, '0')}`), 'R9999999')).toHaveLength(50);
  });
});

describe('#reports 深連結', () => {
  it('#reports、#feedback、#fixes、#回報 → 回報與修正（不用登入）', () => {
    for (const h of ['#reports', '#report', '#feedback', '#fixes', '#回報', `#${encodeURIComponent('回報')}`]) {
      expect(isReportsHash(h)).toBe(true);
      expect(parseStatsHash(h)).toEqual({ kind: 'reports' });
    }
    expect(isReportsHash('#records')).toBe(false);
    expect(PUBLIC_STATS_STATES.has('reports')).toBe(true);
  });
});
