/**
 * The 「聊天紀錄」 tab of the private spreadsheet: create it (with a header)
 * when missing, tell whether a week is already there, append a week's rows
 * in batches, delete weeks (old ones, or a half-written one).
 *
 * Column A holds the 週次 (Monday date, "YYYY-MM-DD"); rows whose column A
 * is not such a date (the header, a note someone typed) are never deleted.
 */

import {
  GoogleSheetsClient,
  a1Range,
  contiguousRuns,
  createSheetsClient,
  type SheetsClientReason,
} from '../digest/sheets';
import { CHAT_EXPORT_APPEND_BATCH, CHAT_EXPORT_HEADER, CHAT_EXPORT_TAB, type ChatExportConfig } from './config';
import type { ChatExportRow } from './rows';
import { isWeekKey } from './window';

/** What the service needs from the sheet (tests inject a fake). */
export interface ChatExportSheetPort {
  /** Make sure the tab exists and row 1 is the header. */
  prepare(): Promise<void>;
  hasWeek(week: string): Promise<boolean>;
  /** Append rows in batches; resolves with the number of requests sent. */
  appendRows(rows: ChatExportRow[]): Promise<number>;
  /** Delete every row whose 週次 matches; resolves with the number of rows deleted. */
  deleteWeeks(match: (week: string) => boolean): Promise<number>;
}

export class ChatExportSheet implements ChatExportSheetPort {
  private sheetId: number | null = null;

  constructor(
    private readonly client: GoogleSheetsClient,
    private readonly opts: { tab?: string; batchSize?: number } = {},
  ) {}

  private get tab(): string {
    return this.opts.tab ?? CHAT_EXPORT_TAB;
  }

  async prepare(): Promise<void> {
    const tabs = await this.client.listTabs();
    const found = tabs.find((t) => t.title === this.tab);
    const lastColumn = String.fromCharCode('A'.charCodeAt(0) + CHAT_EXPORT_HEADER.length - 1);
    const headerRange = a1Range(this.tab, `A1:${lastColumn}1`);
    if (!found) {
      this.sheetId = await this.client.addTab(this.tab, { frozenRows: 1, columns: CHAT_EXPORT_HEADER.length });
      await this.client.updateValues(headerRange, [[...CHAT_EXPORT_HEADER]]);
      return;
    }
    this.sheetId = found.sheetId;
    const head = await this.client.readValues(headerRange);
    if (head.length === 0 || (head[0] ?? []).length === 0) await this.client.updateValues(headerRange, [[...CHAT_EXPORT_HEADER]]);
  }

  /** Column A, one entry per row (index 0 = row 1 = header). */
  private async weekColumn(): Promise<unknown[]> {
    const rows = await this.client.readValues(a1Range(this.tab, 'A:A'));
    return rows.map((r) => (Array.isArray(r) ? r[0] : undefined));
  }

  async hasWeek(week: string): Promise<boolean> {
    const col = await this.weekColumn();
    return col.slice(1).some((v) => v === week);
  }

  async appendRows(rows: ChatExportRow[]): Promise<number> {
    const size = Math.max(1, this.opts.batchSize ?? CHAT_EXPORT_APPEND_BATCH);
    let requests = 0;
    for (let i = 0; i < rows.length; i += size) {
      await this.client.appendValues(a1Range(this.tab, 'A1'), rows.slice(i, i + size));
      requests += 1;
    }
    return requests;
  }

  async deleteWeeks(match: (week: string) => boolean): Promise<number> {
    if (this.sheetId === null) await this.prepare();
    const col = await this.weekColumn();
    const indices: number[] = [];
    col.forEach((v, i) => {
      if (i > 0 && isWeekKey(v) && match(v)) indices.push(i);
    });
    if (indices.length === 0) return 0;
    await this.client.deleteRows(this.sheetId as number, contiguousRuns(indices));
    return indices.length;
  }
}

export type ChatSheetFactory = (cfg: ChatExportConfig) => { sheet: ChatExportSheetPort | null; reason: SheetsClientReason };

export const defaultChatSheetFactory: ChatSheetFactory = (cfg) => {
  const { client, reason } = createSheetsClient(cfg.sheetId, process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return { sheet: client ? new ChatExportSheet(client) : null, reason };
};
