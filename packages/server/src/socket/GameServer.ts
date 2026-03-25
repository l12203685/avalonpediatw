import { Server as SocketIOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { Room, Player, PlayerStatus } from '@avalon/shared';
import { RoomManager } from '../game/RoomManager';
import { GameEngine } from '../game/GameEngine';

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
      console.log(`✓ Player connected: ${socket.id}`);

      // Game events
      socket.on('game:create-room', (playerName: string) => {
        this.handleCreateRoom(socket, playerName);
      });

      socket.on('game:join-room', (roomId: string, playerId: string) => {
        this.handleJoinRoom(socket, roomId, playerId);
      });

      socket.on('game:start-game', (roomId: string) => {
        this.handleStartGame(socket, roomId);
      });

      socket.on('game:vote', (roomId: string, playerId: string, vote: boolean) => {
        this.handleVote(socket, roomId, playerId, vote);
      });

      socket.on('game:submit-quest-result', (roomId: string, result: 'success' | 'fail') => {
        this.handleQuestResult(socket, roomId, result);
      });

      socket.on('game:assassinate', (roomId: string, targetId: string) => {
        this.handleAssassinate(socket, roomId, targetId);
      });

      socket.on('chat:send-message', (roomId: string, message: string) => {
        this.handleChatMessage(socket, roomId, message);
      });

      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  private handleCreateRoom(socket: Socket, playerName: string): void {
    try {
      const roomId = uuidv4();
      const playerId = uuidv4();

      const room = this.roomManager.createRoom(roomId, playerName, playerId);
      const gameEngine = new GameEngine(room);
      this.gameEngines.set(roomId, gameEngine);

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = playerId;

      this.io.to(roomId).emit('game:state-updated', room);

      console.log(`✓ Room created: ${roomId} by ${playerName}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error', 'Failed to create room');
    }
  }

  private handleJoinRoom(socket: Socket, roomId: string, playerId: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      if (Object.keys(room.players).length >= room.maxPlayers) {
        socket.emit('error', 'Room is full');
        return;
      }

      const player: Player = {
        id: playerId,
        name: `Player${uuidv4().substring(0, 4)}`,
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

      console.log(`✓ Player ${playerId} joined room ${roomId}`);
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

      gameEngine.submitVote(playerId, vote);
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.io.to(roomId).emit('game:state-updated', updatedRoom);
    } catch (error) {
      console.error('Error processing vote:', error);
      socket.emit('error', 'Failed to submit vote');
    }
  }

  private handleQuestResult(
    socket: Socket,
    roomId: string,
    result: 'success' | 'fail'
  ): void {
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

      gameEngine.submitQuestResult(result);
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.io.to(roomId).emit('game:state-updated', updatedRoom);
    } catch (error) {
      console.error('Error processing quest result:', error);
      socket.emit('error', 'Failed to submit quest result');
    }
  }

  private handleAssassinate(socket: Socket, roomId: string, targetId: string): void {
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

      gameEngine.submitAssassination(targetId);
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.io.to(roomId).emit('game:ended', updatedRoom);
    } catch (error) {
      console.error('Error processing assassination:', error);
      socket.emit('error', 'Failed to submit assassination');
    }
  }

  private handleChatMessage(socket: Socket, roomId: string, message: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) return;

      const playerId = socket.data.playerId;
      const player = room.players[playerId];
      if (!player) return;

      this.io.to(roomId).emit('chat:message-received', {
        id: uuidv4(),
        roomId,
        playerId,
        playerName: player.name,
        message,
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
