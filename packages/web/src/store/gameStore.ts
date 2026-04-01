import { create } from 'zustand';
import { Room, Player } from '@avalon/shared';

type GameState = 'home' | 'lobby' | 'voting' | 'playing' | 'ended' | 'wiki' | 'leaderboard' | 'profile' | 'aiStats' | 'friends' | 'replay';
export type SocketStatus = 'connected' | 'disconnected' | 'reconnecting';

export interface Toast {
  id: string;
  message: string;
  type: 'error' | 'info' | 'success';
}

interface GameStore {
  gameState: GameState;
  room: Room | null;
  currentPlayer: Player | null;
  profileUserId: string | null;
  replayRoomId: string | null;
  toasts: Toast[];
  socketStatus: SocketStatus;
  isSpectator: boolean;
  quickSoloMode: boolean;
  setGameState: (state: GameState) => void;
  setRoom: (room: Room | null) => void;
  setCurrentPlayer: (player: Player | null) => void;
  updateRoom: (room: Room) => void;
  navigateToProfile: (userId: string | 'me') => void;
  navigateToReplay: (roomId: string) => void;
  addToast: (message: string, type?: Toast['type']) => void;
  removeToast: (id: string) => void;
  setSocketStatus: (status: SocketStatus) => void;
  setSpectating: (value: boolean) => void;
  setQuickSoloMode: (value: boolean) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: 'home',
  room: null,
  currentPlayer: null,
  profileUserId: null,
  replayRoomId: null,
  toasts: [],
  socketStatus: 'disconnected',
  isSpectator: false,
  quickSoloMode: false,

  setGameState: (state: GameState) => set({ gameState: state }),
  navigateToProfile: (userId) => set({ gameState: 'profile', profileUserId: userId }),
  navigateToReplay: (roomId) => set({ gameState: 'replay', replayRoomId: roomId }),
  setSocketStatus: (status: SocketStatus) => set({ socketStatus: status }),
  setSpectating: (value: boolean) => set({ isSpectator: value }),
  setQuickSoloMode: (value: boolean) => set({ quickSoloMode: value }),

  setRoom: (room: Room | null) => {
    if (!room) localStorage.removeItem('avalon_room');
    set({ room });
  },

  setCurrentPlayer: (player: Player | null) => set({ currentPlayer: player }),

  addToast: (message, type = 'error') => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter(t => t.id !== id) }));
    }, 4000);
  },

  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  updateRoom: (room: Room) => set((s) => {
    // Persist room ID for auto-rejoin on page refresh — skip for spectators
    if (!s.isSpectator) {
      if (room.state === 'ended') {
        localStorage.removeItem('avalon_room');
      } else {
        localStorage.setItem('avalon_room', room.id);
      }
    }
    return {
      room,
      gameState:
        room.state === 'lobby'
          ? 'lobby'
          : room.state === 'ended'
            ? 'ended'
            : (room.state === 'quest' || room.state === 'discussion')
              ? 'playing'
              : 'voting',
    };
  }),
}));
