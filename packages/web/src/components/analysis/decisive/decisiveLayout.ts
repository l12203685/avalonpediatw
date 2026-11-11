/**
 * 排行「關鍵外白／內黑」的版面常數（DecisiveBoard、玩家雷達「兩紅之後」的關鍵票那一行）。
 * 定義與算法在 @avalon/shared stats/decisiveVotes.ts。
 */
import { DECISIVE_MIN_N, type DecisiveGroup, type DecisiveRankScope } from '@avalon/shared/stats';
import { rememberSectionTab } from '../ui/SectionTabs';

/** 數據排行裡這個榜的小分頁 id（不會跟快取的榜 id 撞到）。 */
export const DECISIVE_TAB = '__decisive';
/** 數據排行小分頁的記憶鍵（LeaderboardBoards 的 SectionTabs persistKey）。 */
export const BOARDS_PERSIST_KEY = 'boards';
/** 範圍切換的記憶鍵。 */
export const DECISIVE_SCOPE_KEY = 'boards.decisive.scope';

/** 上榜門檻的選項（非中性的關鍵票張數）；預設 DECISIVE_MIN_N = 30。 */
export const DECISIVE_MIN_OPTIONS = [5, 10, 20, DECISIVE_MIN_N, 60, 100] as const;
/** 有篩選（範圍變窄）時的預設門檻。 */
export const DECISIVE_MIN_FILTERED = 10;

/** 四組的統計名詞（表頭的滑鼠提示）。 */
export const DECISIVE_GROUP_TERMS = {
  onYes: 'decisiveOnYes',
  onNo: 'decisiveOnNo',
  offYes: 'decisiveOffYes',
  offNo: 'decisiveOffNo',
} as const satisfies Record<DecisiveGroup, string>;

/** 角色的顏色（小長條）：忠臣藍、派西維爾紫、梅林金。 */
export const DECISIVE_ROLE_COLORS = { 忠臣: '#60a5fa', 派西維爾: '#a78bfa', 梅林: '#fbbf24' } as const;

/** 玩家雷達「兩紅之後」的「看排行」：數據排行打開這個榜、範圍切到兩紅之後。 */
export function rememberDecisiveBoard(scope: DecisiveRankScope = 'twoRed'): void {
  rememberSectionTab(BOARDS_PERSIST_KEY, DECISIVE_TAB);
  rememberSectionTab(DECISIVE_SCOPE_KEY, scope);
}
