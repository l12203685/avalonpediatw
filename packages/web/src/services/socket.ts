import { io, Socket } from 'socket.io-client';
import { useGameStore } from '../store/gameStore';
import { Room, Player, User, AuthSession } from '@avalon/shared';
import { getIdToken } from './auth';
import { toast } from '../store/toastStore';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

let socket: Socket | null = null;
let _hasConnectedOnce = false;

export function getSocket(): Socket {
  if (!socket) {
    throw new Error('Socket not initialized');
  }
  return socket;
}

export async function initializeSocket(token: string): Promise<void> {
  if (socket) return;

  socket = io(SERVER_URL, {
    auth: {
      token,
    },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
  });

  const store = useGameStore.getState();

  socket.on('connect', () => {
    console.log('✓ Connected to server');
    if (_hasConnectedOnce) {
      toast.success('已重新連接伺服器');
      // Re-join room if in one
      const { room, currentPlayer } = useGameStore.getState();
      if (room && currentPlayer) {
        socket!.emit('game:rejoin-room', room.id, currentPlayer.id);
      }
    }
    _hasConnectedOnce = true;
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
  });

  socket.on('game:player-joined', (player: Player) => {
    console.log('Player joined:', player);
  });

  socket.on('game:started', (room: Room) => {
    store.updateRoom(room);
    store.setGameState('voting');
  });

  socket.on('chat:message-received', (message) => {
    store.addChatMessage(message);
  });

  socket.on('error', (error: string) => {
    console.error('Socket error:', error);
    toast.error(error || '伺服器錯誤');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
    toast.warning('與伺服器斷線，嘗試重新連接中...');
  });
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function createRoom(playerName: string): void {
  const socket = getSocket();
  socket.emit('game:create-room', playerName);
}

export function joinRoom(roomId: string, playerId: string): void {
  const socket = getSocket();
  socket.emit('game:join-room', roomId, playerId);
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
