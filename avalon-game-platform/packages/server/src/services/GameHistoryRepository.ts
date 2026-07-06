import {
  Room,
  Player,
  Role,
  QuestResult,
  VoteRecord,
  QuestRecord,
  LadyOfTheLakeRecord,
} from '@avalon/shared';
import { getAdminFirestore } from './firebase';
import { invalidateLeaderboardCache } from './FirestoreLeaderboard';

/**
 * Completed game record stored in Firestore.
 *
 * Collection: games/{gameId}
 * Sub-collection: games/{gameId}/rounds/{roundIndex}
 *
 * #54 Phase 2 (2026-04-22): Added optional per-event history fields so
 * the new EloAttributionService can compute per-player factor deltas.
 * All fields are optional — legacy records (pre-Phase 2) omit them and
 * the service falls back to Phase 1 team-average ELO automatically.
 */
export interface GameRecord {
  gameId: string;
  roomName: string;
  playerCount: number;
  winner: 'good' | 'evil';
  winReason: string;
  questResults: QuestResult[];
  duration: number;            // milliseconds
  players: GamePlayerRecord[];
  createdAt: number;
  endedAt: number;

  // ---- #54 Phase 2 additive fields (all optional) ----

  /** Every team-proposal vote. Required by Proposal factor. */
  voteHistoryPersisted?: VoteRecord[];
  /** Completed quest records. Required by Outer-white-inner-black factor. */
  questHistoryPersisted?: QuestRecord[];
  /** Lady-of-the-Lake inspections. Reserved for Phase 2.5. */
  ladyOfTheLakeHistoryPersisted?: LadyOfTheLakeRecord[];
  /** Player ID the assassin targeted. Reserved for Phase 2.5 Information factor. */
  assassinTargetId?: string;
  /** Seat index of the first leader at game start (rotation reconstruction). */
  leaderStartIndex?: number;
}

export interface GamePlayerRecord {
  playerId: string;
  displayName: string;
  role: Role | null;
  team: 'good' | 'evil' | null;
  won: boolean;
  /**
   * Optional owner UID once a claim for this participation row has been
   * approved. Absent / null on legacy records and for non-claimed slots.
   */
  ownerUid?: string | null;
}

/**
 * Repository for persisting completed game records to Firestore.
 *
 * Firestore schema:
 *   games/{gameId}           -- GameRecord
 *   users/{uid}/gameHistory  -- sub-collection of references (future)
 */
export class GameHistoryRepository {
  private readonly collection = 'games';

  /**
   * Archive a completed game room as a Firestore document.
   * Returns the generated document ID.
   */
  async saveGameRecord(room: Room, winReason: string): Promise<string> {
    try {
      const firestore = getAdminFirestore();

      const winner: 'good' | 'evil' = room.evilWins ? 'evil' : 'good';
      const endedAt = Date.now();
      const duration = endedAt - room.createdAt;

      const players: GamePlayerRecord[] = Object.values(room.players).map(
        (player: Player) => ({
          playerId: player.id,
          displayName: player.name,
          role: player.role,
          team: player.team,
          won:
            (winner === 'good' && player.team === 'good') ||
            (winner === 'evil' && player.team === 'evil'),
        })
      );

      const record: GameRecord = {
        gameId: room.id,
        roomName: room.name,
        playerCount: Object.keys(room.players).length,
        winner,
        winReason,
        questResults: room.questResults,
        duration,
        players,
        createdAt: room.createdAt,
        endedAt,
        // #54 Phase 2 — copy event history so attribution service has data.
        voteHistoryPersisted: room.voteHistory ?? [],
        questHistoryPersisted: room.questHistory ?? [],
        ladyOfTheLakeHistoryPersisted: room.ladyOfTheLakeHistory,
        assassinTargetId: room.assassinTargetId,
        leaderStartIndex:
          typeof room.leaderIndex === 'number' ? room.leaderIndex : undefined,
      };

      const docRef = firestore.collection(this.collection).doc(room.id);
      await docRef.set(record);

      // Invalidate leaderboard cache so next request picks up the new game
      invalidateLeaderboardCache();

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_saved',
        gameId: room.id,
        winner,
        winReason,
        playerCount: record.playerCount,
        duration,
      }));

      return room.id;
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_save_error',
        roomId: room.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      throw error;
    }
  }

  /**
   * Retrieve a single game record by ID.
   */
  async getGameRecord(gameId: string): Promise<GameRecord | null> {
    try {
      const firestore = getAdminFirestore();
      const doc = await firestore.collection(this.collection).doc(gameId).get();

      if (!doc.exists) return null;
      return doc.data() as GameRecord;
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_load_error',
        gameId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return null;
    }
  }

  /**
   * List recent game records, ordered by endedAt descending.
   */
  async listRecentGames(limit = 20): Promise<GameRecord[]> {
    try {
      const firestore = getAdminFirestore();
      const snapshot = await firestore
        .collection(this.collection)
        .orderBy('endedAt', 'desc')
        .limit(limit)
        .get();

      return snapshot.docs.map((doc) => doc.data() as GameRecord);
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'game_history_list_error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return [];
    }
  }

  /**
   * List game records for a specific player, ordered by endedAt descending.
   */
  async listPlayerGames(playerId: string, limit = 20): Promise<GameRecord[]> {
    try {
      const firestore = getAdminFirestore();

      // Firestore array-contains on players[] won't work here because
      // the field is an array of objects. We query all recent games and
      // filter in-memory. For scale, a denormalised sub-collection per
      // user would be better -- added as a TODO for Phase 2.
      const snapshot = await firestore
        .collection(this.collection)
        .orderBy('endedAt', 'desc')
        .limit(limit * 3) // over-fetch to account for filtering
        .get();

      const results: GameRecord[] = [];
      for (const doc of snapshot.docs) {
        const record = doc.data() as GameRecord;
        const isParticipant = record.players.some((p) => p.playerId === playerId);
        if (isParticipant) {
          results.push(record);
          if (results.length >= limit) break;
        }
      }

      return results;
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'player_games_list_error',
        playerId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return [];
    }
  }
}
