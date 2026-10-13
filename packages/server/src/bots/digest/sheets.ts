/**
 * Google Sheets from the server with a service account — shared helper.
 *
 * Plain Sheets REST + a service-account JWT signed with node:crypto (RS256),
 * so the server needs no Google SDK. Credentials come from
 * GOOGLE_SERVICE_ACCOUNT_JSON (the service account's JSON key; raw JSON or
 * base64 of it). Errors carry the step and the HTTP status only, never a
 * response body (it can echo the values that were sent).
 *
 * Users: the weekly chat-log export (bots/chatExport, 2026-10-13). The path
 * bots/digest/sheets.ts is historical (the paid weekly digest it was written
 * for is gone) and is kept because other code imports parseServiceAccountJson,
 * buildServiceAccountJwt, base64url, SHEETS_SCOPE, GOOGLE_TOKEN_URL and
 * SHEETS_API_BASE from here — keep those exports and their signatures.
 *
 * Every value is written with valueInputOption=RAW: a chat line such as
 * "=SUM(A1)" stays text and never becomes a formula.
 */

import crypto from 'crypto';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/** Parse the service-account key (raw JSON or base64 JSON). Null when unusable. */
export function parseServiceAccountJson(raw: string | undefined): ServiceAccountCredentials | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const candidates = [text];
  if (!text.startsWith('{')) {
    try {
      candidates.push(Buffer.from(text, 'base64').toString('utf8').trim());
    } catch {
      // not base64 either
    }
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Partial<ServiceAccountCredentials>;
      if (typeof obj.client_email === 'string' && typeof obj.private_key === 'string' && obj.client_email && obj.private_key) {
        // A key pasted through a single-line field sometimes keeps "\n" as two characters.
        const privateKey = obj.private_key.includes('\\n') ? obj.private_key.replace(/\\n/g, '\n') : obj.private_key;
        return { client_email: obj.client_email, private_key: privateKey };
      }
    } catch {
      // try the next form
    }
  }
  return null;
}

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** RS256 JWT assertion for the OAuth2 jwt-bearer grant (valid one hour). */
export function buildServiceAccountJwt(creds: ServiceAccountCredentials, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: creds.client_email, scope: SHEETS_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${base64url(signer.sign(creds.private_key))}`;
}

export class SheetError extends Error {
  constructor(
    readonly step: string,
    readonly status: number | null,
  ) {
    super(`Google Sheets ${step} failed${status !== null ? ` (HTTP ${status})` : ''}`);
    this.name = 'SheetError';
  }
}

/** `'tab name'!A1:F1` — the tab name quoted (an apostrophe inside it doubled). */
export function a1Range(tab: string, cells: string): string {
  return `'${tab.replace(/'/g, "''")}'!${cells}`;
}

export type CellValue = string | number;

export interface SheetTab {
  /** Numeric id of the tab (gid), needed for row deletion. */
  sheetId: number;
  title: string;
}

/** A half-open run of 0-based row indices [start, end) on one tab. */
export interface RowRun {
  start: number;
  end: number;
}

/** Group 0-based row indices into contiguous runs (input in any order). */
export function contiguousRuns(indices: number[]): RowRun[] {
  const sorted = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0).sort((a, b) => a - b);
  const runs: RowRun[] = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else runs.push({ start: i, end: i + 1 });
  }
  return runs;
}

export interface GoogleSheetsClientOptions {
  spreadsheetId: string;
  credentials: ServiceAccountCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The few Sheets calls the server needs: list / add tabs, read, overwrite,
 * append, delete rows. One access token is reused until a minute before it
 * expires.
 */
export class GoogleSheetsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: GoogleSheetsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    let assertion: string;
    try {
      assertion = buildServiceAccountJwt(this.opts.credentials, Math.floor(this.now() / 1000));
    } catch {
      throw new SheetError('sign', null); // unusable private key; the crypto error is not passed on
    }
    let resp: Response;
    try {
      resp = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
    } catch {
      throw new SheetError('token', null);
    }
    if (!resp.ok) throw new SheetError('token', resp.status);
    const json = (await resp.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SheetError('token', resp.status);
    this.token = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  /** `path` is appended to …/spreadsheets/{id} (e.g. "/values/…", ":batchUpdate", "?fields=…"). */
  private async call(step: string, path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const token = await this.accessToken();
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${SHEETS_API_BASE}/${encodeURIComponent(this.opts.spreadsheetId)}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new SheetError(step, null);
    }
    if (!resp.ok) throw new SheetError(step, resp.status);
    return resp.json().catch(() => ({}));
  }

  /** Every tab of the spreadsheet (id and title only). */
  async listTabs(): Promise<SheetTab[]> {
    const fields = encodeURIComponent('sheets.properties(sheetId,title)');
    const json = (await this.call('metadata', `?fields=${fields}`, { method: 'GET' })) as {
      sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
    };
    return (json?.sheets ?? [])
      .map((s) => ({ sheetId: Number(s.properties?.sheetId ?? NaN), title: String(s.properties?.title ?? '') }))
      .filter((t) => Number.isInteger(t.sheetId) && t.title !== '');
  }

  /** Add a tab; returns its numeric id. */
  async addTab(title: string, opts: { frozenRows?: number; columns?: number } = {}): Promise<number> {
    const gridProperties: Record<string, number> = {};
    if (opts.frozenRows) gridProperties.frozenRowCount = opts.frozenRows;
    if (opts.columns) gridProperties.columnCount = opts.columns;
    const json = (await this.batchUpdate('add-tab', [
      { addSheet: { properties: { title, ...(Object.keys(gridProperties).length ? { gridProperties } : {}) } } },
    ])) as { replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }> };
    const id = Number(json?.replies?.[0]?.addSheet?.properties?.sheetId ?? NaN);
    if (!Number.isInteger(id)) throw new SheetError('add-tab', null);
    return id;
  }

  /** Values of `range` (rows of cells; trailing empty rows and cells are omitted by the API). */
  async readValues(range: string): Promise<unknown[][]> {
    const json = (await this.call('read', `/values/${encodeURIComponent(range)}`, { method: 'GET' })) as { values?: unknown[][] };
    return Array.isArray(json?.values) ? json.values : [];
  }

  /** Overwrite `range` with `values` (RAW). */
  async updateValues(range: string, values: CellValue[][]): Promise<void> {
    await this.call('update', `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: 'PUT', body: { values } });
  }

  /** Append `values` after the table found at `range` (RAW, new rows inserted). */
  async appendValues(range: string, values: CellValue[][]): Promise<void> {
    await this.call('append', `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: { values },
    });
  }

  /** Delete the given row runs of one tab in a single batchUpdate (bottom run first, so indices stay valid). */
  async deleteRows(sheetId: number, runs: RowRun[]): Promise<void> {
    if (runs.length === 0) return;
    const requests = [...runs]
      .sort((a, b) => b.start - a.start)
      .map((r) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r.start, endIndex: r.end } } }));
    await this.batchUpdate('delete-rows', requests);
  }

  async batchUpdate(step: string, requests: unknown[]): Promise<unknown> {
    return this.call(step, ':batchUpdate', { method: 'POST', body: { requests } });
  }
}

export type SheetsClientReason = 'ok' | 'no-sheet-id' | 'no-credentials' | 'bad-credentials';

/** Build a client from config, or null with the reason it is not configured. */
export function createSheetsClient(
  spreadsheetId: string,
  credentialsJson: string | undefined,
  fetchImpl?: typeof fetch,
): { client: GoogleSheetsClient | null; reason: SheetsClientReason } {
  if (!spreadsheetId) return { client: null, reason: 'no-sheet-id' };
  if (!(credentialsJson || '').trim()) return { client: null, reason: 'no-credentials' };
  const credentials = parseServiceAccountJson(credentialsJson);
  if (!credentials) return { client: null, reason: 'bad-credentials' };
  return { client: new GoogleSheetsClient({ spreadsheetId, credentials, fetchImpl }), reason: 'ok' };
}
