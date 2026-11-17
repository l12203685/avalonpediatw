import { rememberSectionTab } from '../ui/SectionTabs';

/**
 * 數據分析的分頁（2026-11-17 Edward：「現在的網站數據有多過於發散了…應用比較重要 先看大方向就好 真的要看細節才深入去看
 * 要符合我們的核心: 任務結果 > 湖中女神 > 隊伍派票組合 & 黑白球投票 > 發言資訊 & 狀態」）：
 *   總覽（三層各一兩句大方向＋可以怎麼做）→ 照核心優先序一層一頁 → 進階（位置、角色、陣容強度、玩家雷達、完整的自動發現）。
 * （同日 Edward：「發言與狀態不是屬於數據的一環吧 所以不需要特別呈現 局勢樹比較像 任務結果 x 湖中女神」→ 沒有「發言與狀態」分頁，
 *  局勢樹是任務結果的小分頁「任務 × 湖中（局勢樹）」，湖中女神那頁有連過去的按鈕。）
 * 舊的 12 個分頁 id 都還認得（研究連結 #study=、「從這裡開始」、自動發現的跳轉、排行點名字），導到新分頁裡對應的小分頁。
 */
export type CoreTab = 'overview' | 'missions' | 'lake' | 'teamsVotes' | 'advanced';

/** 分頁順序 = 核心優先序；進階放最後。 */
export const CORE_TABS: readonly CoreTab[] = ['overview', 'missions', 'lake', 'teamsVotes', 'advanced'];

/** 舊的 12 個分頁 id（2026-11-16 版）。 */
export type LegacyTab =
  | 'overview' | 'findings' | 'teams' | 'votes' | 'missions'
  | 'lake' | 'assassination' | 'position' | 'roles' | 'strength' | 'stateTree' | 'players';

/** 各新分頁裡小分頁的記憶鍵（SectionTabs persistKey）。 */
export const CORE_PERSIST: Readonly<Record<'missions' | 'teamsVotes' | 'advanced', string>> = {
  missions: 'analysis.core.missions',
  teamsVotes: 'analysis.core.teamsVotes',
  advanced: 'analysis.core.advanced',
};

export type MissionsSub = 'missions' | 'stateTree' | 'paths' | 'assassination';
export type TeamsVotesSub = 'teams' | 'votes' | 'twoRed';
export type AdvancedSub = 'discovery' | 'position' | 'roles' | 'strength' | 'players';

export interface CoreTarget {
  tab: CoreTab;
  /** 新分頁裡要打開的小分頁（沒有 = 照記憶或第一個）。 */
  sub?: string;
}

/** 舊 id → 新分頁＋小分頁。舊的「派隊 › 任務進程」跟任務的通過率重複，併進任務結果（完整任務路徑另外一個小分頁）。 */
export const LEGACY_TABS: Readonly<Record<LegacyTab, CoreTarget>> = {
  overview: { tab: 'overview' },
  missions: { tab: 'missions', sub: 'missions' },
  assassination: { tab: 'missions', sub: 'assassination' },
  lake: { tab: 'lake' },
  teams: { tab: 'teamsVotes', sub: 'teams' },
  votes: { tab: 'teamsVotes', sub: 'votes' },
  stateTree: { tab: 'missions', sub: 'stateTree' },
  findings: { tab: 'advanced', sub: 'discovery' },
  position: { tab: 'advanced', sub: 'position' },
  roles: { tab: 'advanced', sub: 'roles' },
  strength: { tab: 'advanced', sub: 'strength' },
  players: { tab: 'advanced', sub: 'players' },
};

/** 新 id 原樣；舊 id 照 LEGACY_TABS；不認得 → null。 */
export function resolveTab(id: string | null | undefined): CoreTarget | null {
  if (!id) return null;
  if ((CORE_TABS as readonly string[]).includes(id)) return { tab: id as CoreTab };
  // 改版初稿的「發言與狀態」分頁（只存在於 PR #54 的初版）：導到局勢樹
  if (id === 'state') return { tab: 'missions', sub: 'stateTree' };
  return (LEGACY_TABS as Record<string, CoreTarget>)[id] ?? null;
}

/** 切到目標之前先記下小分頁，新分頁掛載時就打開它。 */
export function rememberTarget(target: CoreTarget): void {
  if (!target.sub) return;
  const key = (CORE_PERSIST as Record<string, string>)[target.tab];
  if (key) rememberSectionTab(key, target.sub);
}
