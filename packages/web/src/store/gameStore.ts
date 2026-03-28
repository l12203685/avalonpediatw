import { create } from 'zustand';
import { Room, Player } from '@avalon/shared';

type GameState = 'home' | 'lobby' | 'voting' | 'playing' | 'ended' | 'wiki' | 'leaderboard' | 'profile';

interface GameStore {
  gameState: GameState;
  room: Room | null;
  currentPlayer: Player | null;
  profileUserId: string | null; // target for 'profile' state ('me' or supabase UUID)
  setGameState: (state: GameState) => void;
  setRoom: (room: Room | null) => void;
  setCurrentPlayer: (player: Player | null) => void;
  updateRoom: (room: Room) => void;
  navigateToProfile: (userId: string | 'me') => void;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: 'home',
  room: null,
  currentPlayer: null,
  profileUserId: null,

  setGameState: (state: GameState) => set({ gameState: state }),
  navigateToProfile: (userId) => set({ gameState: 'profile', profileUserId: userId }),

  setRoom: (room: Room | null) => set({ room }),

  setCurrentPlayer: (player: Player | null) => set({ currentPlayer: player }),

  updateRoom: (room: Room) =>
    set((state) => ({
      room,
      gameState:
        room.state === 'lobby'
          ? 'lobby'
          : room.state === 'ended'
            ? 'ended'
            : room.state === 'quest'
              ? 'playing'
              : 'voting', // covers 'voting' and 'discussion'
    })),
}));
