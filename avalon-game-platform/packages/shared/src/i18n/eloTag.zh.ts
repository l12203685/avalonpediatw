/**
 * ELO 標籤中文顯示。Edward 2026-04-24 13:43 雙維度分類：
 *   - novice_tag → 入門新手
 *   - mid_tag    → 中堅玩家
 *   - top_tag    → 頂尖高玩
 *
 * Edward 2026-04-24：UI tab 標籤改「純數字 label」，讓玩家一眼看懂門檻。
 */

import type { EloTag } from '../derived/gameMetrics';
import type { TierGroup } from '../derived/gameMetrics';

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
 * TierGroup 中文顯示（純數字門檻 label，UI tab 標籤用）。
 *
 * Edward 2026-04-24：捨棄「菜鳥/常客/老手/專家/大師」字面，改純數字，
 * 讓玩家一眼看出每組的場次門檻、不再需要記術語對照。
 */
export const TIER_GROUP_LABEL_ZH: Record<TierGroup, string> = {
  rookie: '< 100 場',
  regular: '≥ 100 場',
  veteran: '≥ 150 場',
  expert: '≥ 200 場',
  master: '≥ 250 場',
};

/**
 * @deprecated 2026-04-24 Edward 捨字面 label，改用 `TIER_GROUP_LABEL_ZH`（純數字）。
 * 保留此 alias 以不破壞舊呼叫端；所有 UI 請改用 `TIER_GROUP_LABEL_ZH`。
 */
export const TIER_GROUP_ZH: Record<TierGroup, string> = TIER_GROUP_LABEL_ZH;
