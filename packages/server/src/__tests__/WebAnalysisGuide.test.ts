/**
 * 數據分析的整理（2026-11-16 Edward：「數據分析有點太多太亂 也不知道怎麼去看數據或是從數據衍生出可以改善或優化的策略和方向」）：
 *  - 每個分析分頁都有一句「怎麼用」（繁中、英文）；
 *  - 「從這裡開始」的四個問題與按鈕文字都有；
 *  - 自動發現清單與兩紅派隊分組的跳轉改到「發現與策略」，組成比較照舊在陣容強度；
 *  - 座位寫 N 家／0 家，不寫 10 號／10 家。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { useDiscoveryNav } from '../../../web/src/components/analysis/discovery/discoveryNav';

const web = path.resolve(__dirname, '..', '..', '..', 'web', 'src');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 讀 i18n JSON，結構很深
const load = (lang: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(web, 'i18n', 'locales', lang, 'common.json'), 'utf-8'));
const page = fs.readFileSync(path.join(web, 'pages', 'AnalyticsPage.tsx'), 'utf-8');
const tabIds = [...page.matchAll(/\{ id: '(\w+)',\s+labelKey: 'analytics\.analysis\.tabs\.\1'/g)].map((m) => m[1]);

describe('數據分析：從這裡開始、怎麼用、發現與策略', () => {
  it('分頁清單：發現與策略緊接在總覽後面', () => {
    expect(tabIds.slice(0, 2)).toEqual(['overview', 'findings']);
    expect(tabIds).toHaveLength(12);
  });

  for (const lang of ['zh-TW', 'en']) {
    it(`${lang}：每個分頁都有標籤與一句怎麼用；從這裡開始的問題、說明、按鈕都有`, () => {
      const a = load(lang).analytics.analysis;
      for (const id of tabIds) {
        expect(typeof a.tabs[id], `tabs.${id}`).toBe('string');
        expect(a.howTo[id], `howTo.${id}`).toMatch(/\S{4}/);
      }
      for (const q of ['improve', 'situation', 'role', 'strategy']) {
        expect(a.startHere.q[q].q).toBeTruthy();
        expect(a.startHere.q[q].how).toBeTruthy();
      }
      const start = fs.readFileSync(path.join(web, 'components', 'analysis', 'StartHere.tsx'), 'utf-8');
      const targets = [...start.matchAll(/'((?:findings:)?\w+)'/g)].map((m) => m[1]).filter((x) => x in a.startHere.go || x.replace(':', '_') in a.startHere.go);
      expect(targets.length).toBeGreaterThanOrEqual(7);
      expect(a.more.tab).toBeTruthy();
      expect(a.findings.discovery).toBeTruthy();
    });
  }

  it('繁中的新文字不寫 10 號／10 家', () => {
    const a = load('zh-TW').analytics.analysis;
    const text = JSON.stringify({ howTo: a.howTo, startHere: a.startHere, more: a.more, findings: a.findings, link: a.overviewTheoryLink });
    expect(text).not.toMatch(/10\s*[號家]|6～10|1～10/);
  });

  it('跳轉：自動發現清單、兩紅派隊分組去發現與策略；組成比較去陣容強度', () => {
    const nav = useDiscoveryNav.getState();
    nav.openList('lake');
    expect(useDiscoveryNav.getState()).toMatchObject({ tab: 'findings', view: 'discovery', page: 'lake' });
    nav.openView('twoRedCohort');
    expect(useDiscoveryNav.getState()).toMatchObject({ tab: 'findings', view: 'twoRedCohort' });
    nav.openGrouping({ kind: 'tier' } as never);
    expect(useDiscoveryNav.getState()).toMatchObject({ tab: 'strength', view: 'compare' });
  });
});
