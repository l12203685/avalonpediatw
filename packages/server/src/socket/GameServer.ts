import { Server as SocketIOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { Room, Player, User } from '@avalon/shared';
import { RoomManager } from '../game/RoomManager';
import { GameEngine } from '../game/GameEngine';
import { SocketRateLimiter } from '../middleware/rateLimit';
import {
  saveRoom,
  updateRoomState,
  saveGameRecords,
  saveGameEvents,
  awardBadges,
  getUserElo,
  DbGameRecord,
} from '../services/supabase';

// Rate limiters for different events
const voteLimiter = new SocketRateLimiter({
  windowMs: 1000, // 1 second
  maxRequests: 1, // Max 1 vote per second
});

const chatLimiter = new SocketRateLimiter({
  windowMs: 1000, // 1 second
  maxRequests: 2, // Max 2 messages per second
});

// ELO constants
const ELO_WIN  =  20;
const ELO_LOSE = -15;

export class GameServer {
  private io: SocketIOServer;
  private roomManager: RoomManager;
  private gameEngines: Map<string, GameEngine> = new Map();
  // uid → supabase UUID (set from socket.data.supabaseId on join/create)
  private supabaseIds: Map<string, string> = new Map();
  // roomId → start timestamp (ms)
  private roomStartTimes: Map<string, number> = new Map();
  // playerId → socketId (for per-player state delivery)
  private playerToSocket: Map<string, string> = new Map();

  constructor(io: SocketIOServer) {
    this.io = io;
    this.roomManager = new RoomManager();
  }

  public start(): void {
    // Periodic cleanup: remove engine references for rooms that no longer exist
    setInterval(() => {
      for (const roomId of this.gameEngines.keys()) {
        if (!this.roomManager.getRoom(roomId)) {
          this.gameEngines.delete(roomId);
          this.roomStartTimes.delete(roomId);
        }
      }
    }, 10 * 60 * 1000); // every 10 minutes

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

  private generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid confusing chars (0/O, 1/I)
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    // Ensure uniqueness
    if (this.roomManager.getRoom(code)) return this.generateRoomCode();
    return code;
  }

  /**
   * Determine which player IDs are visible (role/team revealed) to the given player
   * based on Avalon knowledge rules. Called only during an active game (not revealAll).
   */
  private getVisiblePlayerIds(playerId: string, room: Room): Set<string> {
    const visible = new Set<string>([playerId]); // always see yourself
    const myPlayer = room.players[playerId];
    if (!myPlayer?.role) return visible;

    const myRole  = myPlayer.role;
    const myTeam  = myPlayer.team;

    for (const [pid, p] of Object.entries(room.players)) {
      if (pid === playerId || !p.role) continue;

      if (myRole === 'merlin') {
        // Merlin sees all evil except Oberon
        if (p.team === 'evil' && p.role !== 'oberon') visible.add(pid);
      } else if (myRole === 'percival') {
        // Percival sees Merlin and Morgana (can't distinguish)
        if (p.role === 'merlin' || p.role === 'morgana') visible.add(pid);
      } else if (myTeam === 'evil' && myRole !== 'oberon') {
        // Evil (except Oberon) sees other evil except Oberon
        if (p.team === 'evil' && p.role !== 'oberon') visible.add(pid);
      }
    }
    return visible;
  }

  /**
   * Returns a copy of room with other players' role/team hidden.
   * Applies Avalon knowledge rules so Merlin/Percival/Evil see correct players.
   * Pass revealAll=true at game end when all roles are disclosed.
   */
  private sanitizeRoomForPlayer(room: Room, playerId: string, revealAll = false): Room {
    const visibleIds = revealAll ? null : this.getVisiblePlayerIds(playerId, room);
    const players: Record<string, Player> = {};
    for (const [pid, player] of Object.entries(room.players)) {
      if (pid === playerId || revealAll || visibleIds?.has(pid)) {
        players[pid] = player;
      } else {
        players[pid] = { ...player, role: null, team: null, vote: undefined };
      }
    }
    // During voting: hide other players' vote direction (show only who has voted, not which way).
    // After voting resolves or at game end: reveal all votes.
    let votes = room.votes;
    if (room.state === 'voting' && !revealAll) {
      votes = {};
      for (const [vid, v] of Object.entries(room.votes)) {
        votes[vid] = vid === playerId ? v : true; // mask direction as "voted" placeholder
      }
    }
    return { ...room, players, votes };
  }

  /**
   * Broadcast room state to every socket in the room, each receiving only their own role.
   */
  private broadcastRoomState(roomId: string, room: Room, revealAll = false): void {
    for (const [pid, socketId] of this.playerToSocket.entries()) {
      if (room.players[pid]) {
        this.io.to(socketId).emit('game:state-updated', this.sanitizeRoomForPlayer(room, pid, revealAll));
      }
    }
  }

  private handleCreateRoom(socket: Socket, playerName: string, user: User): void {
    try {
      const roomId = this.generateRoomCode();
      const playerId = user.uid;

      const room = this.roomManager.createRoom(roomId, playerName || user.displayName, playerId);
      const gameEngine = new GameEngine(room);
      this.gameEngines.set(roomId, gameEngine);

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = playerId;
      this.playerToSocket.set(playerId, socket.id);

      // Track supabase UUID for ELO persistence
      if (socket.data.supabaseId) {
        this.supabaseIds.set(playerId, socket.data.supabaseId as string);
      }

      // Update player info with user avatar
      room.players[playerId].avatar = user.photoURL;

      // Persist to Supabase (non-blocking)
      const hostSupabaseId = this.supabaseIds.get(playerId) || null;
      saveRoom(roomId, hostSupabaseId, room.maxPlayers).catch(err =>
        console.error('[supabase] saveRoom error:', err)
      );

      this.broadcastRoomState(roomId, room);
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
          this.playerToSocket.set(playerId, socket.id);

          this.io.to(roomId).emit('game:player-reconnected', playerId);
          this.broadcastRoomState(roomId, room);

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
      this.playerToSocket.set(playerId, socket.id);

      // Track supabase UUID for ELO persistence
      if (socket.data.supabaseId) {
        this.supabaseIds.set(playerId, socket.data.supabaseId as string);
      }

      this.broadcastRoomState(roomId, room);
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

      this.roomStartTimes.set(roomId, Date.now());
      updateRoomState(roomId, 'playing').catch(err =>
        console.error('[supabase] updateRoomState error:', err)
      );

      // game:started reveals each player's own role only
      for (const [pid, socketId] of this.playerToSocket.entries()) {
        if (updatedRoom.players[pid]) {
          this.io.to(socketId).emit('game:started', this.sanitizeRoomForPlayer(updatedRoom, pid));
        }
      }
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

      this.broadcastRoomState(roomId, updatedRoom);

      if (updatedRoom.state === 'ended') {
        this.onGameEnded(roomId, updatedRoom);
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
      const requestingPlayerId = socket.data.playerId;
      if (requestingPlayerId !== currentLeader) {
        socket.emit('error', 'Only the leader can select the quest team');
        return;
      }

      gameEngine.selectQuestTeam(teamMemberIds);
      const updatedRoom = this.roomManager.getRoom(roomId)!;

      this.broadcastRoomState(roomId, updatedRoom);
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

      this.broadcastRoomState(roomId, updatedRoom);

      if (updatedRoom.state === 'ended') {
        this.onGameEnded(roomId, updatedRoom);
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

      this.broadcastRoomState(roomId, updatedRoom);
      this.onGameEnded(roomId, updatedRoom);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing assassination:', errorMsg);
      socket.emit('error', `Failed to submit assassination: ${errorMsg}`);
    }
  }

  /** Called whenever a room transitions to 'ended' state */
  private onGameEnded(roomId: string, room: Room): void {
    const evilWins = room.evilWins === true;
    const playerCount = Object.keys(room.players).length;
    const startTime = this.roomStartTimes.get(roomId);
    const durationSec = startTime ? Math.round((Date.now() - startTime) / 1000) : undefined;

    console.log(`✓ Game ended in room ${roomId}. Winner: ${evilWins ? 'Evil' : 'Good'}`);

    // Emit game:ended — reveal all roles to all players
    this.broadcastRoomState(roomId, room, true);
    this.io.to(roomId).emit('game:ended', room);

    // Persist asynchronously — never blocks the game flow
    this.persistGameResult(roomId, room, evilWins, playerCount, durationSec).catch(err =>
      console.error('[supabase] persistGameResult error:', err)
    );

    // Cleanup engine reference after a short delay (allow late stragglers to reconnect)
    setTimeout(() => {
      this.gameEngines.delete(roomId);
      this.roomStartTimes.delete(roomId);
    }, 5 * 60 * 1000); // 5 minutes
  }

  private async persistGameResult(
    roomId: string,
    room: Room,
    evilWins: boolean,
    playerCount: number,
    durationSec?: number
  ): Promise<void> {
    // Update room state in Supabase
    await updateRoomState(roomId, 'ended', evilWins);

    // Build game records for Supabase users (skip guests with no supabase ID)
    const records: DbGameRecord[] = [];
    for (const [uid, player] of Object.entries(room.players)) {
      const supabaseId = this.supabaseIds.get(uid);
      if (!supabaseId) continue; // guest or unregistered — skip

      const team = player.team as 'good' | 'evil' | null;
      if (!team) continue;

      const playerWon = evilWins ? team === 'evil' : team === 'good';
      const eloBefore = await getUserElo(supabaseId);
      const eloDelta  = playerWon ? ELO_WIN : ELO_LOSE;
      const eloAfter  = Math.max(0, eloBefore + eloDelta);

      records.push({
        room_id:        roomId,
        player_user_id: supabaseId,
        role:           player.role || 'unknown',
        team,
        won:            playerWon,
        elo_before:     eloBefore,
        elo_after:      eloAfter,
        elo_delta:      eloDelta,
        player_count:   playerCount,
        duration_sec:   durationSec,
      });
    }

    if (records.length > 0) {
      await saveGameRecords(records);
      console.log(`[supabase] Saved ${records.length} game records for room ${roomId}`);

      // Award badges based on this game's results
      for (const record of records) {
        const badges = this.evaluateBadges(record, playerCount, records);
        if (badges.length > 0) {
          await awardBadges(record.player_user_id, badges);
        }
      }
    }

    // Flush event log for replay & AI training
    const engine = this.gameEngines.get(roomId);
    if (engine) {
      const events = engine.getEventLog().map(e => ({
        room_id:    roomId,
        seq:        e.seq,
        event_type: e.event_type,
        actor_id:   e.actor_id,
        event_data: e.event_data,
      }));
      await saveGameEvents(events);
      console.log(`[supabase] Saved ${events.length} game events for room ${roomId}`);
    }
  }

  private evaluateBadges(record: DbGameRecord, playerCount: number, allRecords: DbGameRecord[]): string[] {
    const badges: string[] = [];

    // 首次勝利
    if (record.won) badges.push('初勝');

    // 梅林之盾 — 以梅林身份獲勝
    if (record.won && record.role === 'merlin') badges.push('梅林之盾');

    // 刺客之影 — 以刺客身份獲勝
    if (record.won && record.role === 'assassin') badges.push('刺客之影');

    // 全場最大局 — 10人局
    if (playerCount >= 10) badges.push('十人戰場');

    // 滿血 — ELO 從未低於 1000 且本局獲勝
    if (record.won && record.elo_before >= 1000) badges.push('穩健');

    // 浴火重生 — ELO 低於 800 時獲勝
    if (record.won && record.elo_before < 800) badges.push('浴火重生');

    return badges;
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
    const roomId   = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (playerId) this.playerToSocket.delete(playerId);

    if (roomId && playerId) {
      const room = this.roomManager.getRoom(roomId);
      if (room && room.players[playerId]) {
        room.players[playerId].status = 'disconnected';
        this.io.to(roomId).emit('game:player-left', playerId);

        // If all players are disconnected and game hasn't started, clean up lobby immediately
        if (room.state === 'lobby') {
          const allGone = Object.values(room.players).every(p => p.status === 'disconnected');
          if (allGone) {
            this.roomManager.deleteRoom(roomId);
            this.gameEngines.delete(roomId);
            this.roomStartTimes.delete(roomId);
            console.log(`✓ Empty lobby cleaned up: ${roomId}`);
          }
        }
      }
    }

    console.log(`✓ Player disconnected: ${socket.id}`);
  }

}
