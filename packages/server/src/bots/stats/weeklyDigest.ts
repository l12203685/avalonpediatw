/**
 * Weekly stats digest — every Monday 12:00 +08 the leaderboard is posted to
 * the Discord mirror channel and queued for the LINE mirror group (through
 * the ChatMirror reply_token queue: free, goes out when someone next speaks).
 *
 * No database. Double posts are avoided by
 *   1. a narrow posting window: Monday 12:00 ≤ t < 12:10 (+08), and
 *   2. an in-memory "last posted week" per destination.
 * A restart outside the window can therefore never repost; within the
 * window a destination that failed (e.g. Discord gateway not ready yet) is
 * retried on the next tick until the window closes.
 *
 * Time math is done on epoch milliseconds + a fixed +08 offset and read back
 * with getUTC*(), so the result never depends on the host TZ (Render runs UTC).
 */

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export const DIGEST_WEEKDAY = 1; // Monday
export const DIGEST_HOUR = 12;
export const DIGEST_WINDOW_MINUTES = 10;
export const DIGEST_TICK_MS = 60_000;

export interface TaipeiClock {
  /** 0 = Sunday … 6 = Saturday, in +08. */
  weekday: number;
  hour: number;
  minute: number;
  /** YYYY-MM-DD in +08. */
  date: string;
}

export function taipeiClock(epochMs: number): TaipeiClock {
  const d = new Date(epochMs + TAIPEI_OFFSET_MS);
  return {
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    date: d.toISOString().slice(0, 10),
  };
}

/** True only on Monday 12:00:00–12:09:59 +08. */
export function isDigestWindow(epochMs: number): boolean {
  const t = taipeiClock(epochMs);
  return t.weekday === DIGEST_WEEKDAY && t.hour === DIGEST_HOUR && t.minute < DIGEST_WINDOW_MINUTES;
}

/** Identifies the week: the +08 date of that week's Monday (YYYY-MM-DD). */
export function digestWeekKey(epochMs: number): string {
  const t = taipeiClock(epochMs);
  const daysSinceMonday = (t.weekday + 6) % 7;
  return taipeiClock(epochMs - daysSinceMonday * 24 * 60 * 60 * 1000).date;
}

/** "10/12" for the digest title. */
export function digestDateLabel(epochMs: number): string {
  const [, mm, dd] = taipeiClock(epochMs).date.split('-');
  return `${Number(mm)}/${Number(dd)}`;
}

export interface DigestDestination {
  name: string;
  /**
   * Deliver the text. Resolve `false` when the destination is not available
   * right now (retry next tick); resolve `true`/void when delivered; resolve
   * `'skip'` when it is not configured (counts as done for this week).
   */
  send(text: string): Promise<boolean | 'skip' | void>;
}

export type DigestTickResult = 'disabled' | 'outside-window' | 'already-posted' | 'busy' | 'posted' | 'partial' | 'failed';

export interface WeeklyDigestOptions {
  buildText: (now: number) => Promise<string>;
  destinations: DigestDestination[];
  enabled?: boolean;
  logger?: { info: (m: string) => void; warn: (m: string, err?: unknown) => void };
}

export class WeeklyDigestScheduler {
  private readonly lastPostedWeek = new Map<string, string>();
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: NonNullable<WeeklyDigestOptions['logger']>;

  constructor(private readonly opts: WeeklyDigestOptions) {
    this.logger = opts.logger ?? {
      info: (m): void => console.log(`[stats-digest] ${m}`),
      warn: (m, err): void => console.warn(`[stats-digest] ${m}`, err ?? ''),
    };
  }

  async tick(now: number = Date.now()): Promise<DigestTickResult> {
    if (this.opts.enabled === false) return 'disabled';
    if (!isDigestWindow(now)) return 'outside-window';
    const week = digestWeekKey(now);
    const pending = this.opts.destinations.filter((d) => this.lastPostedWeek.get(d.name) !== week);
    if (pending.length === 0) return 'already-posted';
    if (this.inFlight) return 'busy';

    this.inFlight = true;
    try {
      let text: string;
      try {
        text = await this.opts.buildText(now);
      } catch (err) {
        this.logger.warn('building digest text failed', err);
        return 'failed';
      }
      let done = 0;
      for (const dest of pending) {
        try {
          const result = await dest.send(text);
          if (result === false) {
            this.logger.warn(`${dest.name} not available, will retry within the window`);
            continue;
          }
          this.lastPostedWeek.set(dest.name, week);
          done += 1;
          this.logger.info(result === 'skip' ? `${dest.name} not configured — skipped (${week})` : `posted to ${dest.name} (${week})`);
        } catch (err) {
          this.logger.warn(`posting to ${dest.name} failed`, err);
        }
      }
      if (done === pending.length) return 'posted';
      return done > 0 ? 'partial' : 'failed';
    } finally {
      this.inFlight = false;
    }
  }

  /** For /api/bots/status: destination → last +08 Monday it was posted for. */
  getState(): { running: boolean; lastPostedWeek: Record<string, string> } {
    return { running: this.timer !== null, lastPostedWeek: Object.fromEntries(this.lastPostedWeek) };
  }

  /** Tick now and then every `intervalMs` (default 1 min). Idempotent. */
  start(intervalMs: number = DIGEST_TICK_MS): void {
    if (this.timer || this.opts.enabled === false) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
