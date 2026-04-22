import { Server as SocketIOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { Room, Player, User, AVALON_CONFIG, TimerConfig, TimerMultiplier, isTimerMultiplier } from '@avalon/shared';
import { RoomManager } from '../game/RoomManager';
import { setSharedRoomManager } from '../game/roomManagerSingleton';
import { GameEngine } from '../game/GameEngine';
import { HeuristicAgent } from '../ai/HeuristicAgent';
import { RandomAgent } from '../ai/RandomAgent';
import { PlayerObservation, AvalonAgent } from '../ai/types';
import { SocketRateLimiter } from '../middleware/rateLimit';
import { LobbyChatBuffer, LobbyChatMessage } from './LobbyChatBuffer';
import {
  saveRoom,
  updateRoomState,
  saveGameRecords,
  saveGameEvents,
  awardBadges,
  getUserEloBulk,
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

// #63 — lobby (main page) public chat rate limiter. Slightly stricter than the
// in-room chat because a single noisy client is visible to every lobby visitor.
const lobbyChatLimiter = new SocketRateLimiter({
  windowMs: 2000,
  maxRequests: 2,
});

// ELO constants
const ELO_WIN  =  20;
const ELO_LOSE = -15;

// ─── Discord role-reveal lazy loader ─────────────────────────────────────
//
// `src/bots/**/*` is excluded from the server TypeScript build (pre-existing
// discord.js typing issues in that subtree), so `dist/bots/` is never emitted
// and a static import would fail at build time. We keep the runtime dynamic
// and cache the load outcome in module scope so failed loads warn exactly
// once on first use — not every time a game starts — and successful loads
// avoid paying the require cost on every subsequent game.
type RoleRevealFn = (room: Room) => Promise<unknown>;
let cachedRoleRevealFn: RoleRevealFn | null = null;
let roleRevealLoadAttempted = false;
let roleRevealLoadFailed = false;

function getRoleRevealFn(): RoleRevealFn | null {
  if (roleRevealLoadAttempted) {
    return roleRevealLoadFailed ? null : cachedRoleRevealFn;
  }
  roleRevealLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../bots/discord/roleReveal');
    const fn = mod?.sendRoleRevealToRoom;
    if (typeof fn !== 'function') {
      roleRevealLoadFailed = true;
      console.warn('[roleReveal] module loaded but sendRoleRevealToRoom is not a function — DM reveal disabled');
      return null;
    }
    cachedRoleRevealFn = fn as RoleRevealFn;
    return cachedRoleRevealFn;
  } catch (loadErr) {
    roleRevealLoadFailed = true;
    const msg = loadErr instanceof Error ? loadErr.message : String(loadErr);
    console.warn(`[roleReveal] DM helper not available — disabled for this process (${msg})`);
    return null;
  }
}

function roomHasDiscordPlayer(room: Room): boolean {
  for (const pid of Object.keys(room.players)) {
    if (pid.startsWith('discord:')) return true;
  }
  return false;
}

// ─── ChatMirror (#82) lazy loader ─────────────────────────────────────────
//
// Same dynamic-require pattern as roleReveal above — `src/bots/**/*` is
// excluded from the TypeScript build, so a static import would break `dist/`.
// ChatMirror is optional for the socket hot path: if the env vars or bot
// clients aren't ready, fanout() is a no-op and the lobby emit is unaffected.
//
// We capture the module exports rather than a single function so we can
// both build + retrieve the singleton here.
type ChatMirrorModule = {
  initializeChatMirror: (cfg: unknown) => { fanout: (msg: LobbyChatMessage) => Promise<void> };
  getChatMirror: () => { fanout: (msg: LobbyChatMessage) => Promise<void> } | null;
};
let cachedChatMirrorMod: ChatMirrorModule | null = null;
let chatMirrorLoadAttempted = false;
let chatMirrorLoadFailed = false;

function getChatMirrorModule(): ChatMirrorModule | null {
  if (chatMirrorLoadAttempted) {
    return chatMirrorLoadFailed ? null : cachedChatMirrorMod;
  }
  chatMirrorLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../bots/ChatMirror');
    if (typeof mod?.initializeChatMirror !== 'function') {
      chatMirrorLoadFailed = true;
      console.warn('[ChatMirror] module loaded but initializeChatMirror missing — mirror disabled');
      return null;
    }
    cachedChatMirrorMod = mod as ChatMirrorModule;
    return cachedChatMirrorMod;
  } catch (loadErr) {
    chatMirrorLoadFailed = true;
    const msg = loadErr instanceof Error ? loadErr.message : String(loadErr);
    console.warn(`[ChatMirror] not available — lobby mirror disabled (${msg})`);
    return null;
  }
}

/**
 * Best-effort fanout of a lobby message to LINE/Discord mirrors. Never throws.
 * Called after the socket emit so UI never waits on external network.
 */
function tryMirrorFanout(msg: LobbyChatMessage): void {
  const mod = getChatMirrorModule();
  if (!mod) return;
  const mirror = mod.getChatMirror();
  if (!mirror) return;
  // Fire-and-forget; errors are logged inside ChatMirror itself.
  mirror.fanout(msg).catch((err) => {
    console.warn('[ChatMirror] fanout promise rejected:', err);
  });
}

export class GameServer {
  private io: SocketIOServer;
  private roomManager: RoomManager;
  private gameEngines: Map<string, GameEngine> = new Map();
  // botId → HeuristicAgent instance (for bot-controlled players)
  private botAgents: Map<string, AvalonAgent> = new Map();
  // uid → supabase UUID (set from socket.data.supabaseId on join/create)
  private supabaseIds: Map<string, string> = new Map();
  // roomId → start timestamp (ms)
  private roomStartTimes: Map<string, number> = new Map();
  // playerId → socketId (for per-player state delivery)
  private playerToSocket: Map<string, string> = new Map();
  // roomId → Set of spectator socketIds
  private spectators: Map<string, Set<string>> = new Map();
  // #63 — ring buffer for the main-page public chat. Memory-only by design
  // (MVP scope); persistent sync is tracked under #82.
  private lobbyChat: LobbyChatBuffer = new LobbyChatBuffer();

  constructor(io: SocketIOServer) {
    this.io = io;
    this.roomManager = new RoomManager();
    // Make the same RoomManager visible to non-socket callers (Discord /
    // LINE bot handlers) so a room created via /create can be started,
    // joined, and ended from either the web or Discord. Without this wiring
    // the bot throws "RoomManager not initialised" on its first command.
    setSharedRoomManager(this.roomManager);
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
      socket.on(
        'game:create-room',
        (
          playerName: string,
          password?: string,
          timerMultiplier?: TimerMultiplier,
        ) => {
          this.handleCreateRoom(socket, playerName, user, password, timerMultiplier);
        },
      );

      socket.on('game:join-room', (roomId: string, password?: string) => {
        this.handleJoinRoom(socket, roomId, user, password);
      });

      socket.on('game:set-room-password', (roomId: string, password: string | null) => {
        this.handleSetRoomPassword(socket, roomId, password);
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

      socket.on('game:lady-of-the-lake', (roomId: string, holderId: string, targetId: string) => {
        this.handleLadyOfTheLake(socket, roomId, holderId, targetId);
      });

      socket.on('game:declare-lake-result', (roomId: string, claim: 'good' | 'evil') => {
        this.handleDeclareLakeResult(socket, roomId, claim);
      });

      socket.on('chat:send-message', (roomId: string, message: string) => {
        this.handleChatMessage(socket, roomId, message);
      });

      // #63 — Public lobby chat (main page). Anyone (including guests) can
      // read; only non-guest (authenticated) users can send messages.
      socket.on('lobby:join', () => {
        this.handleLobbyJoin(socket);
      });

      socket.on('lobby:send-message', (message: string) => {
        this.handleLobbySendMessage(socket, message);
      });

      socket.on('game:kick-player', (roomId: string, targetPlayerId: string) => {
        this.handleKickPlayer(socket, roomId, targetPlayerId);
      });

      socket.on('game:add-bot', (roomId: string, difficulty?: string) => {
        this.handleAddBot(socket, roomId, difficulty as 'easy' | 'normal' | 'hard' | undefined);
      });

      socket.on('game:remove-bot', (roomId: string, botId: string) => {
        this.handleRemoveBot(socket, roomId, botId);
      });

      socket.on('game:rematch', (roomId: string) => {
        this.handleRematch(socket, roomId);
      });

      socket.on('game:leave-room', (roomId: string) => {
        this.handleLeaveRoom(socket, roomId);
      });

      socket.on('game:set-max-players', (roomId: string, count: number) => {
        this.handleSetMaxPlayers(socket, roomId, count);
      });

      socket.on('game:set-role-options', (roomId: string, options: Record<string, unknown>) => {
        this.handleSetRoleOptions(socket, roomId, options);
      });

      socket.on('game:toggle-ready', (roomId: string, playerId: string) => {
        this.handleToggleReady(socket, roomId, playerId);
      });

      socket.on('game:spectate-room', (roomId: string) => {
        this.handleSpectateRoom(socket, roomId);
      });

      socket.on('game:leave-spectate', (roomId: string) => {
        this.handleLeaveSpectate(socket, roomId);
      });

      socket.on('game:list-rooms', () => {
        const openRooms = this.roomManager.getAllRooms()
          .filter(r => r.state !== 'ended' && !r.id.startsWith('AI-'))
          .map(r => ({
            id:          r.id.slice(0, 8).toUpperCase(),
            fullId:      r.id,
            name:        r.name,
            playerCount: Object.values(r.players).filter(p => !p.isBot).length,
            maxPlayers:  r.maxPlayers,
            createdAt:   r.createdAt,
            inProgress:  r.state !== 'lobby',
            isPrivate:   r.isPrivate ?? false,
          }))
          .sort((a, b) => (a.inProgress ? 1 : 0) - (b.inProgress ? 1 : 0) || b.createdAt - a.createdAt);
        socket.emit('game:rooms-list', openRooms);
      });

      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  private generateRoomCode(attempt = 0): string {
    if (attempt > 50) throw new Error('Could not generate unique room code after 50 attempts');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid confusing chars (0/O, 1/I)
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (this.roomManager.getRoom(code)) return this.generateRoomCode(attempt + 1);
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
        // Merlin sees all evil except Oberon and Mordred
        if (p.team === 'evil' && p.role !== 'oberon' && p.role !== 'mordred') visible.add(pid);
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
    // Lady of the Lake history: hide inspection result from non-holders
    // (only the holder who performed each inspection knows the actual result)
    const ladyHistory = room.ladyOfTheLakeHistory?.map(record =>
      record.holderId === playerId || revealAll
        ? record
        : { ...record, result: undefined as unknown as 'good' | 'evil' }
    );
    return { ...room, players, votes, ladyOfTheLakeHistory: ladyHistory };
  }

  /**
   * Broadcast room state to every socket in the room, each receiving only their own role.
   * Also broadcasts spectator-sanitized state to any watching sockets.
   */
  private broadcastRoomState(roomId: string, room: Room, revealAll = false): void {
    for (const [pid, socketId] of this.playerToSocket.entries()) {
      if (room.players[pid]) {
        this.io.to(socketId).emit('game:state-updated', this.sanitizeRoomForPlayer(room, pid, revealAll));
      }
    }
    // Spectators get the room with all roles hidden (unless ended)
    const spectatorSet = this.spectators.get(roomId);
    if (spectatorSet && spectatorSet.size > 0) {
      const spectatorRoom = this.sanitizeRoomForSpectator(room, revealAll);
      for (const sid of spectatorSet) {
        this.io.to(sid).emit('game:state-updated', spectatorRoom);
      }
    }
  }

  private sanitizeRoomForSpectator(room: Room, revealAll = false): Room {
    const players: Record<string, Player> = {};
    for (const [pid, player] of Object.entries(room.players)) {
      players[pid] = revealAll ? player : { ...player, role: null, team: null, vote: undefined };
    }
    // Spectators never see individual vote directions
    const votes: Record<string, boolean> = {};
    for (const vid of Object.keys(room.votes)) {
      votes[vid] = true; // just show "has voted"
    }
    // Spectators see Lady inspections but never the result
    const ladyHistory = room.ladyOfTheLakeHistory?.map(record =>
      revealAll ? record : { ...record, result: undefined as unknown as 'good' | 'evil' }
    );
    return { ...room, players, votes, ladyOfTheLakeHistory: ladyHistory };
  }

  private handleSetRoomPassword(socket: Socket, roomId: string, password: string | null): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.host !== socket.data.playerId) { socket.emit('error', 'Only the host can set a password'); return; }
    const pw = password?.trim() || null;
    this.roomManager.setRoomPassword(roomId, pw);
    this.broadcastRoomState(roomId, this.roomManager.getRoom(roomId)!);
  }

  private handleCreateRoom(
    socket: Socket,
    playerName: string,
    user: User,
    password?: string,
    timerMultiplier?: TimerMultiplier,
  ): void {
    try {
      const roomId = this.generateRoomCode();
      const playerId = user.uid;

      // Only honor the multiplier if it passes the shared validator; fall
      // back to 1x for anything else (including legacy clients that don't
      // send the field).
      const timerConfig: TimerConfig | undefined = isTimerMultiplier(timerMultiplier)
        ? { multiplier: timerMultiplier }
        : undefined;
      const room = this.roomManager.createRoom(
        roomId,
        playerName || user.displayName,
        playerId,
        timerConfig,
      );
      if (password?.trim()) {
        this.roomManager.setRoomPassword(roomId, password.trim());
      }
      const gameEngine = this.createGameEngine(roomId, room);
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

  private handleJoinRoom(socket: Socket, roomId: string, user: User, password?: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      const playerId = user.uid;
      const playerExists = room.players[playerId];

      // Check password for non-members (reconnects bypass password check)
      if (!playerExists && !this.roomManager.checkRoomPassword(roomId, password)) {
        socket.emit('error', '密碼錯誤 (Wrong password)');
        return;
      }

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
      this.emitSystemChat(roomId, `${player.name} 加入了房間`);

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
      // Clear ready flags now that the game has started
      updatedRoom.readyPlayerIds = [];

      this.roomStartTimes.set(roomId, Date.now());
      updateRoomState(roomId, 'playing').catch(err =>
        console.error('[supabase] updateRoomState error:', err)
      );

      // Notify each bot agent about their assigned role
      for (const [botId, agent] of this.botAgents.entries()) {
        if (updatedRoom.players[botId]) {
          const obs = this.buildBotObservation(updatedRoom, botId, gameEngine, 'team_select');
          agent.onGameStart(obs);
        }
      }

      // game:started reveals each player's own role only
      for (const [pid, socketId] of this.playerToSocket.entries()) {
        if (updatedRoom.players[pid]) {
          this.io.to(socketId).emit('game:started', this.sanitizeRoomForPlayer(updatedRoom, pid));
        }
      }

      // DM role reveal to every Discord player. Fire-and-forget: a DM
      // failure (user has DMs off, transient Discord outage, …) must not
      // block game start. The helper internally skips non-Discord players
      // (e.g. socket/web clients) — those already got their role via the
      // `game:started` event above.
      //
      // Skip loading entirely when no Discord player is in the room — most
      // socket/bot-only games never need this helper, and loading it would
      // just emit noise in the log. Also skip if a previous load failed (the
      // lazy loader caches the outcome so we warn once, not every game).
      if (roomHasDiscordPlayer(updatedRoom)) {
        const sendRoleRevealToRoom = getRoleRevealFn();
        if (sendRoleRevealToRoom) {
          Promise.resolve(sendRoleRevealToRoom(updatedRoom)).catch((err: unknown) =>
            console.error(`[roleReveal] unexpected error in room ${roomId}:`, err)
          );
        }
      }

      const firstLeader = updatedRoom.players[Object.keys(updatedRoom.players)[updatedRoom.leaderIndex % Object.keys(updatedRoom.players).length]];
      this.emitSystemChat(roomId, `🎭 遊戲開始！第一輪隊長：${firstLeader?.name ?? '?'}`);
      console.log(`✓ Game started in room ${roomId}`);

      // Kick off bot actions if the first leader is a bot
      this.scheduleBotActions(roomId);
    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('error', 'Failed to start game');
    }
  }

  private handleVote(socket: Socket, roomId: string, _clientPlayerId: string, vote: boolean): void {
    try {
      // Rate limiting
      const voteIdentifier = `${socket.id}:vote`;
      if (!voteLimiter.isAllowed(voteIdentifier)) {
        socket.emit('error', 'Voting too frequently. Please wait.');
        return;
      }

      // Use server-verified player ID — ignore client-supplied ID to prevent spoofing
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) { socket.emit('error', 'Not authenticated in room'); return; }

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
      } else {
        this.scheduleBotActions(roomId);
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
      this.scheduleBotActions(roomId);
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
    _clientPlayerId: string,
    vote: 'success' | 'fail'
  ): void {
    try {
      // Use server-verified player ID — ignore client-supplied ID to prevent spoofing
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) { socket.emit('error', 'Not authenticated in room'); return; }

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

      // Verify player is in room and on the quest team
      if (!(playerId in room.players)) {
        socket.emit('error', 'Player not in room');
        return;
      }
      if (!room.questTeam.includes(playerId)) {
        socket.emit('error', 'Not on quest team');
        return;
      }

      // Avalon rule: good-side players can only vote success.
      // Server-side guard prevents cheating/modified clients from sending fail.
      const playerTeam = room.players[playerId]?.team;
      if (playerTeam === 'good' && vote === 'fail') {
        socket.emit('error', 'Good players can only vote success');
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
      } else {
        this.scheduleBotActions(roomId);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing quest vote:', errorMsg);
      socket.emit('error', `Failed to submit quest vote: ${errorMsg}`);
    }
  }

  private handleAssassinate(socket: Socket, roomId: string, _clientAssassinId: string, targetId: string): void {
    try {
      // Use server-verified player ID — ignore client-supplied assassinId to prevent spoofing
      const assassinId = socket.data.playerId as string | undefined;
      if (!assassinId) { socket.emit('error', 'Not authenticated in room'); return; }

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

      // Verify this player is actually the assassin
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

  private handleLadyOfTheLake(socket: Socket, roomId: string, _clientHolderId: string, targetId: string): void {
    try {
      const holderId = socket.data.playerId as string | undefined;
      if (!holderId) { socket.emit('error', 'Not authenticated in room'); return; }

      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }
      if (room.state !== 'lady_of_the_lake') { socket.emit('error', 'Not in Lady of the Lake phase'); return; }

      const gameEngine = this.gameEngines.get(roomId);
      if (!gameEngine) { socket.emit('error', 'Game engine not found'); return; }

      gameEngine.submitLadyOfTheLakeTarget(holderId, targetId);
      // Note: the engine broadcasts via onStateChange callback; result is shown via room state
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing Lady of the Lake:', errorMsg);
      socket.emit('error', `Failed to submit Lady of the Lake: ${errorMsg}`);
    }
  }

  /**
   * Part 4 of #90 — public Lady of the Lake declaration. Holder who just
   * inspected a target can publicly claim 'good' or 'evil' (can also
   * remain silent by simply not calling this handler). The engine records
   * the declaration; we then emit a system-chat message so the whole
   * table sees the claim in-context.
   */
  private handleDeclareLakeResult(socket: Socket, roomId: string, claim: 'good' | 'evil'): void {
    try {
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) { socket.emit('error', 'Not authenticated in room'); return; }

      if (claim !== 'good' && claim !== 'evil') {
        socket.emit('error', `Invalid claim "${claim}"`);
        return;
      }

      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }

      const gameEngine = this.gameEngines.get(roomId);
      if (!gameEngine) { socket.emit('error', 'Game engine not found'); return; }

      const record = gameEngine.declareLakeResult(playerId, claim);
      if (!record) return; // already declared — silent no-op

      const declarer = room.players[playerId];
      const target = room.players[record.targetId];
      const declarerName = declarer?.name ?? playerId;
      const targetName = target?.name ?? record.targetId;
      const claimLabel = claim === 'good' ? '好人' : '壞人';
      this.emitSystemChat(
        roomId,
        `🔮 ${declarerName} 宣告 ${targetName} 是「${claimLabel}」`
      );

      this.broadcastRoomState(roomId, room);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing declare-lake-result:', errorMsg);
      socket.emit('error', `Failed to declare Lady of the Lake result: ${errorMsg}`);
    }
  }

  /** Called whenever a room transitions to 'ended' state */
  private onGameEnded(roomId: string, room: Room): void {
    const evilWins = room.evilWins === true;
    const playerCount = Object.keys(room.players).length;
    const startTime = this.roomStartTimes.get(roomId);
    const durationSec = startTime ? Math.round((Date.now() - startTime) / 1000) : undefined;

    console.log(`✓ Game ended in room ${roomId}. Winner: ${evilWins ? 'Evil' : 'Good'}`);

    // System chat: announce winner
    const endMsg = evilWins ? '👹 邪惡方獲勝！遊戲結束。' : '⚔️ 正義方獲勝！遊戲結束。';
    this.emitSystemChat(roomId, endMsg);

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
    // 效能: 先批次取回所有玩家 ELO（單次 DB 請求），避免 N+1 序列查詢
    const supabaseEntries = Object.entries(room.players)
      .map(([uid, player]) => ({ uid, player, supabaseId: this.supabaseIds.get(uid) }))
      .filter((e): e is { uid: string; player: typeof e.player; supabaseId: string } =>
        !!e.supabaseId && !!e.player.team);

    const allSupabaseIds = supabaseEntries.map((e) => e.supabaseId);
    const eloMap = await getUserEloBulk(allSupabaseIds);

    const records: DbGameRecord[] = [];
    for (const { supabaseId, player } of supabaseEntries) {
      const team = player.team as 'good' | 'evil';
      const playerWon = evilWins ? team === 'evil' : team === 'good';
      const eloBefore = eloMap.get(supabaseId) ?? 1000;
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
      const recordsSaved = await saveGameRecords(records);
      if (recordsSaved) {
        console.log(`[supabase] Saved ${records.length} game records for room ${roomId}`);
      }

      // Emit ELO deltas to all players in room so end screen can show +/- ELO
      const eloDeltas: Record<string, number> = {};
      for (const record of records) {
        // Map supabase ID back to socket uid
        for (const [uid, sid] of this.supabaseIds.entries()) {
          if (sid === record.player_user_id) {
            eloDeltas[uid] = record.elo_delta;
            break;
          }
        }
      }
      if (Object.keys(eloDeltas).length > 0) {
        // Attach eloDeltas to room and re-broadcast so end screen can show +/- ELO
        const currentRoom = this.roomManager.getRoom(roomId);
        if (currentRoom) {
          currentRoom.eloDeltas = eloDeltas;
          this.broadcastRoomState(roomId, currentRoom, true);
        }
      }

      // Award badges based on this game's results
      for (const record of records) {
        const badges = this.evaluateBadges(record, playerCount, records, room);
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
      const eventsSaved = await saveGameEvents(events);
      if (eventsSaved) {
        console.log(`[supabase] Saved ${events.length} game events for room ${roomId}`);
      }
    }
  }

  private evaluateBadges(record: DbGameRecord, playerCount: number, _allRecords: DbGameRecord[], room: Room): string[] {
    const badges: string[] = [];

    // 首次勝利 — pushed on every win; awardBadges() deduplicates so it only stores once
    if (record.won) badges.push('初勝');

    // 梅林之盾 — 以梅林身份獲勝（且未被暗殺）
    if (record.won && record.role === 'merlin') badges.push('梅林之盾');

    // 刺客之影 — 以刺客身份獲勝
    if (record.won && record.role === 'assassin') badges.push('刺客之影');

    // 完美刺客 — 暗殺階段成功找出梅林
    if (record.role === 'assassin' && room.endReason === 'merlin_assassinated') badges.push('完美刺客');

    // 梅林逃脫 — 刺客猜錯，梅林存活並獲勝
    if (record.role === 'merlin' && record.won && room.endReason === 'assassination_failed') badges.push('梅林逃脫');

    // 十人戰場 — 10人局
    if (playerCount >= 10) badges.push('十人戰場');

    // 大局觀 — 8人以上獲勝
    if (record.won && playerCount >= 8) badges.push('大局觀');

    // 穩健 — ELO 1000 以上時獲勝
    if (record.won && record.elo_before >= 1000) badges.push('穩健');

    // 浴火重生 — ELO 800 以下時獲勝
    if (record.won && record.elo_before < 800) badges.push('浴火重生');

    // 速戰速決 — 5 分鐘內獲勝
    if (record.won && record.duration_sec != null && record.duration_sec < 300) badges.push('速戰速決');

    return badges;
  }

  /** Broadcast a system chat message to all players in a room */
  private emitSystemChat(roomId: string, message: string): void {
    this.io.to(roomId).emit('chat:message-received', {
      id: uuidv4(),
      roomId,
      playerId: 'system',
      playerName: '系統',
      message,
      timestamp: Date.now(),
      isSystem: true,
    });
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

  // ─── #63 Public lobby chat ──────────────────────────────────────────────
  //
  // Rooms use Socket.IO rooms keyed by roomId. For the lobby we reuse that
  // primitive with a single well-known room name so every connected socket
  // that joined it receives broadcasts. Snapshot-on-join means late arrivals
  // see the last 50 messages instead of an empty panel.
  //
  // Auth policy: reads open to everyone (guests included); writes restricted
  // to non-guest users. Guest clients still get `lobby:snapshot` on join so
  // they can read along, but their `lobby:send-message` is rejected with a
  // friendly i18n-friendly error code the client translates on the UI side.

  private static readonly LOBBY_ROOM = 'lobby:public';

  private handleLobbyJoin(socket: Socket): void {
    try {
      socket.join(GameServer.LOBBY_ROOM);
      socket.emit('lobby:snapshot', this.lobbyChat.snapshot());
    } catch (error) {
      console.error('[lobby] join error:', error);
    }
  }

  private handleLobbySendMessage(socket: Socket, message: unknown): void {
    try {
      const user = socket.data.user as User | undefined;
      if (!user) {
        socket.emit('lobby:error', 'not-authenticated');
        return;
      }

      // Guests can read the lobby chat but cannot send. Upsell to registration.
      if (user.provider === 'guest') {
        socket.emit('lobby:error', 'guest-read-only');
        return;
      }

      const chatIdentifier = `${socket.id}:lobby-chat`;
      if (!lobbyChatLimiter.isAllowed(chatIdentifier)) {
        socket.emit('lobby:error', 'rate-limited');
        return;
      }

      const trimmed = LobbyChatBuffer.validateBody(message);
      if (!trimmed) {
        socket.emit('lobby:error', 'invalid-message');
        return;
      }

      const msg: LobbyChatMessage = {
        id: uuidv4(),
        playerId: user.uid,
        playerName: user.displayName,
        message: trimmed,
        timestamp: Date.now(),
        source: 'lobby',
      };

      this.lobbyChat.append(msg);
      this.io.to(GameServer.LOBBY_ROOM).emit('lobby:message-received', msg);

      // #82 — mirror lobby-origin messages to external LINE group + Discord
      // channel (fire-and-forget; no-op if env vars or bot clients missing).
      tryMirrorFanout(msg);
    } catch (error) {
      console.error('[lobby] send-message error:', error);
    }
  }

  private handleAddBot(socket: Socket, roomId: string, difficulty: 'easy' | 'normal' | 'hard' = 'normal'): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }
      if (room.host !== (socket.data.playerId as string)) {
        socket.emit('error', 'Only the host can add bots'); return;
      }
      if (room.state !== 'lobby') {
        socket.emit('error', 'Cannot add bots after game has started'); return;
      }
      if (Object.keys(room.players).length >= room.maxPlayers) {
        socket.emit('error', 'Room is full'); return;
      }

      const botId = `BOT-${uuidv4().slice(0, 6).toUpperCase()}`;
      // Bot names encode difficulty tier directly (弱AI / 中AI / 強AI).
      // Per-player seat numbers (the PlayerCard chip) disambiguate
      // multiple bots sharing the same strength label.
      const botName = difficulty === 'easy'
        ? '弱AI'
        : difficulty === 'hard'
          ? '強AI'
          : '中AI';

      room.players[botId] = {
        id: botId,
        name: botName,
        role: null,
        team: null,
        status: 'active',
        isBot: true,
        botDifficulty: difficulty,
        createdAt: Date.now(),
      };

      // Choose agent based on difficulty
      const agent = difficulty === 'easy'
        ? new RandomAgent(botId)
        : new HeuristicAgent(botId, difficulty === 'hard' ? 'hard' : 'normal');

      this.botAgents.set(botId, agent);
      this.broadcastRoomState(roomId, room);
      console.log(`✓ Bot ${botName} (${difficulty}) added to room ${roomId}`);
    } catch (error) {
      console.error('Error adding bot:', error);
      socket.emit('error', 'Failed to add bot');
    }
  }

  private handleRemoveBot(socket: Socket, roomId: string, botId: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }
      if (room.host !== (socket.data.playerId as string)) {
        socket.emit('error', 'Only the host can remove bots'); return;
      }
      if (room.state !== 'lobby') {
        socket.emit('error', 'Cannot remove bots after game has started'); return;
      }
      if (!room.players[botId]?.isBot) {
        socket.emit('error', 'Player is not a bot'); return;
      }

      delete room.players[botId];
      this.botAgents.delete(botId);
      this.broadcastRoomState(roomId, room);
    } catch (error) {
      console.error('Error removing bot:', error);
      socket.emit('error', 'Failed to remove bot');
    }
  }

  /**
  /**
   * Factory: create a GameEngine wired to broadcast state changes autonomously
   * (vote timeouts, quest timeouts, assassination timeout).
   */
  private createGameEngine(roomId: string, room: Room): GameEngine {
    return new GameEngine(room, (updatedRoom: Room) => {
      const r = this.roomManager.getRoom(roomId);
      if (!r) return;
      if (r.state === 'ended') {
        this.broadcastRoomState(roomId, r, true);
        this.onGameEnded(roomId, r);
      } else {
        this.broadcastRoomState(roomId, r);
        this.scheduleBotActions(roomId);
      }
    });
  }

  /**
   * Build a PlayerObservation for a bot player, applying Avalon role-knowledge rules
   * so each bot only sees what their role is entitled to see.
   */
  private buildBotObservation(
    r: Room,
    botId: string,
    engine: GameEngine,
    gamePhase: PlayerObservation['gamePhase']
  ): PlayerObservation {
    const player = r.players[botId];
    const myRole = player.role!;
    const myTeam = player.team!;

    // Compute which other players this bot can identify as evil
    let knownEvils: string[] = [];
    if (myRole === 'merlin') {
      // Merlin sees evil except Oberon and Mordred
      knownEvils = Object.entries(r.players)
        .filter(([id, p]) => id !== botId && p.team === 'evil' && p.role !== 'oberon' && p.role !== 'mordred')
        .map(([id]) => id);
    } else if (myTeam === 'evil' && myRole !== 'oberon') {
      // Evil (except Oberon) sees other evil except Oberon
      knownEvils = Object.entries(r.players)
        .filter(([id, p]) => id !== botId && p.team === 'evil' && p.role !== 'oberon')
        .map(([id]) => id);
    }

    // Percival sees both Merlin and Morgana — can't tell which is which
    const knownWizards: string[] | undefined = myRole === 'percival'
      ? Object.entries(r.players)
          .filter(([id, p]) => id !== botId && (p.role === 'merlin' || p.role === 'morgana'))
          .map(([id]) => id)
      : undefined;

    return {
      myPlayerId:    botId,
      myRole,
      myTeam,
      playerCount:   Object.keys(r.players).length,
      allPlayerIds:  Object.keys(r.players),
      knownEvils,
      knownWizards,
      currentRound:  r.currentRound,
      currentLeader: engine.getCurrentLeaderId(),
      failCount:     r.failCount,
      questResults:  r.questResults as ('success' | 'fail')[],
      gamePhase,
      voteHistory:   r.voteHistory,
      questHistory:  r.questHistory,
      proposedTeam:  r.questTeam,
    };
  }

  /**
   * After each state broadcast, schedule bot actions for any pending bot turns.
   * Uses a small random delay (0.6–1.5s) to simulate thinking.
   * Uses HeuristicAgent for role-aware decisions.
   */
  private scheduleBotActions(roomId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room || room.state === 'lobby' || room.state === 'ended') return;

    const engine = this.gameEngines.get(roomId);
    if (!engine) return;

    const delay = 600 + Math.random() * 900; // 0.6–1.5s

    setTimeout(() => {
      const r = this.roomManager.getRoom(roomId);
      if (!r || r.state === 'ended') return;

      try {
        if (r.state === 'voting' && r.questTeam.length === 0) {
          // Team selection — check if leader is a bot
          const leaderId = engine.getCurrentLeaderId();
          const leader = r.players[leaderId];
          if (leader?.isBot) {
            const agent = this.botAgents.get(leaderId);
            if (!agent) return;
            const obs = this.buildBotObservation(r, leaderId, engine, 'team_select');
            const action = agent.act(obs);
            if (action.type !== 'team_select') return;
            engine.selectQuestTeam(action.teamIds);
            const updated = this.roomManager.getRoom(roomId)!;
            this.broadcastRoomState(roomId, updated);
            this.scheduleBotActions(roomId); // schedule voting bots
          }
        } else if (r.state === 'voting' && r.questTeam.length > 0) {
          // Team vote — stagger each bot vote by 600–1400 ms so they feel human
          const botVoters = Object.entries(r.players).filter(
            ([pid, player]) => player.isBot && !(pid in r.votes)
          );
          let offset = 0;
          for (const [pid] of botVoters) {
            const stagger = offset;
            offset += 600 + Math.random() * 800;
            setTimeout(() => {
              const snapshot = this.roomManager.getRoom(roomId);
              if (!snapshot || snapshot.state !== 'voting' || pid in snapshot.votes) return;
              const eng = this.gameEngines.get(roomId);
              if (!eng) return;
              const agent = this.botAgents.get(pid);
              const vote = agent
                ? (() => {
                    const obs = this.buildBotObservation(snapshot, pid, eng, 'team_vote');
                    const action = agent.act(obs);
                    return action.type === 'team_vote' ? action.vote : Math.random() > 0.3;
                  })()
                : Math.random() > 0.3;
              eng.submitVote(pid, vote);
              const updated = this.roomManager.getRoom(roomId)!;
              if (updated.state === 'ended') {
                this.broadcastRoomState(roomId, updated);
                this.onGameEnded(roomId, updated);
                return;
              }
              this.broadcastRoomState(roomId, updated);
              // After last bot votes, check if all humans have voted too
              if (Object.keys(updated.votes).length === Object.keys(updated.players).length) {
                this.scheduleBotActions(roomId);
              }
            }, stagger);
          }
        } else if (r.state === 'quest') {
          // Quest vote — stagger each bot member vote by 700–1500 ms
          const botMembers = r.questTeam.filter(id => r.players[id]?.isBot);
          let offset = 0;
          for (const memberId of botMembers) {
            const stagger = offset;
            offset += 700 + Math.random() * 800;
            setTimeout(() => {
              const snapshot = this.roomManager.getRoom(roomId);
              if (!snapshot || snapshot.state !== 'quest') return;
              const eng = this.gameEngines.get(roomId);
              if (!eng) return;
              const player = snapshot.players[memberId];
              if (!player?.isBot) return;
              const agent = this.botAgents.get(memberId);
              const vote = agent
                ? (() => {
                    const obs = this.buildBotObservation(snapshot, memberId, eng, 'quest_vote');
                    const action = agent.act(obs);
                    return action.type === 'quest_vote' ? action.vote : 'success';
                  })()
                : (player.team === 'evil' && Math.random() > 0.5 ? 'fail' : 'success');
              eng.submitQuestVote(memberId, vote);
              const updated = this.roomManager.getRoom(roomId)!;
              if (updated.state === 'ended') {
                this.broadcastRoomState(roomId, updated, true);
                this.onGameEnded(roomId, updated);
                return;
              }
              this.broadcastRoomState(roomId, updated);
            }, stagger);
          }
          // After all bots have submitted, check state (human members may still need to vote)
          if (botMembers.length > 0) {
            setTimeout(() => { this.scheduleBotActions(roomId); }, offset);
          }
        } else if (r.state === 'lady_of_the_lake') {
          // Lady of the Lake — if bot holds the Lady, pick a random eligible target
          const holderId = r.ladyOfTheLakeHolder;
          if (holderId && r.players[holderId]?.isBot) {
            const usedIds = r.ladyOfTheLakeUsed ?? [];
            const eligible = Object.keys(r.players).filter(id => id !== holderId && !usedIds.includes(id));
            const targetId = eligible[Math.floor(Math.random() * eligible.length)];
            if (targetId) {
              setTimeout(() => {
                const snapshot = this.roomManager.getRoom(roomId);
                if (!snapshot || snapshot.state !== 'lady_of_the_lake') return;
                const eng = this.gameEngines.get(roomId);
                if (!eng) return;
                eng.submitLadyOfTheLakeTarget(holderId, targetId);
              }, 1000 + Math.random() * 1000);
            }
          }
        } else if (r.state === 'discussion') {
          // Find assassin — if bot, use HeuristicAgent to pick the most Merlin-like target
          const assassinEntry = Object.entries(r.players).find(([, p]) => p.role === 'assassin');
          if (assassinEntry && r.players[assassinEntry[0]]?.isBot) {
            const assassinId = assassinEntry[0];
            const agent = this.botAgents.get(assassinId);
            let targetId: string;
            if (agent) {
              const obs = this.buildBotObservation(r, assassinId, engine, 'assassination');
              const action = agent.act(obs);
              targetId = action.type === 'assassinate' ? action.targetId : '';
            } else {
              const goodPlayers = Object.keys(r.players).filter(
                id => r.players[id].team === 'good' && id !== assassinId
              );
              targetId = goodPlayers[Math.floor(Math.random() * goodPlayers.length)] ?? '';
            }
            if (targetId && r.players[targetId]) {
              engine.submitAssassination(assassinId, targetId);
              const updated = this.roomManager.getRoom(roomId)!;
              this.broadcastRoomState(roomId, updated, true);
              this.onGameEnded(roomId, updated);
            }
          }
        }
      } catch (err) {
        console.error(`[bot] Error processing bot action in room ${roomId}:`, err);
      }
    }, delay);
  }

  private handleSpectateRoom(socket: Socket, roomId: string): void {
    try {
      // Normalize short code to full ID
      const allRooms = this.roomManager.getAllRooms();
      const room = allRooms.find(r => r.id === roomId || r.id.slice(0, 8).toUpperCase() === roomId.toUpperCase());
      if (!room) { socket.emit('error', 'Room not found'); return; }
      if (room.state === 'lobby' || room.state === 'ended') {
        socket.emit('error', '此房間不可觀戰 (No spectating in lobby/ended rooms)');
        return;
      }
      // Cannot spectate if already a player — use canonical playerId, fall back to uid
      const spectatorPlayerId = (socket.data.playerId as string | undefined) || (socket.data.user?.uid as string | undefined);
      if (spectatorPlayerId && room.players[spectatorPlayerId]) {
        socket.emit('error', 'Already a player in this room');
        return;
      }

      const fullRoomId = room.id;
      socket.join(fullRoomId);
      socket.data.spectatingRoomId = fullRoomId;
      if (!this.spectators.has(fullRoomId)) {
        this.spectators.set(fullRoomId, new Set());
      }
      this.spectators.get(fullRoomId)!.add(socket.id);

      // Send current state immediately
      const spectatorRoom = this.sanitizeRoomForSpectator(room);
      socket.emit('game:state-updated', spectatorRoom);
      socket.emit('game:spectating', fullRoomId);
      console.log(`👁 Spectator joined room ${fullRoomId} (${socket.id})`);
    } catch (err) {
      console.error('Error handling spectate-room:', err);
    }
  }

  private handleLeaveSpectate(socket: Socket, roomId: string): void {
    const spectatorSet = this.spectators.get(roomId);
    if (spectatorSet) spectatorSet.delete(socket.id);
    socket.leave(roomId);
    socket.data.spectatingRoomId = undefined;
    socket.emit('game:left-room');
  }

  private handleLeaveRoom(socket: Socket, roomId: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }

      const playerId = socket.data.playerId as string;

      // Cannot leave during active game
      if (room.state !== 'lobby' && room.state !== 'ended') {
        socket.emit('error', '遊戲進行中無法離開房間');
        return;
      }

      // Host leaving dissolves the room (in lobby) — transfer host or remove
      if (room.host === playerId && room.state === 'lobby') {
        const otherIds = Object.keys(room.players).filter(id => id !== playerId && !room.players[id].isBot);
        if (otherIds.length > 0) {
          // Transfer host to the next human player
          room.host = otherIds[0];
          delete room.players[playerId];
          this.playerToSocket.delete(playerId);
          socket.leave(roomId);
          socket.data.roomId = undefined;
          socket.data.playerId = undefined;
          this.broadcastRoomState(roomId, room);
          this.io.to(roomId).emit('game:player-left', playerId);
        } else {
          // No other humans — delete room
          this.roomManager.deleteRoom(roomId);
          this.gameEngines.delete(roomId);
        }
        socket.emit('game:left-room');
        return;
      }

      delete room.players[playerId];
      this.playerToSocket.delete(playerId);
      socket.leave(roomId);
      socket.data.roomId = undefined;
      socket.data.playerId = undefined;

      this.broadcastRoomState(roomId, room);
      this.io.to(roomId).emit('game:player-left', playerId);
      socket.emit('game:left-room');

      console.log(`✓ Player ${playerId} left room ${roomId}`);
    } catch (error) {
      console.error('Error leaving room:', error);
      socket.emit('error', 'Failed to leave room');
    }
  }

  private handleSetRoleOptions(socket: Socket, roomId: string, options: Record<string, unknown>): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }
      if (room.host !== (socket.data.playerId as string)) { socket.emit('error', 'Only the host can change role options'); return; }
      if (room.state !== 'lobby') { socket.emit('error', 'Cannot change roles after game starts'); return; }

      // Boolean toggles (canonical evil roles + Lady enable + R1/R2 swap +
      // 9-variant option 2 inverted protection).
      const boolKeys = ['percival', 'morgana', 'oberon', 'mordred', 'ladyOfTheLake', 'swapR1R2', 'variant9Option2'] as const;
      for (const key of boolKeys) {
        if (key in options) {
          ((room.roleOptions as unknown) as Record<string, boolean>)[key] = Boolean(options[key]);
        }
      }

      // `variant9Player` — enum 'standard' | 'oberonMandatory' (Part 6).
      // When reverting to 'standard', clear the dependent `variant9Option2`
      // flag so stale state can never leak into a non-9-variant game.
      if ('variant9Player' in options) {
        const v = options.variant9Player;
        if (v === 'standard' || v === 'oberonMandatory') {
          ((room.roleOptions as unknown) as Record<string, string>).variant9Player = v;
          if (v === 'standard') {
            ((room.roleOptions as unknown) as Record<string, boolean>).variant9Option2 = false;
          }
        }
      }

      // `ladyStart` — enum 'random' | 'seat0'..'seat9' (Part 3).
      if ('ladyStart' in options) {
        const v = options.ladyStart;
        const validLadyStart = typeof v === 'string' && /^(random|seat[0-9])$/.test(v);
        if (validLadyStart) {
          ((room.roleOptions as unknown) as Record<string, string>).ladyStart = v;
        }
      }

      room.updatedAt = Date.now();
      this.broadcastRoomState(roomId, room);
    } catch (error) {
      console.error('Error setting role options:', error);
      socket.emit('error', 'Failed to set role options');
    }
  }

  private handleToggleReady(socket: Socket, roomId: string, playerId: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }
      if (room.state !== 'lobby') return; // only in lobby

      // Ensure readyPlayerIds exists (backward compat)
      if (!room.readyPlayerIds) room.readyPlayerIds = [];

      const idx = room.readyPlayerIds.indexOf(playerId);
      if (idx >= 0) {
        room.readyPlayerIds.splice(idx, 1); // un-ready
      } else {
        room.readyPlayerIds.push(playerId); // ready
      }
      room.updatedAt = Date.now();
      this.broadcastRoomState(roomId, room);
    } catch (error) {
      console.error('Error toggling ready:', error);
    }
  }

  private handleSetMaxPlayers(socket: Socket, roomId: string, count: number): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }

      if (room.host !== (socket.data.playerId as string)) {
        socket.emit('error', 'Only the host can change max players');
        return;
      }

      if (room.state !== 'lobby') {
        socket.emit('error', 'Cannot change max players after game starts');
        return;
      }

      const clamped = Math.max(5, Math.min(10, Math.round(count)));
      if (clamped < Object.keys(room.players).length) {
        socket.emit('error', `目前已有 ${Object.keys(room.players).length} 名玩家，無法設為 ${clamped} 人`);
        return;
      }

      room.maxPlayers = clamped;
      room.updatedAt = Date.now();
      this.broadcastRoomState(roomId, room);
    } catch (error) {
      console.error('Error setting max players:', error);
      socket.emit('error', 'Failed to set max players');
    }
  }

  private handleRematch(socket: Socket, roomId: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }

      // Only host can trigger rematch
      const requesterId = socket.data.playerId as string;
      if (room.host !== requesterId) {
        socket.emit('error', 'Only the host can start a rematch');
        return;
      }

      if (room.state !== 'ended') {
        socket.emit('error', 'Rematch only available after game ends');
        return;
      }

      // Clean up old game engine
      const oldEngine = this.gameEngines.get(roomId);
      if (oldEngine) {
        oldEngine.cleanup();
        this.gameEngines.delete(roomId);
      }
      this.roomStartTimes.delete(roomId);

      // Remove old bot agents, then re-create them for bots still in the room
      for (const pid of Object.keys(room.players)) {
        if (room.players[pid].isBot) {
          this.botAgents.delete(pid);
        }
      }
      for (const [pid, player] of Object.entries(room.players)) {
        if (!player.isBot) continue;
        const difficulty = player.botDifficulty ?? 'normal';
        const agent = difficulty === 'easy'
          ? new RandomAgent(pid)
          : new HeuristicAgent(pid, difficulty === 'hard' ? 'hard' : 'normal');
        this.botAgents.set(pid, agent);
      }

      // Reset room state (keep players and host, clear all game data)
      room.state = 'lobby';
      room.currentRound = 0;
      room.votes = {};
      room.questTeam = [];
      room.questResults = [];
      room.failCount = 0;
      room.evilWins = null;
      room.leaderIndex = 0;
      room.voteHistory = [];
      room.questHistory = [];
      room.questVotedCount = 0;
      room.endReason = undefined;
      room.assassinTargetId = undefined;
      room.ladyOfTheLakeHolder = undefined;
      room.ladyOfTheLakeTarget = undefined;
      room.ladyOfTheLakeResult = undefined;
      room.ladyOfTheLakeUsed = [];
      room.readyPlayerIds = [];
      room.updatedAt = Date.now();

      // Reset each player's role and team
      for (const player of Object.values(room.players)) {
        player.role = null;
        player.team = null;
        player.vote = undefined;
        player.kills = undefined;
        player.status = player.status === 'disconnected' ? 'disconnected' : 'active';
      }

      // Create fresh engine
      this.gameEngines.set(roomId, this.createGameEngine(roomId, room));

      this.broadcastRoomState(roomId, room);
      console.log(`↩ Rematch started in room ${roomId} by ${requesterId}`);
    } catch (error) {
      console.error('Error handling rematch:', error);
      socket.emit('error', 'Failed to start rematch');
    }
  }

  private handleKickPlayer(socket: Socket, roomId: string, targetPlayerId: string): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }

      // Only host can kick
      const requesterId = socket.data.playerId as string;
      if (room.host !== requesterId) {
        socket.emit('error', 'Only the host can kick players');
        return;
      }

      // Can only kick during lobby
      if (room.state !== 'lobby') {
        socket.emit('error', 'Cannot kick players after game has started');
        return;
      }

      // Cannot kick yourself
      if (targetPlayerId === requesterId) {
        socket.emit('error', 'Cannot kick yourself');
        return;
      }

      if (!(targetPlayerId in room.players)) {
        socket.emit('error', 'Player not in room');
        return;
      }

      // Remove player from room
      delete room.players[targetPlayerId];

      // Notify the kicked player
      const kickedSocketId = this.playerToSocket.get(targetPlayerId);
      if (kickedSocketId) {
        this.io.to(kickedSocketId).emit('game:kicked', roomId);
        this.playerToSocket.delete(targetPlayerId);
      }

      this.broadcastRoomState(roomId, room);
      console.log(`✓ Player ${targetPlayerId} kicked from room ${roomId} by host ${requesterId}`);
    } catch (error) {
      console.error('Error kicking player:', error);
      socket.emit('error', 'Failed to kick player');
    }
  }

  private handleDisconnect(socket: Socket): void {
    // Clean up spectator registration
    const spectatingRoomId = socket.data.spectatingRoomId as string | undefined;
    if (spectatingRoomId) {
      const spectatorSet = this.spectators.get(spectatingRoomId);
      if (spectatorSet) spectatorSet.delete(socket.id);
    }

    const roomId   = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (playerId) this.playerToSocket.delete(playerId);

    if (roomId && playerId) {
      const room = this.roomManager.getRoom(roomId);
      if (room && room.players[playerId]) {
        room.players[playerId].status = 'disconnected';
        this.io.to(roomId).emit('game:player-left', playerId);

        // Push updated room state so all clients reflect the disconnect immediately
        this.broadcastRoomState(roomId, room);

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

        // Auto-act for disconnected player to prevent game from stalling
        // Use a short delay (3s) to allow quick reconnects to cancel this
        const engine = this.gameEngines.get(roomId);
        if (engine && room.state !== 'lobby' && room.state !== 'ended') {
          setTimeout(() => {
            const r = this.roomManager.getRoom(roomId);
            if (!r || r.state === 'ended' || r.players[playerId]?.status === 'active') return;
            try {
              if (r.state === 'voting' && r.questTeam.length > 0 && !(playerId in r.votes)) {
                // Auto-reject on behalf of disconnected voter
                engine.submitVote(playerId, false);
                const updated = this.roomManager.getRoom(roomId)!;
                if (updated.state === 'ended') {
                  this.broadcastRoomState(roomId, updated);
                  this.onGameEnded(roomId, updated);
                } else {
                  this.broadcastRoomState(roomId, updated);
                  this.scheduleBotActions(roomId);
                }
                console.log(`[auto] Submitted reject vote for disconnected player ${playerId}`);
              } else if (r.state === 'quest' && r.questTeam.includes(playerId)) {
                // Auto-success on behalf of disconnected quest team member
                engine.submitQuestVote(playerId, 'success');
                const updated = this.roomManager.getRoom(roomId)!;
                if (updated.state === 'ended') {
                  this.broadcastRoomState(roomId, updated, true);
                  this.onGameEnded(roomId, updated);
                } else {
                  this.broadcastRoomState(roomId, updated);
                  this.scheduleBotActions(roomId);
                }
                console.log(`[auto] Submitted quest vote for disconnected player ${playerId}`);
              } else if (r.state === 'voting' && r.questTeam.length === 0 && engine.getCurrentLeaderId() === playerId) {
                // Disconnected leader — rotate to next player
                const playerIds = Object.keys(r.players);
                const config = AVALON_CONFIG[playerIds.length];
                if (config) {
                  const teamSize = config.questTeams[r.currentRound - 1];
                  const candidates = playerIds.filter(id => id !== playerId);
                  const team = candidates.slice(0, teamSize);
                  if (team.length === teamSize) {
                    engine.selectQuestTeam(team);
                    const updated = this.roomManager.getRoom(roomId)!;
                    this.broadcastRoomState(roomId, updated);
                    this.scheduleBotActions(roomId);
                    console.log(`[auto] Selected quest team for disconnected leader ${playerId}`);
                  }
                }
              } else if (r.state === 'discussion') {
                // Disconnected assassin — auto-target a random good player
                const assassinId = Object.keys(r.players).find(id => r.players[id].role === 'assassin');
                if (assassinId === playerId) {
                  const goodPlayers = Object.keys(r.players).filter(id => id !== playerId && r.players[id].team === 'good');
                  if (goodPlayers.length > 0) {
                    const target = goodPlayers[Math.floor(Math.random() * goodPlayers.length)];
                    engine.submitAssassination(playerId, target);
                    const updated = this.roomManager.getRoom(roomId)!;
                    this.broadcastRoomState(roomId, updated, true);
                    this.onGameEnded(roomId, updated);
                    console.log(`[auto] Submitted assassination for disconnected assassin ${playerId} → ${target}`);
                  }
                }
              }
            } catch (err) {
              // Silently swallow — player may have reconnected or state may have changed
            }
          }, 3000);
        }
      }
    }

    console.log(`✓ Player disconnected: ${socket.id}`);
  }

}
