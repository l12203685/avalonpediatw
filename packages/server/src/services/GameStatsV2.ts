/**
 * V2 派生統計（Phase 2b 實作）。
 *
 * Phase 1 為 stub；Phase 2b 已把純函式挪到 `@avalon/shared/derived/gameMetrics`，
 * 前後端共用。此檔作為 server-side 薄 wrapper，保留 signature 以維持呼叫端相容，
 * 並補上 Phase 2a 的舊 API（`computePlayerQuestSuccessRate` / `computePlayerVotingAlignment`
 * / `computeMerlinSurvivalRate` / `computeAssassinPrecision` / `computeLadyHonesty` /
 * `recomputeEloFromV2`）。
 *
 * Edward 2026-04-24：
 *   - 一天更新一次；存 `computed_stats/{playerId}` 帶 `lastComputedGameId` metadata
 *   - 增量重算：新戰績進 → 對相關玩家重算
 *   - 全玩家進排行榜，按分類分組顯示
 */

import type {
  AlignmentStatsV2,
  ComputedPlayerStatsV2,
  GameRecordV2,
  LeaderboardEntryV2,
  MerlinAssassinationStats,
  PlayerId,
  PlayerRoleStatsV2,
  PlayerTier,
  PlayerWinRateV2,
  Role,
  RolesV2,
  Seat,
} from '@avalon/shared';
import {
  TIER_MIN_GAMES,
  TIER_THRESHOLDS,
  collectAllPlayerIds,
  computeELO as computeELOShared,
  computeLeaderboardByTier as computeLeaderboardByTierShared,
  computeMerlinAssassinationRate as computeMerlinAssassinationRateShared,
  computePlayerLadyAccuracy as computePlayerLadyAccuracyShared,
  computePlayerMissionSuccess as computePlayerMissionSuccessShared,
  computePlayerRoleWinRate as computePlayerRoleWinRateShared,
  computePlayerStatsV2 as computePlayerStatsV2Shared,
  computePlayerVoteAccuracy as computePlayerVoteAccuracyShared,
  computePlayerWinRate as computePlayerWinRateShared,
  computeTier as computeTierShared,
  expandRolesForAllSeats as expandRolesForAllSeatsShared,
  filterGamesForPlayer as filterGamesForPlayerShared,
  findSeatForPlayer as findSeatForPlayerShared,
} from '@avalon/shared';

export type { PlayerId, Seat };
export type {
  AlignmentStatsV2,
  ComputedPlayerStatsV2,
  LeaderboardEntryV2,
  MerlinAssassinationStats,
  PlayerRoleStatsV2,
  PlayerTier,
  PlayerWinRateV2,
};

// ---------------------------------------------------------------------------
// Phase 2b: 正式實作（轉呼 shared 純函式）
// ---------------------------------------------------------------------------

/** 玩家總勝率（分陣營、分人數）。 */
export function computePlayerWinRate(
  games: GameRecordV2[],
  playerId: PlayerId,
): PlayerWinRateV2 {
  return computePlayerWinRateShared(games, playerId);
}

/** 玩家每角色勝率。 */
export function computePlayerRoleWinRate(
  games: GameRecordV2[],
  playerId: PlayerId,
): Record<Role, PlayerRoleStatsV2> {
  return computePlayerRoleWinRateShared(games, playerId);
}

/** 玩家任務成功率（當隊員時）。 */
export function computePlayerMissionSuccess(
  games: GameRecordV2[],
  playerId: PlayerId,
): { asGood: AlignmentStatsV2; asEvil: AlignmentStatsV2 } {
  return computePlayerMissionSuccessShared(games, playerId);
}

/** 玩家投票正確率。 */
export function computePlayerVoteAccuracy(
  games: GameRecordV2[],
  playerId: PlayerId,
): AlignmentStatsV2 {
  return computePlayerVoteAccuracyShared(games, playerId);
}

/** 玩家湖使用正確率（宣告 == 實際）。 */
export function computePlayerLadyAccuracy(
  games: GameRecordV2[],
  playerId: PlayerId,
): AlignmentStatsV2 {
  return computePlayerLadyAccuracyShared(games, playerId);
}

/** 梅林被刺率（含存活率）。 */
export function computeMerlinAssassinationRate(
  games: GameRecordV2[],
  playerId: PlayerId,
): MerlinAssassinationStats {
  return computeMerlinAssassinationRateShared(games, playerId);
}

/** ELO 分數（純函式、批次重算版）。 */
export function computeELO(
  games: GameRecordV2[],
  playerId: PlayerId,
  initialElo = 1000,
): number {
  return computeELOShared(games, playerId, initialElo);
}

/** 分類（菜雞/初學/新手/中堅/高手/大師/unranked）。 */
export function computeTier(
  elo: number,
  totalGames: number,
  minGames = TIER_MIN_GAMES,
): PlayerTier {
  return computeTierShared(elo, totalGames, minGames);
}

/** 按分類排行榜。 */
export function computeLeaderboardByTier(
  stats: ComputedPlayerStatsV2[],
): Record<PlayerTier, LeaderboardEntryV2[]> {
  return computeLeaderboardByTierShared(stats);
}

/** 一次算一位玩家的完整 stats — 供 `ComputedStatsRepositoryV2` 存檔用。 */
export function computePlayerStatsV2(
  games: GameRecordV2[],
  playerId: PlayerId,
  opts?: { initialElo?: number; minGamesForTier?: number },
): ComputedPlayerStatsV2 {
  return computePlayerStatsV2Shared(games, playerId, opts);
}

// ---------------------------------------------------------------------------
// Legacy Phase 1 stub API — 以 shared 純函式改為真實作
// ---------------------------------------------------------------------------

/**
 * (alias of `computePlayerMissionSuccess`) 玩家任務成功率（當隊員時）。
 */
export function computePlayerQuestSuccessRate(
  games: GameRecordV2[],
  playerId: PlayerId,
): { asGood: AlignmentStatsV2; asEvil: AlignmentStatsV2 } {
  return computePlayerMissionSuccessShared(games, playerId);
}

/**
 * (alias of `computePlayerVoteAccuracy`) 玩家投票對齊率。
 */
export function computePlayerVotingAlignment(
  games: GameRecordV2[],
  playerId: PlayerId,
): AlignmentStatsV2 {
  return computePlayerVoteAccuracyShared(games, playerId);
}

/**
 * 梅林存活率（該玩家當梅林時）— 單一 number 版本，對應 Phase 1 signature。
 */
export function computeMerlinSurvivalRate(
  games: GameRecordV2[],
  playerId: PlayerId,
): number {
  return computeMerlinAssassinationRateShared(games, playerId).survivalRate;
}

/**
 * 刺客命中率。
 *
 * 以當前 V2 schema 可得資料計算：玩家當刺客（roles.assassin === seat）時，
 * 若 `winReason === 'threeBlue_merlinKilled'` 或 `finalResult.assassinCorrect === true`
 * → 命中。命中率 = 命中場 / 刺客總場。
 */
export function computeAssassinPrecision(
  games: GameRecordV2[],
  playerId: PlayerId,
): number {
  let asAssassin = 0;
  let hits = 0;
  for (const game of games) {
    const seat = findSeatForPlayerShared(game, playerId);
    if (seat === null) continue;
    if (game.finalResult.roles.assassin !== seat) continue;
    asAssassin += 1;
    if (
      game.finalResult.winReason === 'threeBlue_merlinKilled' ||
      game.finalResult.assassinCorrect === true
    ) {
      hits += 1;
    }
  }
  return asAssassin > 0 ? hits / asAssassin : 0;
}

/**
 * 湖中女神宣告真實度（該玩家持湖時）— alias of `computePlayerLadyAccuracy`.
 */
export function computeLadyHonesty(
  games: GameRecordV2[],
  playerId: PlayerId,
): AlignmentStatsV2 {
  return computePlayerLadyAccuracyShared(games, playerId);
}

/**
 * 能力角色座號 rebuild — 把空位的 role 補成一般好人/壞人。
 * Phase 2b：正式版在 shared（合併 Phase 1 adapter 的簡化版）。
 */
export function expandRolesForAllSeats(
  roles: RolesV2,
  playerCount: number,
): Record<Seat, Role | null> {
  return expandRolesForAllSeatsShared(roles, playerCount);
}

/**
 * 全歷史重算 ELO → 回傳每位玩家的最終分數 map。派生不存（repo 自行 upsert）。
 */
export function recomputeEloFromV2(
  games: GameRecordV2[],
): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>();
  const playerIds = collectAllPlayerIds(games);
  for (const pid of playerIds) {
    const elo = computeELOShared(games, pid);
    out.set(pid, elo);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers re-export
// ---------------------------------------------------------------------------

export {
  filterGamesForPlayerShared as filterGamesForPlayer,
  findSeatForPlayerShared as findSeatForPlayer,
  TIER_THRESHOLDS,
  TIER_MIN_GAMES,
};
