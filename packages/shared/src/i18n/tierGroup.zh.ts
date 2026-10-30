/**
 * 場次組 TierGroup 的中文顯示。
 *
 * （原 eloTag.zh.ts：2026-10-30 舊 V2 ELO 與 ELO 標籤移除，只留場次組的標籤。）
 */

import type { TierGroup } from '../derived/gameMetrics';

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
