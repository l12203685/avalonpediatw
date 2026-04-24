/**
 * ELO 標籤中文顯示。Edward 2026-04-24 13:43 雙維度分類：
 *   - novice_tag → 入門新手
 *   - mid_tag    → 中堅玩家
 *   - top_tag    → 頂尖高玩
 */

import type { EloTag } from '../derived/gameMetrics';

export const ELO_TAG_ZH: Record<EloTag, string> = {
  novice_tag: '入門新手',
  mid_tag: '中堅玩家',
  top_tag: '頂尖高玩',
};

/** Format an EloTag to its Chinese display. Unknown / null / undefined → ''. */
export function formatEloTagZh(tag: EloTag | null | undefined | string): string {
  if (tag == null || tag === '') return '';
  if (tag in ELO_TAG_ZH) return ELO_TAG_ZH[tag as EloTag];
  return String(tag);
}

/**
 * TierGroup 中文顯示（場次組對照表，UI tab 標籤用）。
 */
export const TIER_GROUP_ZH = {
  rookie: '菜鳥',
  regular: '常客',
  veteran: '老手',
  expert: '專家',
  master: '大師',
} as const;
