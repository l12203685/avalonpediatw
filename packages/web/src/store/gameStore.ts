import { create } from 'zustand';
import { Room, Player, ChatMessage } from '@avalon/shared';

type GameState = 'home' | 'lobby' | 'voting' | 'playing' | 'ended' | 'wiki' | 'leaderboard' | 'profile' | 'replay' | 'ai-stats';

interface GameStore {
  gameState: GameState;
  room: Room | null;
  currentPlayer: Player | null;
  chatMessages: ChatMessage[];
  guestMode: boolean;
  replayRoomId: string | null;
  setGameState: (state: GameState) => void;
  setRoom: (room: Room | null) => void;
  setCurrentPlayer: (player: Player | null) => void;
  updateRoom: (room: Room) => void;
  addChatMessage: (message: ChatMessage) => void;
  clearChat: () => void;
  setGuestMode: (v: boolean) => void;
  setReplayRoomId: (id: string | null) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: 'home',
  room: null,
  currentPlayer: null,
  chatMessages: [],
  guestMode: false,
  replayRoomId: null,

  setGameState: (state: GameState) => set({ gameState: state }),

  setRoom: (room: Room | null) => set({ room }),

  setCurrentPlayer: (player: Player | null) => set({ currentPlayer: player }),

  updateRoom: (room: Room) =>
    set(() => ({
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

  addChatMessage: (message: ChatMessage) =>
    set((state) => ({
      chatMessages: [...state.chatMessages, message],
    })),

  clearChat: () => set({ chatMessages: [] }),

  setGuestMode: (v: boolean) => set({ guestMode: v }),

  setReplayRoomId: (id: string | null) => set({ replayRoomId: id }),
}));
