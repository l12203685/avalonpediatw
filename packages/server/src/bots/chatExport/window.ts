/**
 * Time math for the weekly chat-log export: epoch ms + a fixed +08 offset
 * read back with getUTC*(), so nothing depends on the host TZ (Render runs
 * UTC). Self-contained on purpose (no import from bots/stats).
 */

import { CHAT_EXPORT_RUN_HOUR, CHAT_EXPORT_RUN_WEEKDAY, CHAT_EXPORT_RUN_WINDOW_MINUTES } from './config';

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

export interface ExportWindow {
  /** Inclusive start, epoch ms (Monday 00:00 +08). */
  start: number;
  /** Exclusive end, epoch ms (the next Monday 00:00 +08). */
  end: number;
  /** +08 date (YYYY-MM-DD) of the Monday the window starts on — the 週次 column. */
  weekKey: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

interface TaipeiParts {
  date: string;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

export function taipeiParts(epochMs: number): TaipeiParts {
  const d = new Date(epochMs + TAIPEI_OFFSET_MS);
  return {
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

/** "2026-10-05 21:33" in +08. */
export function taipeiStamp(epochMs: number): string {
  const t = taipeiParts(epochMs);
  return `${t.date} ${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** 00:00 +08 of the day containing `epochMs`. */
export function taipeiMidnight(epochMs: number): number {
  return Math.floor((epochMs + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS;
}

/** Monday 00:00 +08 of the week containing `epochMs`. */
export function taipeiMondayStart(epochMs: number): number {
  const daysSinceMonday = (taipeiParts(epochMs).weekday + 6) % 7;
  return taipeiMidnight(epochMs) - daysSinceMonday * DAY_MS;
}

/** True on Monday 09:00:00–11:59:59 +08 (CHAT_EXPORT_RUN_HOUR + CHAT_EXPORT_RUN_WINDOW_MINUTES). */
export function isChatExportRunWindow(epochMs: number): boolean {
  const t = taipeiParts(epochMs);
  const minutesSinceStart = (t.hour - CHAT_EXPORT_RUN_HOUR) * 60 + t.minute;
  return t.weekday === CHAT_EXPORT_RUN_WEEKDAY && minutesSinceStart >= 0 && minutesSinceStart < CHAT_EXPORT_RUN_WINDOW_MINUTES;
}

/** The previous full week: last Monday 00:00 → this Monday 00:00 (+08). */
export function scheduledWindow(now: number): ExportWindow {
  const end = taipeiMondayStart(now);
  const start = end - WEEK_MS;
  return { start, end, weekKey: taipeiParts(start).date };
}

/**
 * The oldest week key kept when `weekKey` is the newest and `weeks` weeks
 * are retained (weekKey itself included): weekKey − (weeks − 1) × 7 days.
 */
export function oldestKeptWeek(weekKey: string, weeks: number): string {
  const monday = Date.parse(`${weekKey}T00:00:00+08:00`);
  return taipeiParts(monday - (Math.max(1, weeks) - 1) * WEEK_MS).date;
}

/** A 週次 cell: "YYYY-MM-DD". */
export function isWeekKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
