/**
 * The two tabs of the private spreadsheet used by the weekly chat-log export:
 *
 *   「聊天紀錄」 — one row per message (週次、時間、頻道、來源、發言者代號、內容)
 *   「匯出紀錄」 — the export log: a 「進行中」 row when an instance takes a
 *                 week (claim), a 「完成」 row once the week is fully written.
 *                 A week counts as exported only with a 完成 row.
 *
 * Both tabs are created (with a frozen header row) when missing. Column A of
 * both holds the 週次 (Monday date, "YYYY-MM-DD"); rows whose column A is not
 * such a date (the header, a note someone typed) are never deleted.
 */

import {
  GoogleSheetsClient,
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
import { isWeekKey, taipeiIso } from './window';

/** One row of 「匯出紀錄」. */
export interface ExportLogEntry {
  /** 週次 (Monday, +08). */
  week: string;
  /** CHAT_EXPORT_STATE_CLAIM (進行中) or CHAT_EXPORT_STATE_DONE (完成). */
  state: string;
  /** Rows written (完成) — 0 for a claim. */
  rows: number;
  /** Channels with at least one exported message (完成) — 0 for a claim. */
  channels: number;
  /** Epoch ms of the 時間（+08） cell; NaN when it cannot be read back. */
  at: number;
  /** Random id of the server process that wrote the row (執行代號). */
  runId: string;
}

/** What the service needs from the sheet (tests inject a fake). */
export interface ChatExportSheetPort {
  /** Make sure both tabs exist and row 1 of each is the header. */
  prepare(): Promise<void>;
  /** Every row of 「匯出紀錄」, in sheet order (header and non-date rows left out). */
  readLog(): Promise<ExportLogEntry[]>;
  /** Append one row to 「匯出紀錄」. */
  appendLog(entry: ExportLogEntry): Promise<void>;
  /** Append rows to 「聊天紀錄」 in batches; resolves with the number of requests sent. */
  appendRows(rows: ChatExportRow[]): Promise<number>;
  /** Delete every row of 「聊天紀錄」 whose 週次 matches; resolves with the number of rows deleted. */
  deleteWeeks(match: (week: string) => boolean): Promise<number>;
  /** Same for 「匯出紀錄」. */
  deleteLogWeeks(match: (week: string) => boolean): Promise<number>;
}

function lastColumn(columns: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + columns - 1);
}

/** One tab whose column A is the 週次: create with header, delete weeks. */
class WeekTab {
  sheetId: number | null = null;

  constructor(
    private readonly client: GoogleSheetsClient,
    readonly title: string,
    private readonly header: readonly string[],
  ) {}

  /** `tabs` = the spreadsheet's tabs (one metadata call shared by both tabs). */
  async ensure(tabs: SheetTab[]): Promise<void> {
    const headerRange = a1Range(this.title, `A1:${lastColumn(this.header.length)}1`);
    const found = tabs.find((t) => t.title === this.title);
    if (!found) {
      this.sheetId = await this.client.addTab(this.title, { frozenRows: 1, columns: this.header.length });
      await this.client.updateValues(headerRange, [[...this.header]]);
      return;
    }
    this.sheetId = found.sheetId;
    const head = await this.client.readValues(headerRange);
    if (head.length === 0 || (head[0] ?? []).length === 0) await this.client.updateValues(headerRange, [[...this.header]]);
  }

  /** Every row of the used columns (index 0 = row 1 = header). */
  async readAll(): Promise<unknown[][]> {
    return this.client.readValues(a1Range(this.title, `A:${lastColumn(this.header.length)}`));
  }

  async append(rows: (string | number)[][]): Promise<void> {
    await this.client.appendValues(a1Range(this.title, 'A1'), rows);
  }

  async deleteWeeks(match: (week: string) => boolean): Promise<number> {
    if (this.sheetId === null) await this.ensure(await this.client.listTabs());
    const col = (await this.client.readValues(a1Range(this.title, 'A:A'))).map((r) => (Array.isArray(r) ? r[0] : undefined));
    const indices: number[] = [];
    col.forEach((v, i) => {
      if (i > 0 && isWeekKey(v) && match(v)) indices.push(i);
    });
    if (indices.length === 0) return 0;
    await this.client.deleteRows(this.sheetId as number, contiguousRuns(indices));
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
  private readonly chat: WeekTab;
  private readonly log: WeekTab;

  constructor(
    private readonly client: GoogleSheetsClient,
    private readonly opts: { tab?: string; logTab?: string; batchSize?: number } = {},
  ) {
    this.chat = new WeekTab(client, opts.tab ?? CHAT_EXPORT_TAB, CHAT_EXPORT_HEADER);
    this.log = new WeekTab(client, opts.logTab ?? CHAT_EXPORT_LOG_TAB, CHAT_EXPORT_LOG_HEADER);
  }

  async prepare(): Promise<void> {
    const tabs = await this.client.listTabs();
    await this.chat.ensure(tabs);
    await this.log.ensure(tabs);
  }

  async readLog(): Promise<ExportLogEntry[]> {
    const rows = await this.log.readAll();
    const out: ExportLogEntry[] = [];
    rows.slice(1).forEach((r) => {
      const cells = Array.isArray(r) ? r : [];
      const week = cells[0];
      if (!isWeekKey(week)) return;
      out.push({
        week,
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
    await this.log.append([[e.week, e.state, e.rows, e.channels, taipeiIso(e.at), e.runId]]);
  }

  async appendRows(rows: ChatExportRow[]): Promise<number> {
    const size = Math.max(1, this.opts.batchSize ?? CHAT_EXPORT_APPEND_BATCH);
    let requests = 0;
    for (let i = 0; i < rows.length; i += size) {
      await this.chat.append(rows.slice(i, i + size));
      requests += 1;
    }
    return requests;
  }

  deleteWeeks(match: (week: string) => boolean): Promise<number> {
    return this.chat.deleteWeeks(match);
  }

  deleteLogWeeks(match: (week: string) => boolean): Promise<number> {
    return this.log.deleteWeeks(match);
  }
}

export type ChatSheetFactory = (cfg: ChatExportConfig) => { sheet: ChatExportSheetPort | null; reason: SheetsClientReason };

export const defaultChatSheetFactory: ChatSheetFactory = (cfg) => {
  const { client, reason } = createSheetsClient(cfg.sheetId, process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return { sheet: client ? new ChatExportSheet(client) : null, reason };
};
