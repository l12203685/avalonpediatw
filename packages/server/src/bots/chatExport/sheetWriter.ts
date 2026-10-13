/**
 * The two tabs used by the daily chat-log export:
 *
 *   「聊天紀錄」 — one row per message (日期、時間、頻道、來源、發言者代號、內容)
 *   「匯出紀錄」 — the export log: a 「進行中」 row when an instance takes a
 *                 day (claim), a 「完成」 row once the day is fully written.
 *                 A day counts as exported only with a 完成 row.
 *                 「清理中」/「清理結束」 rows bracket row deletions (the
 *                 cleanup lock, dated the day they were written).
 *
 * These two tabs are the ONLY ones this module reads rows from, writes to or
 * deletes rows in — the spreadsheet is by default the public 阿瓦隆百科
 * workbook (since 2026-10-13), whose 牌譜 / Discord匯入 / … tabs the records
 * importer and the cache refresh read. Besides those two tabs only
 * the list of tab titles is read (to find them).
 *
 * Both tabs are created (with a frozen header row) when missing; a tab that
 * exists with an empty row 1 gets the header. For the reading copy
 * (`pinChatTabFirst`, config.ts DEFAULT_CHAT_EXPORT_READING_COPY_SHEET_ID)
 * 「聊天紀錄」 is created as the FIRST tab and moved back there when found
 * elsewhere (the other tabs keep their order and are never read, written or
 * deleted — e.g. 「練習回報」, or an empty 工作表1 left by Google), so a CSV
 * export of that spreadsheet (its first tab) is the chat; the main target's
 * tabs are never moved. The move is best effort: when Google refuses it (e.g.
 * a protected tab), prepare() still succeeds and reports it, so the rows and
 * the 7-day retention never wait for a tab position. A tab with any other header
 * (also the 週次 header of the weekly version, which never ran) is not ours:
 * ChatTabConflictError, and neither tab is created or changed. Column A of
 * both tabs holds the 日期 ("YYYY-MM-DD", +08); rows whose column A is not
 * such a date (the header, a note someone typed) are never deleted.
 *
 * Rows are deleted by INDEX (Google has no delete-by-value): column A is read,
 * then the matching rows are deleted. A delete by another instance in between
 * would shift the rows, so the service only deletes while it holds the
 * sheet-wide cleanup lock (service.ts, CHAT_EXPORT_STATE_CLEANUP), and the
 * `stillHeld` guard is checked right before the delete request is sent.
 */

import {
  GoogleSheetsClient,
  SheetError,
  a1Range,
  contiguousRuns,
  createSheetsClient,
  type SheetTab,
  type SheetsClientReason,
} from '../digest/sheets';
import {
  CHAT_EXPORT_APPEND_BATCH,
  CHAT_EXPORT_HEADER,
  CHAT_EXPORT_LOG_HEADER,
  CHAT_EXPORT_LOG_TAB,
  CHAT_EXPORT_TAB,
  type ChatExportConfig,
} from './config';
import type { ChatExportRow } from './rows';
import { isDayKey, taipeiIso } from './window';

/** One row of 「匯出紀錄」. */
export interface ExportLogEntry {
  /** 日期 (+08) of the exported day. */
  day: string;
  /** CHAT_EXPORT_STATE_CLAIM (進行中), CHAT_EXPORT_STATE_DONE (完成), or the cleanup lock's 清理中 / 清理結束. */
  state: string;
  /** Rows written (完成) — 0 for a claim. */
  rows: number;
  /** Channels (forum threads included) with at least one exported message (完成) — 0 for a claim. */
  channels: number;
  /** Epoch ms of the 時間（+08） cell; NaN when it cannot be read back. */
  at: number;
  /** Random id of the server process that wrote the row (執行代號). */
  runId: string;
}

/**
 * A tab named like one of ours exists with another header: it is not ours
 * and is never written to (the message carries a code, never the header).
 */
export class ChatTabConflictError extends Error {
  constructor(readonly tab: 'chat-tab' | 'log-tab') {
    super(`${tab} exists with another header`);
    this.name = 'ChatTabConflictError';
  }
}

/** The cleanup lock was held too long (CHAT_EXPORT_CLEANUP_MAX_MS): nothing was deleted. */
export class ChatCleanupLockLostError extends Error {
  constructor() {
    super('cleanup lock held too long, nothing deleted');
    this.name = 'ChatCleanupLockLostError';
  }
}

/**
 * A row-delete request failed in a way that leaves its outcome unknown
 * (network error, timeout, or a Google 5xx): it may still be applied later.
 * The service then does NOT release the cleanup lock — it lapses after
 * CHAT_EXPORT_CLEANUP_STALE_MS — so no other instance deletes by indices
 * that this late delete would shift (review fix 2026-10-13).
 */
export class ChatDeleteOutcomeUnknownError extends Error {
  constructor(readonly status: number | null) {
    super(`row delete outcome unknown${status !== null ? ` (HTTP ${status})` : ''}`);
    this.name = 'ChatDeleteOutcomeUnknownError';
  }
}

/**
 * prepare() succeeded but 「聊天紀錄」 could not be moved to the first tab
 * (pinChatTabFirst): the SheetError's text (step and HTTP status only).
 */
export interface ChatSheetPrepareNote {
  pinFailed: string;
}

/** What the service needs from the sheet (tests inject a fake). */
export interface ChatExportSheetPort {
  /**
   * Make sure both tabs exist and row 1 of each is the header
   * (ChatTabConflictError when a tab is not ours); with pinChatTabFirst also
   * try to make 「聊天紀錄」 the first tab — a refused move resolves with a
   * ChatSheetPrepareNote instead of failing (the other calls work).
   */
  prepare(): Promise<ChatSheetPrepareNote | void>;
  /**
   * Retention only (export stopped or refused): true when BOTH tabs already
   * exist with our header — then the other calls work; false when either is
   * missing or has an empty row 1 (nothing to prune here). Never creates or
   * changes anything (ChatTabConflictError when a tab is not ours).
   */
  prepareExisting(): Promise<boolean>;
  /** Every row of 「匯出紀錄」, in sheet order (header and non-date rows left out). */
  readLog(): Promise<ExportLogEntry[]>;
  /** Append one row to 「匯出紀錄」. */
  appendLog(entry: ExportLogEntry): Promise<void>;
  /** Append rows to 「聊天紀錄」 in batches; resolves with the number of requests sent. */
  appendRows(rows: ChatExportRow[]): Promise<number>;
  /** Rows of 「聊天紀錄」 whose 日期 matches (reads column A only). */
  countDays(match: (day: string) => boolean): Promise<number>;
  /**
   * Delete every row of 「聊天紀錄」 whose 日期 matches; resolves with the
   * number of rows deleted. By index: call only while holding the cleanup
   * lock; `stillHeld` false right before the request → ChatCleanupLockLostError.
   */
  deleteDays(match: (day: string) => boolean, stillHeld?: () => boolean): Promise<number>;
  /** Same for 「匯出紀錄」. */
  deleteLogDays(match: (day: string) => boolean, stillHeld?: () => boolean): Promise<number>;
}

function lastColumn(columns: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + columns - 1);
}

function rowMatches(cells: unknown[], header: readonly string[]): boolean {
  return header.every((h, i) => String(cells[i] ?? '').trim() === h);
}

type TabState = 'missing' | 'empty' | 'ok';

/** One tab whose column A is the 日期: create with header, delete days. */
class DayTab {
  sheetId: number | null = null;

  constructor(
    private readonly client: GoogleSheetsClient,
    readonly title: string,
    private readonly header: readonly string[],
    private readonly code: 'chat-tab' | 'log-tab',
  ) {}

  private headerRange(): string {
    return a1Range(this.title, `A1:${lastColumn(this.header.length)}1`);
  }

  /**
   * Look at the tab without changing anything (`tabs` = the spreadsheet's
   * tabs, one metadata call shared by both tabs). Throws ChatTabConflictError
   * when the tab exists with a header that is not ours.
   */
  async inspect(tabs: SheetTab[]): Promise<TabState> {
    const found = tabs.find((t) => t.title === this.title);
    if (!found) return 'missing';
    const head = await this.client.readValues(this.headerRange());
    const cells = Array.isArray(head[0]) ? head[0] : [];
    if (cells.every((c) => String(c ?? '').trim() === '')) return this.found(found, 'empty');
    if (rowMatches(cells, this.header)) return this.found(found, 'ok');
    throw new ChatTabConflictError(this.code);
  }

  private found(tab: SheetTab, state: TabState): TabState {
    this.sheetId = tab.sheetId;
    return state;
  }

  /** Create the tab (at the end, or at `index`) and / or write the header, as `inspect` found it. */
  async settle(state: TabState, index?: number): Promise<void> {
    if (state === 'missing') {
      this.sheetId = await this.client.addTab(this.title, {
        frozenRows: 1,
        columns: this.header.length,
        ...(index !== undefined ? { index } : {}),
      });
    }
    if (state !== 'ok') await this.client.updateValues(this.headerRange(), [[...this.header]]);
  }

  /** Move the (existing) tab to index 0 unless `tabs` already lists it first. */
  async pinFirst(tabs: SheetTab[]): Promise<void> {
    const found = tabs.find((t) => t.title === this.title);
    if (!found || found.index === 0 || this.sheetId === null) return;
    await this.client.moveTab(this.sheetId, 0);
  }

  /** Every row of the used columns (index 0 = row 1 = header). */
  async readAll(): Promise<unknown[][]> {
    return this.client.readValues(a1Range(this.title, `A:${lastColumn(this.header.length)}`));
  }

  async append(rows: (string | number)[][]): Promise<void> {
    await this.client.appendValues(a1Range(this.title, 'A1'), rows);
  }

  /** 0-based row indices (header excluded) whose column A is a matching 日期. */
  private async matchingRows(match: (day: string) => boolean): Promise<number[]> {
    const col = (await this.client.readValues(a1Range(this.title, 'A:A'))).map((r) => (Array.isArray(r) ? r[0] : undefined));
    const indices: number[] = [];
    col.forEach((v, i) => {
      if (i > 0 && isDayKey(v) && match(v)) indices.push(i);
    });
    return indices;
  }

  async countDays(match: (day: string) => boolean): Promise<number> {
    if (this.sheetId === null) return 0;
    return (await this.matchingRows(match)).length;
  }

  async deleteDays(match: (day: string) => boolean, stillHeld?: () => boolean): Promise<number> {
    if (this.sheetId === null) return 0; // set by inspect / settle (prepare)
    const indices = await this.matchingRows(match);
    if (indices.length === 0) return 0;
    if (stillHeld && !stillHeld()) throw new ChatCleanupLockLostError();
    try {
      await this.client.deleteRows(this.sheetId, contiguousRuns(indices));
    } catch (err) {
      // Sent (not the token step) and no definite answer: it may land later.
      if (err instanceof SheetError && err.step === 'delete-rows' && (err.status === null || err.status >= 500)) {
        throw new ChatDeleteOutcomeUnknownError(err.status);
      }
      throw err;
    }
    return indices.length;
  }
}

function cellText(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function cellNumber(v: unknown): number {
  const n = Number(cellText(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export class ChatExportSheet implements ChatExportSheetPort {
  private readonly chat: DayTab;
  private readonly log: DayTab;
  private prepared = false;

  constructor(
    private readonly client: GoogleSheetsClient,
    private readonly opts: {
      tab?: string;
      logTab?: string;
      batchSize?: number;
      /** The reading copy: 「聊天紀錄」 is created as / moved back to the first tab. */
      pinChatTabFirst?: boolean;
    } = {},
  ) {
    this.chat = new DayTab(client, opts.tab ?? CHAT_EXPORT_TAB, CHAT_EXPORT_HEADER, 'chat-tab');
    this.log = new DayTab(client, opts.logTab ?? CHAT_EXPORT_LOG_TAB, CHAT_EXPORT_LOG_HEADER, 'log-tab');
  }

  async prepare(): Promise<ChatSheetPrepareNote | void> {
    const tabs = await this.client.listTabs();
    // Look at both before creating or changing either: a tab that is not ours stops everything.
    const chatState = await this.chat.inspect(tabs);
    const logState = await this.log.inspect(tabs);
    const pin = this.opts.pinChatTabFirst === true;
    await this.chat.settle(chatState, pin ? 0 : undefined);
    await this.log.settle(logState);
    this.prepared = true;
    // Created at index 0 above; found elsewhere (someone moved it, or a tab was added in front) → moved back.
    // Best effort: a refused move must not stop the day's rows or the 7-day retention (review fix 2026-10-13).
    if (pin && chatState !== 'missing') {
      try {
        await this.chat.pinFirst(tabs);
      } catch (err) {
        if (err instanceof SheetError) return { pinFailed: err.message };
        throw err;
      }
    }
  }

  async prepareExisting(): Promise<boolean> {
    const tabs = await this.client.listTabs();
    const chatState = await this.chat.inspect(tabs);
    if (chatState !== 'ok') return false;
    if ((await this.log.inspect(tabs)) !== 'ok') return false;
    this.prepared = true;
    return true;
  }

  /** Every other call works only after prepare() checked both tabs are ours. */
  private requirePrepared(): void {
    if (!this.prepared) throw new Error('ChatExportSheet.prepare() was not called');
  }

  async readLog(): Promise<ExportLogEntry[]> {
    this.requirePrepared();
    const rows = await this.log.readAll();
    const out: ExportLogEntry[] = [];
    rows.slice(1).forEach((r) => {
      const cells = Array.isArray(r) ? r : [];
      const day = cells[0];
      if (!isDayKey(day)) return;
      out.push({
        day,
        state: cellText(cells[1]).trim(),
        rows: cellNumber(cells[2]),
        channels: cellNumber(cells[3]),
        at: Date.parse(cellText(cells[4]).trim()),
        runId: cellText(cells[5]).trim(),
      });
    });
    return out;
  }

  async appendLog(e: ExportLogEntry): Promise<void> {
    this.requirePrepared();
    await this.log.append([[e.day, e.state, e.rows, e.channels, taipeiIso(e.at), e.runId]]);
  }

  async appendRows(rows: ChatExportRow[]): Promise<number> {
    this.requirePrepared();
    const size = Math.max(1, this.opts.batchSize ?? CHAT_EXPORT_APPEND_BATCH);
    let requests = 0;
    for (let i = 0; i < rows.length; i += size) {
      await this.chat.append(rows.slice(i, i + size));
      requests += 1;
    }
    return requests;
  }

  async countDays(match: (day: string) => boolean): Promise<number> {
    this.requirePrepared();
    return this.chat.countDays(match);
  }

  async deleteDays(match: (day: string) => boolean, stillHeld?: () => boolean): Promise<number> {
    this.requirePrepared();
    return this.chat.deleteDays(match, stillHeld);
  }

  async deleteLogDays(match: (day: string) => boolean, stillHeld?: () => boolean): Promise<number> {
    this.requirePrepared();
    return this.log.deleteDays(match, stillHeld);
  }
}

export type ChatSheetFactory = (cfg: ChatExportConfig) => { sheet: ChatExportSheetPort | null; reason: SheetsClientReason };

export const defaultChatSheetFactory: ChatSheetFactory = (cfg) => {
  const { client, reason } = createSheetsClient(cfg.sheetId, process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return { sheet: client ? new ChatExportSheet(client, cfg.pinChatTabFirst ? { pinChatTabFirst: true } : {}) : null, reason };
};
