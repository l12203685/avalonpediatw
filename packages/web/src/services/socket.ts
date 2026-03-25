import { io, Socket } from 'socket.io-client';
import { useGameStore } from '../store/gameStore';
import { Room, Player } from '@avalon/shared';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    throw new Error('Socket not initialized');
  }
  return socket;
}

export function initializeSocket(): void {
  if (socket) return;

  socket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
  });

  const store = useGameStore.getState();

  socket.on('connect', () => {
    console.log('✓ Connected to server');
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
    console.log('Message:', message);
  });

  socket.on('error', (error: string) => {
    console.error('Socket error:', error);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
  });
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

export function submitQuestResult(roomId: string, result: 'success' | 'fail'): void {
  const socket = getSocket();
  socket.emit('game:submit-quest-result', roomId, result);
}

export function sendChatMessage(roomId: string, message: string): void {
  const socket = getSocket();
  socket.emit('chat:send-message', roomId, message);
}
