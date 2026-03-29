import { io, Socket } from 'socket.io-client';
import { useGameStore } from '../store/gameStore';
import { Room, Player, User, AuthSession } from '@avalon/shared';
import { getIdToken } from './auth';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

let socket: Socket | null = null;
let _storedToken: string | null = null;
let _hasConnectedOnce = false;

/** Returns the token used to initialise the current socket connection */
export function getStoredToken(): string | null {
  return _storedToken;
}

export function getSocket(): Socket {
  if (!socket) {
    throw new Error('Socket not initialized');
  }
  return socket;
}

export async function initializeSocket(token: string): Promise<void> {
  if (socket) return;
  _storedToken = token;

  const store = useGameStore.getState();

  socket = io(SERVER_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
  });

  // Wait for auth:success or connect_error before resolving
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('連線逾時，請確認伺服器是否運行'));
    }, 10000);

    socket!.once('auth:success', (session: AuthSession) => {
      clearTimeout(timeout);
      store.setCurrentPlayer({
        id: session.user.uid,
        name: session.user.displayName,
        avatar: session.user.photoURL,
        role: null,
        team: null,
        status: 'active',
        createdAt: session.user.createdAt,
      });
      resolve();
    });

    socket!.once('connect_error', (err) => {
      clearTimeout(timeout);
      socket = null;
      reject(new Error(`無法連線伺服器：${err.message}`));
    });
  });

  socket.on('connect', () => {
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
    });
  });

  socket.on('game:state-updated', (room: Room) => {
    store.updateRoom(room);
    // Sync current player's role on reconnect (role only visible if server sanitized it for us)
    const cp = useGameStore.getState().currentPlayer;
    if (cp && room.players[cp.id]?.role && !cp.role) {
      store.setCurrentPlayer({
        ...cp,
        role: room.players[cp.id].role,
        team: room.players[cp.id].team,
      });
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

  socket.on('game:kicked', (_roomId: string) => {
    store.addToast('你已被房主移出房間 (You were kicked from the room)', 'error');
    store.setRoom(null);
    store.setGameState('home');
  });

  socket.on('game:started', (room: Room) => {
    store.updateRoom(room);
    store.setGameState('voting');
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
    // game:ended reveals all roles — sync currentPlayer's confirmed role/team
    const cp = useGameStore.getState().currentPlayer;
    if (cp && room.players[cp.id]) {
      store.setCurrentPlayer({
        ...cp,
        role: room.players[cp.id].role,
        team: room.players[cp.id].team,
      });
    }
  });

  // chat:message-received is handled by ChatPanel component via getSocket().on()

  socket.on('error', (error: string) => {
    console.error('Socket error:', error);
    useGameStore.getState().addToast(error, 'error');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
  });
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    _storedToken = null;
    _hasConnectedOnce = false;
  }
}

export function createRoom(playerName: string): void {
  const socket = getSocket();
  socket.emit('game:create-room', playerName);
}

export function joinRoom(roomId: string): void {
  const socket = getSocket();
  socket.emit('game:join-room', roomId);
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

export function addBot(roomId: string): void {
  const socket = getSocket();
  socket.emit('game:add-bot', roomId);
}

export function removeBot(roomId: string, botId: string): void {
  const socket = getSocket();
  socket.emit('game:remove-bot', roomId, botId);
}
