/**
 * 分析頁的顯示規則 (純函式)。網站沒有測試框架，測試在
 * packages/server/src/__tests__/AnalysisDisplayRules.test.ts。
 */

/** 三紅 / 三藍死 / 三藍活 的百分比 (OutcomeBreakdown 的子集)。 */
export interface OutcomeSplitPct {
  threeRedPct: number;
  threeBlueDeadPct: number;
  threeBlueAlivePct: number;
}

/** 各位置三結果的最大差距 (百分點) 小於這個值就當作「每個位置都一樣」。 */
export const SEAT_OUTCOME_MIN_SPREAD = 1;

/**
 * 位置勝率圖的滑鼠提示要不要列「三紅 · 三藍死 · 三藍活」。
 *
 * 一局只有一個結果，而且 10 個位置都有人坐，所以 overview.seatPositionWinRates[].outcomes
 * 每個位置都是全體的分布 (現在的快取：10 個位置都是三紅 45.5 %)。玩家看到每個位置都 46 %
 * (2026-10-13 玩家反應「全員 46%」)，所以只有各位置真的有差 (≥ SEAT_OUTCOME_MIN_SPREAD 百分點)
 * 才列。少於兩個位置有資料也不列。
 */
export function seatOutcomesDiffer(
  seats: ReadonlyArray<{ outcomes?: OutcomeSplitPct | null }>,
  minSpread: number = SEAT_OUTCOME_MIN_SPREAD,
): boolean {
  const splits = seats
    .map(s => s.outcomes)
    .filter((o): o is OutcomeSplitPct => !!o && typeof o === 'object');
  if (splits.length < 2) return false;
  const keys: Array<keyof OutcomeSplitPct> = ['threeRedPct', 'threeBlueDeadPct', 'threeBlueAlivePct'];
  return keys.some(k => {
    const vals = splits.map(o => o[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return vals.length >= 2 && Math.max(...vals) - Math.min(...vals) >= minSpread;
  });
}

/**
 * 三結果配對矩陣：兩人共同場次少於 minGames (與理論勝率的補值門檻 theoryMinCellGames 相同，預設 3)
 * 的格子不上紅藍色 (灰字虛線框) —— 1、2 場只會是 0 % / 50 % / 100 %，看起來像很強的傾向。
 * 滑鼠提示照樣有數字與場數。minGames 0 = 不區分；沒有場數 (舊快取) 也不區分。
 */
export function isThinPairCell(games: number | null | undefined, minGames: number): boolean {
  return typeof games === 'number' && Number.isFinite(minGames) && minGames > 0 && games < minGames;
}
