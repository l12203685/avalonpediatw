import { Server as SocketIOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { Room, Player, PlayerStatus, User } from '@avalon/shared';
import { RoomManager } from '../game/RoomManager';
import { GameEngine } from '../game/GameEngine';
import { updateUserStats } from '../services/firebase';
import { SocketRateLimiter } from '../middleware/rateLimit';
import { GameStatePersistence } from '../services/GameStatePersistence';
import { GameHistoryRepository } from '../services/GameHistoryRepository';
import { broadcastGameResult } from '../bots/discord/broadcaster';

// Rate limiters for different events
const voteLimiter = new SocketRateLimiter({
  windowMs: 1000, // 1 second
  maxRequests: 1, // Max 1 vote per second
});

const chatLimiter = new SocketRateLimiter({
  windowMs: 1000, // 1 second
  maxRequests: 2, // Max 2 messages per second
});

export class GameServer {
  private io: SocketIOServer;
  private roomManager: RoomManager;
  private gameEngines: Map<string, GameEngine> = new Map();
  private persistence: GameStatePersistence;
  private gameHistory: GameHistoryRepository;

  constructor(io: SocketIOServer, roomManager: RoomManager) {
    this.io = io;
    this.roomManager = roomManager;
    this.persistence = new GameStatePersistence();
    this.gameHistory = new GameHistoryRepository();
  }

  public start(): void {
    this.io.on('connection', (socket: Socket) => {
      const user = socket.data.user as User;
      console.log(`✓ Player connected: ${user.displayName} (${socket.id})`);

      // Emit user authenticated
      socket.emit('auth:success', {
        user,
        isAuthenticated: true,
      });

      // Game events
      socket.on('game:create-room', (playerName: string) => {
        this.handleCreateRoom(socket, playerName, user);
      });

      socket.on('game:join-room', (roomId: string) => {
        this.handleJoinRoom(socket, roomId, user);
      });

      socket.on('game:start-game', (roomId: string) => {
        this.handleStartGame(socket, roomId);
      });

      socket.on('game:vote', (roomId: string, playerId: string, vote: boolean) => {
        this.handleVote(socket, roomId, playerId, vote);
      });

      socket.on('game:select-quest-team', (roomId: string, teamMemberIds: string[]) => {
        this.handleSelectQuestTeam(socket, roomId, teamMemberIds);
      });

      socket.on('game:submit-quest-vote', (roomId: string, playerId: string, vote: 'success' | 'fail') => {
        this.handleSubmitQuestVote(socket, roomId, playerId, vote);
      });

      socket.on('game:assassinate', (roomId: string, assassinId: string, targetId: string) => {
        this.handleAssassinate(socket, roomId, assassinId, targetId);
      });

      socket.on('chat:send-message', (roomId: string, message: string) => {
        this.handleChatMessage(socket, roomId, message);
      });

      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  /**
   * Persist room state (and engine state for in-progress rooms) to Firebase RTD.
   * Fire-and-forget -- errors are logged, not thrown.
   */
  private persistRoom(room: Room): void {
    const inProgress = room.state !== 'lobby' && room.state !== 'ended';
    const engineState = inProgress
      ? this.gameEngines.get(room.id)?.serialize()
      : undefined;

    this.persistence.saveRoom(room, engineState).catch(() => {
      // Error already logged inside saveRoom
    });
  }

  /**
   * Rehydrate rooms from Firebase RTD on server startup.
   * Call this after Firebase is initialised.
   *
   * For rooms in progress (voting/quest/discussion), attempts to restore the
   * GameEngine from the saved engine state snapshot. Falls back to a fresh
   * engine (no internal state) when no snapshot is available — the room
   * remains accessible but mid-vote progress is lost.
   */
  public async rehydrateRooms(): Promise<number> {
    const entries = await this.persistence.loadAllRooms();
    const rooms = entries.map((e) => e.room);
    const count = this.roomManager.rehydrate(rooms);

    // Recreate GameEngine instances for in-progress rooms
    for (const { room, engineState } of entries) {
      if (room.state === 'ended' || room.state === 'lobby') continue;

      const onUpdate = (updatedRoom: Room): void => {
        this.io.to(room.id).emit('game:state-updated', updatedRoom);
        this.persistRoom(updatedRoom);
        if (updatedRoom.state === 'ended') {
          this.io.to(room.id).emit('game:ended', updatedRoom, updatedRoom.evilWins ? 'evil' : 'good');
          this.onGameEnd(room.id, updatedRoom);
        }
      };

      let engine: GameEngine;

      if (engineState !== null) {
        try {
          engine = GameEngine.restore(engineState, room, onUpdate);
          console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'engine_restored',
            roomId: room.id,
            state: room.state,
          }));
        } catch (restoreError) {
          // Snapshot present but corrupt/mismatched — fall back to a blank engine
          console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'engine_restore_failed',
            roomId: room.id,
            error: restoreError instanceof Error ? restoreError.message : 'Unknown error',
          }));
          engine = new GameEngine(room, onUpdate);
        }
      } else {
        // No engine snapshot saved (legacy room or lobby-only persist) — blank engine
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'engine_restored_blank',
          roomId: room.id,
          state: room.state,
        }));
        engine = new GameEngine(room, onUpdate);
      }

      this.gameEngines.set(room.id, engine);
    }

    return count;
  }

  private handleCreateRoom(socket: Socket, playerName: string, user: User): void {
    try {
      const roomId = uuidv4();
      const playerId = user.uid;

      const room = this.roomManager.createRoom(roomId, playerName || user.displayName, playerId);
      const gameEngine = new GameEngine(room, (updatedRoom) => {
        this.io.to(roomId).emit('game:state-updated', updatedRoom);
        this.persistRoom(updatedRoom);
        if (updatedRoom.state === 'ended') {
          this.io.to(roomId).emit('game:ended', updatedRoom, updatedRoom.evilWins ? 'evil' : 'good');
          this.onGameEnd(roomId, updatedRoom);
        }
      });
      this.gameEngines.set(roomId, gameEngine);

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = playerId;

      // Update player info with user avatar
      room.players[playerId].avatar = user.photoURL;

      this.io.to(roomId).emit('game:state-updated', room);
      this.persistRoom(room);

      console.log(`Room created: ${roomId} by ${user.displayName}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error', 'Failed to create room');
    }
  }

  private handleJoinRoom(socket: Socket, roomId: string, user: User): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      const playerId = user.uid;
      const playerExists = room.players[playerId];

      // Handle rejoin scenario (player was disconnected and reconnecting)
      if (playerExists) {
        if (playerExists.status === 'disconnected') {
          // Restore player status
          playerExists.status = 'active';
          socket.join(roomId);
          socket.data.roomId = roomId;
          socket.data.playerId = playerId;

          this.io.to(roomId).emit('game:player-reconnected', playerId);
          this.io.to(roomId).emit('game:state-updated', room);
          this.persistRoom(room);

          console.log(`Player ${user.displayName} reconnected to room ${roomId}`);
          return;
        } else {
          // Player already active in room
          socket.emit('error', 'Already in this room');
          return;
        }
      }

      // Check room capacity
      if (Object.keys(room.players).length >= room.maxPlayers) {
        socket.emit('error', 'Room is full');
        return;
      }

      // Check if room is already started
      if (room.state !== 'lobby') {
        socket.emit('error', 'Game already in progress');
        return;
      }

      const player: Player = {
        id: playerId,
        name: user.displayName,
        avatar: user.photoURL,
        role: null,
        team: null,
        status: 'active',
        createdAt: Date.now(),
      };

      room.players[playerId] = player;
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = playerId;

      this.io.to(roomId).emit('game:state-updated', room);
      this.io.to(roomId).emit('game:player-joined', player);
      this.persistRoom(room);

      console.log(`Player ${user.displayName} joined room ${roomId} (${Object.keys(room.players).length}/${room.maxPlayers})`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', 'Failed to join room');
    }
  }

  private handleStartGame(socket: Socket, roomId: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      const gameEngine = this.gameEngines.get(roomId);
      if (!gameEngine) {
        socket.emit('error', 'Game engine not found');
        return;
      }

      gameEngine.startGame();
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.io.to(roomId).emit('game:started', updatedRoom);
      this.persistRoom(updatedRoom);
      console.log(`Game started in room ${roomId}`);
    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('error', 'Failed to start game');
    }
  }

  private handleVote(socket: Socket, roomId: string, playerId: string, vote: boolean): void {
    try {
      // Rate limiting
      const voteIdentifier = `${socket.id}:vote`;
      if (!voteLimiter.isAllowed(voteIdentifier)) {
        socket.emit('error', 'Voting too frequently. Please wait.');
        return;
      }

      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      // Verify player is in room
      if (!(playerId in room.players)) {
        socket.emit('error', 'Player not in room');
        return;
      }

      // Verify game state
      if (room.state !== 'voting') {
        socket.emit('error', 'Not in voting phase');
        return;
      }

      const gameEngine = this.gameEngines.get(roomId);
      if (!gameEngine) {
        socket.emit('error', 'Game engine not found');
        return;
      }

      gameEngine.submitVote(playerId, vote);
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.io.to(roomId).emit('game:state-updated', updatedRoom);
      this.persistRoom(updatedRoom);

      if (updatedRoom.state === 'ended') {
        this.io.to(roomId).emit('game:ended', updatedRoom, updatedRoom.evilWins ? 'evil' : 'good');
        this.onGameEnd(roomId, updatedRoom);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing vote:', errorMsg);
      socket.emit('error', `Failed to submit vote: ${errorMsg}`);
    }
  }

  private handleSelectQuestTeam(socket: Socket, roomId: string, teamMemberIds: string[]): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      // Verify room is in voting state
      if (room.state !== 'voting') {
        socket.emit('error', 'Not in voting phase');
        return;
      }

      const gameEngine = this.gameEngines.get(roomId);
      if (!gameEngine) {
        socket.emit('error', 'Game engine not found');
        return;
      }

      // Verify the player is the current leader
      const currentLeader = gameEngine.getCurrentLeaderId();
      const playerId = socket.data.playerId;
      if (playerId !== currentLeader) {
        socket.emit('error', 'Only the leader can select the quest team');
        return;
      }

      gameEngine.selectQuestTeam(teamMemberIds);
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.io.to(roomId).emit('game:state-updated', updatedRoom);
      this.persistRoom(updatedRoom);
      console.log(`Quest team selected in room ${roomId}: ${teamMemberIds.length} players`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error selecting quest team:', errorMsg);
      socket.emit('error', `Failed to select quest team: ${errorMsg}`);
    }
  }

  private handleSubmitQuestVote(
    socket: Socket,
    roomId: string,
    playerId: string,
    vote: 'success' | 'fail'
  ): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      // Verify room is in quest state
      if (room.state !== 'quest') {
        socket.emit('error', 'Not in quest phase');
        return;
      }

      // Verify player is in room
      if (!(playerId in room.players)) {
        socket.emit('error', 'Player not in room');
        return;
      }

      const gameEngine = this.gameEngines.get(roomId);
      if (!gameEngine) {
        socket.emit('error', 'Game engine not found');
        return;
      }

      gameEngine.submitQuestVote(playerId, vote);
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.io.to(roomId).emit('game:state-updated', updatedRoom);
      this.persistRoom(updatedRoom);

      if (updatedRoom.state === 'ended') {
        this.io.to(roomId).emit('game:ended', updatedRoom, updatedRoom.evilWins ? 'evil' : 'good');
        this.onGameEnd(roomId, updatedRoom);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing quest vote:', errorMsg);
      socket.emit('error', `Failed to submit quest vote: ${errorMsg}`);
    }
  }

  private handleAssassinate(socket: Socket, roomId: string, assassinId: string, targetId: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      // Verify room is in discussion state
      if (room.state !== 'discussion') {
        socket.emit('error', 'Not in discussion phase');
        return;
      }

      // Verify assassin is in room
      if (!(assassinId in room.players)) {
        socket.emit('error', 'Assassin not in room');
        return;
      }

      const gameEngine = this.gameEngines.get(roomId);
      if (!gameEngine) {
        socket.emit('error', 'Game engine not found');
        return;
      }

      gameEngine.submitAssassination(assassinId, targetId);
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.io.to(roomId).emit('game:state-updated', updatedRoom);
      this.io.to(roomId).emit('game:ended', updatedRoom, updatedRoom.evilWins ? 'evil' : 'good');
      this.persistRoom(updatedRoom);
      console.log(`Game ended in room ${roomId}. Winner: ${updatedRoom.evilWins ? 'Evil' : 'Good'}`);

      this.onGameEnd(roomId, updatedRoom);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing assassination:', errorMsg);
      socket.emit('error', `Failed to submit assassination: ${errorMsg}`);
    }
  }

  /**
   * Called whenever a game transitions to 'ended'.
   * 1. Saves in-memory replay snapshot
   * 2. Persists game record to Firestore (game history)
   * 3. Updates per-player stats in RTD
   * 4. Removes active room from RTD (archived to Firestore)
   */
  private onGameEnd(roomId: string, room: Room): void {
    this.roomManager.saveReplay(room);

    const winner = room.evilWins ? 'evil' : 'good';
    const duration = room.updatedAt - room.createdAt;

    // Determine win reason from the last game engine log (best-effort)
    const winReason = this.inferWinReason(room);

    // Archive to Firestore
    this.gameHistory.saveGameRecord(room, winReason).catch((err) =>
      console.error(`Failed to save game history for room ${roomId}:`, err)
    );

    // Remove active room from RTD (it's now in Firestore)
    this.persistence.removeRoom(roomId).catch((err) =>
      console.error(`Failed to remove room ${roomId} from RTD:`, err)
    );

    // Broadcast result to Discord #同步閒聊
    broadcastGameResult(room, winReason).catch((err) =>
      console.error(`Failed to broadcast game result to Discord for room ${roomId}:`, err)
    );

    // Update per-player stats
    for (const [playerId, player] of Object.entries(room.players)) {
      const playerWon =
        (winner === 'good' && player.team === 'good') ||
        (winner === 'evil' && player.team === 'evil');

      updateUserStats(playerId, {
        won: playerWon,
        role: player.role ?? 'loyal',
        duration,
        kills: player.kills?.length ?? 0,
      }).catch((err) =>
        console.error(`Failed to update stats for player ${playerId}:`, err)
      );
    }

    // Clean up engine
    const engine = this.gameEngines.get(roomId);
    if (engine) {
      engine.cleanup();
      this.gameEngines.delete(roomId);
    }
  }

  /**
   * Infer why the game ended based on room state.
   */
  private inferWinReason(room: Room): string {
    if (room.evilWins === null) return 'unknown';

    const successCount = room.questResults.filter((r) => r === 'success').length;
    const failCount = room.questResults.filter((r) => r === 'fail').length;

    if (room.evilWins) {
      if (failCount >= 3) return 'failed_quests_limit';
      if (room.failCount >= 3) return 'vote_rejections_limit';
      return 'merlin_assassinated';
    }

    if (successCount >= 3) return 'assassination_failed';
    return 'assassination_timeout';
  }

  private handleChatMessage(socket: Socket, roomId: string, message: string): void {
    try {
      // Rate limiting
      const chatIdentifier = `${socket.id}:chat`;
      if (!chatLimiter.isAllowed(chatIdentifier)) {
        socket.emit('error', 'Sending messages too frequently. Please wait.');
        return;
      }

      const room = this.roomManager.getRoom(roomId);
      if (!room) return;

      const playerId = socket.data.playerId;
      const player = room.players[playerId];
      if (!player) return;

      // Validate message content
      const trimmedMessage = message.trim();
      if (!trimmedMessage || trimmedMessage.length > 500) {
        socket.emit('error', 'Message must be between 1 and 500 characters');
        return;
      }

      this.io.to(roomId).emit('chat:message-received', {
        id: uuidv4(),
        roomId,
        playerId,
        playerName: player.name,
        message: trimmedMessage,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Error sending chat message:', error);
    }
  }

  private handleDisconnect(socket: Socket): void {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;

    if (roomId && playerId) {
      const room = this.roomManager.getRoom(roomId);
      if (room && room.players[playerId]) {
        room.players[playerId].status = 'disconnected';
        this.io.to(roomId).emit('game:player-left', playerId);
        this.persistRoom(room);
      }
    }

    console.log(`Player disconnected: ${socket.id}`);
  }
}
