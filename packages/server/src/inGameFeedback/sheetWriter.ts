/**
 * 遊戲內回饋 → 私人試算表的分頁「遊戲內回饋」（站長 2026-11-26）。
 *
 * 跟「練習回報」同一份私人試算表、同一個服務帳號（practice/PracticeReportWriter.ts 的做法：
 * GOOGLE_SERVICE_ACCOUNT_JSON、Sheets REST、valueInputOption=RAW 讓內容不會變成公式）。
 * 那份試算表也是聊天紀錄「閱讀副本」的所在（bots/chatExport；它的第一個分頁要是「聊天紀錄」，
 * 這裡新增的分頁加在最後面，不會動到順序）。一局結束（局後聊天也收完）才一次寫進去，那時角色已經公開，
 * 才寫「被提到的百科AI 的角色」。錯誤只帶步驟和 HTTP 狀態碼，從不帶回應內容；聊天內容從不寫 log。
 *
 * 環境變數：
 *   GOOGLE_SERVICE_ACCOUNT_JSON   服務帳號（聊天紀錄匯出、練習回報已經在用）
 *   INGAME_FEEDBACK_SHEET_ID      試算表 id 或網址（預設＝私人試算表 PRIVATE_CHAT_EXPORT_SHEET_ID；off 關掉）
 * 公開的 阿瓦隆百科 試算表一律不寫（就算被設成那一份）。
 */

import { buildServiceAccountJwt, GOOGLE_TOKEN_URL, parseServiceAccountJson, SHEETS_API_BASE } from '../bots/digest/sheets';
import { PRIVATE_CHAT_EXPORT_SHEET_ID, PUBLIC_STATS_SHEET_ID, spreadsheetIdFrom } from '../bots/chatExport/config';

export const IN_GAME_FEEDBACK_TAB = '遊戲內回饋';
export const DEFAULT_IN_GAME_FEEDBACK_SHEET_ID = PRIVATE_CHAT_EXPORT_SHEET_ID;

export const IN_GAME_FEEDBACK_HEADER = [
  '時間(+08)',
  '房間',
  '第幾局',
  '本局百科AI 座位',
  '回饋則數',
  '階段',
  '提到的百科AI',
  '那個百科AI 的角色',
  '類型',
  '整局對話（▶＝被挑出的那句，前後各 3 句當脈絡）',
] as const;

/** 一格最多 50,000 字（整局對話那一格自己截在 40,000）。 */
const CELL_MAX_CHARS = 45_000;

type Credentials = NonNullable<ReturnType<typeof parseServiceAccountJson>>;

/** 寫進分頁的值（一列）。 */
export type SheetRow = Array<string | number>;

/** 能收一局的列的東西（Sheets 寫入器，或測試的假東西）。 */
export interface InGameFeedbackSink {
  appendRows(rows: SheetRow[]): Promise<void>;
}

export class InGameFeedbackSheetError extends Error {
  constructor(
    readonly step: string,
    readonly status: number | null,
  ) {
    super(`遊戲內回饋 ${step} failed${status !== null ? ` (HTTP ${status})` : ''}`);
    this.name = 'InGameFeedbackSheetError';
  }
}

export function clipCell(text: string): string {
  return text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS)}…` : text;
}

export interface InGameFeedbackSheetWriterOptions {
  sheetId: string;
  credentials: Credentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class InGameFeedbackSheetWriter implements InGameFeedbackSink {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;
  private tabReady = false;
  /** 一次寫一批，兩局不會同時去建分頁。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: InGameFeedbackSheetWriterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  appendRows(rows: SheetRow[]): Promise<void> {
    const run = this.queue.then(() => this.doAppend(rows));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doAppend(rows: SheetRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values: SheetRow[] = [];
    if (!this.tabReady) {
      const needsHeader = await this.ensureTab();
      if (needsHeader) values.push([...IN_GAME_FEEDBACK_HEADER]);
    }
    values.push(...rows);
    const range = encodeURIComponent(`'${IN_GAME_FEEDBACK_TAB}'!A1`);
    await this.call('append', `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: { values },
    });
    this.tabReady = true;
  }

  /** 沒有分頁就建（加在最後面）；要寫表頭 → true。 */
  private async ensureTab(): Promise<boolean> {
    const meta = (await this.call('read-tabs', `?fields=${encodeURIComponent('sheets.properties.title')}`, {
      method: 'GET',
    })) as { sheets?: Array<{ properties?: { title?: string } }> };
    const tabs = meta.sheets ?? [];
    if (!tabs.some((s) => s.properties?.title === IN_GAME_FEEDBACK_TAB)) {
      await this.call('add-tab', ':batchUpdate', {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { title: IN_GAME_FEEDBACK_TAB, index: tabs.length } } }] },
      });
      return true;
    }
    const head = (await this.call('read-header', `/values/${encodeURIComponent(`'${IN_GAME_FEEDBACK_TAB}'!A1:J1`)}`, {
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
      throw new InGameFeedbackSheetError('sign', null);
    }
    let resp: Response;
    try {
      resp = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
    } catch {
      throw new InGameFeedbackSheetError('token', null);
    }
    if (!resp.ok) throw new InGameFeedbackSheetError('token', resp.status);
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new InGameFeedbackSheetError('token', resp.status);
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
      throw new InGameFeedbackSheetError(step, null);
    }
    if (!resp.ok) throw new InGameFeedbackSheetError(step, resp.status);
    return resp.json();
  }
}

export type InGameFeedbackSheetStatus = 'ok' | 'disabled' | 'public-refused' | 'no-credentials' | 'bad-credentials';

/** 從環境變數建寫入器；不能用時 writer 是 null，status 說為什麼。 */
export function createInGameFeedbackSheetWriter(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): { writer: InGameFeedbackSheetWriter | null; status: InGameFeedbackSheetStatus } {
  const raw = (env.INGAME_FEEDBACK_SHEET_ID ?? '').trim();
  if (['off', 'false', '0', 'no', 'none'].includes(raw.toLowerCase())) return { writer: null, status: 'disabled' };
  const sheetId = spreadsheetIdFrom(raw || DEFAULT_IN_GAME_FEEDBACK_SHEET_ID);
  const publicIds = [PUBLIC_STATS_SHEET_ID, spreadsheetIdFrom((env.AVALON_STATS_SHEET_ID ?? '').trim())].filter(Boolean);
  if (publicIds.includes(sheetId)) return { writer: null, status: 'public-refused' };
  const rawKey = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!(rawKey ?? '').trim()) return { writer: null, status: 'no-credentials' };
  const credentials = parseServiceAccountJson(rawKey);
  if (!credentials) return { writer: null, status: 'bad-credentials' };
  return { writer: new InGameFeedbackSheetWriter({ sheetId, credentials, fetchImpl }), status: 'ok' };
}
