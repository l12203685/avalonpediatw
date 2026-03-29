import { create } from 'zustand';
import { Room, Player } from '@avalon/shared';

type GameState = 'home' | 'lobby' | 'voting' | 'playing' | 'ended' | 'wiki' | 'leaderboard' | 'profile';

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
  toasts: Toast[];
  setGameState: (state: GameState) => void;
  setRoom: (room: Room | null) => void;
  setCurrentPlayer: (player: Player | null) => void;
  updateRoom: (room: Room) => void;
  navigateToProfile: (userId: string | 'me') => void;
  addToast: (message: string, type?: Toast['type']) => void;
  removeToast: (id: string) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: 'home',
  room: null,
  currentPlayer: null,
  profileUserId: null,
  toasts: [],

  setGameState: (state: GameState) => set({ gameState: state }),
  navigateToProfile: (userId) => set({ gameState: 'profile', profileUserId: userId }),

  setRoom: (room: Room | null) => set({ room }),

  setCurrentPlayer: (player: Player | null) => set({ currentPlayer: player }),

  addToast: (message, type = 'error') => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter(t => t.id !== id) }));
    }, 4000);
  },

  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  updateRoom: (room: Room) =>
    set(() => ({
      room,
      gameState:
        room.state === 'lobby'
          ? 'lobby'
          : room.state === 'ended'
            ? 'ended'
            : room.state === 'quest'
              ? 'playing'
              : 'voting',
    })),
}));
