import { create } from 'zustand';
import type { DiscoveryPage, StrengthGrouping } from '@avalon/shared/stats';

/**
 * 分析分頁之間的跳轉（自動發現的「看全部」與「在組成比較打開」、玩家雷達的「看各組」、「從這裡開始」的按鈕）：AnalysisSection
 * 看到 tab 就切過去；「發現與策略」分頁看到 view／page 就切到自動發現清單（套分頁篩選）或兩紅派隊分組，陣容強度分頁看到
 * grouping 就切到組成比較並套分組。nonce 讓同一個要求可以再按一次。
 * （2026-11-16 Edward「數據分析太多太亂」：自動發現與兩紅派隊分組從陣容強度搬到「發現與策略」；2026-11-17 改版後自動發現清單與
 * 組成比較在「進階」、兩紅派隊分組在「派隊與投票」。）
 */
export interface DiscoveryNavState {
  /** 要切到的分頁（2026-11-17 改版後的 id，coreTabs.ts）：自動發現清單、組成比較在「進階」，兩紅派隊分組在「派隊與投票」。 */
  tab: 'advanced' | 'teamsVotes' | null;
  view: 'compare' | 'discovery' | 'twoRedCohort' | null;
  grouping: StrengthGrouping | null;
  page: DiscoveryPage | null;
  nonce: number;
  openList: (page: DiscoveryPage | null) => void;
  openGrouping: (grouping: StrengthGrouping) => void;
  /** 打開「發現與策略」的兩紅派隊分組（例：玩家雷達「兩紅之後」的「看各組」）。 */
  openView: (view: 'twoRedCohort') => void;
  consumed: () => void;
  /** 目標分頁已經切到要求的小分頁。 */
  consumeView: () => void;
}

export const useDiscoveryNav = create<DiscoveryNavState>((set) => ({
  tab: null,
  view: null,
  grouping: null,
  page: null,
  nonce: 0,
  openList: (page): void => set((s) => ({ tab: 'advanced', view: 'discovery', page, grouping: null, nonce: s.nonce + 1 })),
  openGrouping: (grouping): void => set((s) => ({ tab: 'advanced', view: 'compare', grouping, page: null, nonce: s.nonce + 1 })),
  openView: (view): void => set((s) => ({ tab: 'teamsVotes', view, page: null, grouping: null, nonce: s.nonce + 1 })),
  consumed: (): void => set({ tab: null }),
  consumeView: (): void => set({ view: null }),
}));
