/**
 * 數據分析的整理（2026-11-16 Edward：「數據分析有點太多太亂 也不知道怎麼去看數據或是從數據衍生出可以改善或優化的策略和方向」）：
 *  - 每個分析分頁都有一句「怎麼用」（繁中、英文）；
 *  - 「從這裡開始」的四個問題與按鈕文字都有；
 *  - 自動發現清單與兩紅派隊分組的跳轉改到「發現與策略」，組成比較照舊在陣容強度；
 *  - 座位寫 N 家／0 家，不寫 10 號／10 家。
 * 2026-11-17 改版（Edward：「要符合我們的核心: 任務結果 > 湖中女神 > 隊伍派票組合 & 黑白球投票 > 發言資訊 & 狀態」「先看大方向」）：
 *  - 分頁照核心優先序：總覽、任務結果、湖中女神、派隊與投票、進階（同日：「發言與狀態不是屬於數據的一環吧…局勢樹比較像
 *    任務結果 x 湖中女神」→ 沒有發言與狀態分頁，局勢樹是任務結果的小分頁）；
 *  - 舊的 12 個分頁 id 都導得到新分頁的小分頁（研究連結、從這裡開始、自動發現跳轉、排行點名字）；
 *  - 總覽三層大方向的文字（數據＋可以怎麼做）兩種語言都有。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { useDiscoveryNav } from '../../../web/src/components/analysis/discovery/discoveryNav';
import { CORE_TABS, LEGACY_TABS, resolveTab } from '../../../web/src/components/analysis/core/coreTabs';
import { STUDY_HOME_TAB } from '../../../web/src/components/analytics/studyLink';
import { topPathShare } from '../../../web/src/components/analysis/roundsPaths';

const web = path.resolve(__dirname, '..', '..', '..', 'web', 'src');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 讀 i18n JSON，結構很深
const load = (lang: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(web, 'i18n', 'locales', lang, 'common.json'), 'utf-8'));
const page = fs.readFileSync(path.join(web, 'pages', 'AnalyticsPage.tsx'), 'utf-8');
const tabIds = [...page.matchAll(/\{ id: '(\w+)',\s+labelKey: 'analytics\.analysis\.core\.tabs\.\1'/g)].map((m) => m[1]);
const LEGACY_IDS = ['overview', 'findings', 'teams', 'votes', 'missions', 'lake', 'assassination', 'position', 'roles', 'strength', 'stateTree', 'players'];

describe('數據分析：從這裡開始、怎麼用、發現與策略', () => {
  it('分頁清單照核心優先序：總覽 → 任務結果 → 湖中女神 → 派隊與投票 → 進階（沒有發言與狀態）', () => {
    expect(tabIds).toEqual(['overview', 'missions', 'lake', 'teamsVotes', 'advanced']);
    expect([...CORE_TABS]).toEqual(tabIds);
  });

  it('舊的 12 個分頁 id 都導得到新分頁（小分頁對得上）', () => {
    for (const id of LEGACY_IDS) expect(resolveTab(id), id).not.toBeNull();
    expect(Object.keys(LEGACY_TABS).sort()).toEqual([...LEGACY_IDS].sort());
    expect(resolveTab('assassination')).toEqual({ tab: 'missions', sub: 'assassination' });
    expect(resolveTab('votes')).toEqual({ tab: 'teamsVotes', sub: 'votes' });
    expect(resolveTab('teams')).toEqual({ tab: 'teamsVotes', sub: 'teams' });
    // 局勢樹 = 任務結果 × 湖中女神：任務結果的小分頁；改版初稿的 'state' 也導過去
    expect(resolveTab('stateTree')).toEqual({ tab: 'missions', sub: 'stateTree' });
    expect(resolveTab('state')).toEqual({ tab: 'missions', sub: 'stateTree' });
    expect(resolveTab('findings')).toEqual({ tab: 'advanced', sub: 'discovery' });
    expect(resolveTab('players')).toEqual({ tab: 'advanced', sub: 'players' });
    expect(resolveTab('teamsVotes')).toEqual({ tab: 'teamsVotes' });
    expect(resolveTab('nope')).toBeNull();
    // 研究連結（#study=）的舊分頁也導得到
    for (const [study, tab] of Object.entries(STUDY_HOME_TAB)) expect(resolveTab(tab), study).not.toBeNull();
  });

  for (const lang of ['zh-TW', 'en']) {
    it(`${lang}：每個分頁都有標籤與一句怎麼用；從這裡開始的問題、說明、按鈕都有`, () => {
      const a = load(lang).analytics.analysis;
      for (const id of tabIds) {
        expect(typeof a.core.tabs[id], `core.tabs.${id}`).toBe('string');
        expect(a.core.howTo[id], `core.howTo.${id}`).toMatch(/\S{4}/);
      }
      // 小分頁標籤沿用舊分頁的標籤
      for (const id of ['players', 'position', 'roles', 'strength', 'missions']) expect(typeof a.tabs[id]).toBe('string');
      expect(a.core.tabs.state).toBeUndefined();
      expect(a.core.lake.stateTreeLink).toBeTruthy();
      for (const layer of ['missions', 'lake', 'teamsVotes']) {
        expect(a.core[layer].title, `${layer}.title`).toBeTruthy();
        expect(a.core[layer].action, `${layer}.action`).toMatch(/\S{6}/);
      }
      for (const sub of ['missions', 'stateTree', 'paths', 'assassination', 'votes', 'teams', 'twoRed']) expect(a.core.sub[sub]).toBeTruthy();
      expect(a.core.actionLabel).toBeTruthy();
      expect(a.core.details).toBeTruthy();
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
    const text = JSON.stringify({ howTo: a.howTo, startHere: a.startHere, more: a.more, findings: a.findings, link: a.overviewTheoryLink, core: a.core });
    expect(text).not.toMatch(/10\s*[號家]|6～10|1～10/);
  });

  it('跳轉：自動發現清單、組成比較去進階；兩紅派隊分組去派隊與投票', () => {
    const nav = useDiscoveryNav.getState();
    nav.openList('lake');
    expect(useDiscoveryNav.getState()).toMatchObject({ tab: 'advanced', view: 'discovery', page: 'lake' });
    nav.openView('twoRedCohort');
    expect(useDiscoveryNav.getState()).toMatchObject({ tab: 'teamsVotes', view: 'twoRedCohort' });
    nav.openGrouping({ kind: 'tier' } as never);
    expect(useDiscoveryNav.getState()).toMatchObject({ tab: 'advanced', view: 'compare' });
  });

  // PR #54 review：排行點名字之後 focus 一直不是 null；進階分頁之後每次掛載都強制切玩家雷達，
  // 會蓋掉記下的小分頁（從這裡開始 → 角色／位置）與自動發現「看全部」的跳轉。
  it('排行點名字只在點的那一下切到玩家雷達（由頁面記下小分頁），進階分頁掛載時不看 focus 切小分頁', () => {
    const views = fs.readFileSync(path.join(web, 'components', 'analysis', 'core', 'CoreTabViews.tsx'), 'utf-8');
    const advanced = views.slice(views.indexOf('export function AdvancedCoreTab'));
    expect(advanced).not.toMatch(/if \(focus\)/);
    expect(advanced).not.toMatch(/setView\('players'\)/);
    // 頁面：一進來就有 focus → 進階 › 玩家雷達；focus 換了 → goTo（記下小分頁再重新掛載）
    expect(resolveTab('players')).toEqual({ tab: 'advanced', sub: 'players' });
    expect(page).toMatch(/if \(focus\) return resolveTab\('players'\)/);
    expect(page).toMatch(/if \(focus !== seenFocus\) \{\s*setSeenFocus\(focus\);\s*if \(focus\) goTo\(resolveTab\('players'\)\);/);
  });

  // PR #54 review：快取的路徑只留最常見的 20 種（也不含沒有路徑的局），拿表上路徑加總當分母會高估最常見那條的比例。
  it('最常見的路徑：分母是全部有路徑的局（任務 1 分支），不是表上前 20 種路徑的加總', () => {
    const gameStates = Array.from({ length: 20 }, (_, i) => ({ state: `S${i}`, games: 100 - i }));
    const shown = gameStates.reduce((s, r) => s + r.games, 0); // 1810
    const got = topPathShare({ gameStates, mission1Branch: [{ games: 1500 }, { games: 1000 }] });
    expect(got).toMatchObject({ path: 'S0', n: 100, total: 2500 });
    expect(got!.share).toBeCloseTo(4, 10);
    expect(got!.share).toBeLessThan((100 / shown) * 100);
    // 舊快取沒有分支、或分支比最常見那條還少（對不上）→ 不講比例
    expect(topPathShare({ gameStates, mission1Branch: [] })).toBeNull();
    expect(topPathShare({ gameStates, mission1Branch: [{ games: 50 }] })).toBeNull();
    expect(topPathShare({ gameStates: [], mission1Branch: [{ games: 10 }] })).toBeNull();
    // 兩個地方（任務進程、完整任務路徑）都用它，不再自己加總路徑
    const rounds = fs.readFileSync(path.join(web, 'components', 'analysis', 'RoundsAnalysis.tsx'), 'utf-8');
    expect(rounds.match(/topPathShare\(data\)/g)?.length).toBe(2);
    expect(rounds).not.toMatch(/pathRows\.reduce/);
  });
});
