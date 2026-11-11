/**
 * 分組（九宮格）的小工具：百分比只四捨五入一次、組名的 i18n 鍵、樣本不足的門檻。
 * 慣例見 @avalon/shared stats/cohort.ts 檔頭（樣本太小 → 看合併的組／S × PR 九宮格）。
 */
import type { PlayerTierKey, TableTierKey } from '@avalon/shared/stats';

/** 一格的樣本數低於這個值時變淡（4 以下差一次就差 25 個百分點以上）。 */
export const COHORT_MIN_N = 5;

/** k / n 的整數百分比（只取整一次）；n = 0 → —。 */
export const cohortPct = (k: number, n: number, digits = 0): string => (n > 0 ? `${((100 * k) / n).toFixed(digits)}%` : '—');

export const K = 'analytics.cohort';
export const playerTierKey = (tier: PlayerTierKey | 'all'): string => `${K}.player.${tier}`;
export const tableTierKey = (tier: TableTierKey | 'all'): string => `${K}.table.${tier}`;

/** 上色的收縮：每格先加上 SHADE_PRIOR 筆「全體比率」的假想樣本再比（樣本少的格被拉向全體，不會因為幾票就最深）。 */
export const SHADE_PRIOR = 30;
/** 上色的固定刻度：（收縮後）跟全體差 SHADE_FULL（10 個百分點）以上才是最深；差一兩個百分點幾乎看不出顏色。 */
export const SHADE_FULL = 0.1;

/**
 * 一格的顏色深淺：-1（比全體低 ≥ 10 個百分點，偏藍）～ 0（跟全體一樣，不上色）～ 1（高 ≥ 10 個百分點，偏黃）；
 * 樣本不到 minN 或全體沒有樣本 → null。固定刻度、不是表內最小到最大拉滿，所以組間差很小時整張幾乎不上色（審查 2026-11-11）。
 */
export function cohortShade(
  { k, n }: { k: number; n: number }, all: { k: number; n: number }, minN: number,
): number | null {
  if (n < minN || all.n <= 0) return null;
  const base = all.k / all.n;
  const shrunk = (k + SHADE_PRIOR * base) / (n + SHADE_PRIOR);
  return Math.max(-1, Math.min(1, (shrunk - base) / SHADE_FULL));
}
