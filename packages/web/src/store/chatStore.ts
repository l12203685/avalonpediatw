import { create } from 'zustand';

/**
 * Edward 2026-04-25 19:40 — GamePage 三條 #3「發言類似對話框展示在任務頭像下面」.
 *
 * Lightweight per-player "latest chat bubble" store. ChatPanel writes to it
 * whenever a `chat:message-received` socket event fires; PlayerCard reads via
 * a selector to render a transient bubble overlay below each player's avatar.
 *
 * Keeping this in a dedicated zustand slice (separate from `gameStore`) means:
 *   - PlayerCard subscriptions stay narrow (only the slice for that player),
 *     so chat traffic doesn't re-render the whole board.
 *   - ChatPanel keeps its existing local message log unchanged (this is a
 *     parallel mirror, not a replacement) — full chat history remains the
 *     source of truth in ChatPanel's local state.
 */
export interface LatestChatEntry {
  /** Plain text body to render inside the bubble. */
  text: string;
  /** Server timestamp (ms epoch) — used to fade-out after 5s. */
  timestamp: number;
}

interface ChatStore {
  /** Map of playerId → most recent chat entry. */
  latestByPlayer: Record<string, LatestChatEntry>;
  /**
   * Record (or overwrite) a player's latest chat message. Older messages for
   * the same player are silently dropped — PlayerCard only renders the most
   * recent line and we don't keep history here (ChatPanel still has the full
   * log).
   */
  setLatestMessage: (playerId: string, text: string, timestamp: number) => void;
  /** Reset everything — call on room change / leave so stale bubbles don't carry. */
  clear: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  latestByPlayer: {},

  setLatestMessage: (playerId, text, timestamp) =>
    set((state) => ({
      latestByPlayer: {
        ...state.latestByPlayer,
        [playerId]: { text, timestamp },
      },
    })),

  clear: () => set({ latestByPlayer: {} }),
}));
