import { GameRecordV2 } from '@avalon/shared';
import { getAdminFirestore } from './firebase';

/**
 * V2 戰績 Repository.
 *
 * Collection: `games_v2/{gameId}` — 與 V1 `games/` 並行；舊 collection 保留唯讀。
 * Phase 1 只提供基本 CRUD；aggregation / player index 留到 Phase 2。
 */
export class GameHistoryRepositoryV2 {
  private readonly collection = 'games_v2';

  /**
   * 寫入一筆 V2 戰績。gameId 作為 document ID（冪等）。
   */
  async saveV2(record: GameRecordV2): Promise<void> {
    try {
      const firestore = getAdminFirestore();
      const docRef = firestore.collection(this.collection).doc(record.gameId);
      await docRef.set(record);

      // 注：V1 寫入會觸發 `invalidateLeaderboardCache()`；V2 目前無派生 leaderboard
      // （Phase 2 才實作 `GameStatsV2`），先不 invalidate，避免誤判。

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_v2_saved',
        gameId: record.gameId,
        schemaVersion: record.schemaVersion,
        winnerCamp: record.finalResult.winnerCamp,
        missionCount: record.missions.length,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_v2_save_error',
        gameId: record.gameId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      throw error;
    }
  }

  /**
   * 讀取單筆 V2 戰績；找不到回 `null`。
   */
  async getV2(gameId: string): Promise<GameRecordV2 | null> {
    try {
      const firestore = getAdminFirestore();
      const doc = await firestore.collection(this.collection).doc(gameId).get();
      if (!doc.exists) return null;
      return doc.data() as GameRecordV2;
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_v2_load_error',
        gameId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return null;
    }
  }

  /**
   * 列某玩家最近的 V2 戰績。
   *
   * 實作策略與 V1 同 — Firestore `array-contains` 對巢狀 tuple 不穩，
   * 先抓最近 N × 3 筆再 in-memory filter `playerIds` 命中者。
   * Phase 2 做 per-player 索引子集合以提升查詢效能。
   */
  async listV2ByPlayer(playerId: string, limit = 20): Promise<GameRecordV2[]> {
    try {
      const firestore = getAdminFirestore();
      const snapshot = await firestore
        .collection(this.collection)
        .orderBy('playedAt', 'desc')
        .limit(limit * 3)
        .get();

      const results: GameRecordV2[] = [];
      for (const doc of snapshot.docs) {
        const record = doc.data() as GameRecordV2;
        if (record.playerIds.some((id) => id === playerId)) {
          results.push(record);
          if (results.length >= limit) break;
        }
      }
      return results;
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_v2_list_by_player_error',
        playerId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return [];
    }
  }

  /**
   * 列最近 N 筆 V2 戰績（所有玩家混）。
   */
  async listRecentV2(limit = 20): Promise<GameRecordV2[]> {
    try {
      const firestore = getAdminFirestore();
      const snapshot = await firestore
        .collection(this.collection)
        .orderBy('playedAt', 'desc')
        .limit(limit)
        .get();
      return snapshot.docs.map((doc) => doc.data() as GameRecordV2);
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_v2_list_recent_error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return [];
    }
  }
}
