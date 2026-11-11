import { create } from 'zustand';
import type { DiscoveryPage, StrengthGrouping } from '@avalon/shared/stats';

/**
 * 分析分頁之間的跳轉（自動發現的「看全部」與「在組成比較打開」、玩家雷達的「看各組」）：AnalysisSection 看到 tab 就切過去，
 * 陣容強度分頁看到 view／grouping／page 就切小分頁、套分組或清單的分頁篩選。nonce 讓同一個要求可以再按一次。
 */
export interface DiscoveryNavState {
  tab: 'strength' | null;
  view: 'compare' | 'discovery' | 'twoRedCohort' | null;
  grouping: StrengthGrouping | null;
  page: DiscoveryPage | null;
  nonce: number;
  openList: (page: DiscoveryPage | null) => void;
  openGrouping: (grouping: StrengthGrouping) => void;
  /** 打開陣容強度的某個小分頁（例：玩家雷達「兩紅之後」的「看各組」→ 兩紅派隊分組）。 */
  openView: (view: 'twoRedCohort') => void;
  consumed: () => void;
  /** 陣容強度分頁已經切到要求的小分頁。 */
  consumeView: () => void;
}

export const useDiscoveryNav = create<DiscoveryNavState>((set) => ({
  tab: null,
  view: null,
  grouping: null,
  page: null,
  nonce: 0,
  openList: (page): void => set((s) => ({ tab: 'strength', view: 'discovery', page, grouping: null, nonce: s.nonce + 1 })),
  openGrouping: (grouping): void => set((s) => ({ tab: 'strength', view: 'compare', grouping, page: null, nonce: s.nonce + 1 })),
  openView: (view): void => set((s) => ({ tab: 'strength', view, page: null, grouping: null, nonce: s.nonce + 1 })),
  consumed: (): void => set({ tab: null }),
  consumeView: (): void => set({ view: null }),
}));
