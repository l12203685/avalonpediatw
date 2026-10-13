import { create } from 'zustand';
import { Room, Player } from '@avalon/shared';

export type GameState = 'home' | 'lobby' | 'voting' | 'playing' | 'ended' | 'wiki' | 'leaderboard' | 'profile' | 'aiStats' | 'friends' | 'replay' | 'analysis' | 'analytics' | 'settings' | 'personalStats' | 'profileSettings' | 'claimsNew' | 'adminClaims' | 'adminAdmins' | 'adminElo' | 'adminImport' | 'help' | 'forgotPassword' | 'resetPassword';
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
  /**
   * 數據分析「玩家雷達」要打開的玩家 (analysis_cache 的名字)；openPlayerStats 設定，
   * AnalyticsPage 切到該分頁並選這位。seq 每次 +1，同一位再點一次也會重新打開。
   * 2026-10-13：不用登入就能看任何玩家的戰績頁。
   */
  statsFocus: { name: string; seq: number } | null;
  replayRoomId: string | null;
  toasts: Toast[];
  socketStatus: SocketStatus;
  isSpectator: boolean;
  setGameState: (state: GameState) => void;
  setRoom: (room: Room | null) => void;
  setCurrentPlayer: (player: Player | null) => void;
  updateRoom: (room: Room) => void;
  navigateToProfile: (userId: string | 'me') => void;
  /** 數據分析 → 分析 → 玩家雷達，選好 `name` (不需要登入)。 */
  openPlayerStats: (name: string) => void;
  navigateToReplay: (roomId: string) => void;
  addToast: (message: string, type?: Toast['type']) => void;
  removeToast: (id: string) => void;
  setSocketStatus: (status: SocketStatus) => void;
  setSpectating: (value: boolean) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: 'home',
  room: null,
  currentPlayer: null,
  profileUserId: null,
  statsFocus: null,
  replayRoomId: null,
  toasts: [],
  socketStatus: 'disconnected',
  isSpectator: false,

  // Leaving the stats page forgets the player it was opened on (statsFocus), so the next
  // visit from the lobby starts on 排行 again instead of that player's radar.
  setGameState: (state: GameState) =>
    set(state === 'analytics' || state === 'analysis' ? { gameState: state } : { gameState: state, statsFocus: null }),
  navigateToProfile: (userId) => set({ gameState: 'profile', profileUserId: userId }),
  openPlayerStats: (name): void => set((s) => ({
    gameState: 'analytics',
    statsFocus: { name, seq: (s.statsFocus?.seq ?? 0) + 1 },
  })),
  navigateToReplay: (roomId) => set({ gameState: 'replay', replayRoomId: roomId }),
  setSocketStatus: (status: SocketStatus) => set({ socketStatus: status }),
  setSpectating: (value: boolean) => set({ isSpectator: value }),

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
