/**
 * In-memory registry of practice rooms (網站「與機器人練習」).
 *
 * Holds, per practice room: the owner, the chosen seat/role, the bot
 * decision trace (server-side only until the game ends), activity
 * timestamps for cleanup, and the per-room 「這步怪怪的」 rate limit.
 * Nothing here is persisted — a restart simply forgets practice rooms.
 */
import type { PracticeDecisionKind, PracticeOptions, PracticeTraceEntry } from './types';

export const PRACTICE_LIMITS = Object.freeze({
  /** Ended practice rooms stay reviewable this long, then are removed. */
  endedTtlMs: 30 * 60 * 1000,
  /** In-progress practice rooms with no player action for this long are removed. */
  idleTtlMs: 30 * 60 * 1000,
  /** At most this many flags per practice room. */
  maxFlagsPerRoom: 30,
  /** Minimum gap between two flags in the same room. */
  minFlagIntervalMs: 2000,
  /** Flag note length cap (characters). */
  maxNoteChars: 500,
  /** Safety cap on trace length (a 5-round game has ~150 bot decisions). */
  maxEntries: 2000,
  /** Server-wide cap on practice rooms that exist at the same time. */
  maxConcurrentRooms: 50,
  /** Server-wide cap on flags written to the report sheet per rolling hour. */
  maxFlagsPerHour: 100,
  /** Per-player cap on flags per rolling 24 hours (all their practice rooms). */
  maxFlagsPerUserPerDay: 200,
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface PracticeSession {
  roomId: string;
  ownerId: string;
  options: PracticeOptions;
  /**
   * Bot player ids seated at creation. Kept here (not only in the room) so
   * disposal frees their agents even when the room itself is already gone.
   */
  botIds: string[];
  createdAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  entries: PracticeTraceEntry[];
  flaggedEntryIds: Set<number>;
  lastFlagAt: number;
}

export type NewTraceEntry = Omit<PracticeTraceEntry, 'id' | 'at'>;

export type FlagCheck =
  | { ok: true; entry: PracticeTraceEntry }
  | { ok: false; error: string };

interface FlagStamp {
  at: number;
  ownerId: string;
  roomId: string;
  entryId: number;
}

export class PracticeSessions {
  private readonly sessions = new Map<string, PracticeSession>();
  /** Flags written in the last 24 h, across every practice room (quota). */
  private flagStamps: FlagStamp[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  create(roomId: string, ownerId: string, options: PracticeOptions, botIds: readonly string[] = []): PracticeSession {
    const t = this.now();
    const session: PracticeSession = {
      roomId,
      ownerId,
      options: { ...options },
      botIds: [...botIds],
      createdAt: t,
      lastActivityAt: t,
      endedAt: null,
      entries: [],
      flaggedEntryIds: new Set(),
      lastFlagAt: 0,
    };
    this.sessions.set(roomId, session);
    return session;
  }

  has(roomId: string | undefined | null): boolean {
    return typeof roomId === 'string' && this.sessions.has(roomId);
  }

  get(roomId: string): PracticeSession | undefined {
    return this.sessions.get(roomId);
  }

  /** Whether another practice room may be created (server-wide cap). */
  isFull(): boolean {
    return this.sessions.size >= PRACTICE_LIMITS.maxConcurrentRooms;
  }

  /** The ended practice room whose game finished first (evicted when full). */
  oldestEnded(): string | undefined {
    let best: PracticeSession | undefined;
    for (const s of this.sessions.values()) {
      if (s.endedAt === null) continue;
      if (!best || (best.endedAt ?? 0) > s.endedAt) best = s;
    }
    return best?.roomId;
  }

  /** Practice rooms owned by `ownerId` (normally zero or one). */
  findByOwner(ownerId: string): PracticeSession[] {
    return [...this.sessions.values()].filter((s) => s.ownerId === ownerId);
  }

  touch(roomId: string): void {
    const s = this.sessions.get(roomId);
    if (s) s.lastActivityAt = this.now();
  }

  /** Append one bot decision; returns null when the room is unknown, ended or full. */
  record(roomId: string, entry: NewTraceEntry): PracticeTraceEntry | null {
    const s = this.sessions.get(roomId);
    if (!s || s.endedAt !== null || s.entries.length >= PRACTICE_LIMITS.maxEntries) return null;
    const full: PracticeTraceEntry = { ...entry, id: s.entries.length + 1, at: this.now() };
    s.entries.push(full);
    return full;
  }

  /** Mark the game over; true only the first time (callers emit the trace once). */
  markEnded(roomId: string): boolean {
    const s = this.sessions.get(roomId);
    if (!s || s.endedAt !== null) return false;
    s.endedAt = this.now();
    s.lastActivityAt = s.endedAt;
    return true;
  }

  flagsLeft(roomId: string): number {
    const s = this.sessions.get(roomId);
    if (!s) return 0;
    return Math.max(0, PRACTICE_LIMITS.maxFlagsPerRoom - s.flaggedEntryIds.size);
  }

  /** Validate a 「這步怪怪的」 request without consuming the quota. */
  checkFlag(roomId: string, entryId: unknown, requesterId: string | undefined): FlagCheck {
    const s = this.sessions.get(roomId);
    if (!s) return { ok: false, error: '找不到這個練習房（可能已逾時清除）' };
    if (!requesterId || requesterId !== s.ownerId) return { ok: false, error: '只有練習房的玩家可以回報' };
    if (s.endedAt === null) return { ok: false, error: '對局結束後才能回報' };
    const id = typeof entryId === 'number' ? entryId : Number(entryId);
    const entry = Number.isInteger(id) ? s.entries.find((e) => e.id === id) : undefined;
    if (!entry) return { ok: false, error: '找不到這一步' };
    if (s.flaggedEntryIds.has(entry.id)) return { ok: false, error: '這一步已經回報過了' };
    if (s.flaggedEntryIds.size >= PRACTICE_LIMITS.maxFlagsPerRoom) {
      return { ok: false, error: `每局最多回報 ${PRACTICE_LIMITS.maxFlagsPerRoom} 步` };
    }
    if (this.now() - s.lastFlagAt < PRACTICE_LIMITS.minFlagIntervalMs) {
      return { ok: false, error: '回報太快了，請稍等一下再送' };
    }
    const t = this.now();
    this.flagStamps = this.flagStamps.filter((f) => t - f.at < DAY_MS);
    if (this.flagStamps.filter((f) => t - f.at < HOUR_MS).length >= PRACTICE_LIMITS.maxFlagsPerHour) {
      return { ok: false, error: '這一小時的回報已達上限，請稍後再送' };
    }
    if (this.flagStamps.filter((f) => f.ownerId === s.ownerId).length >= PRACTICE_LIMITS.maxFlagsPerUserPerDay) {
      return { ok: false, error: `每人每天最多回報 ${PRACTICE_LIMITS.maxFlagsPerUserPerDay} 步` };
    }
    return { ok: true, entry };
  }

  /** Reserve the flag slot (call before the async write; undo with `releaseFlag`). */
  commitFlag(roomId: string, entryId: number): void {
    const s = this.sessions.get(roomId);
    if (!s) return;
    s.flaggedEntryIds.add(entryId);
    s.lastFlagAt = this.now();
    s.lastActivityAt = s.lastFlagAt;
    this.flagStamps.push({ at: s.lastFlagAt, ownerId: s.ownerId, roomId, entryId });
  }

  /** Give the slot back when the write failed, so the player can retry. */
  releaseFlag(roomId: string, entryId: number): void {
    this.sessions.get(roomId)?.flaggedEntryIds.delete(entryId);
    this.flagStamps = this.flagStamps.filter((f) => !(f.roomId === roomId && f.entryId === entryId));
  }

  delete(roomId: string): void {
    this.sessions.delete(roomId);
  }

  /** Room ids whose TTL has passed (ended too long ago, or idle too long). */
  expired(): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.endedAt !== null) {
        if (t - s.endedAt > PRACTICE_LIMITS.endedTtlMs) out.push(s.roomId);
      } else if (t - s.lastActivityAt > PRACTICE_LIMITS.idleTtlMs) {
        out.push(s.roomId);
      }
    }
    return out;
  }

  size(): number {
    return this.sessions.size;
  }

  /** Every practice room id (sweep checks the room still exists). */
  roomIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Count of traced decisions of one kind (tests / smoke). */
  countKind(roomId: string, kind: PracticeDecisionKind): number {
    return this.sessions.get(roomId)?.entries.filter((e) => e.kind === kind).length ?? 0;
  }
}

/** Strip control characters and cap length; never logged. */
export function sanitizeFlagNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return cleaned.slice(0, PRACTICE_LIMITS.maxNoteChars);
}
