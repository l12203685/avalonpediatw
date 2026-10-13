/**
 * Daily chat-log export — schedule, catch-up, idempotency, status.
 *
 *   Discord history of one day (collector) → rows (pseudonymized, rows.ts)
 *     → tab 「聊天紀錄」 of the Google Sheet (sheetWriter.ts)
 *
 * Free: Discord REST + Google Sheets API, no LLM, no paid API. The AI
 * manager reads the sheet through Google Drive. Logs and the status endpoint
 * carry counts, dates and outcome codes only — never text, names or channel
 * names.
 *
 * Which days, when (+08):
 *   - catch-up: as soon as Discord is ready after a (re)start — any time of
 *     day — every one of the last 7 complete days without a 「完成」 row,
 *     oldest first (so right after a deploy the sheet holds the last 7 days);
 *   - daily: from 04:30 the previous calendar day 00:00 → 24:00 (the newest
 *     of the 7), retried every 10 minutes until it is written; a day that
 *     failed stays in the 7-day window and keeps being retried.
 *
 * One complete copy per day, durable across restarts and instances (a
 * deploy overlaps the old and the new server for a while), kept in the tab
 * 「匯出紀錄」:
 *   - a day is exported only when it has a 「完成」 row (written after the
 *     last batch);
 *   - before reading Discord, and again before writing, an instance takes
 *     the day with a 「進行中」 row and reads the log back: the first fresh
 *     (< 30 min) 進行中 row holds the day; any other instance waits;
 *   - the holder deletes the day's rows in 聊天紀錄 before appending (rows
 *     without a 完成 row are a write that was cut off — killed process,
 *     Sheets error), then appends, then writes 完成.
 * After each pass, days older than the last 7 complete days are deleted from
 * both tabs.
 */

import crypto from 'crypto';
import { SheetError } from '../digest/sheets';
import { describeError } from '../feedback/service';
import {
  CHAT_EXPORT_CLAIM_RENEW_MS,
  CHAT_EXPORT_CLAIM_STALE_MS,
  CHAT_EXPORT_READ_ATTEMPTS,
  CHAT_EXPORT_RETRY_DELAY_MS,
  CHAT_EXPORT_STATE_CLAIM,
  CHAT_EXPORT_STATE_DONE,
  defaultChatExportLogger,
  readChatExportConfig,
  type ChatExportConfig,
  type ChatExportLogger,
} from './config';
import type { CollectResult } from './collector';
import type { ChatExportDiscordPort } from './discordPort';
import { buildExportRows } from './rows';
import {
  ChatTabConflictError,
  defaultChatSheetFactory,
  type ChatExportSheetPort,
  type ChatSheetFactory,
  type ExportLogEntry,
} from './sheetWriter';
import { dayWindow, isChatExportRunTime, lastCompleteDays, oldestKeptDay, taipeiParts, type ExportWindow } from './window';

export type ChatExportOutcome =
  /** The day's rows were appended (and its 完成 row written). */
  | 'written'
  /** No conversation message that day (nothing appended; 完成 with 0 rows). */
  | 'empty'
  /** The day already has a 完成 row (e.g. after a restart, or another instance wrote it). */
  | 'already-exported'
  /** Another server instance holds the day (deploy overlap); looked at again in 10 minutes. */
  | 'claimed-elsewhere'
  /** No sheet id (or the public stats sheet id without the opt-in, refused) or no usable service-account JSON. */
  | 'not-configured'
  /** A Google Sheets call failed (retried every 10 minutes). */
  | 'sheet-error'
  /** A tab named 聊天紀錄 / 匯出紀錄 exists with another header: not ours, never touched (retried every 10 minutes). */
  | 'tab-conflict'
  /**
   * Channels could not be read: some → read again once, then what was read
   * is exported; none at all → read again every 10 minutes, never recorded
   * as an empty day.
   */
  | 'read-error'
  | 'error';

/** /api/bots/status → chatExport.lastRun: the last day handled. Counts, dates and codes only. */
export interface ChatExportLastRun {
  /** The day (+08, YYYY-MM-DD). */
  day: string;
  /** ISO time of the run. */
  at: string;
  /** Rows (messages) exported. */
  messages: number;
  /** Channels (forum threads included) with at least one exported message. */
  channels: number;
  /** Forum threads with at least one exported message. */
  threads: number;
  /** Cuts while reading (page caps, thread cap, archived-thread listing cap): > 0 → the day may be incomplete. */
  truncated: number;
  outcome: ChatExportOutcome;
}

/** /api/bots/status → chatExport.catchUp: the catch-up after this start, by the latest outcome of each day. */
export interface ChatExportCatchUp {
  /** ISO time the catch-up started (Discord ready and the sheet configured). */
  startedAt: string;
  /** Oldest and newest day it covers (the last 7 complete days then). */
  from: string;
  to: string;
  /** Days written by this server (rows or an empty day). */
  exported: number;
  /** Days that already had 完成, or that another instance was writing. */
  skipped: number;
  /** Days whose latest attempt failed (retried every 10 minutes). */
  failed: number;
  /** Days not attempted yet. */
  pending: number;
}

export interface ChatExportStatus {
  enabled: boolean;
  sheetConfigured: boolean;
  /** Writing to the link-public 阿瓦隆百科 workbook (CHAT_EXPORT_ALLOW_PUBLIC_SHEET=1). */
  publicSheet: boolean;
  lastRun: ChatExportLastRun | null;
  catchUp: ChatExportCatchUp | null;
}

export type ChatExportTickState =
  | 'disabled'
  | 'busy'
  /** Nothing due (every day of the window settled, or the next day waits for 04:30). */
  | 'idle'
  /** Days are due but every one waits for its retry time. */
  | 'waiting'
  | 'discord-not-ready'
  | 'not-configured'
  /** At least one day was handled; see `days`. */
  | 'ran';

export interface ChatExportTickReport {
  state: ChatExportTickState;
  /** Days handled in this tick, oldest first. */
  days: Array<{ day: string; outcome: ChatExportOutcome }>;
}

export interface ChatExportServiceOptions {
  discord: ChatExportDiscordPort;
  sheetFactory?: ChatSheetFactory;
  config?: () => ChatExportConfig;
  now?: () => number;
  logger?: ChatExportLogger;
  /** 執行代號 written to 「匯出紀錄」; random per process by default. */
  runId?: string;
}

function sheetErrorText(err: unknown): string {
  if (err instanceof SheetError) return err.message;
  if (err instanceof ChatTabConflictError) return err.message;
  return describeError(err);
}

function isDone(e: ExportLogEntry): boolean {
  return e.state === CHAT_EXPORT_STATE_DONE;
}

function isClaim(e: ExportLogEntry): boolean {
  return e.state === CHAT_EXPORT_STATE_CLAIM;
}

/**
 * The instance holding `day`: the run id of its first 進行中 row (sheet
 * order) that is less than CHAT_EXPORT_CLAIM_STALE_MS old; null when none.
 * Every instance reads the same order, so two that claim at the same moment
 * agree on one holder.
 */
export function claimHolder(log: ExportLogEntry[], day: string, now: number): string | null {
  for (const e of log) {
    if (e.day === day && isClaim(e) && Number.isFinite(e.at) && now - e.at < CHAT_EXPORT_CLAIM_STALE_MS) return e.runId;
  }
  return null;
}

type ClaimResult = 'mine' | 'other' | 'done';

/** Outcomes that settle a day in this process (never looked at again). */
const SETTLED: ReadonlySet<ChatExportOutcome> = new Set(['written', 'empty', 'already-exported']);
/** One day's result; stopPass when the sheet or Discord as a whole is failing (the other days would fail too). */
type DayResult = { outcome: ChatExportOutcome; stopPass: boolean };

interface CatchUpState {
  startedAt: number;
  days: string[];
  outcomes: Map<string, ChatExportOutcome>;
}

export class ChatExportService {
  private readonly discord: ChatExportDiscordPort;
  private readonly sheetFactory: ChatSheetFactory;
  private readonly config: () => ChatExportConfig;
  private readonly now: () => number;
  private readonly logger: ChatExportLogger;
  readonly runId: string;

  /** Days settled in this process (exported, empty, or already there). */
  private readonly settled = new Set<string>();
  /** Days attempted in this process (eligible for retries at any time of day). */
  private readonly attempted = new Set<string>();
  private readonly readAttempts = new Map<string, number>();
  /** Per day: no attempt before this time (claimed elsewhere, partial read, unexpected error). */
  private readonly retryAt = new Map<string, number>();
  /** The whole pass waits until this time (Sheets failing, tab conflict, Discord unreadable). */
  private passRetryAt = 0;
  private catchUp: CatchUpState | null = null;
  private notConfiguredLoggedOn = '';
  private inFlight = false;
  private lastRun: ChatExportLastRun | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ChatExportServiceOptions) {
    this.discord = opts.discord;
    this.sheetFactory = opts.sheetFactory ?? defaultChatSheetFactory;
    this.config = opts.config ?? ((): ChatExportConfig => readChatExportConfig());
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? defaultChatExportLogger;
    this.runId = opts.runId ?? crypto.randomBytes(4).toString('hex');
  }

  getStatus(): ChatExportStatus {
    const cfg = this.config();
    return {
      enabled: cfg.enabled,
      sheetConfigured: !!cfg.sheetId && cfg.sheetCredentialsUsable,
      publicSheet: cfg.publicSheet,
      lastRun: this.lastRun ? { ...this.lastRun } : null,
      catchUp: this.catchUpStatus(),
    };
  }

  private catchUpStatus(): ChatExportCatchUp | null {
    const c = this.catchUp;
    if (!c) return null;
    const out: ChatExportCatchUp = {
      startedAt: new Date(c.startedAt).toISOString(),
      from: c.days[0],
      to: c.days[c.days.length - 1],
      exported: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
    };
    for (const day of c.days) {
      const o = c.outcomes.get(day);
      if (o === undefined) out.pending += 1;
      else if (o === 'written' || o === 'empty') out.exported += 1;
      else if (o === 'already-exported' || o === 'claimed-elsewhere') out.skipped += 1;
      else out.failed += 1;
    }
    return out;
  }

  private record(day: string, outcome: ChatExportOutcome, counts: Partial<Omit<ChatExportLastRun, 'day' | 'at' | 'outcome'>> = {}): void {
    this.lastRun = {
      day,
      at: new Date(this.now()).toISOString(),
      messages: counts.messages ?? 0,
      channels: counts.channels ?? 0,
      threads: counts.threads ?? 0,
      truncated: counts.truncated ?? 0,
      outcome,
    };
    this.attempted.add(day);
    if (SETTLED.has(outcome)) this.settled.add(day);
    if (this.catchUp?.days.includes(day)) this.catchUp.outcomes.set(day, outcome);
  }

  /** Measured from when the attempt returned (reading a busy day can take a while). */
  private later(now: number): number {
    return Math.max(now, this.now()) + CHAT_EXPORT_RETRY_DELAY_MS;
  }

  /**
   * Days to handle now, oldest first: the last 7 complete days that are not
   * settled and not waiting for a retry, and — once the catch-up has
   * started — that belong to the catch-up, were attempted before, or it is
   * past 04:30 (a day that just became complete waits for 04:30).
   */
  private dueDays(now: number): { due: string[]; waiting: number } {
    const runTime = isChatExportRunTime(now);
    const open = lastCompleteDays(now).filter((d) => !this.settled.has(d));
    const eligible = open.filter((d) => this.catchUp === null || this.catchUp.days.includes(d) || this.attempted.has(d) || runTime);
    if (eligible.length > 0 && now < this.passRetryAt) return { due: [], waiting: eligible.length };
    const due = eligible.filter((d) => !((this.retryAt.get(d) ?? 0) > now));
    return { due, waiting: eligible.length - due.length };
  }

  /**
   * Take (or keep) the day: 'done' when it has a 完成 row, 'other' when
   * another instance holds it, 'mine' when this one does. A claim of this
   * instance older than CHAT_EXPORT_CLAIM_RENEW_MS is renewed (new 進行中
   * row), so a live claim never goes stale between two attempts.
   */
  private async ensureClaim(sheet: ChatExportSheetPort, day: string, now: number): Promise<ClaimResult> {
    let log = await sheet.readLog();
    if (log.some((e) => e.day === day && isDone(e))) return 'done';
    const holder = claimHolder(log, day, now);
    if (holder !== null && holder !== this.runId) return 'other';
    const newestOwn = Math.max(
      -Infinity,
      ...log.filter((e) => e.day === day && isClaim(e) && e.runId === this.runId && Number.isFinite(e.at)).map((e) => e.at),
    );
    if (holder === this.runId && now - newestOwn < CHAT_EXPORT_CLAIM_RENEW_MS) return 'mine';
    await sheet.appendLog({ day, state: CHAT_EXPORT_STATE_CLAIM, rows: 0, channels: 0, at: now, runId: this.runId });
    log = await sheet.readLog();
    if (log.some((e) => e.day === day && isDone(e))) return 'done';
    return claimHolder(log, day, now) === this.runId ? 'mine' : 'other';
  }

  /** Delete days older than the last 7 complete days (both tabs). A failure only warns (the next pass tries again). */
  private async prune(sheet: ChatExportSheetPort, now: number): Promise<number> {
    const oldest = oldestKeptDay(now);
    try {
      const removed = await sheet.deleteDays((d) => d < oldest);
      await sheet.deleteLogDays((d) => d < oldest);
      return removed;
    } catch (err) {
      this.logger.warn(`pruning days before ${oldest} failed: ${sheetErrorText(err)}`);
      return 0;
    }
  }

  /** One scheduler step; call every minute (start()) or directly in tests. */
  async tick(now: number = this.now()): Promise<ChatExportTickReport> {
    const cfg = this.config();
    if (!cfg.enabled) return { state: 'disabled', days: [] };
    if (this.inFlight) return { state: 'busy', days: [] };
    const { due, waiting } = this.dueDays(now);
    if (due.length === 0) return { state: waiting > 0 ? 'waiting' : 'idle', days: [] };
    if (!this.discord.isReady()) return { state: 'discord-not-ready', days: [] };
    const { sheet, reason } = this.sheetFactory(cfg);
    if (!sheet) {
      const today = taipeiParts(now).date;
      if (this.notConfiguredLoggedOn !== today) {
        this.notConfiguredLoggedOn = today;
        this.logger.warn(`not exported: sheet not configured (${cfg.sheetIdRefused ? 'public-sheet-refused' : reason})`);
      }
      // Not record(): a day is not "attempted" while nothing can be written.
      const day = due[due.length - 1];
      this.lastRun = { day, at: new Date(now).toISOString(), messages: 0, channels: 0, threads: 0, truncated: 0, outcome: 'not-configured' };
      return { state: 'not-configured', days: [] };
    }

    this.inFlight = true;
    const days: ChatExportTickReport['days'] = [];
    try {
      if (!this.catchUp) {
        this.catchUp = { startedAt: now, days: lastCompleteDays(now), outcomes: new Map() };
        const { days: window } = this.catchUp;
        this.logger.info(`catch-up: ${due.length} of the last ${window.length} days to check (${window[0]} → ${window[window.length - 1]})`);
      }
      try {
        await sheet.prepare();
      } catch (err) {
        const outcome: ChatExportOutcome = err instanceof ChatTabConflictError ? 'tab-conflict' : 'sheet-error';
        this.logger.warn(`sheet check failed (${outcome}): ${sheetErrorText(err)} — trying again in 10 minutes`);
        this.record(due[0], outcome);
        this.passRetryAt = this.later(now);
        days.push({ day: due[0], outcome });
        return { state: 'ran', days };
      }
      let reachedSheet = false;
      for (const day of due) {
        let res: DayResult;
        try {
          res = await this.exportDay(sheet, dayWindow(day), cfg, now);
        } catch (err) {
          this.logger.warn(`export of day ${day} threw: ${describeError(err)}`);
          this.record(day, 'error');
          this.retryAt.set(day, this.later(now));
          res = { outcome: 'error', stopPass: false };
        }
        days.push({ day, outcome: res.outcome });
        if (res.outcome !== 'sheet-error') reachedSheet = true;
        if (res.stopPass) {
          this.passRetryAt = this.later(now);
          break;
        }
      }
      if (reachedSheet) {
        const pruned = await this.prune(sheet, now);
        if (pruned > 0) this.logger.info(`pruned ${pruned} row(s) of days before ${oldestKeptDay(now)}`);
      }
      return { state: 'ran', days };
    } finally {
      this.inFlight = false;
    }
  }

  private async exportDay(sheet: ChatExportSheetPort, w: ExportWindow, cfg: ChatExportConfig, now: number): Promise<DayResult> {
    const day = w.dayKey;

    // 1. The day has no 完成 row; this instance holds it.
    try {
      const claim = await this.ensureClaim(sheet, day, now);
      if (claim === 'done') {
        this.record(day, 'already-exported');
        return { outcome: 'already-exported', stopPass: false };
      }
      if (claim === 'other') return this.claimedElsewhere(day, now);
    } catch (err) {
      this.logger.warn(`day ${day}: sheet check failed: ${sheetErrorText(err)} — trying again in 10 minutes`);
      this.record(day, 'sheet-error');
      return { outcome: 'sheet-error', stopPass: true };
    }

    // 2. Read the day from Discord.
    const attempt = (this.readAttempts.get(day) ?? 0) + 1;
    this.readAttempts.set(day, attempt);
    const collected: CollectResult = await this.discord.collect(cfg, w);
    if (collected.publicChannelsFound === 0) {
      this.logger.warn('no channel visible to @everyone was found — only the sync channel is read (set CHAT_EXPORT_SOURCE_CHANNEL_IDS)');
    }
    const truncated = collected.truncatedChannels + collected.threadsOverCap + collected.archivedListsTruncated;
    // No channel read at all (Discord outage, gateway dropped): an unreadable day must not pass
    // for a quiet one — read again in 10 minutes, never settled as empty. The other days would fail too.
    if (collected.channels.length === 0) {
      this.logger.warn(`day ${day}: no channel could be read (${collected.failedChannels} failed) — reading again in 10 minutes`);
      this.record(day, 'read-error');
      return { outcome: 'read-error', stopPass: true };
    }
    // Some channels failed: read again once (10 minutes later), then export what was read.
    if (collected.failedChannels > 0 && attempt < CHAT_EXPORT_READ_ATTEMPTS) {
      this.logger.warn(
        `day ${day}: ${collected.failedChannels} channel(s) failed, ${collected.channels.length} read — reading again in 10 minutes`,
      );
      this.record(day, 'read-error');
      this.retryAt.set(day, this.later(now));
      return { outcome: 'read-error', stopPass: false };
    }
    const built = buildExportRows(collected.messages, collected.channels, day);
    const skipped = Object.values(built.skipped).reduce((a, b) => a + b, 0);
    const counts =
      `fetched=${collected.messages.length} rows=${built.rows.length} skipped=${skipped} ` +
      `attachmentOnly=${built.skipped['attachment-only']} speakers=${built.speakers} channels=${built.channels}/${collected.channels.length} ` +
      `forums=${collected.forums} threadsRead=${collected.threadsRead} threadsWithRows=${built.threads} starterSkipped=${collected.starterSkipped} ` +
      `truncatedChannels=${collected.truncatedChannels} threadsOverCap=${collected.threadsOverCap} ` +
      `archivedListsTruncated=${collected.archivedListsTruncated} failedChannels=${collected.failedChannels}`;
    const stats = { messages: built.rows.length, channels: built.channels, threads: built.threads, truncated };

    // 3. Still the holder → rows of a write that was cut off removed → append → 完成.
    let phase: 'check' | 'rows' | 'done-row' = 'check';
    let requests = 0;
    try {
      const claim = await this.ensureClaim(sheet, day, Math.max(now, this.now()));
      if (claim === 'done') {
        this.record(day, 'already-exported');
        return { outcome: 'already-exported', stopPass: false };
      }
      if (claim === 'other') return this.claimedElsewhere(day, now);
      const removed = await sheet.deleteDays((d) => d === day);
      if (removed > 0) this.logger.warn(`day ${day}: removed ${removed} row(s) left by an interrupted export`);
      phase = 'rows';
      if (built.rows.length > 0) requests = await sheet.appendRows(built.rows);
      phase = 'done-row';
      await sheet.appendLog({
        day,
        state: CHAT_EXPORT_STATE_DONE,
        rows: built.rows.length,
        channels: built.channels,
        at: this.now(),
        runId: this.runId,
      });
    } catch (err) {
      this.logger.warn(`day ${day}: writing failed (${phase}): ${sheetErrorText(err)} — retrying in 10 minutes`);
      // Best effort: take the partial day out now. Not after the 完成 row was sent — it may have
      // landed. Either way the next attempt removes the day's rows first while there is no 完成.
      if (phase === 'rows') {
        try {
          await sheet.deleteDays((d) => d === day);
        } catch (cleanupErr) {
          this.logger.warn(`day ${day}: cleanup failed too (${sheetErrorText(cleanupErr)}) — removed before the next attempt`);
        }
      }
      this.record(day, 'sheet-error', stats);
      return { outcome: 'sheet-error', stopPass: true };
    }

    if (built.rows.length === 0) {
      this.record(day, 'empty', { ...stats, messages: 0, channels: 0, threads: 0 });
      this.logger.info(`day ${day}: nothing to export (${counts})`);
      return { outcome: 'empty', stopPass: false };
    }
    this.record(day, 'written', stats);
    this.logger.info(`day ${day} exported: ${counts} requests=${requests}`);
    return { outcome: 'written', stopPass: false };
  }

  private claimedElsewhere(day: string, now: number): DayResult {
    this.record(day, 'claimed-elsewhere');
    this.retryAt.set(day, this.later(now));
    this.logger.info(`day ${day} is held by another server instance — looking again in 10 minutes`);
    return { outcome: 'claimed-elsewhere', stopPass: false };
  }

  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let instance: ChatExportService | null = null;

export function initializeChatExport(opts: ChatExportServiceOptions): ChatExportService {
  if (!instance) instance = new ChatExportService(opts);
  return instance;
}

export function getChatExportService(): ChatExportService | null {
  return instance;
}

/** Status block for /api/bots/status, also before (or without) initialisation. */
export function chatExportStatus(): ChatExportStatus {
  if (instance) return instance.getStatus();
  const cfg = readChatExportConfig();
  return {
    enabled: cfg.enabled,
    sheetConfigured: !!cfg.sheetId && cfg.sheetCredentialsUsable,
    publicSheet: cfg.publicSheet,
    lastRun: null,
    catchUp: null,
  };
}

/** Test-only. */
export function __resetChatExportForTests(): void {
  instance?.stop();
  instance = null;
}
