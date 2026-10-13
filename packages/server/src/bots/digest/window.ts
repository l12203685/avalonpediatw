/**
 * Time math for the weekly community digest. Same approach as
 * bots/stats/weeklyDigest.ts: epoch ms + a fixed +08 offset read back with
 * getUTC*(), so nothing depends on the host TZ (Render runs UTC).
 */

import { taipeiClock } from '../stats/weeklyDigest';
import { DIGEST_RUN_HOUR, DIGEST_RUN_WEEKDAY, DIGEST_RUN_WINDOW_MINUTES } from './config';

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

export interface DigestWindow {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end, epoch ms. */
  end: number;
  /** +08 date (YYYY-MM-DD) of the Monday of the week the window starts in. */
  weekKey: string;
  /** /社群週報 run (last 7 days up to now) rather than the Monday schedule. */
  manual: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 00:00 +08 of the day containing `epochMs`. */
export function taipeiMidnight(epochMs: number): number {
  return Math.floor((epochMs + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS;
}

/** Monday 00:00 +08 of the week containing `epochMs`. */
export function taipeiMondayStart(epochMs: number): number {
  const daysSinceMonday = (taipeiClock(epochMs).weekday + 6) % 7;
  return taipeiMidnight(epochMs) - daysSinceMonday * DAY_MS;
}

/** True on Monday 09:00:00–11:59:59 +08 (DIGEST_RUN_HOUR + DIGEST_RUN_WINDOW_MINUTES). */
export function isCommunityDigestRunWindow(epochMs: number): boolean {
  const t = taipeiClock(epochMs);
  const minutesSinceStart = (t.hour - DIGEST_RUN_HOUR) * 60 + t.minute;
  return t.weekday === DIGEST_RUN_WEEKDAY && minutesSinceStart >= 0 && minutesSinceStart < DIGEST_RUN_WINDOW_MINUTES;
}

/** The previous full week: last Monday 00:00 → this Monday 00:00 (+08). */
export function scheduledWindow(now: number): DigestWindow {
  const end = taipeiMondayStart(now);
  const start = end - WEEK_MS;
  return { start, end, weekKey: taipeiClock(start).date, manual: false };
}

/** The last 7 days up to `now` (manual trigger). */
export function manualWindow(now: number): DigestWindow {
  const start = now - WEEK_MS;
  return { start, end: now, weekKey: taipeiClock(taipeiMondayStart(start)).date, manual: true };
}

/** "10/05 21:33" in +08. */
export function stampMMDDHHmm(epochMs: number): string {
  const d = new Date(epochMs + TAIPEI_OFFSET_MS);
  return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function hhmm(epochMs: number): string {
  const d = new Date(epochMs + TAIPEI_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Last day covered (+08), as YYYY-MM-DD: the end is exclusive. */
function lastDay(w: DigestWindow): string {
  return taipeiClock(w.manual ? w.end : w.end - 1).date;
}

/**
 * First line of the Discord post and the thing searched for after a restart:
 *   scheduled  "🤖 社群週報 2026-10-05～10-11"
 *   manual     "🤖 社群週報 2026-10-06～10-13（手動，最近 7 天）"
 */
export function digestMarker(w: DigestWindow): string {
  const first = taipeiClock(w.start).date;
  const last = lastDay(w).slice(5);
  return `🤖 社群週報 ${first}～${last}${w.manual ? '（手動，最近 7 天）' : ''}`;
}

/** "2026-10-05 00:00～2026-10-11 24:00" (scheduled) or "2026-10-06 14:05～2026-10-13 14:05（手動）". */
export function formatPeriod(w: DigestWindow): string {
  const first = `${taipeiClock(w.start).date} ${hhmm(w.start)}`;
  if (w.manual) return `${first}～${taipeiClock(w.end).date} ${hhmm(w.end)}（手動）`;
  return `${first}～${lastDay(w)} 24:00`;
}
