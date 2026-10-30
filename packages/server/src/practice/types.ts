/**
 * 網站「與機器人練習」（2026-10-13）— shared practice-mode types.
 *
 * A practice room is a private 10-seat room (the player + 9 bots) whose id
 * starts with `PRACTICE-`. It is never listed, cannot be joined or watched by
 * anyone else, and is never recorded (no game record, stats or archive).
 * Every bot decision is traced server-side and sent to the player only after
 * the game ends, so the post-game review can show why each bot did what it did.
 *
 * The web client keeps a structural copy of these types in
 * `packages/web/src/services/practice.ts`.
 */
import type { Role } from '@avalon/shared';

export const PRACTICE_ROOM_PREFIX = 'PRACTICE-';
export const PRACTICE_PLAYER_COUNT = 10;

export function isPracticeRoomId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(PRACTICE_ROOM_PREFIX);
}

/** Roles the player may pick (10-player canonical set). `null` = random. */
export const PRACTICE_ROLE_CHOICES = [
  'merlin',
  'percival',
  'loyal',
  'assassin',
  'morgana',
  'mordred',
  'oberon',
] as const satisfies readonly Role[];
export type PracticeRoleChoice = (typeof PRACTICE_ROLE_CHOICES)[number];

export interface PracticeOptions {
  /** 1-based seat (1..10); null = random. */
  seat: number | null;
  /** Forced role; null = random. */
  role: PracticeRoleChoice | null;
}

/** Tolerant parse of the client payload — anything unusable becomes "random". */
export function parsePracticeOptions(raw: unknown): PracticeOptions {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const seatNum = typeof obj.seat === 'number' ? obj.seat : typeof obj.seat === 'string' ? Number(obj.seat) : NaN;
  const seat = Number.isInteger(seatNum) && seatNum >= 1 && seatNum <= PRACTICE_PLAYER_COUNT ? seatNum : null;
  const role = typeof obj.role === 'string' && (PRACTICE_ROLE_CHOICES as readonly string[]).includes(obj.role)
    ? (obj.role as PracticeRoleChoice)
    : null;
  return { seat, role };
}

export type PracticeDecisionKind =
  | 'team_propose'
  | 'team_vote'
  | 'quest_card'
  | 'lake_target'
  | 'lake_declare'
  | 'assassinate';

export interface PracticeSuspect {
  seat: number;
  /** 0..1 for 紅方嫌疑 (good bots); unbounded score for 像梅林 (red bots). */
  score: number;
}

export interface PracticeTraceEntry {
  /** 1-based, in decision order. */
  id: number;
  /** Epoch ms when the bot decided. */
  at: number;
  round: number;
  /** Proposal number inside the round (1..5); for lake / assassination: the approved proposal. */
  attempt: number;
  kind: PracticeDecisionKind;
  botSeat: number;
  botRole: Role;
  botTeam: 'good' | 'evil';
  /** Short Chinese action summary, e.g.「派隊 1、4、0家」「贊成」「出失敗」. */
  action: string;
  detail: {
    team?: number[];
    vote?: boolean;
    card?: 'success' | 'fail';
    target?: number;
    claim?: 'good' | 'evil' | null;
    actual?: 'good' | 'evil';
  };
  /** One or two sentences built from what the bot saw. */
  reason: string;
  /** Which rule / decision path fired, when the agent exposes it. */
  rule?: string;
  /** What `suspects` ranks: 紅方嫌疑 (good bots) or 像梅林 (red bots). */
  suspectsLabel?: string;
  suspects?: PracticeSuspect[];
  /** Instead of an empty `suspects` list (「尚無區分（全員 0.50）」), or after it when ties decide the order. */
  suspectsNote?: string;
  /** Private knowledge used (梅林看到的紅方、派西看到的兩位、紅方隊友…). */
  knowledge?: string;
  /** 'agent' = the bot's own AI; 'fallback' = AI failed / missing, backup rule used. */
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

/** Sent to the practice owner only after the game ended. */
export interface PracticeTracePayload {
  roomId: string;
  ownerId: string;
  winner: 'good' | 'evil' | null;
  endReason?: string;
  seats: PracticeSeatInfo[];
  entries: PracticeTraceEntry[];
  /** Whether 「這步怪怪的」 reports can be saved on this server. */
  canFlag: boolean;
  /** Chinese explanation shown when `canFlag` is false. */
  flagUnavailableReason?: string;
  flagsLeft: number;
  flaggedEntryIds: number[];
}

export interface PracticeFlagResult {
  ok: boolean;
  error?: string;
  flagsLeft?: number;
}

export const ROLE_LABEL_ZH: Readonly<Record<string, string>> = Object.freeze({
  merlin: '梅林',
  percival: '派西維爾',
  loyal: '忠臣',
  assassin: '刺客',
  morgana: '莫甘娜',
  mordred: '莫德雷德',
  oberon: '奧伯倫',
  minion: '爪牙',
});

export const DECISION_KIND_LABEL_ZH: Readonly<Record<PracticeDecisionKind, string>> = Object.freeze({
  team_propose: '派隊',
  team_vote: '投票',
  quest_card: '任務牌',
  lake_target: '湖中目標',
  lake_declare: '湖中宣告',
  assassinate: '刺殺',
});

/** Paper-scoresheet seat label: seat 10 reads「0家」. */
export function seatLabelZh(seat: number): string {
  return `${seat === 10 ? '0' : String(seat)}家`;
}
