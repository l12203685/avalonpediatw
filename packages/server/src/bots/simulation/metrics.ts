/**
 * 模擬瓦（2026-10-14）— 狀態頁計數（`/api/bots/status → simulation`）。
 *
 * 只有數字和布林：沒有題號、聊天室 id、使用者 id，也沒有任何人打的字。重啟歸零（進行中的題目本身會存檔，計數不存）。
 */

import type { Role } from '@avalon/shared';
import type { SimPersistenceStatus } from './persist';

export interface SimCounts {
  started: { line: number; discord: number };
  byRole: Record<string, number>;
  answers: number;
  /** 作答跟真人當時派的一模一樣。 */
  sameAsReal: number;
  intervals: number;
  /** /分析 的次數（2026-11-16）。 */
  analyses: number;
  /** 從 2-5、3-5 開始的題目數（2026-11-16）。 */
  midStarts: number;
  /** 刺殺題、今天的主題開題數；/刺 的次數（2026-11-16）。 */
  assassinStarts: number;
  todayStarts: number;
  kills: number;
  intervalGroupsRight: number;
  intervalGroupsTotal: number;
  /** /區間 不帶內容（百科AI 怎麼讀）的次數（2026-11-17；取代拿掉的 /下一步）。 */
  aiReads: number;
  reveals: number;
  ended: number;
  expired: number;
  usage: number;
  noSession: number;
  rateLimited: number;
  /** /模擬 說明 的次數。 */
  help: number;
  /** 幫別人開的題目作答（代答）的指令次數。 */
  coAnswers: number;
}

export const COUNTED_ROLES: readonly Role[] = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];

export function emptySimCounts(): SimCounts {
  return {
    started: { line: 0, discord: 0 },
    byRole: Object.fromEntries(COUNTED_ROLES.map((r) => [r, 0])),
    answers: 0,
    sameAsReal: 0,
    intervals: 0,
    analyses: 0,
    midStarts: 0,
    assassinStarts: 0,
    todayStarts: 0,
    kills: 0,
    intervalGroupsRight: 0,
    intervalGroupsTotal: 0,
    aiReads: 0,
    reveals: 0,
    ended: 0,
    expired: 0,
    usage: 0,
    noSession: 0,
    rateLimited: 0,
    help: 0,
    coAnswers: 0,
  };
}

export interface SimulationStatus {
  enabled: boolean;
  /** 世界模型有沒有算派票行為（v1 純邏輯：false）。 */
  weighsBehaviour: boolean;
  bank: { loaded: boolean; games: number; dropped: number; decisionPoints: number; linked: number };
  /** persistence：進行中的題目存檔（persist.ts）——有沒有設定、開機有沒有讀回來、寫了幾次。 */
  sessions: { active: number; persistence: SimPersistenceStatus };
  counts: SimCounts;
}
