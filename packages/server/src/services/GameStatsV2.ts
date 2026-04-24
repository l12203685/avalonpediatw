/**
 * V2 派生統計（Phase 1 stub）。
 *
 * 所有函式目前 throw `TODO Phase 2` — Phase 1 只鎖 signature，Phase 2 實作。
 * 若呼叫端需要真正結果，暫時仍用 `GameAnalytics` 吃 V1 資料。
 *
 * Phase 2 會把純函式挪到 `packages/shared/src/derived/gameMetrics.ts` 去 shared
 * package（與 V2 adapter 同層），讓前後端共用；此檔會退化為薄 wrapper。
 */

import type { GameRecordV2, RolesV2 } from '@avalon/shared';
import type { Role } from '@avalon/shared';

export type PlayerId = string;
export type Seat = number;

/**
 * 玩家總勝率（分陣營、分人數）。
 */
export interface PlayerWinRateV2 {
  overall: number;
  asGood: number;
  asEvil: number;
  byPlayerCount: Record<number, number>;
  totalGames: number;
}

/**
 * 每角色統計。
 */
export interface PlayerRoleStatsV2 {
  plays: number;
  wins: number;
  rate: number;
}

/**
 * 玩家陣營比對結果（good / evil 兩方向）。
 */
export interface AlignmentStatsV2 {
  rate: number;
  total: number;
  correct: number;
}

/**
 * (Phase 2) 玩家總體勝率。
 */
export function computePlayerWinRate(
  _games: GameRecordV2[],
  _playerId: PlayerId,
): PlayerWinRateV2 {
  throw new Error('TODO Phase 2: computePlayerWinRate');
}

/**
 * (Phase 2) 玩家每角色勝率。
 */
export function computePlayerRoleWinRate(
  _games: GameRecordV2[],
  _playerId: PlayerId,
): Record<Role, PlayerRoleStatsV2> {
  throw new Error('TODO Phase 2: computePlayerRoleWinRate');
}

/**
 * (Phase 2) 玩家任務成功率（當隊員時）。
 */
export function computePlayerQuestSuccessRate(
  _games: GameRecordV2[],
  _playerId: PlayerId,
): { asGood: AlignmentStatsV2; asEvil: AlignmentStatsV2 } {
  throw new Error('TODO Phase 2: computePlayerQuestSuccessRate');
}

/**
 * (Phase 2) 玩家投票對齊率（投 approve 且任務成功 → +1 對好人；反過來為壞人）。
 */
export function computePlayerVotingAlignment(
  _games: GameRecordV2[],
  _playerId: PlayerId,
): AlignmentStatsV2 {
  throw new Error('TODO Phase 2: computePlayerVotingAlignment');
}

/**
 * (Phase 2) 梅林存活率（該玩家當梅林時）。
 */
export function computeMerlinSurvivalRate(
  _games: GameRecordV2[],
  _playerId: PlayerId,
): number {
  throw new Error('TODO Phase 2: computeMerlinSurvivalRate');
}

/**
 * (Phase 2) 刺客命中率。
 */
export function computeAssassinPrecision(
  _games: GameRecordV2[],
  _playerId: PlayerId,
): number {
  throw new Error('TODO Phase 2: computeAssassinPrecision');
}

/**
 * (Phase 2) 湖中女神宣告真實度（該玩家持湖時）。
 */
export function computeLadyHonesty(
  _games: GameRecordV2[],
  _playerId: PlayerId,
): AlignmentStatsV2 {
  throw new Error('TODO Phase 2: computeLadyHonesty');
}

/**
 * (Phase 2) 能力角色座號 rebuild — 把空位的 role 補成一般好人/壞人。
 *
 * 提前列出 signature，讓 V2 adapter 未來可 offload 複雜推導；目前 adapter 內有
 * 一份簡化版 `deriveRoleForSeat`，Phase 2 會合併到此處。
 */
export function expandRolesForAllSeats(
  _roles: RolesV2,
  _playerCount: number,
): Record<Seat, Role | null> {
  throw new Error('TODO Phase 2: expandRolesForAllSeats');
}

/**
 * (Phase 2) 全歷史重算 ELO。派生不存。
 */
export function recomputeEloFromV2(
  _games: GameRecordV2[],
): Map<PlayerId, number> {
  throw new Error('TODO Phase 2: recomputeEloFromV2');
}
