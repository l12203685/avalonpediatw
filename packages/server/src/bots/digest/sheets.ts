/**
 * Append the weekly digest to a private Google Sheet the AI manager reads.
 *
 * Plain Sheets REST + a service-account JWT signed with node:crypto (RS256),
 * so the server needs no Google SDK. Credentials come from
 * GOOGLE_SERVICE_ACCOUNT_JSON (the service account's JSON key; raw JSON or
 * base64 of it). Only the summary is written — never the chat transcript.
 * Errors carry the HTTP status only, never a response body.
 */

import crypto from 'crypto';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export const SHEET_HEADER = ['週次', '期間', '訊息數', '頻道數', '省略數', '模型', '產生時間', '摘要全文'] as const;

/** A cell holds at most 50,000 characters. */
const CELL_MAX_CHARS = 49_000;

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export interface DigestSheetRow {
  /** +08 Monday of the summarized week (YYYY-MM-DD). */
  week: string;
  period: string;
  messages: number;
  channels: number;
  omitted: number;
  model: string;
  /** ISO time the summary was produced. */
  generatedAt: string;
  summary: string;
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

export function rowValues(row: DigestSheetRow): Array<string | number> {
  const summary = row.summary.length > CELL_MAX_CHARS ? `${row.summary.slice(0, CELL_MAX_CHARS)}…` : row.summary;
  return [row.week, row.period, row.messages, row.channels, row.omitted, row.model, row.generatedAt, summary];
}

export interface DigestSheetWriterOptions {
  sheetId: string;
  credentials: ServiceAccountCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class DigestSheetWriter {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: DigestSheetWriterOptions) {
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
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SheetError('token', resp.status);
    this.token = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  private async call(step: string, path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const token = await this.accessToken();
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${SHEETS_API_BASE}/${encodeURIComponent(this.opts.sheetId)}${path}`, {
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
    return resp.json();
  }

  private async readRange(range: string): Promise<unknown[][]> {
    const json = (await this.call('read', `/values/${encodeURIComponent(range)}`, { method: 'GET' })) as { values?: unknown[][] };
    return Array.isArray(json?.values) ? json.values : [];
  }

  private async append(values: Array<Array<string | number>>): Promise<void> {
    await this.call('append', `/values/${encodeURIComponent('A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: { values },
    });
  }

  /** True when a scheduled (non-manual) row for `week` exists (restart idempotency). */
  async hasWeek(week: string): Promise<boolean> {
    const rows = await this.readRange('A:B');
    return rows.some((r) => String(r[0] ?? '') === week && !String(r[1] ?? '').includes('手動'));
  }

  /** Append one row to the first sheet; writes the header first when the sheet is empty. */
  async appendRow(row: DigestSheetRow): Promise<void> {
    const head = await this.readRange('A1:H1');
    const values: Array<Array<string | number>> = [];
    if (head.length === 0 || (head[0] ?? []).length === 0) values.push([...SHEET_HEADER]);
    values.push(rowValues(row));
    await this.append(values);
  }
}

/** Build a writer from config, or null with the reason it is not configured. */
export function createDigestSheetWriter(
  sheetId: string,
  credentialsJson: string | undefined,
  fetchImpl?: typeof fetch,
): { writer: DigestSheetWriter | null; reason: 'ok' | 'no-sheet-id' | 'no-credentials' | 'bad-credentials' } {
  if (!sheetId) return { writer: null, reason: 'no-sheet-id' };
  if (!(credentialsJson || '').trim()) return { writer: null, reason: 'no-credentials' };
  const credentials = parseServiceAccountJson(credentialsJson);
  if (!credentials) return { writer: null, reason: 'bad-credentials' };
  return { writer: new DigestSheetWriter({ sheetId, credentials, fetchImpl }), reason: 'ok' };
}
