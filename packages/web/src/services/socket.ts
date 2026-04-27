import { io, Socket } from 'socket.io-client';
import { useGameStore } from '../store/gameStore';
import {
  Room,
  Player,
  User,
  AuthSession,
  TimerMultiplier,
  classifyToken,
} from '@avalon/shared';
import { getIdToken } from './auth';
import { sendTurnNotification } from './notifications';
import audioService from './audio';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

// 2026-04-27 持久化登入 (Edward: 「登入後常駐 不用每次重開頁面就要重新登入」):
// 之前 `_storedToken` 只存模組變數，重新整理頁面就清空 → `getStoredToken()` 回 null →
// App.tsx mount 跑進 ensureGuestSession() → 拿到全新 guest_xxx，原本登入身份直接遺失。
// 修正：把 site-issued JWT (custom + guest) 寫進 localStorage，cold start 時讀回來；
// 跟 server 端 JWT TTL（site 7d / guest 30d）對齊，到期 server 會回 401，
// initializeSocket 會 reject → App.tsx 自動退到 ensureGuestSession 重新發訪客 token。
// 注意 Firebase Google 登入不走這條 — Firebase SDK 自己用 browserLocalPersistence
// 把 currentUser 存 IndexedDB，`onAuthStateChange` 重啟頁面會自己餵 ID token 進來。
const STORED_TOKEN_KEY = 'avalon_session_token';

function readPersistedToken(): string | null {
  try {
    return localStorage.getItem(STORED_TOKEN_KEY);
  } catch {
    // private mode / SecurityError — module memory 是唯一 fallback
    return null;
  }
}

function writePersistedToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(STORED_TOKEN_KEY);
    else                localStorage.setItem(STORED_TOKEN_KEY, token);
  } catch {
    // private mode / quota — 寫不進就算了，本 session 仍能正常運作
  }
}

let socket: Socket | null = null;
// Lazy-init from localStorage so the first reload after a successful login can
// re-handshake the socket without requiring `onAuthStateChange` (Firebase) to
// fire — covers email/password / Discord / LINE / quickLoginWithGoogle paths
// that mint site JWTs not Firebase tokens.
let _storedToken: string | null = readPersistedToken();
let _hasConnectedOnce = false;

/** Returns the token used to initialise the current socket connection */
export function getStoredToken(): string | null {
  // 防呆：模組變數遺失（HMR / lazy chunk reload）時 fall back 到 localStorage
  if (_storedToken) return _storedToken;
  const persisted = readPersistedToken();
  if (persisted) _storedToken = persisted;
  return _storedToken;
}

export function getSocket(): Socket {
  if (!socket) {
    throw new Error('Socket not initialized');
  }
  if (!socket.connected) {
    throw new Error('尚未連線 - 請稍候再試');
  }
  return socket;
}

export async function initializeSocket(token: string): Promise<void> {
  // 2026-04-23 guest→google upgrade fix: when Edward binds Google after entering
  // as guest, `onAuthStateChange` re-calls this with the new Firebase ID token,
  // but previously we early-returned on `socket?.connected` → socket stayed on
  // the old guest token → server kept reporting provider='guest' → settings page
  // still showed guest UI → Edward couldn't rename. Now: if the token changed,
  // tear down the existing socket so we re-handshake with the new identity.
  if (socket?.connected && _storedToken === token) return;
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  _storedToken = token;
  // 持久化 site JWT，下次冷啟動 App.tsx 才能用 getStoredToken() 接回身份。
  writePersistedToken(token);

  const store = useGameStore.getState();

  // 2026-04-26: dropped the `ngrok-skip-browser-warning` extraHeaders that used
  // to bypass ngrok's free-plan interstitial. Backend tunnel migrated off ngrok
  // (cloudflared quick tunnel today; named tunnel planned), so the header is no
  // longer needed. Re-add only if a tunnel that requires it comes back.
  socket = io(SERVER_URL, {
    auth: { token },
    // polling → websocket upgrade order. WS-first fails intermittently on
    // some tunnels + iPhone Safari (Edward 2026-04-23 P0: 訪客 websocket
    // error). Polling-first handshakes cleanly then upgrades when stable;
    // if WS upgrade later fails, Socket.IO keeps the polling transport alive
    // instead of emitting connect_error. Ref: socket.io-client v4 docs.
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    // Keep retrying forever — backend restarts (tunnel hiccups / redeploys) can
    // take longer than 5 × 5s to come back. If we give up, getSocket() throws
    // "尚未連線" forever and the only fix is a full page refresh, which Edward
    // observed as "無法建立房間" (P0 diag 2026-04-21 19:26 +08).
    reconnectionAttempts: Infinity,
  });

  // Refresh Firebase ID token before each reconnect attempt so expired tokens
  // (Firebase tokens last 1h) don't cause `connect_error: Token expired`.
  //
  // 2026-04-24 root-cause fix (drift_storedtoken_overwrite): previously this
  // handler called `getIdToken()` unconditionally. Firebase persists the Google
  // session to localStorage by default, so any browser that ever signed in
  // with Google kept a warm `currentUser` — even after the user switched to a
  // Discord / LINE / email / guest session. The refresh then silently replaced
  // the site-issued custom JWT in `_storedToken` with a Firebase ID token,
  // breaking downstream REST handlers that branched on the `provider` claim.
  //
  // New behaviour: classify the stored token first. Only Firebase ID tokens
  // (iss = `https://securetoken.google.com/...`) get refreshed. Custom JWTs
  // (provider = password/discord/line/google/etc.) and guest JWTs are left
  // intact — they're long-lived site-issued tokens without a refresh endpoint,
  // and forcing a Firebase swap would change the user's perceived identity.
  // Unknown / missing tokens fall through to the legacy refresh-or-keep flow.
  socket.io.on('reconnect_attempt', async () => {
    const current = _storedToken;
    const kind = classifyToken(current);

    if (kind === 'custom-jwt' || kind === 'guest') {
      // Site-issued token — do NOT refresh via Firebase. Keep `_storedToken`
      // untouched and re-seat `socket.auth.token` so any mutation elsewhere
      // doesn't drift.
      if (socket && current) {
        socket.auth = { ...(socket.auth as Record<string, unknown>), token: current };
      }
      return;
    }

    try {
      const freshToken = await getIdToken();
      _storedToken = freshToken;
      // 同步更新持久化拷貝 — Firebase ID token 1h 過期，refresh 後不寫回
      // localStorage 會讓下次 cold start 撈到舊 token 直接被 server 401 拒掉。
      writePersistedToken(freshToken);
      if (socket) {
        socket.auth = { ...(socket.auth as Record<string, unknown>), token: freshToken };
      }
    } catch {
      // Firebase not configured or no currentUser — keep the stored token.
      if (socket && current) {
        socket.auth = { ...(socket.auth as Record<string, unknown>), token: current };
      }
    }
  });

  // Wait for auth:success or connect_error before resolving.
  //
  // 2026-04-23 guest stabilize (P0, drift_35): transient `xhr poll error`
  // / `websocket error` spikes — usually from a 1–2s tunnel hiccup or a
  // wifi flap on iPhone Safari — were being turned into an immediate
  // "無法連線伺服器" rejection, which the UI then surfaces as a hard failure
  // even though Socket.IO's own reconnection loop would have recovered in
  // <5s. We now tolerate up to CONNECT_ERROR_TOLERANCE transient errors
  // before rejecting; during that window, the UI stays in the
  // "reconnecting" state (yellow banner "重新連線中…") instead of flipping
  // to red "連線中斷".
  const CONNECT_ERROR_TOLERANCE = 3;
  const INITIAL_CONNECT_TIMEOUT_MS = 10_000;
  await new Promise<void>((resolve, reject) => {
    let transientErrors = 0;
    const timeout = setTimeout(() => {
      socket?.off('connect_error', onConnectError);
      reject(new Error('連線逾時，請確認伺服器是否運行'));
    }, INITIAL_CONNECT_TIMEOUT_MS);

    const onAuthSuccess = (session: AuthSession): void => {
      clearTimeout(timeout);
      socket?.off('connect_error', onConnectError);
      store.setSocketStatus('connected');
      store.setCurrentPlayer({
        id: session.user.uid,
        name: session.user.displayName,
        avatar: session.user.photoURL,
        role: null,
        team: null,
        status: 'active',
        createdAt: session.user.createdAt,
        // #84 hotfix: propagate provider so ProfileSettingsPage can tell guests
        // apart from registered users without relying on avatar presence (which
        // misclassified Discord/Line users lacking a photoURL as guests).
        provider: session.user.provider,
      });
      // Auto-rejoin room if player was in one before page refresh
      const savedRoom = localStorage.getItem('avalon_room');
      if (savedRoom) {
        console.log('↩ Auto-rejoining room after refresh:', savedRoom);
        socket!.emit('game:join-room', savedRoom);
      }
      resolve();
    };

    const onConnectError = (err: Error): void => {
      transientErrors += 1;
      // Show reconnecting state so the user sees "重新連線中…" instead of
      // a scary error — Socket.IO's own reconnection handles the retry.
      store.setSocketStatus('reconnecting');
      console.warn(
        `[socket] connect_error #${transientErrors}/${CONNECT_ERROR_TOLERANCE}: ${err.message}`,
      );
      if (transientErrors >= CONNECT_ERROR_TOLERANCE) {
        clearTimeout(timeout);
        socket?.off('auth:success', onAuthSuccess);
        socket = null;
        reject(new Error(`無法連線伺服器：${err.message}`));
      }
      // else: let Socket.IO keep retrying inside the 10s window.
    };

    socket!.once('auth:success', onAuthSuccess);
    socket!.on('connect_error', onConnectError);
  });

  socket.on('connect', () => {
    useGameStore.getState().setSocketStatus('connected');
    if (_hasConnectedOnce) {
      // This is a reconnect — re-join the current room if we were in one
      const { room } = useGameStore.getState();
      if (room?.id) {
        console.log('↩ Reconnected — rejoining room', room.id);
        socket!.emit('game:join-room', room.id);
      }
    }
    _hasConnectedOnce = true;
    console.log('✓ Connected to server');
  });

  socket.on('auth:success', (session: AuthSession) => {
    console.log('✓ Authenticated:', session.user.displayName);
    store.setCurrentPlayer({
      id: session.user.uid,
      name: session.user.displayName,
      avatar: session.user.photoURL,
      role: null,
      team: null,
      status: 'active',
      createdAt: session.user.createdAt,
      // #84 hotfix: keep provider in sync across reconnects so the settings
      // page never regresses back to the guest UI after a socket hiccup.
      provider: session.user.provider,
    });
  });

  socket.on('game:state-updated', (room: Room) => {
    store.updateRoom(room);

    // Vote + quest result toasts/sounds are handled by VoteRevealOverlay / QuestResultOverlay in GamePage

    // Sync current player's role on reconnect (role only visible if server sanitized it for us)
    const cp = useGameStore.getState().currentPlayer;
    if (cp && room.players[cp.id]?.role && !cp.role) {
      store.setCurrentPlayer({
        ...cp,
        role: room.players[cp.id].role,
        team: room.players[cp.id].team,
      });
    }

    // Send browser notification when it's the player's turn
    if (cp) {
      const playerIds = Object.keys(room.players);
      const leaderId = playerIds[room.leaderIndex % playerIds.length];
      if (room.state === 'voting' && room.questTeam.length === 0 && leaderId === cp.id) {
        sendTurnNotification('⚔️ Avalon — 輪到你了！', '你是隊長，請選擇任務隊伍');
      } else if (room.state === 'voting' && room.questTeam.length > 0 && !(cp.id in room.votes)) {
        sendTurnNotification('🗳️ Avalon — 輪到你投票！', '贊成或反對此次任務隊伍');
      } else if (room.state === 'quest' && room.questTeam.includes(cp.id)) {
        sendTurnNotification('⚔️ Avalon — 任務投票！', '你在任務隊伍中，請投票成功或失敗');
      } else if (room.state === 'discussion' && room.players[cp.id]?.role === 'assassin') {
        sendTurnNotification('🗡️ Avalon — 你是刺客！', '好人贏得了任務。選擇你的目標刺殺梅林！');
      }
    }
  });

  socket.on('game:player-joined', (player: Player) => {
    store.addToast(`${player.name} 加入了房間`, 'info');
  });

  socket.on('game:player-reconnected', (playerId: string) => {
    const { room } = useGameStore.getState();
    const name = room?.players[playerId]?.name ?? playerId;
    store.addToast(`${name} 重新連線`, 'success');
  });

  socket.on('game:player-left', (playerId: string) => {
    const { room } = useGameStore.getState();
    const name = room?.players[playerId]?.name ?? playerId;
    store.addToast(`${name} 斷線`, 'info');
  });

  socket.on('game:spectating', (roomId: string) => {
    useGameStore.getState().setSpectating(true);
    console.log('👁 Spectating room:', roomId);
  });

  socket.on('game:kicked', (_roomId: string) => {
    store.addToast('你已被房主移出房間', 'error');
    store.setRoom(null);
    store.setGameState('home');
  });

  socket.on('game:left-room', () => {
    store.setRoom(null);
    store.setGameState('home');
    store.setSpectating(false);
  });

  socket.on('game:started', (room: Room) => {
    store.updateRoom(room);
    store.setGameState('voting');
    store.addToast('🎭 遊戲開始！查看你的角色', 'success');
    audioService.playSound('game-start');
    // Sync current player's role from room (server assigns roles on start)
    const cp = useGameStore.getState().currentPlayer;
    if (cp && room.players[cp.id]) {
      store.setCurrentPlayer({
        ...cp,
        role: room.players[cp.id].role,
        team: room.players[cp.id].team,
      });
    }
  });

  socket.on('game:ended', (room: Room) => {
    store.updateRoom(room);
    const cp = useGameStore.getState().currentPlayer;
    if (cp && room.players[cp.id]) {
      store.setCurrentPlayer({
        ...cp,
        role: room.players[cp.id].role,
        team: room.players[cp.id].team,
      });
      const myTeam = room.players[cp.id].team;
      const won = room.evilWins ? myTeam === 'evil' : myTeam === 'good';
      store.addToast(won ? '🏆 你贏了！' : '😔 你輸了', won ? 'success' : 'error');
    }
  });

  // chat:message-received is handled by ChatPanel component via getSocket().on()

  socket.on('error', (error: string) => {
    console.error('Socket error:', error);
    useGameStore.getState().addToast(error, 'error');
    // Clear stale room on "not found" so auto-rejoin doesn't loop
    if (error === 'Room not found' || error === 'Game already in progress') {
      localStorage.removeItem('avalon_room');
    }
  });

  socket.on('disconnect', () => {
    useGameStore.getState().setSocketStatus('disconnected');
    console.log('Disconnected from server');
  });

  socket.on('reconnect_attempt', () => {
    useGameStore.getState().setSocketStatus('reconnecting');
  });
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    _storedToken = null;
    _hasConnectedOnce = false;
    // logout 路徑必須順手清掉 localStorage，不然下次 cold start `getStoredToken()`
    // 會撈到舊 token，把已登出的使用者又拉回去。
    writePersistedToken(null);
  }
}

export function createRoom(
  playerName: string,
  password?: string,
  timerMultiplier?: TimerMultiplier,
  /**
   * Casual match (Edward 2026-04-24 14:43): when `true` the server tags the
   * room as 娛樂局 and the ELO pipeline skips the resulting game. Defaults
   * to `false` — omitting the arg keeps the legacy ranked behaviour.
   */
  casual?: boolean,
): void {
  const socket = getSocket();
  socket.emit('game:create-room', playerName, password, timerMultiplier, Boolean(casual));
}

export function joinRoom(roomId: string, password?: string): void {
  const socket = getSocket();
  socket.emit('game:join-room', roomId, password);
}

export function setRoomPassword(roomId: string, password: string | null): void {
  const socket = getSocket();
  socket.emit('game:set-room-password', roomId, password);
}

export function startGame(roomId: string): void {
  const socket = getSocket();
  socket.emit('game:start-game', roomId);
}

export function submitVote(roomId: string, playerId: string, vote: boolean): void {
  const socket = getSocket();
  socket.emit('game:vote', roomId, playerId, vote);
}

export function selectQuestTeam(roomId: string, teamMemberIds: string[]): void {
  const socket = getSocket();
  socket.emit('game:select-quest-team', roomId, teamMemberIds);
}

export function submitQuestVote(roomId: string, playerId: string, vote: 'success' | 'fail'): void {
  const socket = getSocket();
  socket.emit('game:submit-quest-vote', roomId, playerId, vote);
}

export function submitAssassination(roomId: string, assassinId: string, targetId: string): void {
  const socket = getSocket();
  socket.emit('game:assassinate', roomId, assassinId, targetId);
}

export function submitLadyOfTheLake(roomId: string, holderId: string, targetId: string): void {
  const socket = getSocket();
  socket.emit('game:lady-of-the-lake', roomId, holderId, targetId);
}

/**
 * Part 4 of #90 — Lady of the Lake holder publicly declares the inspected
 * player as 'good' or 'evil'. No-op on the server if already declared.
 */
export function declareLakeResult(roomId: string, claim: 'good' | 'evil'): void {
  const socket = getSocket();
  socket.emit('game:declare-lake-result', roomId, claim);
}

/**
 * Part 4 of #90 — the Lady of the Lake declarer explicitly skips the public
 * declaration so the game advances without waiting on the 90s AFK timeout.
 * Server handler: `game:skip-lake-declaration` → `GameEngine.skipLakeDeclaration`.
 */
export function skipLakeDeclaration(roomId: string): void {
  const socket = getSocket();
  socket.emit('game:skip-lake-declaration', roomId);
}

export function sendChatMessage(roomId: string, message: string): void {
  const socket = getSocket();
  socket.emit('chat:send-message', roomId, message);
}

export function listRooms(): void {
  const socket = getSocket();
  socket.emit('game:list-rooms');
}

export function kickPlayer(roomId: string, targetPlayerId: string): void {
  const socket = getSocket();
  socket.emit('game:kick-player', roomId, targetPlayerId);
}

export function addBot(roomId: string, difficulty: 'easy' | 'normal' | 'hard' = 'normal'): void {
  const socket = getSocket();
  socket.emit('game:add-bot', roomId, difficulty);
}

export function removeBot(roomId: string, botId: string): void {
  const socket = getSocket();
  socket.emit('game:remove-bot', roomId, botId);
}

export function requestRematch(roomId: string): void {
  const socket = getSocket();
  socket.emit('game:rematch', roomId);
}

export function leaveRoom(roomId: string): void {
  const socket = getSocket();
  socket.emit('game:leave-room', roomId);
}

export function spectateRoom(roomId: string): void {
  const socket = getSocket();
  socket.emit('game:spectate-room', roomId);
}

export function leaveSpectate(roomId: string): void {
  const socket = getSocket();
  socket.emit('game:leave-spectate', roomId);
}

export function setMaxPlayers(roomId: string, count: number): void {
  const socket = getSocket();
  socket.emit('game:set-max-players', roomId, count);
}

/**
 * Advanced-rule-aware setRoleOptions (#90). Host UI sends a mixed payload
 * that may contain any combination of:
 *   - booleans: percival/morgana/oberon/mordred/ladyOfTheLake/swapR1R2
 *   - enum strings: variant9Player ('standard' | 'oberonMandatory'),
 *     ladyStart ('random' | 'seat0'..'seat9')
 * Server validates per-key before applying.
 */
export function setRoleOptions(roomId: string, options: Record<string, unknown>): void {
  const socket = getSocket();
  socket.emit('game:set-role-options', roomId, options);
}

export function toggleReady(roomId: string, playerId: string): void {
  const socket = getSocket();
  socket.emit('game:toggle-ready', roomId, playerId);
}

/**
 * Host-only adjustment of the room's thinking-time multiplier while the
 * room is still in the `lobby` state (Edward 2026-04-25:「思考時間在遊戲
 * 開始前可以調整」). Server rejects the event once the game has started,
 * so the engine's per-phase timer reads stay locked once running.
 */
export function setTimerMultiplier(roomId: string, multiplier: TimerMultiplier): void {
  const socket = getSocket();
  socket.emit('game:set-timer-multiplier', roomId, multiplier);
}
