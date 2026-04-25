/**
 * V2 勝因 → 繁體中文顯示對應。
 *
 * 對應 `WinReasonV2`：
 *   - threeBlue_merlinAlive   三藍活（刺殺失敗 → 好人勝）
 *   - threeBlue_merlinKilled  三藍死（刺殺成功 → 壞人勝）
 *   - threeRed                三紅（任務三次失敗 → 壞人勝）
 *   - fiveRejections          五連否決（自動壞人勝）
 *   - hostCancelled           房主中止
 *
 * 實作要求：Edward Phase 2b 2026-04-24 指示。
 */

import type { WinReasonV2 } from '../types/game_v2';

export const WIN_REASON_ZH: Record<WinReasonV2, string> = {
  threeBlue_merlinAlive: '三藍勝 - 刺殺失敗',
  threeBlue_merlinKilled: '紅方勝 - 刺殺成功',
  threeRed: '紅方勝 - 三任務失敗',
  fiveRejections: '紅方勝 - 五連否決',
  hostCancelled: '房主取消',
};

/**
 * 勝因 enum → 中文字串；未命中回 fallback 英文 token（供降級顯示）。
 */
export function formatWinReasonZh(reason: WinReasonV2 | string | null | undefined): string {
  if (!reason) return '';
  const zh = WIN_REASON_ZH[reason as WinReasonV2];
  return zh ?? String(reason);
}
