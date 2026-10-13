/**
 * 網站「與機器人練習」— client state: the post-game trace per practice room,
 * which decisions were flagged, and the last setup (for 「再練一局」).
 */
import { create } from 'zustand';
import type { PracticeOptions, PracticeTracePayload } from '../services/practice';

const LAST_OPTIONS_KEY = 'avalon_practice_options';
// Local copy (no value import from services/practice: socket.ts imports this store).
const ROLE_CHOICES: readonly string[] = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];

function readLastOptions(): PracticeOptions {
  try {
    const raw = localStorage.getItem(LAST_OPTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PracticeOptions>;
      const seat = typeof parsed.seat === 'number' && parsed.seat >= 1 && parsed.seat <= 10 ? parsed.seat : null;
      const role = typeof parsed.role === 'string' && ROLE_CHOICES.includes(parsed.role) ? parsed.role : null;
      return { seat, role } as PracticeOptions;
    }
  } catch {
    // storage unavailable / bad JSON → defaults
  }
  return { seat: null, role: null };
}

interface PracticeStore {
  traces: Record<string, PracticeTracePayload>;
  /** `${roomId}:${entryId}` of decisions this player flagged. */
  flagged: Record<string, true>;
  lastOptions: PracticeOptions;
  setTrace: (payload: PracticeTracePayload) => void;
  markFlagged: (roomId: string, entryId: number, flagsLeft?: number) => void;
  setLastOptions: (options: PracticeOptions) => void;
}

export const usePracticeStore = create<PracticeStore>((set) => ({
  traces: {},
  flagged: {},
  lastOptions: readLastOptions(),
  setTrace: (payload): void =>
    set((s) => {
      const flagged = { ...s.flagged };
      for (const id of payload.flaggedEntryIds ?? []) flagged[`${payload.roomId}:${id}`] = true;
      // Keep only the latest few games in memory.
      const keep = Object.entries(s.traces).slice(-4);
      return { traces: { ...Object.fromEntries(keep), [payload.roomId]: payload }, flagged };
    }),
  markFlagged: (roomId, entryId, flagsLeft): void =>
    set((s) => {
      const trace = s.traces[roomId];
      return {
        flagged: { ...s.flagged, [`${roomId}:${entryId}`]: true },
        traces: trace && typeof flagsLeft === 'number'
          ? { ...s.traces, [roomId]: { ...trace, flagsLeft } }
          : s.traces,
      };
    }),
  setLastOptions: (options): void => {
    try {
      localStorage.setItem(LAST_OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // storage unavailable — in-memory only
    }
    set({ lastOptions: options });
  },
}));
