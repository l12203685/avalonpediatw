/**
 * Time math for the daily chat-log export: epoch ms + a fixed +08 offset
 * read back with getUTC*(), so nothing depends on the host TZ (Render runs
 * UTC). Taiwan has no daylight saving time, so every +08 day is 24 hours.
 * Self-contained on purpose (no import from bots/stats).
 */

import { CHAT_EXPORT_RETAIN_DAYS, CHAT_EXPORT_RUN_HOUR, CHAT_EXPORT_RUN_MINUTE } from './config';

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExportWindow {
  /** Inclusive start, epoch ms (00:00 +08 of the day). */
  start: number;
  /** Exclusive end, epoch ms (00:00 +08 of the next day). */
  end: number;
  /** +08 date (YYYY-MM-DD) of the day — the 日期 column and the export-log key. */
  dayKey: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

interface TaipeiParts {
  date: string;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

export function taipeiParts(epochMs: number): TaipeiParts {
  const d = new Date(epochMs + TAIPEI_OFFSET_MS);
  return {
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** "2026-10-05 21:33" in +08. */
export function taipeiStamp(epochMs: number): string {
  const t = taipeiParts(epochMs);
  return `${t.date} ${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** "2026-10-19T09:01:23+08:00" — readable in the sheet and parseable back with Date.parse (export log). */
export function taipeiIso(epochMs: number): string {
  const t = taipeiParts(epochMs);
  return `${t.date}T${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}+08:00`;
}

/** 00:00 +08 of the day containing `epochMs`. */
export function taipeiMidnight(epochMs: number): number {
  return Math.floor((epochMs + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS;
}

/** A 日期 cell: "YYYY-MM-DD". */
export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The day `dayKey` (+08): 00:00 → 24:00. */
export function dayWindow(dayKey: string): ExportWindow {
  const start = Date.parse(`${dayKey}T00:00:00+08:00`);
  return { start, end: start + DAY_MS, dayKey };
}

/** The previous calendar day (+08) — the day the 04:30 run exports. */
export function previousDay(now: number): ExportWindow {
  const end = taipeiMidnight(now);
  return { start: end - DAY_MS, end, dayKey: taipeiParts(end - DAY_MS).date };
}

/**
 * The last `days` complete days (+08) before the day containing `now`,
 * oldest first: yesterday is the last one.
 */
export function lastCompleteDays(now: number, days: number = CHAT_EXPORT_RETAIN_DAYS): string[] {
  const today = taipeiMidnight(now);
  const out: string[] = [];
  for (let k = Math.max(1, days); k >= 1; k -= 1) out.push(taipeiParts(today - k * DAY_MS).date);
  return out;
}

/** The oldest day kept in the sheet at `now`: today − CHAT_EXPORT_RETAIN_DAYS (+08). */
export function oldestKeptDay(now: number, days: number = CHAT_EXPORT_RETAIN_DAYS): string {
  return lastCompleteDays(now, days)[0];
}

/** True from 04:30:00 to 23:59:59 +08 (CHAT_EXPORT_RUN_HOUR:CHAT_EXPORT_RUN_MINUTE until the end of the day). */
export function isChatExportRunTime(epochMs: number): boolean {
  const t = taipeiParts(epochMs);
  return t.hour * 60 + t.minute >= CHAT_EXPORT_RUN_HOUR * 60 + CHAT_EXPORT_RUN_MINUTE;
}
