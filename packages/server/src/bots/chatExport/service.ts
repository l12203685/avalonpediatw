/**
 * Weekly chat-log export — schedule, idempotency, status (2026-10-13).
 *
 *   Discord history (collector) → rows (pseudonymized, rows.ts)
 *     → tab 「聊天紀錄」 of the PRIVATE Google Sheet (sheetWriter.ts)
 *
 * Free: Discord REST + Google Sheets API, no paid API. The AI manager reads
 * the sheet through Google Drive once a week. Logs and the status endpoint
 * carry counts, dates and outcome codes only — never text, names or channel
 * names.
 *
 * Schedule: from Monday 09:00 +08 (until 12:00 for catch-up) for the
 * previous Monday 00:00 → Sunday 24:00.
 *
 * One complete copy per week, durable across restarts and instances (a
 * deploy overlaps the old and the new server for a while), kept in the tab
 * 「匯出紀錄」:
 *   - a week is exported only when it has a 「完成」 row (written after the
 *     last batch);
 *   - before reading Discord, and again before writing, an instance takes
 *     the week with a 「進行中」 row and reads the log back: the first fresh
 *     (< 30 min) 進行中 row holds the week; any other instance waits;
 *   - the holder deletes the week's rows in 聊天紀錄 before appending (rows
 *     without a 完成 row are a write that was cut off — killed process,
 *     Sheets error), then appends, then writes 完成.
 * After each export, weeks older than the last CHAT_EXPORT_RETAIN_WEEKS are
 * deleted from both tabs, and so are the rows of an older week that was
 * taken but never finished.
 */

import crypto from 'crypto';
import { SheetError } from '../digest/sheets';
import { describeError } from '../feedback/service';
import {
  CHAT_EXPORT_CLAIM_RENEW_MS,
  CHAT_EXPORT_CLAIM_STALE_MS,
  CHAT_EXPORT_READ_ATTEMPTS,
  CHAT_EXPORT_RETAIN_WEEKS,
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
import { defaultChatSheetFactory, type ChatExportSheetPort, type ChatSheetFactory, type ExportLogEntry } from './sheetWriter';
import { isChatExportRunWindow, oldestKeptWeek, scheduledWindow, type ExportWindow } from './window';

export type ChatExportOutcome =
  /** The week's rows were appended (and its 完成 row written). */
  | 'written'
  /** No conversation message that week (nothing appended; 完成 with 0 rows). */
  | 'empty'
  /** The week already has a 完成 row (e.g. after a restart, or another instance wrote it). */
  | 'already-exported'
  /** Another server instance holds the week (deploy overlap); looked at again in 10 minutes. */
  | 'claimed-elsewhere'
  /** No sheet id (or the public stats sheet id, refused) or no usable service-account JSON. */
  | 'not-configured'
  /** A Google Sheets call failed (retried every 10 minutes until 12:00). */
  | 'sheet-error'
  /**
   * Channels could not be read: some → read again once, then what was read
   * is exported; none at all → read again every 10 minutes until 12:00,
   * never recorded as an empty week.
   */
  | 'read-error'
  | 'error';

/** /api/bots/status → chatExport.lastRun. Counts, dates and codes only. */
export interface ChatExportLastRun {
  /** Monday (+08) of the exported week. */
  week: string;
  /** ISO time of the run. */
  at: string;
  /** Rows (messages) exported. */
  messages: number;
  /** Channels with at least one exported message. */
  channels: number;
  outcome: ChatExportOutcome;
}

export interface ChatExportStatus {
  enabled: boolean;
  sheetConfigured: boolean;
  lastRun: ChatExportLastRun | null;
}

export type ChatExportTickResult =
  | 'disabled'
  | 'outside-window'
  | 'busy'
  | 'done'
  | 'waiting'
  | 'discord-not-ready'
  | 'not-configured'
  | 'already-exported'
  | 'claimed-elsewhere'
  | 'written'
  | 'empty'
  | 'retry'
  | 'failed';

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
  return err instanceof SheetError ? err.message : describeError(err);
}

function isDone(e: ExportLogEntry): boolean {
  return e.state === CHAT_EXPORT_STATE_DONE;
}

function isClaim(e: ExportLogEntry): boolean {
  return e.state === CHAT_EXPORT_STATE_CLAIM;
}

/**
 * The instance holding `week`: the run id of its first 進行中 row (sheet
 * order) that is less than CHAT_EXPORT_CLAIM_STALE_MS old; null when none.
 * Every instance reads the same order, so two that claim at the same moment
 * agree on one holder.
 */
export function claimHolder(log: ExportLogEntry[], week: string, now: number): string | null {
  for (const e of log) {
    if (e.week === week && isClaim(e) && Number.isFinite(e.at) && now - e.at < CHAT_EXPORT_CLAIM_STALE_MS) return e.runId;
  }
  return null;
}

type ClaimResult = 'mine' | 'other' | 'done';

export class ChatExportService {
  private readonly discord: ChatExportDiscordPort;
  private readonly sheetFactory: ChatSheetFactory;
  private readonly config: () => ChatExportConfig;
  private readonly now: () => number;
  private readonly logger: ChatExportLogger;
  readonly runId: string;

  /** Week settled in this process (exported, empty, already there, or not configured). */
  private doneWeek = '';
  private readonly readAttempts = new Map<string, number>();
  private retryNotBefore: { week: string; at: number } = { week: '', at: 0 };
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
      lastRun: this.lastRun ? { ...this.lastRun } : null,
    };
  }

  private record(week: string, outcome: ChatExportOutcome, messages = 0, channels = 0): void {
    this.lastRun = { week, at: new Date(this.now()).toISOString(), messages, channels, outcome };
  }

  private retryLater(week: string, now: number): void {
    // Measured from when the attempt returned (reading a busy week can take minutes).
    this.retryNotBefore = { week, at: Math.max(now, this.now()) + CHAT_EXPORT_RETRY_DELAY_MS };
  }

  /**
   * Take (or keep) the week: 'done' when it has a 完成 row, 'other' when
   * another instance holds it, 'mine' when this one does. A claim of this
   * instance older than CHAT_EXPORT_CLAIM_RENEW_MS is renewed (new 進行中
   * row), so a live claim never goes stale between two attempts.
   */
  private async ensureClaim(sheet: ChatExportSheetPort, week: string, now: number): Promise<ClaimResult> {
    let log = await sheet.readLog();
    if (log.some((e) => e.week === week && isDone(e))) return 'done';
    const holder = claimHolder(log, week, now);
    if (holder !== null && holder !== this.runId) return 'other';
    const newestOwn = Math.max(
      -Infinity,
      ...log.filter((e) => e.week === week && isClaim(e) && e.runId === this.runId && Number.isFinite(e.at)).map((e) => e.at),
    );
    if (holder === this.runId && now - newestOwn < CHAT_EXPORT_CLAIM_RENEW_MS) return 'mine';
    await sheet.appendLog({ week, state: CHAT_EXPORT_STATE_CLAIM, rows: 0, channels: 0, at: now, runId: this.runId });
    log = await sheet.readLog();
    if (log.some((e) => e.week === week && isDone(e))) return 'done';
    return claimHolder(log, week, now) === this.runId ? 'mine' : 'other';
  }

  /**
   * Delete weeks older than the retention window (both tabs), and the chat
   * rows of an older week that was taken but never finished (a write cut
   * off before 12:00). A failure only warns (next week tries again).
   */
  private async prune(sheet: ChatExportSheetPort, week: string): Promise<number> {
    const oldest = oldestKeptWeek(week, CHAT_EXPORT_RETAIN_WEEKS);
    try {
      const log = await sheet.readLog();
      const done = new Set(log.filter(isDone).map((e) => e.week));
      const unfinished = new Set(log.filter((e) => isClaim(e) && e.week !== week && !done.has(e.week)).map((e) => e.week));
      const removed = await sheet.deleteWeeks((w) => w < oldest || unfinished.has(w));
      await sheet.deleteLogWeeks((w) => w < oldest);
      return removed;
    } catch (err) {
      this.logger.warn(`pruning weeks before ${oldest} failed: ${sheetErrorText(err)}`);
      return 0;
    }
  }

  private async settleAlreadyExported(sheet: ChatExportSheetPort, week: string): Promise<ChatExportTickResult> {
    this.doneWeek = week;
    this.record(week, 'already-exported');
    const pruned = await this.prune(sheet, week);
    this.logger.info(`week ${week} already exported (完成 in the export log); pruned=${pruned}`);
    return 'already-exported';
  }

  private claimedElsewhere(week: string, now: number): ChatExportTickResult {
    this.record(week, 'claimed-elsewhere');
    this.retryLater(week, now);
    this.logger.info(`week ${week} is held by another server instance — looking again in 10 minutes`);
    return 'claimed-elsewhere';
  }

  /** One scheduler step; call every minute (start()) or directly in tests. */
  async tick(now: number = this.now()): Promise<ChatExportTickResult> {
    const cfg = this.config();
    if (!cfg.enabled) return 'disabled';
    if (!isChatExportRunWindow(now)) return 'outside-window';
    if (this.inFlight) return 'busy';
    const w = scheduledWindow(now);
    if (this.doneWeek === w.weekKey) return 'done';
    if (this.retryNotBefore.week === w.weekKey && now < this.retryNotBefore.at) return 'waiting';
    this.inFlight = true;
    try {
      return await this.exportWeek(w, cfg, now);
    } catch (err) {
      this.logger.warn(`export of week ${w.weekKey} threw: ${describeError(err)}`);
      this.record(w.weekKey, 'error');
      this.retryLater(w.weekKey, now);
      return 'failed';
    } finally {
      this.inFlight = false;
    }
  }

  private async exportWeek(w: ExportWindow, cfg: ChatExportConfig, now: number): Promise<ChatExportTickResult> {
    const week = w.weekKey;
    const { sheet, reason } = this.sheetFactory(cfg);
    if (!sheet) {
      this.doneWeek = week;
      this.record(week, 'not-configured');
      this.logger.warn(`week ${week} not exported: sheet not configured (${cfg.sheetIdRefused ? 'public-sheet-refused' : reason})`);
      return 'not-configured';
    }
    if (!this.discord.isReady()) return 'discord-not-ready';

    // 1. Both tabs exist; the week has no 完成 row; this instance holds it.
    try {
      await sheet.prepare();
      const claim = await this.ensureClaim(sheet, week, now);
      if (claim === 'done') return await this.settleAlreadyExported(sheet, week);
      if (claim === 'other') return this.claimedElsewhere(week, now);
    } catch (err) {
      this.logger.warn(`week ${week}: sheet check failed: ${sheetErrorText(err)}`);
      this.record(week, 'sheet-error');
      this.retryLater(week, now);
      return 'retry';
    }

    // 2. Read the week from Discord.
    const attempt = (this.readAttempts.get(week) ?? 0) + 1;
    this.readAttempts.set(week, attempt);
    const collected: CollectResult = await this.discord.collect(cfg, w);
    if (collected.publicChannelsFound === 0) {
      this.logger.warn('no channel visible to @everyone was found — only the sync channel is read (set CHAT_EXPORT_SOURCE_CHANNEL_IDS)');
    }
    // No channel read at all (Discord outage, gateway dropped): an unreadable week must not pass
    // for a quiet one — read again every 10 minutes until 12:00, never settled as empty.
    if (collected.channels.length === 0) {
      this.logger.warn(`week ${week}: no channel could be read (${collected.failedChannels} failed) — reading again in 10 minutes`);
      this.record(week, 'read-error');
      this.retryLater(week, now);
      return 'retry';
    }
    // Some channels failed: read again once, then export what was read.
    if (collected.failedChannels > 0 && attempt < CHAT_EXPORT_READ_ATTEMPTS) {
      this.logger.warn(
        `week ${week}: ${collected.failedChannels} channel(s) failed, ${collected.channels.length} read — reading again in 10 minutes`,
      );
      this.record(week, 'read-error');
      this.retryLater(week, now);
      return 'retry';
    }
    const built = buildExportRows(collected.messages, collected.channels, week);
    const skipped = Object.values(built.skipped).reduce((a, b) => a + b, 0);
    const counts =
      `fetched=${collected.messages.length} rows=${built.rows.length} skipped=${skipped} ` +
      `attachmentOnly=${built.skipped['attachment-only']} speakers=${built.speakers} channels=${built.channels}/${collected.channels.length} ` +
      `truncatedChannels=${collected.truncatedChannels} failedChannels=${collected.failedChannels}`;

    // 3. Still the holder → rows of a write that was cut off removed → append → 完成.
    let phase: 'check' | 'rows' | 'done-row' = 'check';
    let requests = 0;
    try {
      const claim = await this.ensureClaim(sheet, week, Math.max(now, this.now()));
      if (claim === 'done') return await this.settleAlreadyExported(sheet, week);
      if (claim === 'other') return this.claimedElsewhere(week, now);
      const removed = await sheet.deleteWeeks((k) => k === week);
      if (removed > 0) this.logger.warn(`week ${week}: removed ${removed} row(s) left by an interrupted export`);
      phase = 'rows';
      if (built.rows.length > 0) requests = await sheet.appendRows(built.rows);
      phase = 'done-row';
      await sheet.appendLog({
        week,
        state: CHAT_EXPORT_STATE_DONE,
        rows: built.rows.length,
        channels: built.channels,
        at: this.now(),
        runId: this.runId,
      });
    } catch (err) {
      this.logger.warn(`week ${week}: writing failed (${phase}): ${sheetErrorText(err)} — retrying in 10 minutes`);
      // Best effort: take the partial week out now. Not after the 完成 row was sent — it may have
      // landed. Either way the next attempt removes the week's rows first while there is no 完成.
      if (phase === 'rows') {
        try {
          await sheet.deleteWeeks((k) => k === week);
        } catch (cleanupErr) {
          this.logger.warn(`week ${week}: cleanup failed too (${sheetErrorText(cleanupErr)}) — removed before the next attempt`);
        }
      }
      this.record(week, 'sheet-error');
      this.retryLater(week, now);
      return 'retry';
    }

    this.doneWeek = week;
    const pruned = await this.prune(sheet, week);
    if (built.rows.length === 0) {
      this.record(week, 'empty', 0, 0);
      this.logger.info(`week ${week}: nothing to export (${counts}) pruned=${pruned}`);
      return 'empty';
    }
    this.record(week, 'written', built.rows.length, built.channels);
    this.logger.info(`week ${week} exported: ${counts} requests=${requests} pruned=${pruned}`);
    return 'written';
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
  return { enabled: cfg.enabled, sheetConfigured: !!cfg.sheetId && cfg.sheetCredentialsUsable, lastRun: null };
}

/** Test-only. */
export function __resetChatExportForTests(): void {
  instance?.stop();
  instance = null;
}
