/**
 * 網站「與機器人練習」— client side of the practice-room socket API.
 *
 * Server: packages/server/src/socket/GameServer.ts (`practice:*` events) and
 * packages/server/src/practice/types.ts (the types below are a structural copy).
 */
import type { Role } from '@avalon/shared';
import { getSocket } from './socket';
import { useGameStore } from '../store/gameStore';
import { usePracticeStore } from '../store/practiceStore';

export const PRACTICE_ROOM_PREFIX = 'PRACTICE-';

export function isPracticeRoomId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(PRACTICE_ROOM_PREFIX);
}

export const PRACTICE_ROLE_CHOICES = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'] as const;
export type PracticeRoleChoice = (typeof PRACTICE_ROLE_CHOICES)[number];

export interface PracticeOptions {
  /** 1..10, null = random. */
  seat: number | null;
  role: PracticeRoleChoice | null;
}

export type PracticeDecisionKind =
  | 'team_propose'
  | 'team_vote'
  | 'quest_card'
  | 'lake_target'
  | 'lake_declare'
  | 'assassinate';

export interface PracticeTraceEntry {
  id: number;
  at: number;
  round: number;
  attempt: number;
  kind: PracticeDecisionKind;
  botSeat: number;
  botRole: Role;
  botTeam: 'good' | 'evil';
  action: string;
  detail: {
    team?: number[];
    vote?: boolean;
    card?: 'success' | 'fail';
    target?: number;
    claim?: 'good' | 'evil' | null;
    actual?: 'good' | 'evil';
  };
  reason: string;
  rule?: string;
  suspectsLabel?: string;
  suspects?: Array<{ seat: number; score: number }>;
  knowledge?: string;
  source: 'agent' | 'fallback';
}

export interface PracticeSeatInfo {
  seat: number;
  playerId: string;
  name: string;
  role: Role | null;
  team: 'good' | 'evil' | null;
  isBot: boolean;
}

export interface PracticeTracePayload {
  roomId: string;
  ownerId: string;
  winner: 'good' | 'evil' | null;
  endReason?: string;
  seats: PracticeSeatInfo[];
  entries: PracticeTraceEntry[];
  canFlag: boolean;
  flagUnavailableReason?: string;
  flagsLeft: number;
  flaggedEntryIds: number[];
}

export interface PracticeFlagResult {
  ok: boolean;
  error?: string;
  flagsLeft?: number;
}

const ACK_TIMEOUT_MS = 10_000;

function emitWithAck<T>(event: string, ...args: unknown[]): Promise<T> {
  const socket = getSocket();
  return new Promise<T>((resolve, reject) => {
    socket.timeout(ACK_TIMEOUT_MS).emit(event, ...args, (err: Error | null, res: T) => {
      if (err) reject(new Error('伺服器沒有回應，請稍後再試'));
      else resolve(res);
    });
  });
}

/** Create + start a practice room (the player + 9 bots). Resolves with the room id. */
export async function createPracticeRoom(options: PracticeOptions): Promise<string> {
  const res = await emitWithAck<{ ok: boolean; roomId?: string; error?: string }>('practice:create', options);
  if (!res?.ok || !res.roomId) throw new Error(res?.error || '無法建立練習房');
  return res.roomId;
}

/** Pull the trace after the game ended (e.g. the push was missed). */
export async function fetchPracticeTrace(roomId: string): Promise<PracticeTracePayload> {
  const res = await emitWithAck<{ ok: boolean; payload?: PracticeTracePayload; error?: string }>('practice:get-trace', roomId);
  if (!res?.ok || !res.payload) throw new Error(res?.error || '讀取決策紀錄失敗');
  return res.payload;
}

/** 「這步怪怪的」 — server appends it to the private report sheet. */
export async function flagPracticeDecision(roomId: string, entryId: number, note: string): Promise<PracticeFlagResult> {
  return emitWithAck<PracticeFlagResult>('practice:flag', { roomId, entryId, note });
}

/**
 * Start a practice game with `options` (setup card and 「再練一局」). Shows
 * RoomPage's "連線中…" state until the started room arrives; on failure goes
 * back home with a toast built by `errorText`.
 */
export async function startPractice(options: PracticeOptions, errorText: (error: string) => string): Promise<boolean> {
  const { setGameState, setRoom, addToast } = useGameStore.getState();
  usePracticeStore.getState().setLastOptions(options);
  try {
    // Drop a previous (ended) practice room so the spinner shows, not its review.
    setRoom(null);
    setGameState('lobby');
    await createPracticeRoom(options);
    // Leaving the room later should land on the normal home page, not the setup card.
    if (window.location.hash === '#practice') {
      try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); } catch { /* ignore */ }
    }
    return true;
  } catch (err) {
    setGameState('home');
    addToast(errorText(err instanceof Error ? err.message : String(err)), 'error');
    return false;
  }
}
