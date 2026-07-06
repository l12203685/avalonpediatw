/**
 * LobbyChatBuffer — In-memory circular buffer for the public lobby chat (#63).
 *
 * Rationale:
 *  - MVP scope: "主頁公眾聊天視窗" only (see task #63). Persistent history /
 *    cross-platform sync (LINE / Discord) is #82 and deliberately excluded.
 *  - A small ring (default 50) keeps memory bounded and, combined with emitting
 *    snapshots on join, gives late joiners enough context without a database.
 *  - Immutable helpers — every mutation returns a fresh list so tests and
 *    consumers can diff without worrying about aliasing.
 *
 * Schema matches `ChatMessage` on the client but lives in its own event
 * channel (`lobby:*`) so room chat (`chat:*`) is undisturbed.
 *
 * #82: `source` tag threads through every message so `ChatMirror` can fan a
 * lobby message out to LINE/Discord while suppressing re-entries from those
 * platforms (prevents lobby → LINE → lobby loops).
 */

/**
 * Where a message originated. `lobby` is the default for web-client sends;
 * `line` / `discord` are inbound from the corresponding platform (#82 Phase B).
 */
export type LobbyChatSource = 'lobby' | 'line' | 'discord';

export interface LobbyChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
  /** true for broadcast system notices (joined/left). */
  isSystem?: boolean;
  /**
   * Platform that originated this message. Optional for backward compatibility
   * with #63 snapshots that pre-date #82 — treat `undefined` as `'lobby'`.
   */
  source?: LobbyChatSource;
}

export const LOBBY_CHAT_MAX = 50;
export const LOBBY_CHAT_MAX_LEN = 200;

export class LobbyChatBuffer {
  private messages: LobbyChatMessage[] = [];
  private readonly capacity: number;

  constructor(capacity: number = LOBBY_CHAT_MAX) {
    if (capacity <= 0) throw new Error('LobbyChatBuffer capacity must be > 0');
    this.capacity = capacity;
  }

  /** Append a message; oldest is dropped once capacity is exceeded. */
  public append(msg: LobbyChatMessage): LobbyChatMessage {
    this.messages = [...this.messages, msg];
    if (this.messages.length > this.capacity) {
      this.messages = this.messages.slice(this.messages.length - this.capacity);
    }
    return msg;
  }

  /** Snapshot — returns a shallow copy so callers can't mutate the ring. */
  public snapshot(): LobbyChatMessage[] {
    return [...this.messages];
  }

  public size(): number {
    return this.messages.length;
  }

  public clear(): void {
    this.messages = [];
  }

  /**
   * Validate a candidate message body. Returns a trimmed copy on success,
   * or null if the body is invalid (empty / too long / non-string).
   */
  public static validateBody(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length > LOBBY_CHAT_MAX_LEN) return null;
    return trimmed;
  }
}
