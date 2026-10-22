/**
 * 模擬瓦（2026-10-14）— LINE 打字指令：/模擬 /派 /區間 /下一步 /公布（/解答）/結束。
 *
 * 跟 /戰績 一樣：只回這幾個指令，一般聊天一律不回；回覆在送出成功後才 commit()（見 session.ts）。
 *
 * Edward 2026-10-14 審查修正：
 *   - withSimLock()：同一個聊天室的模擬指令排隊，「算回覆 → 送出 → commit」一次一個；
 *   - isActiveSimCommand()：1 對 1 裡模擬指令沒有回覆（限流、重送、沒有題目的 /派西 2）時，
 *     不交給舊的指令處理（不然會回「未知指令」，限流也形同虛設）；
 *   - hideSimFollowUp()：鏡像群裡開著題目的人打的後續指令預設不同步到 Discord／大廳；
 *   - simHelpFor()：只回模擬的練習群（SIM_LINE_GROUP_IDS）也回 /指令。
 *
 * 2026-10-22 代答：群組裡自己沒開題的人打的寫對的後續指令（/派 /區間 /下一步 /公布 /結束）會作用在
 * 這個聊天室最新開的一題上，所以不同步（hideSimFollowUp）照那一題算；看不懂的 /派、/區間 不代答，
 * 沒有自己的題目時照舊同步。排隊（withSimLock）是整個聊天室一條（代答要動哪一題，輪到它時才決定）。
 */

import { isSimCommandText, parseSimCommand } from './commands';
import { SIM_CONFIG, simMirrorFollowUps } from './config';
import { getSimEngine } from './index';
import { SIM_HELP_TEXT } from './replies';
import type { SimReply, SimRequest } from './session';

/** 模擬指令的回覆，或 null（不是模擬指令／不該回）。 */
export function answerSimTextCommand(text: string, req: SimRequest): Promise<SimReply | null> {
  return getSimEngine().handleText(text, req);
}

/** 開關開著、而且這段文字是模擬指令（含看不懂的 /派西 2）。 */
export function isActiveSimCommand(text: string): boolean {
  return SIM_CONFIG.commandsEnabled && isSimCommandText(text);
}

/**
 * 模擬指令時，把 `fn`（算回覆、送出、commit）排在同一個聊天室的前一個模擬指令後面；其他文字直接跑。
 */
export function withSimLock<T>(req: Pick<SimRequest, 'platform' | 'chatId'>, text: string, fn: () => Promise<T>): Promise<T> {
  if (!isActiveSimCommand(text)) return fn();
  return getSimEngine().withLock(req, fn);
}

/**
 * 鏡像群：這段文字是後續指令（/派 /區間 /下一步 /公布 /結束，含看不懂的 /派、/區間），會作用在打的人
 * 自己開著的題目、或（寫對的指令）代答這個聊天室裡別人的題目，而且 SIM_MIRROR_FOLLOWUPS 沒開
 * → 不同步到 Discord／大廳（答案本來就不同步，只剩指令行會洗版）。
 */
export function hideSimFollowUp(text: string, req: Pick<SimRequest, 'platform' | 'chatId' | 'userId' | 'shared'>): boolean {
  if (!SIM_CONFIG.commandsEnabled || simMirrorFollowUps()) return false;
  const cmd = parseSimCommand(text);
  return !!cmd && getSimEngine().answersFollowUp(req, cmd);
}

/** 只回模擬的練習群裡的 /指令、/help → 模擬瓦的指令說明（LINE 版）；其他 null。 */
export function simHelpFor(text: string): string | null {
  if (!SIM_CONFIG.commandsEnabled) return null;
  return /^[/／]\s*(指令|help)\s*$/iu.test((text ?? '').normalize('NFKC').trim()) ? SIM_HELP_TEXT : null;
}

/** LINE 1 對 1 的快速按鈕（群組裡不放：按鈕要放在最後一則，鏡像群的最後一則是同步訊息）。 */
export const SIM_QUICK_REPLY_TEXTS: readonly string[] = ['/下一步', '/公布', '/結束'];

export function simQuickReply(): { items: { type: 'action'; action: { type: 'message'; label: string; text: string } }[] } {
  return {
    items: SIM_QUICK_REPLY_TEXTS.map((text) => ({ type: 'action', action: { type: 'message', label: text.slice(1), text } })),
  };
}
