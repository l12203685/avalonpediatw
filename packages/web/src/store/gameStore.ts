import { create } from 'zustand';
import { Room, Player } from '@avalon/shared';

type GameState = 'home' | 'lobby' | 'voting' | 'playing' | 'ended';

interface GameStore {
  gameState: GameState;
  room: Room | null;
  currentPlayer: Player | null;
  setGameState: (state: GameState) => void;
  setRoom: (room: Room | null) => void;
  setCurrentPlayer: (player: Player | null) => void;
  updateRoom: (room: Room) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: 'home',
  room: null,
  currentPlayer: null,

  setGameState: (state: GameState) => set({ gameState: state }),

  setRoom: (room: Room | null) => set({ room }),

  setCurrentPlayer: (player: Player | null) => set({ currentPlayer: player }),

  updateRoom: (room: Room) =>
    set((state) => ({
      room,
      gameState:
        room.state === 'lobby'
          ? 'lobby'
          : room.state === 'voting'
            ? 'voting'
            : room.state === 'quest'
              ? 'playing'
              : room.state === 'ended'
                ? 'ended'
                : 'voting',
    })),
}));
