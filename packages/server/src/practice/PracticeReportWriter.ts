/**
 * 「這步怪怪的」 → private Google Sheet tab 「練習回報」.
 *
 * Plain Sheets REST with a service-account JWT, built on the stable
 * low-level helpers of `bots/digest/sheets.ts` (key parsing + RS256 JWT);
 * the server needs no Google SDK. Credentials come from
 * GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON or base64). The tab is created with
 * a header row when missing. Values are written with valueInputOption=RAW so
 * a note can never become a formula. Errors carry the step and HTTP status
 * only — never a response body, and the player's note is never logged.
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  service-account key (already used by the digest)
 *   PRACTICE_REPORT_SHEET_ID     spreadsheet id (default below; `off` disables)
 */
import {
  parseServiceAccountJson,
  buildServiceAccountJwt,
  GOOGLE_TOKEN_URL,
  SHEETS_API_BASE,
} from '../bots/digest/sheets';
import { DECISION_KIND_LABEL_ZH, ROLE_LABEL_ZH, seatLabelZh, type PracticeDecisionKind } from './types';

export const PRACTICE_REPORT_TAB = '練習回報';
export const DEFAULT_PRACTICE_REPORT_SHEET_ID = '1k-ZNYqCnnS__Oc-NLX_ciVmaHOnBwilHbFjXeE5orx8';

export const PRACTICE_REPORT_HEADER = [
  '時間(+08)',
  '房間',
  '回合',
  '第幾次派隊',
  '機器人座位',
  '機器人角色',
  '決策類型',
  '決策',
  '機器人理由',
  '備註',
] as const;

/** A cell holds at most 50,000 characters. */
const CELL_MAX_CHARS = 49_000;

type Credentials = NonNullable<ReturnType<typeof parseServiceAccountJson>>;

export interface PracticeFlagRow {
  /** Epoch ms of the report. */
  at: number;
  roomId: string;
  round: number;
  attempt: number;
  botSeat: number;
  botRole: string;
  kind: PracticeDecisionKind;
  /** The bot's action summary (from the server-side trace). */
  decision: string;
  /** The bot's reason (from the server-side trace, incl. rule). */
  reason: string;
  /** Player's optional note. */
  note: string;
}

/** Anything that can store a flag (the Sheets writer, or a fake in tests). */
export interface PracticeFlagSink {
  appendFlag(row: PracticeFlagRow): Promise<void>;
}

/** 'YYYY-MM-DD HH:mm:ss' in UTC+8 (Taiwan has no DST). */
export function formatTaipeiTime(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function cell(text: string): string {
  return text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS)}…` : text;
}

export function flagRowValues(row: PracticeFlagRow): Array<string | number> {
  return [
    formatTaipeiTime(row.at),
    row.roomId,
    row.round,
    row.attempt,
    seatLabelZh(row.botSeat),
    ROLE_LABEL_ZH[row.botRole] ?? row.botRole,
    DECISION_KIND_LABEL_ZH[row.kind] ?? row.kind,
    cell(row.decision),
    cell(row.reason),
    cell(row.note),
  ];
}

export class PracticeReportError extends Error {
  constructor(
    readonly step: string,
    readonly status: number | null,
  ) {
    super(`練習回報 ${step} failed${status !== null ? ` (HTTP ${status})` : ''}`);
    this.name = 'PracticeReportError';
  }
}

export interface PracticeReportWriterOptions {
  sheetId: string;
  credentials: Credentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class PracticeReportWriter implements PracticeFlagSink {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;
  /** Tab exists and has a header (checked once per process). */
  private tabReady = false;
  /** Writes are serialized so two flags never race to create the tab. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: PracticeReportWriterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  appendFlag(row: PracticeFlagRow): Promise<void> {
    const run = this.queue.then(() => this.doAppend(row));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doAppend(row: PracticeFlagRow): Promise<void> {
    const values: Array<Array<string | number>> = [];
    if (!this.tabReady) {
      const needsHeader = await this.ensureTab();
      if (needsHeader) values.push([...PRACTICE_REPORT_HEADER]);
    }
    values.push(flagRowValues(row));
    const range = encodeURIComponent(`'${PRACTICE_REPORT_TAB}'!A1`);
    await this.call('append', `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: { values },
    });
    this.tabReady = true;
  }

  /** Create the tab when missing; returns true when a header must be written. */
  private async ensureTab(): Promise<boolean> {
    const meta = (await this.call('read-tabs', `?fields=${encodeURIComponent('sheets.properties.title')}`, {
      method: 'GET',
    })) as { sheets?: Array<{ properties?: { title?: string } }> };
    const exists = (meta.sheets ?? []).some((s) => s.properties?.title === PRACTICE_REPORT_TAB);
    if (!exists) {
      await this.call('add-tab', ':batchUpdate', {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { title: PRACTICE_REPORT_TAB } } }] },
      });
      return true;
    }
    const head = (await this.call('read-header', `/values/${encodeURIComponent(`'${PRACTICE_REPORT_TAB}'!A1:J1`)}`, {
      method: 'GET',
    })) as { values?: unknown[][] };
    return !Array.isArray(head.values) || head.values.length === 0 || (head.values[0] ?? []).length === 0;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    let assertion: string;
    try {
      assertion = buildServiceAccountJwt(this.opts.credentials, Math.floor(this.now() / 1000));
    } catch {
      throw new PracticeReportError('sign', null);
    }
    let resp: Response;
    try {
      resp = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
    } catch {
      throw new PracticeReportError('token', null);
    }
    if (!resp.ok) throw new PracticeReportError('token', resp.status);
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new PracticeReportError('token', resp.status);
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
      throw new PracticeReportError(step, null);
    }
    if (!resp.ok) throw new PracticeReportError(step, resp.status);
    return resp.json();
  }
}

export type PracticeReportStatus = 'ok' | 'disabled' | 'no-credentials' | 'bad-credentials';

/** Build the writer from env, or null with the reason it is unavailable. */
export function createPracticeReportWriter(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): { writer: PracticeReportWriter | null; status: PracticeReportStatus } {
  const rawId = (env.PRACTICE_REPORT_SHEET_ID ?? '').trim();
  if (rawId.toLowerCase() === 'off') return { writer: null, status: 'disabled' };
  const sheetId = rawId || DEFAULT_PRACTICE_REPORT_SHEET_ID;
  const rawKey = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!(rawKey ?? '').trim()) return { writer: null, status: 'no-credentials' };
  const credentials = parseServiceAccountJson(rawKey);
  if (!credentials) return { writer: null, status: 'bad-credentials' };
  return { writer: new PracticeReportWriter({ sheetId, credentials, fetchImpl }), status: 'ok' };
}

/** Chinese explanation for the review panel when saving is unavailable. */
export function practiceReportUnavailableReason(status: PracticeReportStatus): string | undefined {
  switch (status) {
    case 'ok':
      return undefined;
    case 'disabled':
      return '這台伺服器關閉了練習回報（PRACTICE_REPORT_SHEET_ID=off），「這步怪怪的」目前無法儲存。';
    case 'no-credentials':
      return '這台伺服器沒有設定 Google 服務帳號（GOOGLE_SERVICE_ACCOUNT_JSON），「這步怪怪的」目前無法儲存。';
    case 'bad-credentials':
      return '這台伺服器的 Google 服務帳號設定無法使用，「這步怪怪的」目前無法儲存。';
  }
}
