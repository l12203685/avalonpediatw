/**
 * 遊戲內回饋（站長 2026-11-26）：網站房間聊天裡對百科AI 玩法的回饋。docs/COMMUNITY_FEEDBACK.md 說為什麼，這裡是怎麼做：
 *
 *   keywords.ts    — 哪些話算回饋（所有關鍵字在這裡）
 *   capture.ts     — 每局在記憶體收聊天、判斷、轉管理員頻道、局後寫試算表
 *   sheetWriter.ts — 私人試算表的「遊戲內回饋」分頁
 *
 * GameServer 用 getInGameFeedback()；/api/bots/status 讀 snapshot()（feedback.inGame）。
 */

import { getFeedbackService } from '../bots/feedback/service';
import { InGameChatCapture } from './capture';
import { createInGameFeedbackSheetWriter } from './sheetWriter';

export * from './keywords';
export * from './capture';
export * from './sheetWriter';

let instance: InGameChatCapture | null = null;

/** 全程序一個；第一次用時照環境變數建（試算表、管理員頻道）。 */
export function getInGameFeedback(): InGameChatCapture {
  if (!instance) {
    const { writer, status } = createInGameFeedbackSheetWriter();
    instance = new InGameChatCapture({
      forward: (content) => getFeedbackService().recordInGameFeedback(content),
      sink: writer,
      sinkStatus: status,
    });
  }
  return instance;
}

/** 測試用：丟掉單例。 */
export function __resetInGameFeedbackForTests(): void {
  instance = null;
}
