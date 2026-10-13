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
 * previous Monday 00:00 → Sunday 24:00. One copy per week: a week already in
 * the tab is skipped (also after a restart); a batch that fails half-way is
 * cleaned up (the week's rows deleted) before the next attempt, so a week is
 * never left half-written. After each export, weeks older than the last
 * CHAT_EXPORT_RETAIN_WEEKS are deleted.
 */

import { SheetError } from '../digest/sheets';
import { describeError } from '../feedback/service';
import {
  CHAT_EXPORT_READ_ATTEMPTS,
  CHAT_EXPORT_RETAIN_WEEKS,
  CHAT_EXPORT_RETRY_DELAY_MS,
  defaultChatExportLogger,
  readChatExportConfig,
  type ChatExportConfig,
  type ChatExportLogger,
} from './config';
import type { CollectResult } from './collector';
import type { ChatExportDiscordPort } from './discordPort';
import { buildExportRows } from './rows';
import { defaultChatSheetFactory, type ChatExportSheetPort, type ChatSheetFactory } from './sheetWriter';
import { isChatExportRunWindow, oldestKeptWeek, scheduledWindow, type ExportWindow } from './window';

export type ChatExportOutcome =
  /** The week's rows were appended. */
  | 'written'
  /** No conversation message that week (nothing to append). */
  | 'empty'
  /** The week was already in the tab (e.g. after a restart). */
  | 'already-exported'
  /** No sheet id or no usable service-account JSON. */
  | 'not-configured'
  /** A Google Sheets call failed (retried every 10 minutes until 12:00). */
  | 'sheet-error'
  /** Some channels could not be read; read again once before exporting. */
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
}

function sheetErrorText(err: unknown): string {
  return err instanceof SheetError ? err.message : describeError(err);
}

export class ChatExportService {
  private readonly discord: ChatExportDiscordPort;
  private readonly sheetFactory: ChatSheetFactory;
  private readonly config: () => ChatExportConfig;
  private readonly now: () => number;
  private readonly logger: ChatExportLogger;

  /** Week settled in this process (exported, empty, already there, or not configured). */
  private doneWeek = '';
  /** A week whose append failed half-way and whose cleanup failed too: delete its rows first. */
  private dirtyWeek = '';
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

  /** Delete weeks older than the retention window; a failure only warns (next week tries again). */
  private async prune(sheet: ChatExportSheetPort, week: string): Promise<number> {
    const oldest = oldestKeptWeek(week, CHAT_EXPORT_RETAIN_WEEKS);
    try {
      return await sheet.deleteWeeks((w) => w < oldest);
    } catch (err) {
      this.logger.warn(`pruning weeks before ${oldest} failed: ${sheetErrorText(err)}`);
      return 0;
    }
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
      this.logger.warn(`week ${week} not exported: sheet not configured (${reason})`);
      return 'not-configured';
    }
    if (!this.discord.isReady()) return 'discord-not-ready';

    // 1. The tab exists; the week is not there yet (or a half-written copy is removed).
    try {
      await sheet.prepare();
      if (this.dirtyWeek === week) {
        const removed = await sheet.deleteWeeks((k) => k === week);
        this.dirtyWeek = '';
        this.logger.warn(`week ${week}: removed ${removed} row(s) left by an interrupted export`);
      } else if (await sheet.hasWeek(week)) {
        this.doneWeek = week;
        this.record(week, 'already-exported');
        const pruned = await this.prune(sheet, week);
        this.logger.info(`week ${week} already in the sheet; pruned=${pruned}`);
        return 'already-exported';
      }
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
    // Some channels failed, or none could be read at all (Discord hiccup, gateway dropped): read
    // again once before exporting what there is — an unreadable week must not pass for a quiet one.
    const unreadable = collected.failedChannels > 0 || collected.channels.length === 0;
    if (unreadable && attempt < CHAT_EXPORT_READ_ATTEMPTS) {
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

    if (built.rows.length === 0) {
      this.doneWeek = week;
      this.record(week, 'empty', 0, 0);
      const pruned = await this.prune(sheet, week);
      this.logger.info(`week ${week}: nothing to export (${counts}) pruned=${pruned}`);
      return 'empty';
    }

    // 3. Append; a half-written week is removed before the next attempt.
    let requests = 0;
    try {
      requests = await sheet.appendRows(built.rows);
    } catch (err) {
      this.logger.warn(`week ${week}: appending failed: ${sheetErrorText(err)} — retrying in 10 minutes`);
      try {
        await sheet.deleteWeeks((k) => k === week);
      } catch (cleanupErr) {
        this.dirtyWeek = week;
        this.logger.warn(`week ${week}: cleanup failed too (${sheetErrorText(cleanupErr)}) — removed before the next attempt`);
      }
      this.record(week, 'sheet-error');
      this.retryLater(week, now);
      return 'retry';
    }

    this.doneWeek = week;
    this.record(week, 'written', built.rows.length, built.channels);
    const pruned = await this.prune(sheet, week);
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
