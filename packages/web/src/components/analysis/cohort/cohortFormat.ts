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
