import { Server as SocketIOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { Room, Player, PlayerStatus, User } from '@avalon/shared';
import { RoomManager } from '../game/RoomManager';
import { GameEngine } from '../game/GameEngine';
import { updateUserStats } from '../services/firebase';
import { SocketRateLimiter } from '../middleware/rateLimit';

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

  constructor(io: SocketIOServer) {
    this.io = io;
    this.roomManager = new RoomManager();
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

  private handleCreateRoom(socket: Socket, playerName: string, user: User): void {
    try {
      const roomId = uuidv4();
      const playerId = user.uid;

      const room = this.roomManager.createRoom(roomId, playerName || user.displayName, playerId);
      const gameEngine = new GameEngine(room);
      this.gameEngines.set(roomId, gameEngine);

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = playerId;

      // Update player info with user avatar
      room.players[playerId].avatar = user.photoURL;

      this.io.to(roomId).emit('game:state-updated', room);

      console.log(`✓ Room created: ${roomId} by ${user.displayName}`);
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

          console.log(`✓ Player ${user.displayName} reconnected to room ${roomId}`);
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

      console.log(`✓ Player ${user.displayName} joined room ${roomId} (${Object.keys(room.players).length}/${room.maxPlayers})`);
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
      console.log(`✓ Game started in room ${roomId}`);
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
      console.log(`✓ Quest team selected in room ${roomId}: ${teamMemberIds.length} players`);
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
      this.io.to(roomId).emit('game:ended', updatedRoom);
      console.log(`✓ Game ended in room ${roomId}. Winner: ${updatedRoom.evilWins ? 'Evil' : 'Good'}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing assassination:', errorMsg);
      socket.emit('error', `Failed to submit assassination: ${errorMsg}`);
    }
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
      }
    }

    console.log(`✓ Player disconnected: ${socket.id}`);
  }
}
