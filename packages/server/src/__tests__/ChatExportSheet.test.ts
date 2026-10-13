/**
 * Weekly chat-log export (2026-10-13) — Google Sheets, against an in-memory
 * fake of the Sheets REST API (mocked fetch, no network):
 *
 *   digest/sheets.ts — service-account JWT (RS256, verified with a throwaway
 *                      RSA key), token reuse, errors carry the HTTP status
 *                      only, credentials parsing, a1Range / contiguousRuns
 *   ChatExportSheet  — tabs 「聊天紀錄」 and 「匯出紀錄」 created with their
 *                      headers when missing (addSheet), header filled into
 *                      an empty existing tab, appends in batches of 500 with
 *                      RAW input, the export log written and read back
 *                      (+08 time with seconds), deleteWeeks (bottom run
 *                      first; header and non-date rows never touched)
 *   end to end       — ChatExportService + ChatExportSheet: export with a
 *                      完成 row, restart idempotency, 8-week pruning of both
 *                      tabs, a half-written week cleaned up and rewritten, a
 *                      process killed mid-write taken over after its claim
 *                      went stale
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
import { ChatExportSheet } from '../bots/chatExport/sheetWriter';
import {
  CHAT_EXPORT_HEADER,
  CHAT_EXPORT_LOG_HEADER,
  CHAT_EXPORT_LOG_TAB,
  CHAT_EXPORT_TAB,
  readChatExportConfig,
} from '../bots/chatExport/config';
import { ChatExportService } from '../bots/chatExport/service';
import type { ChatExportDiscordPort } from '../bots/chatExport/discordPort';
import type { RawChatMessage } from '../bots/chatExport/rows';
import type { ChatExportRow } from '../bots/chatExport/rows';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const creds = { client_email: 'chat-export-test@example-project.iam.gserviceaccount.com', private_key: privateKey };
const SHEET_ID = '1k-ZNYqCnnS__Oc-NLX_ciVmaHOnBwilHbFjXeE5orx8';
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

/** The two batchUpdate requests the code sends. */
interface BatchRequest {
  addSheet?: { properties: { title: string } };
  deleteDimension?: { range: { sheetId: number; dimension: string; startIndex: number; endIndex: number } };
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

class FakeSheets {
  readonly tabs = new Map<string, FakeTab>([['工作表1', { sheetId: 0, rows: [] }]]);
  readonly calls: Call[] = [];
  private nextId = 100;
  /** Fail the n-th append call (1-based) with this status; 0 = never. */
  failAppendAt = 0;
  failAppendStatus = 500;
  failDeleteStatus = 0;
  failMetadataStatus = 0;
  appendCount = 0;

  readonly fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init?.body;
    this.calls.push({ method, url, body });
    if (url === GOOGLE_TOKEN_URL) return json({ access_token: 'ya29.test-token', expires_in: 3600 });
    if (!url.startsWith(BASE)) return json({}, 404);
    const rest = url.slice(BASE.length);
    if (rest.startsWith('?fields=')) {
      if (this.failMetadataStatus) return json({ error: 'secret detail' }, this.failMetadataStatus);
      return json({ sheets: [...this.tabs].map(([title, t]) => ({ properties: { sheetId: t.sheetId, title } })) });
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
        replies.push({ addSheet: { properties: { sheetId: id, title: r.addSheet.properties.title } } });
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

  tab(title = CHAT_EXPORT_TAB): string[][] {
    return this.tabs.get(title)?.rows ?? [];
  }

  client(now?: () => number): GoogleSheetsClient {
    return new GoogleSheetsClient({ spreadsheetId: SHEET_ID, credentials: creds, fetchImpl: this.fetchImpl as unknown as typeof fetch, now });
  }
}

function row(week: string, i: number): ChatExportRow {
  return [week, `${week} 12:${String(i % 60).padStart(2, '0')}`, '一般聊天', 'Discord', `成員${(i % 7) + 1}`, `第${i}則`];
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
    expect(g.calls[1].url).toBe(`${BASE}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`);
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
    const badKey = new GoogleSheetsClient({ spreadsheetId: SHEET_ID, credentials: { client_email: 'x', private_key: 'not a key' } });
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
    const rows = Array.from({ length: 1234 }, (_, i) => row('2026-10-05', i));
    expect(await sheet.appendRows(rows)).toBe(3);
    const appends = g.calls.filter((c) => c.url.includes(':append'));
    expect(appends.map((c) => (c.body as { values: unknown[] }).values.length)).toEqual([500, 500, 234]);
    expect(appends[0].url).toBe(`${BASE}/values/${encodeURIComponent("'聊天紀錄'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`);
    expect(g.tab()).toHaveLength(1235);
    expect(g.tab()[1]).toEqual(row('2026-10-05', 0));
    expect(g.tab()[1234]).toEqual(row('2026-10-05', 1233));
  });

  it('the export log: one row per claim / 完成, time in +08 with seconds, read back in sheet order', async () => {
    const g = new FakeSheets();
    const sheet = new ChatExportSheet(g.client());
    await sheet.prepare();
    const at = Date.parse('2026-10-12T01:02:03.456Z');
    await sheet.appendLog({ week: '2026-10-05', state: '進行中', rows: 0, channels: 0, at, runId: 'ab12cd34' });
    await sheet.appendLog({ week: '2026-10-05', state: '完成', rows: 1234, channels: 7, at: at + 60_000, runId: 'ab12cd34' });
    const appends = g.calls.filter((c) => c.url.includes(':append'));
    expect(appends[0].url).toBe(`${BASE}/values/${encodeURIComponent("'匯出紀錄'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`);
    expect((appends[0].body as { values: unknown[][] }).values).toEqual([['2026-10-05', '進行中', 0, 0, '2026-10-12T09:02:03+08:00', 'ab12cd34']]);
    g.tab(CHAT_EXPORT_LOG_TAB).push(['備註'], ['2026-10-12', '完成', '1,200', '3', 'not a time', '']);
    expect(await sheet.readLog()).toEqual([
      { week: '2026-10-05', state: '進行中', rows: 0, channels: 0, at: Date.parse('2026-10-12T01:02:03Z'), runId: 'ab12cd34' },
      { week: '2026-10-05', state: '完成', rows: 1234, channels: 7, at: Date.parse('2026-10-12T01:03:03Z'), runId: 'ab12cd34' },
      { week: '2026-10-12', state: '完成', rows: 1200, channels: 3, at: NaN, runId: '' },
    ]);
    // Log rows are pruned by week like the chat rows; the header and notes stay.
    expect(await sheet.deleteLogWeeks((w) => w < '2026-10-12')).toBe(2);
    expect(g.tab(CHAT_EXPORT_LOG_TAB).map((r) => r[0])).toEqual(['週次', '備註', '2026-10-12']);
  });

  it('deleteWeeks removes matching rows in one batchUpdate, bottom run first; header and notes stay', async () => {
    const g = new FakeSheets();
    g.tabs.set(CHAT_EXPORT_TAB, {
      sheetId: 42,
      rows: [
        [...CHAT_EXPORT_HEADER],
        row('2026-08-10', 1),
        row('2026-08-10', 2),
        ['備註：這列是人手寫的'],
        row('2026-08-17', 3),
        row('2026-08-10', 4), // out of order on purpose
        row('2026-10-05', 5),
      ],
    });
    const sheet = new ChatExportSheet(g.client());
    await sheet.prepare(); // (also creates 匯出紀錄)
    const afterPrepare = g.calls.length;
    expect(await sheet.deleteWeeks((w) => w < '2026-08-17')).toBe(3);
    const del = g.calls.slice(afterPrepare).filter((c) => c.url.endsWith(':batchUpdate'));
    expect(del).toHaveLength(1);
    expect((del[0].body as { requests: unknown[] }).requests).toEqual([
      { deleteDimension: { range: { sheetId: 42, dimension: 'ROWS', startIndex: 5, endIndex: 6 } } },
      { deleteDimension: { range: { sheetId: 42, dimension: 'ROWS', startIndex: 1, endIndex: 3 } } },
    ]);
    expect(g.tab().map((r) => r[0])).toEqual(['週次', '備註：這列是人手寫的', '2026-08-17', '2026-10-05']);
    // Nothing matches → no request at all.
    const before = g.calls.length;
    expect(await sheet.deleteWeeks(() => false)).toBe(0);
    expect(g.calls.slice(before).some((c) => c.url.endsWith(':batchUpdate'))).toBe(false);
  });
});

// ─── End to end: service + sheet + fake Google ────────────────────────────

const MONDAY_0905 = Date.parse('2026-10-12T01:05:00Z'); // Mon 09:05 +08 → week 2026-10-05
const MIRROR = '1132901301802504242';
const GENERAL = '2000000000000000001';

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

function discordWith(messages: RawChatMessage[]): ChatExportDiscordPort {
  return {
    isReady: () => true,
    collect: async () => ({
      messages,
      channels: [
        { id: GENERAL, name: '一般聊天', isMirror: false },
        { id: MIRROR, name: '阿瓦隆同步', isMirror: true },
      ],
      truncatedChannels: 0,
      failedChannels: 0,
      publicChannelsFound: 1,
    }),
  };
}

function e2e(g: FakeSheets, messages: RawChatMessage[], now = MONDAY_0905) {
  const logs: string[] = [];
  const service = new ChatExportService({
    discord: discordWith(messages),
    sheetFactory: () => ({ sheet: new ChatExportSheet(g.client(() => now)), reason: 'ok' }),
    config: () => readChatExportConfig({}),
    now: () => now,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return { service, logs };
}

describe('end to end with the fake Sheets API', () => {
  const weekStart = Date.parse('2026-10-04T16:00:00Z'); // Mon 10/05 00:00 +08
  const messages = Array.from({ length: 620 }, (_, i) =>
    chat(i, weekStart + 60_000 * (i + 1), i % 10 === 0 ? { channelId: MIRROR, authorId: 'bot', authorIsBot: true, authorIsSelf: true, content: `[1005 10:00][LINE][小明${i % 4}] 好耶 ${i}` } : {}),
  );

  it('exports the week once (tabs created, 2 append batches, 完成 logged), then a restart finds it and does nothing', async () => {
    const g = new FakeSheets();
    const first = e2e(g, messages);
    expect(await first.service.tick()).toBe('written');
    const rows = g.tab();
    expect(rows[0]).toEqual([...CHAT_EXPORT_HEADER]);
    expect(rows).toHaveLength(621);
    expect(new Set(rows.slice(1).map((r) => r[0]))).toEqual(new Set(['2026-10-05']));
    expect(rows.filter((r) => r[3] === 'LINE')).toHaveLength(62);
    expect(JSON.stringify(rows)).not.toMatch(/小明|9000000/);
    const chatAppend = `${BASE}/values/${encodeURIComponent("'聊天紀錄'!A1")}:append`;
    expect(g.calls.filter((c) => c.url.startsWith(chatAppend))).toHaveLength(2);
    const log = g.tab(CHAT_EXPORT_LOG_TAB);
    expect(log.map((r) => r.slice(0, 4))).toEqual([
      [...CHAT_EXPORT_LOG_HEADER].slice(0, 4),
      ['2026-10-05', '進行中', '0', '0'],
      ['2026-10-05', '完成', '620', '2'],
    ]);
    expect(log[1][4]).toBe('2026-10-12T09:05:00+08:00');
    expect(log[1][5]).toBe(first.service.runId);
    expect(first.service.getStatus().lastRun).toMatchObject({ week: '2026-10-05', messages: 620, channels: 2, outcome: 'written' });
    // Logs: counts only.
    expect(first.logs.join('\n')).not.toMatch(/訊息|好耶|小明|一般聊天|阿瓦隆同步/);
    expect(await first.service.tick()).toBe('done');

    // "Restart": a new service, same sheet → already exported, nothing appended.
    const appendsBefore = g.appendCount;
    const second = e2e(g, messages, MONDAY_0905 + 30 * 60_000);
    expect(await second.service.tick()).toBe('already-exported');
    expect(g.appendCount).toBe(appendsBefore);
    expect(g.tab()).toHaveLength(621);
    expect(second.service.getStatus().lastRun).toMatchObject({ outcome: 'already-exported', messages: 0 });
  });

  it('keeps the last 8 weeks: older weeks are deleted after the export', async () => {
    const g = new FakeSheets();
    const old: string[][] = [[...CHAT_EXPORT_HEADER]];
    // Ten earlier weeks, oldest first: 2026-07-27 … 2026-09-28.
    for (let k = 10; k >= 1; k -= 1) {
      const wk = new Date(Date.parse('2026-10-05T00:00:00Z') - k * 7 * 86_400_000).toISOString().slice(0, 10);
      old.push(row(wk, k), row(wk, k + 100));
    }
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 5, rows: old });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, {
      sheetId: 6,
      rows: [[...CHAT_EXPORT_LOG_HEADER], ...old.slice(1).filter((_, i) => i % 2 === 0).map((r) => [r[0], '完成', '2', '1', '', 'old'])],
    });
    const { service } = e2e(g, messages.slice(0, 3));
    expect(await service.tick()).toBe('written');
    const kept = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
    expect([...new Set(g.tab().slice(1).map((r) => r[0]))]).toEqual(kept);
    expect([...new Set(g.tab(CHAT_EXPORT_LOG_TAB).slice(1).map((r) => r[0]))]).toEqual(kept);
    expect(g.tab(CHAT_EXPORT_LOG_TAB)[0]).toEqual([...CHAT_EXPORT_LOG_HEADER]);
  });

  it('an append failing half-way: the partial week is removed and the next attempt writes it whole', async () => {
    const g = new FakeSheets();
    g.failAppendAt = 3; // append 1 = the claim, 2 = batch 1 (lands), 3 = batch 2 (fails)
    const now = { t: MONDAY_0905 };
    const service = new ChatExportService({
      discord: discordWith(messages),
      sheetFactory: () => ({ sheet: new ChatExportSheet(g.client(() => now.t)), reason: 'ok' }),
      config: () => readChatExportConfig({}),
      now: () => now.t,
      logger: { info: () => undefined, warn: () => undefined },
    });
    expect(await service.tick(now.t)).toBe('retry');
    expect(g.tab()).toEqual([[...CHAT_EXPORT_HEADER]]); // the 500 rows of batch 1 were cleaned up
    expect(service.getStatus().lastRun?.outcome).toBe('sheet-error');
    expect(await service.tick(now.t + 60_000)).toBe('waiting');
    now.t += 11 * 60_000;
    expect(await service.tick(now.t)).toBe('written');
    expect(g.tab()).toHaveLength(621);
  });

  it('a process killed mid-write: the next one waits for the stale claim, deletes the 500 partial rows, writes 620', async () => {
    const g = new FakeSheets();
    const partial = Array.from({ length: 500 }, (_, i) => row('2026-10-05', i));
    g.tabs.set(CHAT_EXPORT_TAB, { sheetId: 5, rows: [[...CHAT_EXPORT_HEADER], ...partial] });
    g.tabs.set(CHAT_EXPORT_LOG_TAB, {
      sheetId: 6,
      rows: [[...CHAT_EXPORT_LOG_HEADER], ['2026-10-05', '進行中', '0', '0', '2026-10-12T09:00:30+08:00', 'deadbeef']],
    });
    const early = e2e(g, messages, MONDAY_0905);
    expect(await early.service.tick()).toBe('claimed-elsewhere');
    expect(g.tab()).toHaveLength(501); // untouched while the claim is fresh
    const later = e2e(g, messages, Date.parse('2026-10-12T01:31:00Z')); // 09:31: the 09:00:30 claim is stale
    expect(await later.service.tick()).toBe('written');
    expect(g.tab()).toHaveLength(621);
    expect(g.tab().slice(1).every((r) => !/^第\d+則$/.test(r[5]))).toBe(true); // the partial rows are gone
    expect(g.tab(CHAT_EXPORT_LOG_TAB).slice(1).map((r) => r[1])).toEqual(['進行中', '進行中', '完成']);
  });
});
