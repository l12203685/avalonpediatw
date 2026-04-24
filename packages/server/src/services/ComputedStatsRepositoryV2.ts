/**
 * V2 派生指標 Repository（Firestore-backed）。
 *
 * Edward 2026-04-24：
 *   - Collection: `computed_stats/{playerId}` — 存 `ComputedPlayerStatsV2`
 *   - 帶 `lastComputedGameId` metadata（避免重複處理已算過的局）
 *   - 增量重算：新戰績進 → 對該局玩家相關重算並 upsert
 *   - 全玩家進排行榜，按分類分組
 *
 * Phase 2b 無 realtime 需求（一天更新一次）。
 */

import type {
  ComputedPlayerStatsV2,
  GameRecordV2,
  LeaderboardEntryV2,
  PlayerId,
  PlayerTier,
} from '@avalon/shared';
import {
  collectAllPlayerIds,
  computeLeaderboardByTier,
  computePlayerStatsV2,
} from '@avalon/shared';
import { getAdminFirestore } from './firebase';
import { GameHistoryRepositoryV2 } from './GameHistoryRepositoryV2';

export class ComputedStatsRepositoryV2 {
  private readonly collection = 'computed_stats';

  /**
   * 讀取單一玩家的 computed stats；找不到回 null。
   */
  async get(playerId: PlayerId): Promise<ComputedPlayerStatsV2 | null> {
    try {
      const firestore = getAdminFirestore();
      const doc = await firestore
        .collection(this.collection)
        .doc(this.encodeId(playerId))
        .get();
      if (!doc.exists) return null;
      return doc.data() as ComputedPlayerStatsV2;
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'computed_stats_v2_get_error',
        playerId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return null;
    }
  }

  /**
   * 寫入一筆 computed stats。
   */
  async save(stats: ComputedPlayerStatsV2): Promise<void> {
    try {
      const firestore = getAdminFirestore();
      const docRef = firestore
        .collection(this.collection)
        .doc(this.encodeId(stats.playerId));
      await docRef.set(stats);
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'computed_stats_v2_saved',
        playerId: stats.playerId,
        elo: stats.elo,
        tier: stats.tier,
        totalGames: stats.totalGames,
        lastComputedGameId: stats.lastComputedGameId,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'computed_stats_v2_save_error',
        playerId: stats.playerId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      throw error;
    }
  }

  /**
   * 列出所有玩家 computed stats。
   */
  async listAll(): Promise<ComputedPlayerStatsV2[]> {
    try {
      const firestore = getAdminFirestore();
      const snap = await firestore.collection(this.collection).get();
      return snap.docs.map((d) => d.data() as ComputedPlayerStatsV2);
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'computed_stats_v2_list_error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return [];
    }
  }

  /**
   * 依 playerIds 子集重算並 upsert（增量重算）。
   * 傳入 `games` 為所有 V2 games（由 caller 決定範圍）。
   */
  async recomputeForPlayers(
    games: GameRecordV2[],
    playerIds: PlayerId[],
    opts?: { initialElo?: number; minGamesForTier?: number },
  ): Promise<{ updated: number; skipped: number }> {
    let updated = 0;
    let skipped = 0;
    for (const pid of playerIds) {
      const stats = computePlayerStatsV2(games, pid, opts);
      if (stats.totalGames === 0) {
        skipped += 1;
        continue;
      }

      // 若 lastComputedGameId 相同 → skip（冪等保護）
      const prev = await this.get(pid);
      if (
        prev &&
        prev.lastComputedGameId === stats.lastComputedGameId &&
        prev.totalGames === stats.totalGames
      ) {
        skipped += 1;
        continue;
      }

      await this.save(stats);
      updated += 1;
    }
    return { updated, skipped };
  }

  /**
   * 全量重算：掃所有 V2 games → 收集玩家 → 對每位重算。
   * 慢但正確，一天跑一次即可。
   */
  async recomputeAll(opts?: {
    initialElo?: number;
    minGamesForTier?: number;
    pageSize?: number;
  }): Promise<{ players: number; games: number; updated: number }> {
    const games = await this.loadAllGames(opts?.pageSize ?? 500);
    const playerIds = collectAllPlayerIds(games);
    const { updated } = await this.recomputeForPlayers(games, playerIds, opts);
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'computed_stats_v2_recompute_all_done',
      players: playerIds.length,
      games: games.length,
      updated,
    }));
    return { players: playerIds.length, games: games.length, updated };
  }

  /**
   * 對單一新戰績增量重算：只處理該局的 playerSeats 非空玩家。
   * Caller 保證已把該局寫入 `games_v2/`。
   */
  async recomputeForGame(
    newGame: GameRecordV2,
    opts?: { initialElo?: number; minGamesForTier?: number; pageSize?: number },
  ): Promise<{ updated: number; skipped: number }> {
    const games = await this.loadAllGames(opts?.pageSize ?? 500);
    const playerIds = new Set<PlayerId>();
    for (let i = 0; i < 10; i += 1) {
      const uid = newGame.playerSeats[i];
      if (uid && uid.trim()) playerIds.add(uid);
    }
    return this.recomputeForPlayers(games, Array.from(playerIds), opts);
  }

  /**
   * 算出分類排行榜並回傳（不存）。讀端即時算。
   */
  async getLeaderboard(): Promise<Record<PlayerTier, LeaderboardEntryV2[]>> {
    const all = await this.listAll();
    return computeLeaderboardByTier(all);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Firestore doc ID 不能含 `/`；`sheets:<名字>` 直接用，但把 `/` 替換掉。
   */
  private encodeId(playerId: PlayerId): string {
    return playerId.replace(/\//g, '_');
  }

  private async loadAllGames(pageSize: number): Promise<GameRecordV2[]> {
    const firestore = getAdminFirestore();
    const out: GameRecordV2[] = [];
    let last: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData> | null = null;

    for (;;) {
      let query = firestore
        .collection('games_v2')
        .orderBy('playedAt', 'asc')
        .limit(pageSize);
      if (last) query = query.startAfter(last);
      const snap = await query.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        out.push(doc.data() as GameRecordV2);
      }
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }
    return out;
  }
}

/**
 * 便利 factory — 配對 `GameHistoryRepositoryV2` 作 wave-2 使用。
 */
export function createComputedStatsRepositoryV2(): ComputedStatsRepositoryV2 {
  return new ComputedStatsRepositoryV2();
}

/**
 * 將 repo 暴露給腳本用 — 需要 `GameHistoryRepositoryV2` 時請直接 `new`。
 */
export { GameHistoryRepositoryV2 };
