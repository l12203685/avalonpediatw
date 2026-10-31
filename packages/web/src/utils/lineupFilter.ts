/**
 * 陣容強度篩選的畫面狀態（Edward 2026-10-31：「可以同時給出篩選功能：S = 場上 PR 的平均，直接用 S 來篩選；或是人數：
 * PR X 有 Y 人以上，X 跟 Y 都可以調整；而且這兩個條件都可以複選（且／或）」）。牌譜紀錄頁籤與統計頁的「更多篩選」共用。
 *
 * 判斷本身在 @avalon/shared/stats 的 matchesLineup；這裡只管開關與數字（關掉的條件也記得上次的數字）。
 * 純函式，packages/server/src/__tests__/WebRecords.test.ts 測。
 */
import type { LineupCondition } from '@avalon/shared/stats';

export interface LineupFilterState {
  /** S ≥ sMin 這個條件開了沒。 */
  sOn: boolean;
  sMin: number;
  /** 「PR strongPr 以上至少 strongCount 人」開了沒。 */
  countOn: boolean;
  strongPr: number;
  strongCount: number;
  /** 兩個條件都開時：且／或。 */
  combine: 'and' | 'or';
  /** 沒評分的局也列出來。 */
  includeUnscored: boolean;
}

/** 預設數字：S ≥ 65（歷史約 7.5% 的局）、PR 70 以上至少 6 人（約 3.8%）。 */
export const DEFAULT_LINEUP_FILTER: LineupFilterState = {
  sOn: false, sMin: 65, countOn: false, strongPr: 70, strongCount: 6, combine: 'and', includeUnscored: false,
};

/** 高強度（S ≥ 65）／偏強（≥ 55）：清單徽章的顏色分級。 */
export const LINEUP_HIGH_S = 65;
export const LINEUP_STRONG_S = 55;

export function lineupTier(s: number): 'high' | 'strong' | 'normal' {
  return s >= LINEUP_HIGH_S ? 'high' : s >= LINEUP_STRONG_S ? 'strong' : 'normal';
}

/** 畫面狀態 → 篩選條件（只放開著的條件；都關 = {}，不篩）。 */
export function lineupCondition(state: LineupFilterState): LineupCondition {
  const c: LineupCondition = {};
  if (state.sOn) c.sMin = state.sMin;
  if (state.countOn) {
    c.strongPr = state.strongPr;
    c.strongCount = state.strongCount;
  }
  if (state.sOn && state.countOn && state.combine === 'or') c.combine = 'or';
  if ((state.sOn || state.countOn) && state.includeUnscored) c.includeUnscored = true;
  return c;
}

/** 篩選條件 → 畫面狀態（沒開的條件用預設數字）。 */
export function lineupStateFromCondition(c: LineupCondition | null | undefined): LineupFilterState {
  if (!c) return { ...DEFAULT_LINEUP_FILTER };
  const sOn = typeof c.sMin === 'number';
  const countOn = typeof c.strongPr === 'number' && typeof c.strongCount === 'number';
  return {
    sOn,
    sMin: sOn ? (c.sMin as number) : DEFAULT_LINEUP_FILTER.sMin,
    countOn,
    strongPr: countOn ? (c.strongPr as number) : DEFAULT_LINEUP_FILTER.strongPr,
    strongCount: countOn ? (c.strongCount as number) : DEFAULT_LINEUP_FILTER.strongCount,
    combine: c.combine === 'or' ? 'or' : 'and',
    includeUnscored: c.includeUnscored === true,
  };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

/** 從儲存（或輸入框）來的值整理成合法狀態：S、PR 是 0–100 的整數，人數 1–10。 */
export function sanitizeLineupState(raw: unknown): LineupFilterState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_LINEUP_FILTER;
  return {
    sOn: r.sOn === true,
    sMin: clampInt(r.sMin, 0, 100, d.sMin),
    countOn: r.countOn === true,
    strongPr: clampInt(r.strongPr, 0, 100, d.strongPr),
    strongCount: clampInt(r.strongCount, 1, 10, d.strongCount),
    combine: r.combine === 'or' ? 'or' : 'and',
    includeUnscored: r.includeUnscored === true,
  };
}

/** 條件有沒有開（清除篩選的按鈕、符合幾局的說明用）。 */
export function lineupFilterActive(state: LineupFilterState): boolean {
  return state.sOn || state.countOn;
}
