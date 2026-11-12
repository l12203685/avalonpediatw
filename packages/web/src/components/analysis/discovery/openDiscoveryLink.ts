import { rememberSectionTab } from '../ui/SectionTabs';
import { BOARDS_PERSIST_KEY, DECISIVE_COHORT_KIND_KEY, DECISIVE_COHORT_VIEW_KEY, DECISIVE_TAB, DECISIVE_SCOPE_KEY } from '../decisive/decisiveLayout';
import { useGameStore } from '../../../store/gameStore';
import { useDiscoveryNav } from './discoveryNav';
import type { FindingLink } from './discoveryText';

/**
 * 自動發現的卡片「看數字」：兩紅派隊 → 數據分析 › 陣容強度 › 兩紅派隊分組（強者／一般人／新手的表與九宮格）；
 * 關鍵票／全部投票 → 戰績排行 › 關鍵外白／內黑（範圍、「關鍵票／全部投票」與八格對率小分頁先記住，那一頁掛載時讀到；最上面就是分組九宮格）。
 */
export function openDiscoveryLink(link: FindingLink): void {
  if (link.kind === 'twoRedCohort') {
    useGameStore.setState({ gameState: 'analysis' });
    useDiscoveryNav.getState().openView('twoRedCohort');
  } else {
    rememberSectionTab(BOARDS_PERSIST_KEY, DECISIVE_TAB);
    rememberSectionTab(DECISIVE_SCOPE_KEY, link.scope ?? 'r35');
    rememberSectionTab(DECISIVE_COHORT_KIND_KEY, link.kind === 'decisiveBoardAll' ? 'all' : 'decisive');
    // 卡片的數字是八格對率；上次停在「場外藍票」也要切回八格
    rememberSectionTab(DECISIVE_COHORT_VIEW_KEY, 'cells');
    // 要清掉 statsFocus：戰績排行看到 statsFocus 會再跳回玩家雷達（AnalyticsPage）
    useGameStore.setState({ gameState: 'analytics', statsFocus: null });
  }
  window.scrollTo({ top: 0 });
}
