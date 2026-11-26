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
  /** Instead of an empty `suspects` list, or after it when ties decide the order. */
  suspectsNote?: string;
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
  /** 局後的整局回饋：enabled＝會問也存得下來；done＝局後那一題已回答或略過；wholeGameLeft＝「整局回饋」還能送幾則。 */
  exploitAsk?: { enabled: boolean; done: boolean; wholeGameLeft?: number };
}

/** 局後那一題的選項（伺服器 practice/PracticeExploitReport.ts 有同樣一份）。 */
export const PRACTICE_EXPLOIT_CHOICES = [
  'red_bot_play',
  'blue_bot_play',
  'merlin_obvious',
  'assassin_fooled',
  'team_fixed',
  'vote_fixed',
  'lake',
  'none',
] as const;
export type PracticeExploitChoice = (typeof PRACTICE_EXPLOIT_CHOICES)[number];
export const PRACTICE_EXPLOIT_TEXT_MAX = 500;

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

/** 局後那一題：題目顯示了（伺服器只算一次）。失敗不用管。 */
export function notePracticeExploitShown(roomId: string): void {
  try {
    emitWithAck<PracticeFlagResult>('practice:exploit-ask', { roomId, action: 'shown' }).catch(() => undefined);
  } catch {
    // not connected — only a counter, nothing to retry
  }
}

/** 局後那一題：略過（這局被伺服器標記的話照樣記一列）。 */
export async function skipPracticeExploitAsk(roomId: string): Promise<PracticeFlagResult> {
  return emitWithAck<PracticeFlagResult>('practice:exploit-ask', { roomId, action: 'skip' });
}

export type PracticeExploitSource = 'end-card' | 'whole-game';

export interface PracticeExploitAskResult {
  ok: boolean;
  error?: string;
  /** 有的話：一個開放的追問（伺服器用簡單規則挑），答案寫在同一列。 */
  followUp?: { code: string; question: string };
}

/** 整局回饋：送出描述（主要）＋選填標籤。`source`：局後那一題，或回顧裡的「整局回饋（不限某一步）」。 */
export async function answerPracticeExploitAsk(
  roomId: string,
  choices: readonly PracticeExploitChoice[],
  text: string,
  source: PracticeExploitSource = 'end-card',
): Promise<PracticeExploitAskResult> {
  return emitWithAck<PracticeExploitAskResult>('practice:exploit-ask', { roomId, action: 'answer', choices, text, source });
}

/** 追問的回答（空字串＝略過）。 */
export async function answerPracticeFollowUp(roomId: string, text: string): Promise<PracticeExploitAskResult> {
  return emitWithAck<PracticeExploitAskResult>('practice:exploit-ask', { roomId, action: 'follow-up', text });
}

/**
 * Start a practice game with `options` (setup card and 「再練一局」). Shows
 * RoomPage's "連線中…" state until the started room arrives; on failure goes
 * back to the practice setup page with a toast built by `errorText`.
 */
export async function startPractice(options: PracticeOptions, errorText: (error: string) => string): Promise<boolean> {
  const { setGameState, setRoom, addToast } = useGameStore.getState();
  usePracticeStore.getState().setLastOptions(options);
  try {
    // Drop a previous (ended) practice room so the spinner shows, not its review.
    setRoom(null);
    setGameState('lobby');
    await createPracticeRoom(options);
    // The #practice deep link has done its job (App normally consumes it already).
    if (window.location.hash === '#practice') {
      try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); } catch { /* ignore */ }
    }
    return true;
  } catch (err) {
    setGameState('practice');
    addToast(errorText(err instanceof Error ? err.message : String(err)), 'error');
    return false;
  }
}
