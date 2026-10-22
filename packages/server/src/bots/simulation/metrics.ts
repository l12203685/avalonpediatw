/**
 * 模擬瓦（2026-10-14）— 狀態頁計數（`/api/bots/status → simulation`）。
 *
 * 只有數字和布林：沒有題號、聊天室 id、使用者 id，也沒有任何人打的字。重啟歸零。
 */

import type { Role } from '@avalon/shared';

export interface SimCounts {
  started: { line: number; discord: number };
  byRole: Record<string, number>;
  answers: number;
  /** 作答跟真人當時派的一模一樣。 */
  sameAsReal: number;
  intervals: number;
  intervalGroupsRight: number;
  intervalGroupsTotal: number;
  steps: number;
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
    intervalGroupsRight: 0,
    intervalGroupsTotal: 0,
    steps: 0,
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
  bank: { loaded: boolean; games: number; dropped: number; decisionPoints: number };
  sessions: { active: number };
  counts: SimCounts;
}
