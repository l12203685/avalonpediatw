/**
 * 模擬瓦（2026-10-14）— LINE 打字指令：/模擬 /派 /區間 /下一步 /公布（/解答）/結束。
 *
 * 跟 /戰績 一樣：只回這幾個指令，一般聊天一律不回；回覆在送出成功後才 commit()（見 session.ts）。
 */

import { getSimEngine } from './index';
import type { SimReply, SimRequest } from './session';

/** 模擬指令的回覆，或 null（不是模擬指令／不該回）。 */
export function answerSimTextCommand(text: string, req: SimRequest): Promise<SimReply | null> {
  return getSimEngine().handleText(text, req);
}

/** LINE 1 對 1 的快速按鈕（群組裡不放：按鈕要放在最後一則，鏡像群的最後一則是同步訊息）。 */
export const SIM_QUICK_REPLY_TEXTS: readonly string[] = ['/下一步', '/公布', '/結束'];

export function simQuickReply(): { items: { type: 'action'; action: { type: 'message'; label: string; text: string } }[] } {
  return {
    items: SIM_QUICK_REPLY_TEXTS.map((text) => ({ type: 'action', action: { type: 'message', label: text.slice(1), text } })),
  };
}
