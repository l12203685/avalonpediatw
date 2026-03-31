import { Room } from '@avalon/shared';
import { getAdminDB } from './firebase';
import { GameEngineState } from '../game/GameEngine';

/**
 * Persists active game room state to Firebase Realtime Database.
 *
 * Schema:
 *   /rooms/{roomId}/room    -- serialised Room object (active games only)
 *   /rooms/{roomId}/engine  -- serialised GameEngineState (in-progress games only)
 *
 * Legacy entries written as a flat Room object (before engine state was added)
 * are handled transparently by deserialiseRoomEntry().
 *
 * Rooms are written on every state change and removed when the game ends
 * (completed games are archived separately via GameHistoryRepository).
 */
export class GameStatePersistence {
  private readonly basePath = 'rooms';

  /**
   * Write the full room state (and optionally engine state) to RTD.
   * Called after every meaningful state transition.
   *
   * Pass `engineState` whenever the room is in a non-lobby, non-ended state
   * so that the engine can be restored after a server restart.
   */
  async saveRoom(room: Room, engineState?: GameEngineState): Promise<void> {
    try {
      const db = getAdminDB();
      const ref = db.ref(`${this.basePath}/${room.id}`);

      const payload: Record<string, unknown> = {
        room: this.serialiseRoom(room),
      };

      if (engineState !== undefined) {
        payload.engine = JSON.parse(JSON.stringify(engineState));
      }

      await ref.set(payload);
    } catch (error) {
      // Log but do not throw -- persistence failure must not break gameplay
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'room_persist_error',
        roomId: room.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }

  /**
   * Load a single room entry from RTD.
   * Returns null if the room does not exist.
   * The returned object contains the Room and, when available, the saved GameEngineState.
   */
  async loadRoom(roomId: string): Promise<{ room: Room; engineState: GameEngineState | null } | null> {
    try {
      const db = getAdminDB();
      const ref = db.ref(`${this.basePath}/${roomId}`);
      const snapshot = await ref.once('value');
      const data = snapshot.val();
      if (!data) return null;
      return this.deserialiseRoomEntry(data);
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'room_load_error',
        roomId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return null;
    }
  }

  /**
   * Load all active rooms from RTD.
   * Used on server restart to rehydrate in-memory RoomManager and GameEngine instances.
   * Each entry includes the Room and, when present, the saved GameEngineState.
   */
  async loadAllRooms(): Promise<Array<{ room: Room; engineState: GameEngineState | null }>> {
    try {
      const db = getAdminDB();
      const ref = db.ref(this.basePath);
      const snapshot = await ref.once('value');
      const data = snapshot.val();

      if (!data) return [];

      const entries: Array<{ room: Room; engineState: GameEngineState | null }> = [];
      for (const roomId of Object.keys(data)) {
        const entry = this.deserialiseRoomEntry(data[roomId]);
        if (entry) entries.push(entry);
      }

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'rooms_rehydrated',
        count: entries.length,
        withEngineState: entries.filter((e) => e.engineState !== null).length,
      }));

      return entries;
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'rooms_rehydrate_error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return [];
    }
  }

  /**
   * Remove a room from RTD (called after game ends and history is archived).
   */
  async removeRoom(roomId: string): Promise<void> {
    try {
      const db = getAdminDB();
      const ref = db.ref(`${this.basePath}/${roomId}`);
      await ref.remove();
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'room_remove_error',
        roomId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }

  /**
   * Serialise a Room to a plain JSON-safe object for RTD.
   * RTD does not support undefined values, so we strip them.
   */
  private serialiseRoom(room: Room): Record<string, unknown> {
    return JSON.parse(JSON.stringify(room));
  }

  /**
   * Deserialise a raw RTD entry back into a Room + optional GameEngineState.
   *
   * Handles two storage formats:
   *   - New format: `{ room: {...}, engine: {...} }`
   *   - Legacy format: flat Room object (no nested `room` key)
   */
  private deserialiseRoomEntry(
    data: Record<string, unknown>
  ): { room: Room; engineState: GameEngineState | null } {
    // Detect new nested format vs. legacy flat format
    const roomData =
      data.room !== undefined && typeof data.room === 'object' && data.room !== null
        ? (data.room as Record<string, unknown>)
        : data;

    const room = this.deserialiseRoom(roomData);

    const engineState =
      data.engine !== undefined && typeof data.engine === 'object' && data.engine !== null
        ? this.deserialiseEngineState(data.engine as Record<string, unknown>)
        : null;

    return { room, engineState };
  }

  /**
   * Deserialise raw RTD data back into a Room.
   * Applies defaults for any fields that may be missing due to schema evolution.
   */
  private deserialiseRoom(data: Record<string, unknown>): Room {
    return {
      id: data.id as string,
      name: data.name as string,
      host: data.host as string,
      state: (data.state as Room['state']) ?? 'lobby',
      players: (data.players as Room['players']) ?? {},
      maxPlayers: (data.maxPlayers as number) ?? 10,
      currentRound: (data.currentRound as number) ?? 0,
      maxRounds: (data.maxRounds as number) ?? 5,
      votes: (data.votes as Room['votes']) ?? {},
      questTeam: (data.questTeam as string[]) ?? [],
      questResults: (data.questResults as Room['questResults']) ?? [],
      failCount: (data.failCount as number) ?? 0,
      evilWins: (data.evilWins as boolean | null) ?? null,
      leaderIndex: (data.leaderIndex as number) ?? 0,
      createdAt: (data.createdAt as number) ?? Date.now(),
      updatedAt: (data.updatedAt as number) ?? Date.now(),
    };
  }

  /**
   * Deserialise raw RTD data back into a GameEngineState.
   * Returns null if the data is not a recognisable engine state snapshot.
   */
  private deserialiseEngineState(data: Record<string, unknown>): GameEngineState | null {
    if (data.version !== 1) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'engine_state_version_mismatch',
        version: data.version,
      }));
      return null;
    }

    return {
      version: 1,
      roomId: data.roomId as string,
      roleAssignments: (data.roleAssignments as Record<string, string>) ?? {},
      questVotes: (data.questVotes as Array<{ playerId: string; vote: 'success' | 'fail' }>) ?? [],
      currentLeaderIndex: (data.currentLeaderIndex as number) ?? 0,
    };
  }
}
