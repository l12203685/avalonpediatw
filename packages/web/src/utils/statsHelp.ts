import { useGameStore, type GameState } from '../store/gameStore';

/**
 * 從數據頁 (戰績排行／分析) 的 ⓘ「完整說明」跳到說明頁的「統計名詞與算法」區塊 (Edward 2026-10-30：
 * 「理論勝率的右邊 上綁文字說明有點太過冗長 … 可以另外全部集中丟到說明頁面 或是用滑鼠移過去再顯示定義跟算法就好」)。
 *
 * 記住從哪一頁來，說明頁的「返回」回到那一頁；進說明頁後捲到該區塊。
 */
export const STATS_HELP_ANCHOR = 'stat-terms';

let returnTo: GameState | null = null;
let pendingAnchor: string | null = null;

export function openStatsHelp(anchor: string = STATS_HELP_ANCHOR): void {
  const { gameState, setGameState } = useGameStore.getState();
  if (gameState !== 'help') returnTo = gameState;
  pendingAnchor = anchor;
  setGameState('help');
}

/** 說明頁「返回」要回去的頁面 (沒有從數據頁來 → null)；取一次就清掉。 */
export function takeStatsHelpReturn(): GameState | null {
  const r = returnTo;
  returnTo = null;
  return r;
}

/** 說明頁掛上時要捲到的區塊 id (捲完再 clearStatsHelpAnchor；StrictMode 會把 effect 跑兩次，不能讀一次就清)。 */
export function peekStatsHelpAnchor(): string | null {
  return pendingAnchor;
}

export function clearStatsHelpAnchor(): void {
  pendingAnchor = null;
}
