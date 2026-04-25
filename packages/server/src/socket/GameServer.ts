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
  getUserElo,
  DbGameRecord,
} from '../services/supabase';
import { GameHistoryRepository } from '../services/GameHistoryRepository';
import { GameHistoryRepositoryV2 } from '../services/GameHistoryRepositoryV2';
import { buildV2RecordFromRoom } from '../services/liveGameToV2';
import { ComputedStatsRepositoryV2 } from '../services/ComputedStatsRepositoryV2';

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
type MirrorInstance = {
  fanout: (msg: LobbyChatMessage) => Promise<void>;
  setLobbyIngest?: (fn: (msg: LobbyChatMessage) => void) => void;
};
type ChatMirrorModule = {
  initializeChatMirror: (cfg: unknown) => MirrorInstance;
  getChatMirror: () => MirrorInstance | null;
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

  /**
   * #82 Phase B — inbound bridge. ChatMirror calls this back with messages
   * sourced from LINE / Discord; we append to the ring buffer + emit to every
   * connected web client so the lobby UI stays in sync with the external
   * platforms.
   *
   * MUST be called AFTER `initializeBots()` — the ChatMirror singleton is
   * only constructed inside that call, so trying to wire up the ingest
   * callback earlier is a silent no-op.
   *
   * Safe to call when the mirror is disabled (env vars missing) — we log a
   * single note and move on.
   */
  public wireChatMirrorIngest(): void {
    const mod = getChatMirrorModule();
    if (!mod) return;
    const mirror = mod.getChatMirror();
    if (!mirror) {
      console.log('ℹ️  ChatMirror not initialised — inbound bridge disabled');
      return;
    }
    if (typeof mirror.setLobbyIngest !== 'function') {
      console.warn('[ChatMirror] setLobbyIngest missing — inbound bridge disabled');
      return;
    }
    mirror.setLobbyIngest((msg) => {
      try {
        this.lobbyChat.append(msg);
        this.io.to(GameServer.LOBBY_ROOM).emit('lobby:message-received', msg);
      } catch (err) {
        console.warn('[ChatMirror] lobbyIngest emit failed:', err);
      }
    });
    console.log('✅ ChatMirror inbound bridge wired (LINE/Discord → lobby)');
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
          casual?: boolean,
        ) => {
          this.handleCreateRoom(
            socket,
            playerName,
            user,
            password,
            timerMultiplier,
            casual,
          );
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

      socket.on('game:skip-lake-declaration', (roomId: string) => {
        this.handleSkipLakeDeclaration(socket, roomId);
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

      // Edward 2026-04-25:「思考時間在遊戲開始前可以調整」— host-only
      // mid-lobby update of room.timerConfig. Locked once state !== 'lobby'.
      socket.on('game:set-timer-multiplier', (roomId: string, multiplier: unknown) => {
        this.handleSetTimerMultiplier(socket, roomId, multiplier);
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
    // Edward 2026-04-25: 4-digit numeric room codes (0000-9999) for simpler
    // human entry on phones. 10000 unique slots cover current concurrency
    // (typical active rooms < 100). Retry up to 50 times on collision; if
    // we somehow exhaust retries, surface the error so the caller can decide
    // whether to fall back (rather than silently looping forever).
    if (attempt > 50) throw new Error('Could not generate unique room code after 50 attempts');
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
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
    casual?: boolean,
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
        Boolean(casual),
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
      //
      // 2026-04-24 P0 fix (Edward: "跳出後 重新整理 回不到遊戲"):
      // Previously only entered the rejoin branch when status === 'disconnected'.
      // But page reload / crash recovery hits a race: the new socket finishes
      // Socket.IO handshake + emits `game:join-room` *before* the old socket's
      // `disconnect` event reaches our handler, so status is still 'active' →
      // server rejects with "Already in this room" → client never gets room
      // state → player stuck on HomePage. Now: if the player is already
      // registered but their previous socket is gone from `io.sockets.sockets`
      // (or it's a different socket.id from what we mapped), treat as rejoin
      // rather than reject.
      if (playerExists) {
        const prevSocketId = this.playerToSocket.get(playerId);
        const prevSocketStillConnected =
          prevSocketId !== undefined &&
          prevSocketId !== socket.id &&
          this.io.sockets.sockets.get(prevSocketId)?.connected === true;

        if (prevSocketStillConnected) {
          // Same player genuinely holds a live second socket (e.g. two tabs
          // open). Keep the legacy guard — Avalon is a single-session game
          // and dual clients would see duplicate state events.
          socket.emit('error', 'Already in this room');
          return;
        }

        // Either marked disconnected, or the previous socket is stale /
        // identical — either way this is a reconnect.
        playerExists.status = 'active';
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.playerId = playerId;
        this.playerToSocket.set(playerId, socket.id);
        if (socket.data.supabaseId) {
          this.supabaseIds.set(playerId, socket.data.supabaseId as string);
        }

        this.io.to(roomId).emit('game:player-reconnected', playerId);
        // Use broadcastRoomState so every client (including the rejoining
        // socket) receives a fresh, sanitised snapshot — the rejoining
        // client specifically needs this to re-derive role/team/current
        // phase from an empty store after a page refresh.
        this.broadcastRoomState(roomId, room);

        console.log(`✓ Player ${user.displayName} reconnected to room ${roomId}`);
        return;
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

  /**
   * Companion to `handleDeclareLakeResult` — the declarer may choose to
   * keep the inspection result private. This advances the Lady phase
   * without recording a declaration so the game can progress.
   */
  private handleSkipLakeDeclaration(socket: Socket, roomId: string): void {
    try {
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) { socket.emit('error', 'Not authenticated in room'); return; }

      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }

      const gameEngine = this.gameEngines.get(roomId);
      if (!gameEngine) { socket.emit('error', 'Game engine not found'); return; }

      gameEngine.skipLakeDeclaration(playerId);
      // Engine broadcasts via onStateChange; nothing else to emit.
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing skip-lake-declaration:', errorMsg);
      socket.emit('error', `Failed to skip Lady of the Lake declaration: ${errorMsg}`);
    }
  }

  /**
   * Lightweight bot lake-announcement heuristic (live games).
   *
   * SelfPlayEngine has the full `decideLakeAnnouncement` (suspicion-scored
   * Merlin guess); the live path doesn't need that depth and we want to
   * avoid pulling SelfPlayEngine's observation builder into the socket
   * layer. Simplified rule:
   *   - Good holder  → declare the actual team (loyal players are honest).
   *   - Evil holder  → declare 'good' for an evil ally (washes pressure);
   *                    declare 'evil' for a good target (seeds doubt).
   *   - Unknown team → null (caller falls back to skip).
   *
   * The actual target team is read from `room.ladyOfTheLakeResult` (the
   * private result the engine just exposed to the holder).
   */
  private decideBotLakeClaim(
    room: Room,
    holderId: string,
    targetId: string,
  ): 'good' | 'evil' | null {
    const holder = room.players[holderId];
    const target = room.players[targetId];
    const holderTeam = holder?.team;
    if (holderTeam !== 'good' && holderTeam !== 'evil') return null;

    // Prefer the engine-exposed inspection result (authoritative); fall
    // back to target.team if the live snapshot already cleared the
    // private result.
    const actualTargetTeam: 'good' | 'evil' | undefined =
      (room.ladyOfTheLakeResult === 'good' || room.ladyOfTheLakeResult === 'evil')
        ? room.ladyOfTheLakeResult
        : (target?.team === 'good' || target?.team === 'evil')
          ? target.team
          : undefined;
    if (actualTargetTeam === undefined) return null;

    if (holderTeam === 'good') {
      // Loyal — declare what was seen.
      return actualTargetTeam;
    }

    // Evil holder — invert truth to muddy the water (ally→good, opponent→evil).
    return actualTargetTeam === 'good' ? 'evil' : 'good';
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

    // V2 戰績雙寫（Phase 2c 2026-04-24）：Firestore games/ + games_v2/.
    // 平行於 supabase 寫入，獨立 try/catch 不讓任一路徑失敗影響另一條。
    // 同時觸發該局玩家的 computed_stats 增量重算（冪等，只重算這些 UUID）。
    this.persistGameToFirestore(roomId, room).catch((err) =>
      console.error('[firestore] persistGameToFirestore error:', err),
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

  /**
   * Firestore dual-write on game end (Phase 2c 2026-04-24).
   *
   * 1. V1 write: `games/{gameId}` via `GameHistoryRepository.saveGameRecord`
   *    （保留舊欄位以支援 leaderboard cache invalidation + 歷史遷移鏡像）
   * 2. V2 write: `games_v2/{gameId}` via `GameHistoryRepositoryV2.saveV2`
   *    （組 V2 原子結構，含 missions / ladyChain / finalResult）
   * 3. V2 computed_stats 增量重算：只針對該局玩家 UUID
   *
   * 每條路徑獨立 try/catch — 任一失敗不影響其他；engine 不阻塞。
   */
  private async persistGameToFirestore(
    roomId: string,
    room: Room,
  ): Promise<void> {
    // 未 end 的房間不落 Firestore（防禦性）
    if (room.state !== 'ended') return;

    const startedAt = this.roomStartTimes.get(roomId) ?? room.createdAt;
    const endedAt = Date.now();

    // V1 write —— winReason 字串對齊 endReason（GameEngine 寫 room.endReason 的語意）
    const winReasonStr =
      room.endReason ??
      (room.evilWins ? 'failed_quests_limit' : 'assassination_failed');

    try {
      const v1Repo = new GameHistoryRepository();
      await v1Repo.saveGameRecord(room, winReasonStr);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'firestore_v1_save_error',
          roomId,
          error: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }

    // V2 write —— 從 Room + engine state 組 V2 record，寫 games_v2/
    let v2Record;
    try {
      const engine = this.gameEngines.get(roomId);
      if (!engine) {
        console.warn(`[firestore] engine missing for room ${roomId}; skip V2 write`);
        return;
      }
      v2Record = buildV2RecordFromRoom(room, engine, {
        startedAtMs: startedAt,
        endedAtMs: endedAt,
      });
      const v2Repo = new GameHistoryRepositoryV2();
      await v2Repo.saveV2(v2Record);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'firestore_v2_save_error',
          roomId,
          error: err instanceof Error ? err.message : 'unknown',
        }),
      );
      return;
    }

    // V2 computed_stats 增量重算 — 只針對該局玩家 UUID（冪等；不阻塞 game flow）
    if (v2Record) {
      try {
        const statsRepo = new ComputedStatsRepositoryV2();
        await statsRepo.recomputeForGame(v2Record);
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: 'firestore_computed_stats_incremental_warn',
            roomId,
            error: err instanceof Error ? err.message : 'unknown',
          }),
        );
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
      // Display name is uniformly "AI" regardless of difficulty tier.
      // Per-player seat numbers (the PlayerCard chip) disambiguate
      // multiple bots in the same room. Difficulty is preserved in
      // `botDifficulty` and drives agent behaviour, but is hidden from
      // the player-visible name (Edward 2026-04-25).
      const botName = 'AI';

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
   * Uses a small random delay to simulate thinking without making humans wait.
   *
   * Edward 2026-04-25 「AI 選人會卡住 3/4/9 都卡特別久」— previous delays
   * (0.6–1.5s leader pick + 0.6–1.4s × N bots vote stagger) compounded to
   * 7–17s per voting attempt × up to 5 attempts per round = 30-80s of dead
   * air, which UX-wise reads as "stuck" even though the agent never actually
   * blocked. We tightened all three delays to keep the human-feel cue but
   * cap per-attempt latency well under 5 s.
   */
  private scheduleBotActions(roomId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room || room.state === 'lobby' || room.state === 'ended') return;

    const engine = this.gameEngines.get(roomId);
    if (!engine) return;

    const delay = 250 + Math.random() * 350; // 0.25–0.6s (was 0.6–1.5s)

    setTimeout(() => {
      const r = this.roomManager.getRoom(roomId);
      if (!r || r.state === 'ended') return;

      try {
        if (r.state === 'voting' && r.questTeam.length === 0) {
          // Team selection — check if leader is a bot
          const leaderId = engine.getCurrentLeaderId();
          const leader = r.players[leaderId];
          if (leader?.isBot) {
            // Fallback: if anything in the AI agent path blows up (agent missing,
            // wrong action type, illegal teamIds, etc.) we MUST still advance the
            // game. The previous code silently `return`ed and left the room
            // hanging on the bot leader's turn — #bug "AI 選人卡住" (2026-04-24).
            const pickFallbackTeam = (): string[] => {
              const pcount = Object.keys(r.players).length;
              const cfg = AVALON_CONFIG[pcount];
              const size = cfg?.questTeams[r.currentRound - 1] ?? 2;
              const ids = Object.keys(r.players);
              // Leader goes first so the team is at least plausible.
              const ordered = [leaderId, ...ids.filter(id => id !== leaderId)];
              return ordered.slice(0, size);
            };

            let chosenTeam: string[] | null = null;
            try {
              const agent = this.botAgents.get(leaderId);
              if (agent) {
                const obs = this.buildBotObservation(r, leaderId, engine, 'team_select');
                const action = agent.act(obs);
                if (action.type === 'team_select' && Array.isArray(action.teamIds) && action.teamIds.length > 0) {
                  chosenTeam = action.teamIds;
                }
              }
            } catch (agentErr) {
              console.error(`[bot] Agent threw in selectTeam for ${leaderId} in room ${roomId}:`, agentErr);
            }

            if (!chosenTeam) {
              chosenTeam = pickFallbackTeam();
              console.warn(`[bot] Using fallback team for bot leader ${leaderId} in room ${roomId}: ${chosenTeam.join(',')}`);
            }

            try {
              engine.selectQuestTeam(chosenTeam);
            } catch (selectErr) {
              // selectQuestTeam can throw on wrong size / unknown id. Retry with fallback.
              console.error(`[bot] selectQuestTeam rejected AI pick for ${leaderId} in room ${roomId}:`, selectErr);
              const safe = pickFallbackTeam();
              try {
                engine.selectQuestTeam(safe);
              } catch (safeErr) {
                console.error(`[bot] Fallback selectQuestTeam also failed in room ${roomId}:`, safeErr);
                return; // truly unrecoverable; leave for operator intervention
              }
            }

            const updated = this.roomManager.getRoom(roomId)!;
            this.broadcastRoomState(roomId, updated);
            this.scheduleBotActions(roomId); // schedule voting bots
          }
        } else if (r.state === 'voting' && r.questTeam.length > 0) {
          // Team vote — stagger each bot vote by 150–350 ms so they feel
          // human-ish but the whole batch finishes in ≤3 s even with 9 bots.
          // Edward 2026-04-25 「AI 選人會卡住 3/4/9 都卡特別久」 — old
          // 0.6–1.4 s × 9 = up to 12.6 s/attempt × 5 attempts = 60+ s.
          const botVoters = Object.entries(r.players).filter(
            ([pid, player]) => player.isBot && !(pid in r.votes)
          );
          let offset = 0;
          for (const [pid] of botVoters) {
            const stagger = offset;
            offset += 150 + Math.random() * 200;
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
              // Edward 2026-04-25 P0「輪到我投任務成功 就斷線」 — bot-as-last-
              // team-voter stuck-quest fix.
              //
              // Original guard: `votes.length === playerCount` → schedule
              // next bots. But when this bot's submitVote completed the
              // tally, `engine.resolveVoting()` synchronously fired and
              // cleared `room.votes = {}` plus advanced state to 'quest'
              // (or 'voting' next round / 'ended'). So `votes.length === 0`,
              // the guard never matched, and `scheduleBotActions` was NOT
              // queued for the new phase. Quest then sat idle until the 30s
              // QUEST_TIMEOUT auto-success fired — UX-wise reads as "卡住 /
              // 斷線" because a player on the quest team sees their UI hang
              // for 30 s before the next phase appears.
              //
              // Fix: also trigger scheduleBotActions when the engine state
              // moved away from 'voting' (resolveVoting fired this tick).
              // Original "all players voted" guard preserved so non-resolve
              // ticks still chain into late-arriving bot ballots correctly.
              if (updated.state !== 'voting'
                  || Object.keys(updated.votes).length === Object.keys(updated.players).length) {
                this.scheduleBotActions(roomId);
              }
            }, stagger);
          }
        } else if (r.state === 'quest') {
          // Quest vote — stagger each bot member vote by 200–450 ms (was
          // 0.7–1.5 s). Edward 2026-04-25 stuck-feel root cause: cumulative
          // stagger reads as "AI 選人會卡住" even though no real block.
          const botMembers = r.questTeam.filter(id => r.players[id]?.isBot);
          let offset = 0;
          for (const memberId of botMembers) {
            const stagger = offset;
            offset += 200 + Math.random() * 250;
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
          // Lady of the Lake — if bot holds the Lady, pick a random eligible
          // target. After inspection, the bot must skip its declaration so
          // the phase finalizes and the round advances; otherwise the next
          // scheduleBotActions tick (triggered by submitLadyOfTheLakeTarget's
          // onStateChange) sees the new bot holder and chains another inspect,
          // burning the entire lady_of_the_lake round in a single tick and
          // leaving any human eventually on the chain unable to act (Edward
          // 2026-04-25 10:20 +08 — "湖中女神使用卡住了").
          const holderId = r.ladyOfTheLakeHolder;
          // CASE 1 — pre-inspection: bot is the current holder and has yet
          // to pick a target. After inspect we synchronously skip declaration.
          if (
            holderId
            && r.players[holderId]?.isBot
            && !r.ladyOfTheLakeResult
          ) {
            const usedIds = r.ladyOfTheLakeUsed ?? [];
            const eligible = Object.keys(r.players).filter(id => id !== holderId && !usedIds.includes(id));
            const targetId = eligible[Math.floor(Math.random() * eligible.length)];
            if (targetId) {
              setTimeout(() => {
                const snapshot = this.roomManager.getRoom(roomId);
                if (!snapshot || snapshot.state !== 'lady_of_the_lake') return;
                const eng = this.gameEngines.get(roomId);
                if (!eng) return;
                try {
                  eng.submitLadyOfTheLakeTarget(holderId, targetId);
                  // Edward 2026-04-25 22:38 +08「湖中女神宣告怪怪的 0>1 ?
                  // 但 0 跟 1 都是忠臣」— bot 之前 100% skip → chat 永遠 `?`，
                  // 即便忠臣 bot 看到忠臣 target 也沒誠實宣告。改成讓 bot 開口：
                  //   - 好人 holder: 誠實宣告 actual target team
                  //   - 壞人 holder: 同夥洗 'good'，對手反向宣告 (簡化版 SelfPlay 啟發)
                  // 失敗 fallback 仍走 skip 維持原 phase advance 保險。
                  setTimeout(() => {
                    const s2 = this.roomManager.getRoom(roomId);
                    if (!s2 || s2.state !== 'lady_of_the_lake') return;
                    const eng2 = this.gameEngines.get(roomId);
                    if (!eng2) return;
                    try {
                      const claim = this.decideBotLakeClaim(s2, holderId, targetId);
                      if (claim !== null) {
                        const record = eng2.declareLakeResult(holderId, claim);
                        if (record) {
                          const declarer = s2.players[holderId];
                          const target = s2.players[record.targetId];
                          const declarerName = declarer?.name ?? holderId;
                          const targetName = target?.name ?? record.targetId;
                          const claimLabel = claim === 'good' ? '好人' : '壞人';
                          this.emitSystemChat(
                            roomId,
                            `🔮 ${declarerName} 宣告 ${targetName} 是「${claimLabel}」`
                          );
                          this.broadcastRoomState(roomId, s2);
                        }
                      } else {
                        eng2.skipLakeDeclaration(holderId);
                      }
                    } catch (err) {
                      console.error(`[bot] declareLakeResult error in room ${roomId}:`, err);
                      // Best-effort fallback — keep phase moving even if declare failed.
                      try {
                        eng2.skipLakeDeclaration(holderId);
                      } catch (skipErr) {
                        console.error(`[bot] skipLakeDeclaration fallback error in room ${roomId}:`, skipErr);
                      }
                    }
                  }, 1500);
                } catch (err) {
                  console.error(`[bot] submitLadyOfTheLakeTarget error in room ${roomId}:`, err);
                }
              }, 1000 + Math.random() * 1000);
            }
          } else if (
            // CASE 2 — post-inspection by a human: a human just inspected a
            // bot, the bot is now waiting on a declaration that will never
            // come from the engine. The human declarer (history[last].holderId)
            // owns declare/skip — bots should NOT declare on their behalf.
            // Nothing to schedule here; the human's declare/skip click or the
            // 90s AFK timeout drives the phase forward.
            r.ladyOfTheLakeResult
            && r.ladyOfTheLakeHistory
            && r.ladyOfTheLakeHistory.length > 0
          ) {
            const last = r.ladyOfTheLakeHistory[r.ladyOfTheLakeHistory.length - 1];
            // If the last declarer is a bot (e.g. bot inspected a human and
            // human is now holder), skip on the bot's behalf so the phase
            // advances and the human can play their lady on the next round.
            if (last && r.players[last.holderId]?.isBot) {
              setTimeout(() => {
                const snapshot = this.roomManager.getRoom(roomId);
                if (!snapshot || snapshot.state !== 'lady_of_the_lake') return;
                const eng = this.gameEngines.get(roomId);
                if (!eng) return;
                try {
                  eng.skipLakeDeclaration(last.holderId);
                } catch (err) {
                  console.error(`[bot] skipLakeDeclaration (post-human) error in room ${roomId}:`, err);
                }
              }, 1500);
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
      const inLobby  = room.state === 'lobby';
      const inActive = room.state !== 'lobby' && room.state !== 'ended';
      const wasHost  = room.host === playerId;
      const previousHost = room.host;

      // Edward 2026-04-25: 房主離開 → 自動交接給下一位座位順位的真人玩家.
      // 座位順序 = Object.keys(room.players) 插入順序（GameEngine seat 索引同源）.
      // Active game 中也要交接而不中斷遊戲；唯一真人離開 = 房間解散.
      const seatOrder = Object.keys(room.players);
      const nextHumanHostId = seatOrder.find(
        id => id !== playerId && !room.players[id]?.isBot,
      );

      if (wasHost && !nextHumanHostId) {
        // No other humans — delete room across all states (host was the only human).
        this.playerToSocket.delete(playerId);
        socket.leave(roomId);
        socket.data.roomId = undefined;
        socket.data.playerId = undefined;
        this.roomManager.deleteRoom(roomId);
        this.gameEngines.delete(roomId);
        this.roomStartTimes.delete(roomId);
        socket.emit('game:left-room');
        console.log(`✓ Host ${playerId} left room ${roomId} — no other humans, room dissolved`);
        return;
      }

      if (wasHost && nextHumanHostId) {
        room.host = nextHumanHostId;
        console.log(
          `✓ Host transfer in room ${roomId}: ${previousHost} → ${nextHumanHostId} (state=${room.state})`,
        );
      }

      // Player removal vs disconnection:
      //  - lobby/ended: hard-remove (no GameEngine state to break).
      //  - active game: mark disconnected to keep engine references intact
      //    (votes, questTeam, leaderIndex). Auto-act fallbacks already handle
      //    disconnected players (handleDisconnect logic).
      if (inLobby || room.state === 'ended') {
        delete room.players[playerId];
      } else if (inActive) {
        const player = room.players[playerId];
        if (player) player.status = 'disconnected';
      }

      this.playerToSocket.delete(playerId);
      socket.leave(roomId);
      socket.data.roomId = undefined;
      socket.data.playerId = undefined;

      this.broadcastRoomState(roomId, room);
      this.io.to(roomId).emit('game:player-left', playerId);
      socket.emit('game:left-room');

      console.log(`✓ Player ${playerId} left room ${roomId} (state=${room.state}, hostTransferred=${wasHost})`);
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

  /**
   * Edward 2026-04-25:「思考時間在遊戲開始前可以調整」— host-only timer
   * adjustment while the room is in the `lobby` state. Mirrors the guard
   * shape of {@link handleSetMaxPlayers} / {@link handleSetRoleOptions}:
   *   - room exists
   *   - caller is the room host
   *   - room.state === 'lobby' (game has not started)
   *   - value passes {@link isTimerMultiplier} (0.5 | 1 | 1.5 | 2 | null)
   *
   * The GameEngine reads `room.timerConfig?.multiplier` lazily inside
   * {@code getTimerMultiplier()} per phase, so updating the field
   * pre-game just changes the value the engine resolves on first read.
   * Once {@link handleStartGame} flips state to `voting`, this handler
   * rejects further changes — the running game's timer values stay locked.
   */
  private handleSetTimerMultiplier(socket: Socket, roomId: string, multiplier: unknown): void {
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) { socket.emit('error', 'Room not found'); return; }

      if (room.host !== (socket.data.playerId as string)) {
        socket.emit('error', 'Only the host can change thinking time');
        return;
      }

      if (room.state !== 'lobby') {
        socket.emit('error', 'Cannot change thinking time after game starts');
        return;
      }

      if (!isTimerMultiplier(multiplier)) {
        socket.emit('error', 'Invalid thinking-time multiplier');
        return;
      }

      const next: TimerConfig = { multiplier: multiplier as TimerMultiplier };
      room.timerConfig = next;
      room.updatedAt = Date.now();
      this.broadcastRoomState(roomId, room);
    } catch (error) {
      console.error('Error setting timer multiplier:', error);
      socket.emit('error', 'Failed to set thinking time');
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
