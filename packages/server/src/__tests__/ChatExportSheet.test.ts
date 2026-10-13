/**
 * Daily chat-log export — Google Sheets, against an in-memory fake of the
 * Sheets REST API (mocked fetch, no network):
 *
 *   digest/sheets.ts — service-account JWT (RS256, verified with a throwaway
 *                      RSA key), token reuse, errors carry the HTTP status
 *                      only, credentials parsing, a1Range / contiguousRuns
 *   ChatExportSheet  — tabs 「聊天紀錄」 and 「匯出紀錄」 created with their
 *                      headers when missing (addSheet), header filled into
 *                      an empty existing tab, a tab with another header (also
 *                      the old 週次 one) refused before anything is written,
 *                      appends in batches of 500 with RAW input, the export
 *                      log written and read back (+08 time with seconds),
 *                      deleteDays (bottom run first; header and non-date
 *                      rows never touched; the cleanup-lock guard false →
 *                      nothing sent), countDays
 *   end to end       — ChatExportService + ChatExportSheet: the 7-day
 *                      catch-up with 完成 rows, restart idempotency, 7-day
 *                      retention of both tabs, a half-written day cleaned up
 *                      and rewritten, a process killed mid-write taken over
 *                      after its claim went stale; two instances pruning at
 *                      once against index-based deletes lose no row; on
 *                      the 阿瓦隆百科 workbook (the default) only the two
 *                      chat tabs are touched and no name or id reaches it;
 *                      CHAT_EXPORT_ALLOW_PUBLIC_SHEET=0 → no chat sent to it,
 *                      only the retention (old days deleted, no tab created);
 *                      a delete with no definite answer → outcome unknown;
 *                      CHAT_EXPORT_SHEET_ID still picks the private sheet
 *   reading copy     — 「聊天紀錄」 created at index 0 / moved back there
 *                      (best effort: a refused move never stops the rows or
 *                      the retention), 工作表1 and 練習回報 untouched; both
 *                      targets end to end with one Discord read per day; an
 *                      earlier version's tabs adopted and its 完成 days
 *                      written again; a failing target never blocks the other
 */
import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  GOOGLE_TOKEN_URL,
  SHEETS_API_BASE,
  SHEETS_SCOPE,
  GoogleSheetsClient,
  SheetError,
  a1Range,
  base64url,
  buildServiceAccountJwt,
  contiguousRuns,
  createSheetsClient,
  parseServiceAccountJson,
} from '../bots/digest/sheets';
import {
  ChatCleanupLockLostError,
  ChatDeleteOutcomeUnknownError,
  ChatExportSheet,
  ChatTabConflictError,
  defaultChatSheetFactory,
} from '../bots/chatExport/sheetWriter';
import {
  CHAT_EXPORT_HEADER,
  CHAT_EXPORT_LOG_HEADER,
  CHAT_EXPORT_LOG_TAB,
  CHAT_EXPORT_TAB,
  DEFAULT_CHAT_EXPORT_SHEET_ID,
  PRIVATE_CHAT_EXPORT_SHEET_ID,
  PUBLIC_STATS_SHEET_ID,
  STATS_WORKBOOK_TABS,
  readChatExportConfig,
  readChatExportReadingCopyConfig,
} from '../bots/chatExport/config';
import { ChatExportService } from '../bots/chatExport/service';
import { shareChatExportReads, type ChatExportDiscordPort } from '../bots/chatExport/discordPort';
import type { RawChatMessage } from '../bots/chatExport/rows';
import type { ChatExportRow } from '../bots/chatExport/rows';
import { emptyCollectResult } from '../bots/chatExport/collector';
import { lastCompleteDays } from '../bots/chatExport/window';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const creds = { client_email: 'chat-export-test@example-project.iam.gserviceaccount.com', private_key: privateKey };
/** The default target (the 阿瓦隆百科 workbook since 2026-10-13): the end-to-end tests run on the default config. */
const SHEET_ID = DEFAULT_CHAT_EXPORT_SHEET_ID;
const BASE = `${SHEETS_API_BASE}/${SHEET_ID}`;

// ─── Fake Google Sheets ───────────────────────────────────────────────────

interface FakeTab {
  sheetId: number;
  rows: string[][];
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** The batchUpdate requests the code sends. */
interface BatchRequest {
  addSheet?: { properties: { title: string; index?: number } };
  deleteDimension?: { range: { sheetId: number; dimension: string; startIndex: number; endIndex: number } };
  updateSheetProperties?: { properties: { sheetId: number; index: number }; fields: string };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Parse "'tab'!A1:F1" / "'tab'!A:A" / "'tab'!A1". */
function parseRange(range: string): { tab: string; cells: string } {
  const m = /^'((?:[^']|'')*)'!(.+)$/.exec(range);
  if (!m) throw new Error(`unexpected range ${range}`);
  return { tab: m[1].replace(/''/g, "'"), cells: m[2] };
}

/** Tab order = the Map's order (like Google, `index` is the position). */
class FakeSheets {
  readonly tabs = new Map<string, FakeTab>([['工作表1', { sheetId: 0, rows: [] }]]);
  readonly base: string;
  readonly calls: Call[] = [];
  private nextId = 100;
  /** Fail the n-th append call (1-based) with this status; 0 = never. */
  failAppendAt = 0;
  failAppendStatus = 500;
  failDeleteStatus = 0;
  failMetadataStatus = 0;
  /** The metadata answer leaves `index` out (the client then uses the listing order). */
  omitIndex = false;
  /** updateSheetProperties (a tab move) answers with this status; 0 = it works. */
  failMoveStatus = 0;
  appendCount = 0;
  /** Each call waits this long first (a macrotask), so two instances interleave like real network calls. */
  latencyMs = 0;

  constructor(readonly spreadsheetId: string = SHEET_ID) {
    this.base = `${SHEETS_API_BASE}/${spreadsheetId}`;
  }

  readonly fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init?.body;
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    this.calls.push({ method, url, body });
    if (url === GOOGLE_TOKEN_URL) return json({ access_token: 'ya29.test-token', expires_in: 3600 });
    if (!url.startsWith(this.base)) return json({}, 404);
    const rest = url.slice(this.base.length);
    if (rest.startsWith('?fields=')) {
      if (this.failMetadataStatus) return json({ error: 'secret detail' }, this.failMetadataStatus);
      return json({
        sheets: [...this.tabs].map(([title, t], index) => ({ properties: { sheetId: t.sheetId, title, ...(this.omitIndex ? {} : { index }) } })),
      });
    }
    if (rest === ':batchUpdate') return this.batchUpdate(body as { requests: BatchRequest[] });
    const m = /^\/values\/([^?:]+)(:append)?(?:\?(.*))?$/.exec(rest);
    if (!m) return json({}, 404);
    const { tab, cells } = parseRange(decodeURIComponent(m[1]));
    const t = this.tabs.get(tab);
    if (!t) return json({ error: 'no tab' }, 400);
    const query = new URLSearchParams(m[3] ?? '');
    if (m[2]) {
      this.appendCount += 1;
      if (this.appendCount === this.failAppendAt) return json({ error: 'appended values echoed here' }, this.failAppendStatus);
      expect(query.get('valueInputOption')).toBe('RAW');
      expect(query.get('insertDataOption')).toBe('INSERT_ROWS');
      t.rows.push(...(body as { values: string[][] }).values.map((r) => r.map(String)));
      return json({ updates: {} });
    }
    if (method === 'PUT') {
      expect(query.get('valueInputOption')).toBe('RAW');
      expect(cells).toBe('A1:F1');
      t.rows[0] = (body as { values: string[][] }).values[0].map(String);
      return json({});
    }
    if (cells === 'A:A') return json({ values: t.rows.map((r) => (r[0] === undefined || r[0] === '' ? [] : [r[0]])) });
    if (cells === 'A:F') return json({ values: t.rows.map((r) => r.slice(0, 6)) });
    if (cells === 'A1:F1') return json(t.rows[0]?.length ? { values: [t.rows[0]] } : { range: cells });
    return json({}, 404);
  });

  private batchUpdate(body: { requests: BatchRequest[] }): Response {
    const replies: unknown[] = [];
    for (const r of body.requests) {
      if (r.addSheet) {
        const id = this.nextId++;
        this.tabs.set(r.addSheet.properties.title, { sheetId: id, rows: [] });
        if (r.addSheet.properties.index !== undefined) this.moveTo(r.addSheet.properties.title, r.addSheet.properties.index);
        replies.push({ addSheet: { properties: { sheetId: id, title: r.addSheet.properties.title } } });
      } else if (r.updateSheetProperties) {
        if (this.failMoveStatus) return json({ error: 'secret detail' }, this.failMoveStatus);
        const { properties, fields } = r.updateSheetProperties;
        expect(fields).toBe('index'); // nothing but the position
        const title = [...this.tabs].find(([, t]) => t.sheetId === properties.sheetId)?.[0];
        if (title === undefined) return json({ error: 'no sheet' }, 400);
        this.moveTo(title, properties.index);
        replies.push({});
      } else if (r.deleteDimension) {
        if (this.failDeleteStatus) return json({ error: 'x' }, this.failDeleteStatus);
        const { sheetId, startIndex, endIndex, dimension } = r.deleteDimension.range;
        expect(dimension).toBe('ROWS');
        const tab = [...this.tabs.values()].find((t) => t.sheetId === sheetId);
        if (!tab) return json({ error: 'no sheet' }, 400);
        tab.rows.splice(startIndex, endIndex - startIndex);
        replies.push({});
      }
    }
    return json({ replies });
  }

  /** Put tab `title` at position `index`; the others keep their order. */
  moveTo(title: string, index: number): void {
    const entries = [...this.tabs];
    const at = entries.findIndex(([t]) => t === title);
    const [entry] = entries.splice(at, 1);
    entries.splice(index, 0, entry);
    this.tabs.clear();
    for (const [t, tab] of entries) this.tabs.set(t, tab);
  }

  /** Tab titles in order (index 0 first) — what a CSV export of the spreadsheet starts with. */
  order(): string[] {
    return [...this.tabs.keys()];
  }

  tab(title = CHAT_EXPORT_TAB): string[][] {
    return this.tabs.get(title)?.rows ?? [];
  }

  /**
   * The tab each spreadsheet call reads or writes ('(metadata)' for the tab
   * list): values ranges by their tab name, batchUpdate requests by the
   * added title or the deleted rows' sheet id.
   */
  touched(): Array<{ method: string; tab: string }> {
    const byId = new Map([...this.tabs].map(([title, t]) => [t.sheetId, title]));
    const out: Array<{ method: string; tab: string }> = [];
    for (const c of this.calls) {
      if (!c.url.startsWith(this.base)) continue;
      const rest = c.url.slice(this.base.length);
      if (rest.startsWith('?fields=')) out.push({ method: c.method, tab: '(metadata)' });
      else if (rest === ':batchUpdate') {
        for (const r of (c.body as { requests: BatchRequest[] }).requests) {
          if (r.addSheet) out.push({ method: 'addSheet', tab: r.addSheet.properties.title });
          if (r.deleteDimension) out.push({ method: 'deleteRows', tab: byId.get(r.deleteDimension.range.sheetId) ?? `#${r.deleteDimension.range.sheetId}` });
          if (r.updateSheetProperties) {
            const id = r.updateSheetProperties.properties.sheetId;
            out.push({ method: 'moveTab', tab: byId.get(id) ?? `#${id}` });
          }
        }
      } else {
        const m = /^\/values\/([^?:]+)/.exec(rest);
        out.push({ method: c.method, tab: m ? parseRange(decodeURIComponent(m[1])).tab : rest });
      }
    }
    return out;
  }

  client(now?: () => number): GoogleSheetsClient {
    return new GoogleSheetsClient({
      spreadsheetId: this.spreadsheetId,
      credentials: creds,
      fetchImpl: this.fetchImpl as unknown as typeof fetch,
      now,
    });
  }
}

function row(day: string, i: number): ChatExportRow {
  return [day, `${day} 12:${String(i % 60).padStart(2, '0')}`, '一般聊天', 'Discord', `成員${(i % 7) + 1}`, `第${i}則`];
}

// ─── digest/sheets.ts ─────────────────────────────────────────────────────

describe('Google Sheets client (digest/sheets.ts)', () => {
  it('signs an RS256 service-account JWT and exchanges it for a token, reused within its lifetime', async () => {
    const g = new FakeSheets();
    const now = Date.parse('2026-10-12T01:03:00Z');
    const client = g.client(() => now);
    await client.listTabs();
    await client.readValues(a1Range('工作表1', 'A:A'));

    const token = g.calls[0];
    expect(token.url).toBe(GOOGLE_TOKEN_URL);
    expect(token.method).toBe('POST');
    const form = new URLSearchParams(String(token.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = (form.get('assertion') ?? '').split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims).toEqual({ iss: creds.client_email, scope: SHEETS_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now / 1000, exp: now / 1000 + 3600 });
    expect(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(buildServiceAccountJwt(creds, 1).split('.')).toHaveLength(3);
    expect(base64url('a+b/c=')).not.toMatch(/[+/=]/);
    expect(g.calls.filter((x) => x.url === GOOGLE_TOKEN_URL)).toHaveLength(1);
    expect(g.calls[1].url).toBe(`${BASE}?fields=${encodeURIComponent('sheets.properties(sheetId,title,index)')}`);
  });

  it('errors carry the step and HTTP status only, never the response body', async () => {
    const g = new FakeSheets();
    g.failMetadataStatus = 403;
    const err = await g.client().listTabs().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SheetError);
    expect((err as SheetError).status).toBe(403);
    expect((err as SheetError).message).toBe('Google Sheets metadata failed (HTTP 403)');
    expect((err as SheetError).message).not.toContain('secret');
    const offline = new GoogleSheetsClient({
      spreadsheetId: SHEET_ID,
      credentials: creds,
      fetchImpl: (async () => {
        throw new Error('ECONNRESET with details');
      }) as unknown as typeof fetch,
    });
    expect(String(await offline.listTabs().catch((e: unknown) => (e as Error).message))).toBe('Google Sheets token failed');
    const badKey = new GoogleSheetsClient({
      spreadsheetId: SHEET_ID,
      credentials: { client_email: 'x', private_key: 'not a key' },
      fetchImpl: g.fetchImpl as unknown as typeof fetch, // never the real network
    });
    expect(await badKey.listTabs().catch((e: unknown) => (e as SheetError).step)).toBe('sign');
  });

  it('credentials: raw JSON, base64 JSON, escaped newlines; missing / bad → not configured', () => {
    const raw = JSON.stringify({ type: 'service_account', client_email: creds.client_email, private_key: privateKey.replace(/\n/g, '\\n') });
    expect(parseServiceAccountJson(raw)?.private_key).toBe(privateKey);
    expect(parseServiceAccountJson(Buffer.from(raw).toString('base64'))?.client_email).toBe(creds.client_email);
    expect(parseServiceAccountJson('{"client_email":"x"}')).toBeNull();
    expect(parseServiceAccountJson('')).toBeNull();
    expect(createSheetsClient(SHEET_ID, '').reason).toBe('no-credentials');
    expect(createSheetsClient(SHEET_ID, 'garbage').reason).toBe('bad-credentials');
    expect(createSheetsClient('', raw).reason).toBe('no-sheet-id');
    expect(createSheetsClient(SHEET_ID, raw).client).toBeInstanceOf(GoogleSheetsClient);
  });

  it('a1Range quotes the tab; contiguousRuns groups row indices', () => {
    expect(a1Range('聊天紀錄', 'A:A')).toBe("'聊天紀錄'!A:A");
    expect(a1Range("Edward's", 'A1')).toBe("'Edward''s'!A1");
    expect(contiguousRuns([7, 1, 2, 3, 9, 8, 3, 12])).toEqual([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
      { start: 12, end: 13 },
    ]);
    expect(contiguousRuns([])).toEqual([]);
  });
});

// ─── ChatExportSheet ──────────────────────────────────────────────────────

describe('ChatExportSheet (tab 聊天紀錄)', () => {
  it('creates both tabs with a frozen header row when they are missing (other tabs untouched)', async () => {
    const g = new FakeSheets();
    g.tabs.get('工作表1')!.rows.push(['別的資料']);
    const sheet = new ChatExportSheet(g.client());
    await sheet.prepare();
    const adds = g.calls.filter((c) => c.url === `${BASE}:batchUpdate`);
    expect(adds.map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(adds.map((c) => c.body)).toEqual([
      { requests: [{ addSheet: { properties: { title: '聊天紀錄', gridProperties: { frozenRowCount: 1, columnCount: 6 } } } }] },
      { requests: [{ addSheet: { properties: { title: '匯出紀錄', gridProperties: { frozenRowCount: 1, columnCount: 6 } } } }] },
    ]);
    const puts = g.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual([
      `${BASE}/values/${encodeURIComponent("'聊天紀錄'!A1:F1")}?valueInputOption=RAW`,
      `${BASE}/values/${encodeURIComponent("'匯出紀錄'!A1:F1")}?valueInputOption=RAW`,
    ]);
    expect(g.tab()).toEqual([[...CHAT_EXPORT_HEADER]]);
    expect(g.tab(CHAT_EXPORT_LOG_TAB)).toEqual([[...CHAT_EXPORT_LOG_HEADER]]);
    expect(g.tab('工作表1')).toEqual([['別的資料']]);
    // Second time: found, header present → no add, no write.
    const before = g.calls.length;
    await new ChatExportSheet(g.client()).prepare();
    expect(g.calls.slice(before).some((c) => c.url.endsWith(':batchUpdate') || c.method === 'PUT')).toBe(false);
  });

  it('an existing but empty tab gets the header', async () => {
    const g = new FakeSheets();
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 7, rows: [] });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, { sheetId: 8, rows: [[...CHAT_EXPORT_LOG_HEADER]] });
    await new ChatExportSheet(g.client()).prepare();
    expect(g.tab()).toEqual([[...CHAT_EXPORT_HEADER]]);
    expect(g.calls.some((c) => c.url.endsWith(':batchUpdate'))).toBe(false);
  });

  it('appends in batches of 500 (RAW, INSERT_ROWS)', async () => {
    const g = new FakeSheets();
    const sheet = new ChatExportSheet(g.client());
    await sheet.prepare();
    const rows = Array.from({ length: 1234 }, (_, i) => row('2026-10-12', i));
    expect(await sheet.appendRows(rows)).toBe(3);
    const appends = g.calls.filter((c) => c.url.includes(':append'));
    expect(appends.map((c) => (c.body as { values: unknown[] }).values.length)).toEqual([500, 500, 234]);
    expect(appends[0].url).toBe(`${BASE}/values/${encodeURIComponent("'聊天紀錄'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`);
    expect(g.tab()).toHaveLength(1235);
    expect(g.tab()[1]).toEqual(row('2026-10-12', 0));
    expect(g.tab()[1234]).toEqual(row('2026-10-12', 1233));
  });

  it('the export log: one row per claim / 完成, time in +08 with seconds, read back in sheet order', async () => {
    const g = new FakeSheets();
    const sheet = new ChatExportSheet(g.client());
    await sheet.prepare();
    const at = Date.parse('2026-10-12T01:02:03.456Z');
    await sheet.appendLog({ day: '2026-10-11', state: '進行中', rows: 0, channels: 0, at, runId: 'ab12cd34' });
    await sheet.appendLog({ day: '2026-10-11', state: '完成', rows: 1234, channels: 7, at: at + 60_000, runId: 'ab12cd34' });
    const appends = g.calls.filter((c) => c.url.includes(':append'));
    expect(appends[0].url).toBe(`${BASE}/values/${encodeURIComponent("'匯出紀錄'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`);
    expect((appends[0].body as { values: unknown[][] }).values).toEqual([['2026-10-11', '進行中', 0, 0, '2026-10-12T09:02:03+08:00', 'ab12cd34']]);
    g.tab(CHAT_EXPORT_LOG_TAB).push(['備註'], ['2026-10-12', '完成', '1,200', '3', 'not a time', '']);
    expect(await sheet.readLog()).toEqual([
      { day: '2026-10-11', state: '進行中', rows: 0, channels: 0, at: Date.parse('2026-10-12T01:02:03Z'), runId: 'ab12cd34' },
      { day: '2026-10-11', state: '完成', rows: 1234, channels: 7, at: Date.parse('2026-10-12T01:03:03Z'), runId: 'ab12cd34' },
      { day: '2026-10-12', state: '完成', rows: 1200, channels: 3, at: NaN, runId: '' },
    ]);
    // Log rows are pruned by day like the chat rows; the header and notes stay.
    expect(await sheet.deleteLogDays((d) => d < '2026-10-12')).toBe(2);
    expect(g.tab(CHAT_EXPORT_LOG_TAB).map((r) => r[0])).toEqual(['日期', '備註', '2026-10-12']);
  });

  it('deleteDays removes matching rows in one batchUpdate, bottom run first; header and notes stay', async () => {
    const g = new FakeSheets();
    g.tabs.set(CHAT_EXPORT_TAB, {
      sheetId: 42,
      rows: [
        [...CHAT_EXPORT_HEADER],
        row('2026-10-01', 1),
        row('2026-10-01', 2),
        ['備註：這列是人手寫的'],
        row('2026-10-02', 3),
        row('2026-10-01', 4), // out of order on purpose
        row('2026-10-12', 5),
      ],
    });
    const sheet = new ChatExportSheet(g.client());
    await sheet.prepare(); // (also creates 匯出紀錄)
    const afterPrepare = g.calls.length;
    expect(await sheet.deleteDays((d) => d < '2026-10-02')).toBe(3);
    const del = g.calls.slice(afterPrepare).filter((c) => c.url.endsWith(':batchUpdate'));
    expect(del).toHaveLength(1);
    expect((del[0].body as { requests: unknown[] }).requests).toEqual([
      { deleteDimension: { range: { sheetId: 42, dimension: 'ROWS', startIndex: 5, endIndex: 6 } } },
      { deleteDimension: { range: { sheetId: 42, dimension: 'ROWS', startIndex: 1, endIndex: 3 } } },
    ]);
    expect(g.tab().map((r) => r[0])).toEqual(['日期', '備註：這列是人手寫的', '2026-10-02', '2026-10-12']);
    // Nothing matches → no request at all.
    const before = g.calls.length;
    expect(await sheet.deleteDays(() => false)).toBe(0);
    expect(g.calls.slice(before).some((c) => c.url.endsWith(':batchUpdate'))).toBe(false);
    // countDays reads column A only; the cleanup-lock guard false → nothing is deleted.
    expect(await sheet.countDays((d) => d >= '2026-10-02')).toBe(2);
    await expect(sheet.deleteDays((d) => d === '2026-10-12', () => false)).rejects.toBeInstanceOf(ChatCleanupLockLostError);
    expect(g.calls.slice(before).some((c) => c.url.endsWith(':batchUpdate'))).toBe(false);
    expect(g.tab().map((r) => r[0])).toEqual(['日期', '備註：這列是人手寫的', '2026-10-02', '2026-10-12']);
    expect(await sheet.deleteDays((d) => d === '2026-10-12', () => true)).toBe(1);
  });
  it('a tab with another header (someone else’s, or the old 週次 one) is refused before anything is created or written', async () => {
    for (const [title, header] of [
      [CHAT_EXPORT_TAB, ['姓名', '電話']],
      [CHAT_EXPORT_TAB, ['週次', '時間（+08）', '頻道', '來源', '發言者代號', '內容']],
      [CHAT_EXPORT_LOG_TAB, ['週次', '狀態', '列數', '頻道數', '時間（+08）', '執行代號']],
    ] as Array<[string, string[]]>) {
      const g = new FakeSheets();
      g.tabs.set(title, { sheetId: 9, rows: [header, ['2026-10-12', 'x']] });
      const sheet = new ChatExportSheet(g.client());
      const err = await sheet.prepare().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChatTabConflictError);
      expect((err as Error).message).not.toContain(header[0]); // a code, not the cells
      expect(g.calls.some((c) => c.method !== 'GET' && c.url !== GOOGLE_TOKEN_URL)).toBe(false); // nothing created or written
      expect(g.tab(title)).toEqual([header, ['2026-10-12', 'x']]);
      // And no other call works without a successful prepare().
      await expect(sheet.deleteDays(() => true)).rejects.toThrow(/prepare/);
      await expect(sheet.appendRows([row('2026-10-12', 1)])).rejects.toThrow(/prepare/);
    }
  });
});

// ─── End to end: service + sheet + fake Google ────────────────────────────

const TUE_1005 = Date.parse('2026-10-13T02:05:00Z'); // Tue 10/13 10:05 +08 → days 10/06 … 10/12
const DAYS = lastCompleteDays(TUE_1005);
const BUSY_DAY = '2026-10-12';
const MIRROR = '1132901301802504242';
const GENERAL = '2000000000000000001';
const SA_JSON = JSON.stringify(creds);

function chat(i: number, at: number, over: Partial<RawChatMessage> = {}): RawChatMessage {
  return {
    id: String(4_000_000_000_000_000_000n + BigInt(i)),
    channelId: GENERAL,
    createdAt: at,
    authorId: `9${String(i % 3).padStart(17, '0')}`,
    authorIsBot: false,
    authorIsSelf: false,
    webhookId: null,
    system: false,
    content: `訊息 ${i}`,
    attachmentCount: 0,
    ...over,
  };
}

/** Discord with `perDay(day)` messages on each day, one a minute; every 10th is a LINE line relayed by the bot. */
function discordDaily(perDay: (day: string) => number): ChatExportDiscordPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isReady: () => true,
    collect: async (_cfg, w) => {
      calls.push(w.dayKey);
      const messages = Array.from({ length: perDay(w.dayKey) }, (_, i) =>
        chat(
          i,
          w.start + 60_000 * (i + 1),
          i % 10 === 0
            ? { channelId: MIRROR, authorId: 'bot', authorIsBot: true, authorIsSelf: true, content: `[1005 10:00][LINE][小明${i % 4}] 好耶 ${i}` }
            : {},
        ),
      );
      return {
        ...emptyCollectResult(),
        messages,
        channels: [
          { id: GENERAL, name: '一般聊天', isMirror: false },
          { id: MIRROR, name: '阿瓦隆同步', isMirror: true },
        ],
        publicChannelsFound: 1,
      };
    },
  };
}

const busy = (day: string): number => (day === BUSY_DAY ? 620 : 5);

/** One service against `g`: the main target, or (`copy`) the reading copy — config and sheet options as in production. */
function e2e(g: FakeSheets, discord: ChatExportDiscordPort, clock: { now: number }, env: NodeJS.ProcessEnv = {}, opts: { copy?: boolean } = {}) {
  const logs: string[] = [];
  const service = new ChatExportService({
    discord,
    sheetFactory: (cfg) => {
      if (!cfg.sheetId) return { sheet: null, reason: 'no-sheet-id' };
      expect(cfg.sheetId).toBe(g.spreadsheetId);
      return { sheet: new ChatExportSheet(g.client(() => clock.now), cfg.pinChatTabFirst ? { pinChatTabFirst: true } : {}), reason: 'ok' };
    },
    config: () => (opts.copy ? readChatExportReadingCopyConfig(env) : readChatExportConfig(env)),
    now: () => clock.now,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return { service, logs };
}

describe('end to end with the fake Sheets API', () => {
  it('the catch-up writes the last 7 days once (tabs created, 2 batches for a busy day, 完成 per day); a restart does nothing', async () => {
    const g = new FakeSheets();
    const clock = { now: TUE_1005 };
    const discord = discordDaily(busy);
    const first = e2e(g, discord, clock);
    const r = await first.service.tick();
    expect(r.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    const rows = g.tab();
    expect(rows[0]).toEqual([...CHAT_EXPORT_HEADER]);
    expect(rows).toHaveLength(1 + 620 + 6 * 5);
    expect([...new Set(rows.slice(1).map((r) => r[0]))]).toEqual(DAYS); // oldest first
    expect(rows.filter((r) => r[0] === BUSY_DAY && r[3] === 'LINE')).toHaveLength(62);
    expect(rows.filter((r) => r[0] === BUSY_DAY && r[1].startsWith(`${BUSY_DAY} `))).toHaveLength(620); // times on the day itself
    expect(JSON.stringify(rows)).not.toMatch(/小明|9000000/);
    const chatAppend = `${g.base}/values/${encodeURIComponent("'聊天紀錄'!A1")}:append`;
    expect(g.calls.filter((c) => c.url.startsWith(chatAppend))).toHaveLength(6 + 2); // one per quiet day, two for the busy one
    const log = g.tab(CHAT_EXPORT_LOG_TAB);
    expect(log[0]).toEqual([...CHAT_EXPORT_LOG_HEADER]);
    expect(log.slice(1).filter((r) => r[1] === '完成').map((r) => [r[0], r[2], r[3]])).toEqual(
      DAYS.map((d) => [d, d === BUSY_DAY ? '620' : '5', '2']),
    );
    expect(log.slice(1).filter((r) => r[1] === '進行中').map((r) => r[0])).toEqual(DAYS);
    expect(log[1][4]).toBe('2026-10-13T10:05:00+08:00');
    expect(log[1][5]).toBe(first.service.runId);
    expect(first.service.getStatus().lastRun).toMatchObject({ day: BUSY_DAY, messages: 620, channels: 2, outcome: 'written' });
    expect(first.service.getStatus().catchUp).toMatchObject({ exported: 7, skipped: 0, failed: 0, pending: 0 });
    // Logs: counts and dates only.
    expect(first.logs.join('\n')).not.toMatch(/訊息|好耶|小明|一般聊天|阿瓦隆同步/);
    expect((await first.service.tick()).state).toBe('idle');

    // "Restart": a new service, same sheet → every day already exported, nothing appended.
    const appendsBefore = g.appendCount;
    clock.now += 30 * 60_000;
    const second = e2e(g, discordDaily(busy), clock);
    const r2 = await second.service.tick();
    expect(r2.days.map((d) => d.outcome)).toEqual(Array(7).fill('already-exported'));
    expect(g.appendCount).toBe(appendsBefore);
    expect(g.tab()).toHaveLength(1 + 620 + 30);
  });

  it('keeps exactly the last 7 complete days in both tabs (older days deleted after the pass)', async () => {
    const g = new FakeSheets();
    const older = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 5, rows: [[...CHAT_EXPORT_HEADER], ...older.flatMap((d) => [row(d, 1), row(d, 2)])] });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, {
      sheetId: 6,
      rows: [[...CHAT_EXPORT_LOG_HEADER], ...older.map((d) => [d, '完成', '2', '1', '', 'old'])],
    });
    const clock = { now: TUE_1005 };
    const { service } = e2e(g, discordDaily(() => 3), clock);
    await service.tick();
    const logDays = (): string[] => [...new Set(g.tab(CHAT_EXPORT_LOG_TAB).slice(1).filter((r) => r[1] === '進行中' || r[1] === '完成').map((r) => r[0]))];
    const lockRows = (): string[] => g.tab(CHAT_EXPORT_LOG_TAB).slice(1).filter((r) => r[1].startsWith('清理')).map((r) => `${r[0]} ${r[1]}`);
    expect([...new Set(g.tab().slice(1).map((r) => r[0]))]).toEqual(DAYS);
    expect(logDays()).toEqual(DAYS);
    expect(lockRows()).toEqual(['2026-10-13 清理中', '2026-10-13 清理結束']);
    expect(g.tab()[0]).toEqual([...CHAT_EXPORT_HEADER]);
    expect(g.tab(CHAT_EXPORT_LOG_TAB)[0]).toEqual([...CHAT_EXPORT_LOG_HEADER]);
    // The next day at 04:30: the new day comes in, the oldest goes out — still 7.
    clock.now = Date.parse('2026-10-13T20:30:00Z'); // Wed 10/14 04:30 +08
    const r = await service.tick();
    expect(r.days).toEqual([{ day: '2026-10-13', outcome: 'written' }]);
    expect([...new Set(g.tab().slice(1).map((r) => r[0]))]).toEqual(lastCompleteDays(clock.now));
    expect(logDays()).toEqual(lastCompleteDays(clock.now));
    expect(lockRows()).toEqual(['2026-10-13 清理中', '2026-10-13 清理結束', '2026-10-14 清理中', '2026-10-14 清理結束']);
    // A week on, the lock rows of 10/13 go with the days of that time.
    clock.now = Date.parse('2026-10-20T20:30:00Z'); // Wed 10/21 04:30 +08
    await service.tick();
    expect([...new Set(g.tab().slice(1).map((r) => r[0]))]).toEqual(lastCompleteDays(clock.now));
    expect(lockRows().some((l) => l.startsWith('2026-10-13'))).toBe(false);
  });

  it('an append failing half-way: the partial day is removed and the next attempt writes it whole', async () => {
    const g = new FakeSheets();
    // Days before the busy one already done.
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 5, rows: [[...CHAT_EXPORT_HEADER]] });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, { sheetId: 6, rows: [[...CHAT_EXPORT_LOG_HEADER], ...DAYS.slice(0, 6).map((d) => [d, '完成', '0', '0', '', 'old'])] });
    g.failAppendAt = 3; // append 1 = the claim, 2 = batch 1 (lands), 3 = batch 2 (fails)
    const clock = { now: TUE_1005 };
    const { service } = e2e(g, discordDaily(busy), clock);
    const r = await service.tick();
    expect(r.days.at(-1)).toEqual({ day: BUSY_DAY, outcome: 'sheet-error' });
    expect(g.tab()).toEqual([[...CHAT_EXPORT_HEADER]]); // the 500 rows of batch 1 were cleaned up
    clock.now += 60_000;
    expect((await service.tick()).state).toBe('waiting');
    clock.now += 10 * 60_000;
    expect((await service.tick()).days).toEqual([{ day: BUSY_DAY, outcome: 'written' }]);
    expect(g.tab()).toHaveLength(621);
  });

  it('a process killed mid-write: the next one waits for the stale claim, deletes the 500 partial rows, writes 620', async () => {
    const g = new FakeSheets();
    const partial = Array.from({ length: 500 }, (_, i) => row(BUSY_DAY, i));
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 5, rows: [[...CHAT_EXPORT_HEADER], ...partial] });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, {
      sheetId: 6,
      rows: [
        [...CHAT_EXPORT_LOG_HEADER],
        ...DAYS.slice(0, 6).map((d) => [d, '完成', '0', '0', '', 'old']),
        [BUSY_DAY, '進行中', '0', '0', '2026-10-13T10:00:30+08:00', 'deadbeef'],
      ],
    });
    const clock = { now: TUE_1005 };
    const early = e2e(g, discordDaily(busy), clock);
    expect((await early.service.tick()).days.at(-1)).toEqual({ day: BUSY_DAY, outcome: 'claimed-elsewhere' });
    expect(g.tab()).toHaveLength(501); // untouched while the claim is fresh
    clock.now = Date.parse('2026-10-13T02:31:00Z'); // 10:31: the 10:00:30 claim is stale
    const later = e2e(g, discordDaily(busy), clock);
    expect((await later.service.tick()).days.at(-1)).toEqual({ day: BUSY_DAY, outcome: 'written' });
    expect(g.tab()).toHaveLength(621);
    expect(g.tab().slice(1).every((r) => !/^第\d+則$/.test(r[5]))).toBe(true); // the partial rows are gone
    expect(g.tab(CHAT_EXPORT_LOG_TAB).filter((r) => r[0] === BUSY_DAY).map((r) => r[1])).toEqual(['進行中', '進行中', '完成']);
  });
});

describe('two instances against the fake Sheets API (rows deleted by index, like Google)', () => {
  it('both prune at the same moment: no kept day loses a row or its 完成 (one holds the cleanup lock, the other skips)', async () => {
    const g = new FakeSheets();
    g.latencyMs = 1;
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 5, rows: [[...CHAT_EXPORT_HEADER], ...['2026-10-05', ...DAYS].flatMap((d) => [row(d, 1), row(d, 2), row(d, 3)])] });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, {
      sheetId: 6,
      rows: [[...CHAT_EXPORT_LOG_HEADER], ...['2026-10-05', ...DAYS].map((d) => [d, '完成', '3', '1', '2026-10-13T01:00:00+08:00', 'old'])],
    });
    const clock = { now: TUE_1005 };
    const a = e2e(g, discordDaily(() => 3), clock);
    const b = e2e(g, discordDaily(() => 3), clock);
    const [ra, rb] = await Promise.all([a.service.tick(), b.service.tick()]);
    expect([...ra.days, ...rb.days].every((d) => d.outcome === 'already-exported')).toBe(true);
    const chatDays = g.tab().slice(1).map((r) => r[0]);
    for (const d of DAYS) expect(chatDays.filter((x) => x === d)).toHaveLength(3);
    expect(chatDays).toHaveLength(21); // 2026-10-05 gone, nothing else
    const log = g.tab(CHAT_EXPORT_LOG_TAB).slice(1);
    for (const d of DAYS) expect(log.filter((r) => r[0] === d && r[1] === '完成')).toHaveLength(1);
    expect(log.some((r) => r[0] === '2026-10-05')).toBe(false);
    // The lock rows: dated today, one 清理中 + 清理結束 pair per instance.
    expect(log.filter((r) => r[1] === '清理中' || r[1] === '清理結束').map((r) => `${r[0]} ${r[1]}`).sort()).toEqual([
      '2026-10-13 清理中',
      '2026-10-13 清理中',
      '2026-10-13 清理結束',
      '2026-10-13 清理結束',
    ]);
    expect(g.touched().filter((t) => t.method === 'deleteRows')).toHaveLength(2); // one instance, both tabs
  });
});

describe('retention-only and unsure deletes (review fixes 2026-10-13)', () => {
  it('prepareExisting: false (nothing created) without both tabs; true with them', async () => {
    const g = new FakeSheets();
    expect(await new ChatExportSheet(g.client()).prepareExisting()).toBe(false);
    expect(g.touched()).toEqual([{ method: 'GET', tab: '(metadata)' }]);
    await new ChatExportSheet(g.client()).prepare();
    const sheet = new ChatExportSheet(g.client());
    expect(await sheet.prepareExisting()).toBe(true);
    expect(await sheet.countDays(() => true)).toBe(0);
  });

  it('a row delete with no definite answer (network error, 5xx) is reported as outcome unknown; a 4xx is a plain failure', async () => {
    for (const [status, unknown] of [[503, true], [500, true], [400, false]] as const) {
      const g = new FakeSheets();
      const sheet = new ChatExportSheet(g.client());
      await sheet.prepare();
      await sheet.appendRows([['2026-10-01', 'x', 'c', 'Discord', '成員1', 'y']]);
      g.failDeleteStatus = status;
      const err = await sheet.deleteDays(() => true).catch((e: unknown) => e);
      expect(err instanceof ChatDeleteOutcomeUnknownError).toBe(unknown);
      if (!unknown) expect(err).toBeInstanceOf(SheetError);
    }
    // fetch itself failing (timeout / connection reset) on the delete request
    const g = new FakeSheets();
    const client = g.client();
    const sheet = new ChatExportSheet(client);
    await sheet.prepare();
    await sheet.appendRows([['2026-10-01', 'x', 'c', 'Discord', '成員1', 'y']]);
    const orig = g.fetchImpl.getMockImplementation()!;
    g.fetchImpl.mockImplementation(async (input, init) => {
      if (String(input).endsWith(':batchUpdate')) throw new TypeError('fetch failed');
      return orig(input, init);
    });
    expect(await sheet.deleteDays(() => true).catch((e: unknown) => e)).toBeInstanceOf(ChatDeleteOutcomeUnknownError);
  });
});

/** The stats workbook as the importer / cache refresh see it. */
function statsWorkbook(): FakeSheets {
  const g = new FakeSheets(PUBLIC_STATS_SHEET_ID);
  let id = 1;
  for (const tab of STATS_WORKBOOK_TABS) {
    g.tabs.set(tab, { sheetId: id++, rows: [['日期時間', '場次', '配置'], ['2026/10/12', '1', '123456'], ['2026-10-01', 'looks like a day', 'x']] });
  }
  return g;
}

describe('the 阿瓦隆百科 workbook (the default target since 2026-10-13)', () => {
  it('CHAT_EXPORT_ALLOW_PUBLIC_SHEET=0 refuses it: no chat is written; only the tab list is read (retention, nothing there)', async () => {
    for (const env of [
      { CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '0', GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON },
      { CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '0', CHAT_EXPORT_SHEET_ID: PUBLIC_STATS_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON },
    ]) {
      const g = statsWorkbook();
      const before = JSON.stringify([...g.tabs]);
      const clock = { now: TUE_1005 };
      const discord = discordDaily(busy);
      const { service } = e2e(g, discord, clock, env);
      expect((await service.tick()).state).toBe('not-configured');
      expect(g.touched()).toEqual([{ method: 'GET', tab: '(metadata)' }]); // no chat tab there: nothing else
      expect(JSON.stringify([...g.tabs])).toBe(before);
      expect(discord.calls).toEqual([]);
      expect(service.getStatus()).toMatchObject({ sheetConfigured: false, publicSheet: false });
      // The real factory builds no client for a refused id either.
      expect(defaultChatSheetFactory(readChatExportConfig(env))).toEqual({ sheet: null, reason: 'no-sheet-id' });
    }
  });

  it('refused after it was written to: the days older than 7 still leave both chat tabs; nothing is appended, the stats tabs stay', async () => {
    const g = statsWorkbook();
    const clock = { now: TUE_1005 };
    // A week of export first (the default), then CHAT_EXPORT_ALLOW_PUBLIC_SHEET=0.
    await e2e(g, discordDaily(() => 3), clock, { GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON }).service.tick();
    const stats = new Map(STATS_WORKBOOK_TABS.map((t) => [t, JSON.stringify(g.tab(t))]));
    const refused = e2e(g, discordDaily(() => 3), clock, { CHAT_EXPORT_ALLOW_PUBLIC_SHEET: '0', GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON });
    const rowsBefore = g.tab().length;
    clock.now = Date.parse('2026-10-15T20:30:00Z'); // Fri 10/16 04:30 +08: 10/06 … 10/08 left the window
    expect((await refused.service.tick()).state).toBe('not-configured');
    expect([...new Set(g.tab().slice(1).map((r) => r[0]))]).toEqual(DAYS.slice(3));
    expect(g.tab().length).toBe(rowsBefore - 3 * 3);
    expect(g.touched().filter((t) => t.method === 'addSheet')).toHaveLength(2); // only the export's own two, a week before
    for (const t of STATS_WORKBOOK_TABS) expect(JSON.stringify(g.tab(t))).toBe(stats.get(t));
    // No new chat or 完成 row: only the cleanup lock pair in 匯出紀錄.
    expect(g.tab(CHAT_EXPORT_LOG_TAB).slice(1).filter((r) => r[0] === '2026-10-16').map((r) => r[1])).toEqual(['清理中', '清理結束']);
  });

  it('by default only the two chat tabs are created, written, read and pruned — 牌譜 / Discord匯入 / … stay byte for byte', async () => {
    const g = statsWorkbook();
    const before = new Map([...g.tabs].map(([title, t]) => [title, JSON.parse(JSON.stringify(t.rows))]));
    const clock = { now: TUE_1005 };
    const env = { GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON }; // no CHAT_EXPORT_SHEET_ID, no CHAT_EXPORT_ALLOW_PUBLIC_SHEET
    const { service } = e2e(g, discordDaily(() => 4), clock, env);
    expect(service.getStatus()).toMatchObject({ enabled: true, sheetConfigured: true, publicSheet: true });
    expect((await service.tick()).days).toHaveLength(7);
    // Two more passes: the next day's run and the retention that comes with it.
    clock.now = Date.parse('2026-10-13T20:30:00Z'); // Wed 04:30 +08
    await service.tick();
    clock.now = Date.parse('2026-10-14T20:30:00Z'); // Thu 04:30 +08
    await service.tick();
    const touched = g.touched();
    expect(new Set(touched.map((t) => t.tab))).toEqual(new Set(['(metadata)', CHAT_EXPORT_TAB, CHAT_EXPORT_LOG_TAB]));
    expect(touched.filter((t) => t.method === 'addSheet').map((t) => t.tab).sort()).toEqual([CHAT_EXPORT_LOG_TAB, CHAT_EXPORT_TAB].sort());
    expect(touched.filter((t) => t.method === 'deleteRows').map((t) => t.tab).sort()).toEqual([CHAT_EXPORT_LOG_TAB, CHAT_EXPORT_LOG_TAB, CHAT_EXPORT_TAB, CHAT_EXPORT_TAB]);
    // Every spreadsheet request went to this workbook (besides the token endpoint).
    expect(g.calls.every((c) => c.url === GOOGLE_TOKEN_URL || c.url.startsWith(g.base))).toBe(true);
    for (const tab of STATS_WORKBOOK_TABS) expect(g.tab(tab)).toEqual(before.get(tab));
    expect(g.tab('工作表1')).toEqual(before.get('工作表1'));
    const days = lastCompleteDays(clock.now);
    expect([...new Set(g.tab().slice(1).map((r) => r[0]))]).toEqual(days);
    // What anyone with the link sees: speaker codes only, numbered from 成員1 again every day; no name or Discord id.
    const chatRows = g.tab().slice(1);
    expect(chatRows.every((r) => /^成員\d+$/.test(r[4]))).toBe(true);
    for (const d of days) expect(chatRows.find((r) => r[0] === d)?.[4]).toBe('成員1');
    const visible = JSON.stringify([g.tab(), g.tab(CHAT_EXPORT_LOG_TAB)]);
    for (const leaked of ['小明', '900000000000000000', '900000000000000001', '900000000000000002']) expect(visible).not.toContain(leaked);
  });

  it('CHAT_EXPORT_SHEET_ID still picks the private sheet: everything goes there, publicSheet: false', async () => {
    const priv = new FakeSheets(PRIVATE_CHAT_EXPORT_SHEET_ID);
    const clock = { now: TUE_1005 };
    const env = { CHAT_EXPORT_SHEET_ID: PRIVATE_CHAT_EXPORT_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON };
    const { service } = e2e(priv, discordDaily(() => 3), clock, env);
    expect(service.getStatus()).toMatchObject({ enabled: true, sheetConfigured: true, publicSheet: false });
    expect((await service.tick()).days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    expect([...new Set(priv.tab().slice(1).map((r) => r[0]))]).toEqual(DAYS);
    expect(priv.calls.every((c) => c.url === GOOGLE_TOKEN_URL || c.url.startsWith(`${SHEETS_API_BASE}/${PRIVATE_CHAT_EXPORT_SHEET_ID}`))).toBe(true);
  });
});

// ─── The reading copy (first tab of a small private sheet) ────────────────

const PRACTICE_TAB = '練習回報';

/** The reading copy's default sheet as the owner keeps it: an empty 工作表1 and the practice-mode tab 練習回報. */
function privateSheet(): FakeSheets {
  const g = new FakeSheets(PRIVATE_CHAT_EXPORT_SHEET_ID);
  g.tabs.set(PRACTICE_TAB, {
    sheetId: 1,
    rows: [
      ['時間(+08)', '房間', '回合', '第幾次派隊', '機器人座位', '機器人角色', '決策類型', '決策', '機器人理由', '備註'],
      ['2026-10-12 21:00:00', 'room-1', '2', '1', '3', '梅林', 'vote', 'x', 'y', ''],
      ['2026-10-01', 'looks like a day', 'x'],
    ],
  });
  return g;
}

function batchBodies(g: FakeSheets): unknown[] {
  return g.calls.filter((c) => c.url === `${g.base}:batchUpdate`).map((c) => c.body);
}

describe('the reading copy: 聊天紀錄 is the first tab (a CSV export of the spreadsheet is the chat)', () => {
  it('created at index 0; 匯出紀錄 at the end; 工作表1 and 練習回報 neither read nor written', async () => {
    const g = privateSheet();
    const practice = JSON.stringify(g.tab(PRACTICE_TAB));
    await new ChatExportSheet(g.client(), { pinChatTabFirst: true }).prepare();
    expect(batchBodies(g)).toEqual([
      { requests: [{ addSheet: { properties: { title: CHAT_EXPORT_TAB, index: 0, gridProperties: { frozenRowCount: 1, columnCount: 6 } } } }] },
      { requests: [{ addSheet: { properties: { title: CHAT_EXPORT_LOG_TAB, gridProperties: { frozenRowCount: 1, columnCount: 6 } } } }] },
    ]);
    expect(g.order()).toEqual([CHAT_EXPORT_TAB, '工作表1', PRACTICE_TAB, CHAT_EXPORT_LOG_TAB]);
    expect(g.tab()).toEqual([[...CHAT_EXPORT_HEADER]]);
    expect(JSON.stringify(g.tab(PRACTICE_TAB))).toBe(practice);
    expect(g.tab('工作表1')).toEqual([]); // the empty default tab stays (never deleted)
    const tabs = new Set(g.touched().map((t) => t.tab));
    expect(tabs).toEqual(new Set(['(metadata)', CHAT_EXPORT_TAB, CHAT_EXPORT_LOG_TAB]));
    // Next time: already first, header there → nothing sent but the reads.
    const before = g.calls.length;
    await new ChatExportSheet(g.client(), { pinChatTabFirst: true }).prepare();
    expect(g.calls.slice(before).some((c) => c.method !== 'GET' && c.url !== GOOGLE_TOKEN_URL)).toBe(false);
  });

  it('found elsewhere → moved back to index 0 (updateSheetProperties, the index only); the other tabs keep their order and rows', async () => {
    const g = privateSheet();
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 7, rows: [[...CHAT_EXPORT_HEADER], row('2026-10-12', 1)] });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, { sheetId: 8, rows: [[...CHAT_EXPORT_LOG_HEADER]] });
    const contents = JSON.stringify([...g.tabs].map(([title, t]) => [title, t.rows]).sort());
    expect(g.order()).toEqual(['工作表1', PRACTICE_TAB, CHAT_EXPORT_TAB, CHAT_EXPORT_LOG_TAB]);
    await new ChatExportSheet(g.client(), { pinChatTabFirst: true }).prepare();
    expect(batchBodies(g)).toEqual([{ requests: [{ updateSheetProperties: { properties: { sheetId: 7, index: 0 }, fields: 'index' } }] }]);
    expect(g.order()).toEqual([CHAT_EXPORT_TAB, '工作表1', PRACTICE_TAB, CHAT_EXPORT_LOG_TAB]);
    expect(JSON.stringify([...g.tabs].map(([title, t]) => [title, t.rows]).sort())).toBe(contents);
    expect(g.touched().filter((t) => t.method === 'moveTab')).toEqual([{ method: 'moveTab', tab: CHAT_EXPORT_TAB }]);

    // Already first → no request. The metadata without `index`: the listing order decides.
    const quiet = async (): Promise<boolean> => {
      const n = g.calls.length;
      await new ChatExportSheet(g.client(), { pinChatTabFirst: true }).prepare();
      return !g.calls.slice(n).some((c) => c.url.endsWith(':batchUpdate'));
    };
    expect(await quiet()).toBe(true);
    g.omitIndex = true;
    expect(await quiet()).toBe(true);
    g.moveTo(PRACTICE_TAB, 0); // someone drags 練習回報 in front
    expect(await quiet()).toBe(false);
    expect(g.order()).toEqual([CHAT_EXPORT_TAB, PRACTICE_TAB, '工作表1', CHAT_EXPORT_LOG_TAB]);

    // The main target never moves a tab.
    g.moveTo(CHAT_EXPORT_TAB, 3);
    const n = g.calls.length;
    await new ChatExportSheet(g.client()).prepare();
    expect(g.calls.slice(n).some((c) => c.url.endsWith(':batchUpdate'))).toBe(false);
    expect(g.order()[3]).toBe(CHAT_EXPORT_TAB);
  });

  it('a pinned tab with another header is still not ours: refused, not moved', async () => {
    const g = privateSheet();
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 9, rows: [['姓名', '電話']] });
    const err = await new ChatExportSheet(g.client(), { pinChatTabFirst: true }).prepare().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatTabConflictError);
    expect(batchBodies(g)).toEqual([]);
    expect(g.order()).toEqual(['工作表1', PRACTICE_TAB, CHAT_EXPORT_TAB]);
  });

  it('a refused move (e.g. a protected tab) is best effort: prepare() resolves with a code-only note, both tabs usable; the move is tried again next time', async () => {
    const g = privateSheet();
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 7, rows: [[...CHAT_EXPORT_HEADER]] });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, { sheetId: 8, rows: [[...CHAT_EXPORT_LOG_HEADER]] });
    g.failMoveStatus = 403;
    const sheet = new ChatExportSheet(g.client(), { pinChatTabFirst: true });
    expect(await sheet.prepare()).toEqual({ pinFailed: 'Google Sheets move-tab failed (HTTP 403)' });
    expect(await sheet.appendRows([row('2026-10-12', 1)])).toBe(1); // prepared: the other calls work
    expect(g.order()).toEqual(['工作表1', PRACTICE_TAB, CHAT_EXPORT_TAB, CHAT_EXPORT_LOG_TAB]);
    g.failMoveStatus = 0;
    expect(await new ChatExportSheet(g.client(), { pinChatTabFirst: true }).prepare()).toBeUndefined();
    expect(g.order()[0]).toBe(CHAT_EXPORT_TAB);
    // A missing tab is still created first (no move needed); other failures still fail prepare().
    const h = privateSheet();
    h.failMoveStatus = 403;
    expect(await new ChatExportSheet(h.client(), { pinChatTabFirst: true }).prepare()).toBeUndefined();
    expect(h.order()[0]).toBe(CHAT_EXPORT_TAB);
    h.failMetadataStatus = 500;
    await expect(new ChatExportSheet(h.client(), { pinChatTabFirst: true }).prepare()).rejects.toBeInstanceOf(SheetError);
  });

  it('the production factory: the reading copy\'s sheet gets the chat tab first, the main target\'s does not', async () => {
    const env = { GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON };
    const prev = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA_JSON;
    const priv = privateSheet();
    const pub = statsWorkbook();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith(pub.base) ? pub.fetchImpl(input, init) : priv.fetchImpl(input, init)) as typeof fetch);
    try {
      await defaultChatSheetFactory(readChatExportReadingCopyConfig(env)).sheet!.prepare();
      await defaultChatSheetFactory(readChatExportConfig(env)).sheet!.prepare();
      expect(priv.order()).toEqual([CHAT_EXPORT_TAB, '工作表1', PRACTICE_TAB, CHAT_EXPORT_LOG_TAB]);
      expect(pub.order().slice(-2)).toEqual([CHAT_EXPORT_TAB, CHAT_EXPORT_LOG_TAB]);
      expect(pub.order()[0]).not.toBe(CHAT_EXPORT_TAB);
    } finally {
      fetchSpy.mockRestore();
      if (prev === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = prev;
    }
  });
});

describe('both targets end to end (the 阿瓦隆百科 workbook + the reading copy)', () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON }; // the defaults: main = 百科 workbook, copy = the private sheet

  function both(pub: FakeSheets, priv: FakeSheets, clock: { now: number }) {
    const discord = discordDaily(busy);
    const shared = shareChatExportReads(discord, { now: () => clock.now });
    const main = e2e(pub, shared, clock, env);
    const copy = e2e(priv, shared, clock, env, { copy: true });
    const tick = () => Promise.all([main.service.tick(), copy.service.tick()]);
    return { discord, main, copy, tick };
  }

  /** 完成 rows: day, 列數, 頻道數 (time and run id differ per target). */
  const done = (g: FakeSheets): string[][] => g.tab(CHAT_EXPORT_LOG_TAB).filter((r) => r[1] === '完成').map((r) => [r[0], r[2], r[3]]);

  it('the same rows, days and 完成 in both, each day read from Discord once; the copy\'s first tab is 聊天紀錄; 練習回報 and the stats tabs untouched', async () => {
    const pub = statsWorkbook();
    const priv = privateSheet();
    const statsBefore = new Map(STATS_WORKBOOK_TABS.map((t) => [t, JSON.stringify(pub.tab(t))]));
    const practice = JSON.stringify(priv.tab(PRACTICE_TAB));
    const pubOrder = pub.order();
    const clock = { now: TUE_1005 };
    const { discord, main, copy, tick } = both(pub, priv, clock);
    const [rm, rc] = await tick();
    expect(rm.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    expect(rc.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    expect(discord.calls).toEqual(DAYS); // one read per day for both targets
    expect(priv.tab()).toHaveLength(1 + 620 + 6 * 5);
    expect(priv.tab()).toEqual(pub.tab());
    expect(done(priv)).toEqual(done(pub));
    expect(done(priv).map((r) => r[0])).toEqual(DAYS);
    // The copy: chat first (what a CSV export of the spreadsheet yields); the main target: appended at the end as before.
    expect(priv.order()).toEqual([CHAT_EXPORT_TAB, '工作表1', PRACTICE_TAB, CHAT_EXPORT_LOG_TAB]);
    expect(pub.order()).toEqual([...pubOrder, CHAT_EXPORT_TAB, CHAT_EXPORT_LOG_TAB]);
    expect(pub.touched().some((t) => t.method === 'moveTab')).toBe(false);
    expect(main.service.getStatus()).toMatchObject({ sheetConfigured: true, publicSheet: true });
    expect(copy.service.getStatus()).toMatchObject({ enabled: true, sheetConfigured: true, publicSheet: false });
    expect(copy.service.getStatus().catchUp).toMatchObject({ exported: 7, failed: 0, pending: 0 });

    // The next day at 04:30: the new day in both (read once), the oldest out of both.
    clock.now = Date.parse('2026-10-13T20:30:00Z'); // Wed 10/14 04:30 +08
    const [nm, nc] = await tick();
    expect(nm.days).toEqual([{ day: '2026-10-13', outcome: 'written' }]);
    expect(nc.days).toEqual([{ day: '2026-10-13', outcome: 'written' }]);
    expect(discord.calls).toEqual([...DAYS, '2026-10-13']);
    expect([...new Set(priv.tab().slice(1).map((r) => r[0]))]).toEqual(lastCompleteDays(clock.now));
    expect(priv.tab()).toEqual(pub.tab());
    expect(done(priv)).toEqual(done(pub));
    expect(priv.order()[0]).toBe(CHAT_EXPORT_TAB);

    // Never touched: 練習回報 and 工作表1 in the copy, the stats tabs in the workbook; every request went to its own sheet.
    expect(JSON.stringify(priv.tab(PRACTICE_TAB))).toBe(practice);
    expect(new Set(priv.touched().map((t) => t.tab))).toEqual(new Set(['(metadata)', CHAT_EXPORT_TAB, CHAT_EXPORT_LOG_TAB]));
    for (const t of STATS_WORKBOOK_TABS) expect(JSON.stringify(pub.tab(t))).toBe(statsBefore.get(t));
    expect(priv.calls.every((c) => c.url === GOOGLE_TOKEN_URL || c.url.startsWith(priv.base))).toBe(true);
    expect(pub.calls.every((c) => c.url === GOOGLE_TOKEN_URL || c.url.startsWith(pub.base))).toBe(true);
    // Logs: counts only, in both.
    expect([...main.logs, ...copy.logs].join('\n')).not.toMatch(/訊息|好耶|小明|一般聊天|阿瓦隆同步/);
  });

  it('an earlier version\'s tabs in the private sheet: adopted, 聊天紀錄 moved first, its 完成 days written again so the copy equals the 百科 tab; 練習回報 untouched', async () => {
    const pub = statsWorkbook();
    const priv = privateSheet();
    // What the main export left there before 2026-10-13 (same headers; tabs at the end; 8-hex run ids).
    priv.tabs.set(CHAT_EXPORT_TAB, { sheetId: 7, rows: [[...CHAT_EXPORT_HEADER], row('2026-09-30', 1), row('2026-10-10', 2), row('2026-10-11', 3)] });
    priv.tabs.set(CHAT_EXPORT_LOG_TAB, {
      sheetId: 8,
      rows: [
        [...CHAT_EXPORT_LOG_HEADER],
        ['2026-09-30', '完成', '1', '1', '2026-10-01T04:31:00+08:00', '3f9a1c07'],
        ['2026-10-10', '完成', '1', '1', '2026-10-11T04:31:00+08:00', '3f9a1c07'],
        ['2026-10-11', '進行中', '0', '0', '2026-10-12T04:31:00+08:00', '3f9a1c07'],
      ],
    });
    const practice = JSON.stringify(priv.tab(PRACTICE_TAB));
    const clock = { now: TUE_1005 };
    const { discord, copy, tick } = both(pub, priv, clock);
    const [rm, rc] = await tick();
    expect(rm.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    expect(rc.days.map((d) => d.outcome)).toEqual(Array(7).fill('written')); // 10-10 too: an earlier version's 完成 does not count
    expect(discord.calls).toEqual(DAYS);
    expect(priv.tab()).toEqual(pub.tab()); // the old rows are gone (09-30 pruned, 10-10 / 10-11 replaced)
    expect(priv.order()).toEqual([CHAT_EXPORT_TAB, '工作表1', PRACTICE_TAB, CHAT_EXPORT_LOG_TAB]);
    expect(JSON.stringify(priv.tab(PRACTICE_TAB))).toBe(practice);
    const copyDone = priv.tab(CHAT_EXPORT_LOG_TAB).filter((r) => r[1] === '完成' && r[5].startsWith('copy-'));
    expect(copyDone.map((r) => [r[0], r[2], r[3]])).toEqual(done(pub));
    expect(copy.logs.join('\n')).toContain('day 2026-10-10: its 完成 row was not written by a reading copy');
    // A restart: nothing to do again.
    const again = e2e(priv, discord, clock, env, { copy: true });
    clock.now += 5 * 60_000;
    expect((await again.service.tick()).days.map((d) => d.outcome)).toEqual(Array(7).fill('already-exported'));
    expect(discord.calls).toEqual(DAYS);
  });

  it('a refused tab move never blocks the copy: written, old days pruned (also while Discord is down), a code-only warning', async () => {
    const pub = statsWorkbook();
    const priv = privateSheet();
    priv.tabs.set(CHAT_EXPORT_TAB, { sheetId: 7, rows: [[...CHAT_EXPORT_HEADER], row('2026-09-30', 1), row('2026-10-01', 2)] });
    priv.tabs.set(CHAT_EXPORT_LOG_TAB, { sheetId: 8, rows: [[...CHAT_EXPORT_LOG_HEADER], ['2026-09-30', '完成', '1', '1', '2026-10-01T04:31:00+08:00', 'copy-0a1b2c3d']] });
    priv.failMoveStatus = 403;
    const clock = { now: TUE_1005 };
    const { copy, tick } = both(pub, priv, clock);
    const [, rc] = await tick();
    expect(rc.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
    expect(priv.tab()).toEqual(pub.tab()); // 09-30 and 10-01 pruned
    expect(priv.tab(CHAT_EXPORT_LOG_TAB).some((r) => r[0] === '2026-09-30')).toBe(false);
    expect(copy.logs).toContain('chat tab not moved to the first position (Google Sheets move-tab failed (HTTP 403)) — rows and retention go on; tried again on the next run');
    expect(copy.logs.join('\n')).not.toMatch(/secret detail|1k-ZNY/);
    // Discord down after a restart: the retention alone still runs.
    priv.tab().push(row('2026-10-02', 3));
    clock.now = Date.parse('2026-10-13T20:30:00Z'); // 10/14 04:30 +08: 10-06 leaves the window too
    const down = e2e(priv, { isReady: () => false, collect: async () => emptyCollectResult() }, clock, env, { copy: true });
    expect((await down.service.tick()).state).toBe('discord-not-ready');
    expect([...new Set(priv.tab().slice(1).map((r) => r[0]))]).toEqual(DAYS.slice(1));
    expect(down.logs.join('\n')).toContain('chat tab not moved to the first position (Google Sheets move-tab failed (HTTP 403))');
    // Fixed: the next run moves it.
    priv.failMoveStatus = 0;
    clock.now += 60_000;
    await copy.service.tick();
    expect(priv.order()[0]).toBe(CHAT_EXPORT_TAB);
  });

  it('a failing target never blocks the other; once fixed it catches up on its own', async () => {
    for (const failing of ['copy', 'main'] as const) {
      const pub = statsWorkbook();
      const priv = privateSheet();
      const clock = { now: TUE_1005 };
      const { discord, main, copy, tick } = both(pub, priv, clock);
      const bad = failing === 'copy' ? priv : pub;
      bad.failMetadataStatus = 403; // e.g. the sheet not shared with the service account
      const [rm, rc] = await tick();
      const [ok, ko] = failing === 'copy' ? [rm, rc] : [rc, rm];
      expect(ok.days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
      expect(ko.days).toEqual([{ day: DAYS[0], outcome: 'sheet-error' }]);
      const good = failing === 'copy' ? pub : priv;
      expect(done(good).map((r) => r[0])).toEqual(DAYS);
      expect(bad.tab()).toEqual([]);
      expect((failing === 'copy' ? copy : main).service.getStatus().lastRun?.outcome).toBe('sheet-error');
      // Fixed: 10 minutes later it writes the same 7 days (Discord read again — the shared read is older than 5 minutes).
      bad.failMetadataStatus = 0;
      clock.now += 10 * 60_000;
      const [am, ac] = await tick();
      expect((failing === 'copy' ? ac : am).days.map((d) => d.outcome)).toEqual(Array(7).fill('written'));
      expect((failing === 'copy' ? am : ac).state).toBe('idle');
      expect(priv.tab()).toEqual(pub.tab());
      expect(done(priv)).toEqual(done(pub));
      expect(priv.order()[0]).toBe(CHAT_EXPORT_TAB);
      expect(discord.calls).toEqual([...DAYS, ...DAYS]);
    }
  });
});
