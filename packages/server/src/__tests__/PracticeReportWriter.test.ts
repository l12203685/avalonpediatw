/**
 * 「這步怪怪的」 → Google Sheet tab 「練習回報」 (mocked fetch).
 */
import crypto from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPracticeReportWriter,
  DEFAULT_PRACTICE_REPORT_SHEET_ID,
  flagRowValues,
  formatTaipeiTime,
  PRACTICE_REPORT_HEADER,
  PracticeReportWriter,
  practiceReportUnavailableReason,
  type PracticeFlagRow,
} from '../practice/PracticeReportWriter';
import { GOOGLE_TOKEN_URL, SHEETS_API_BASE } from '../bots/digest/sheets';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const creds = { client_email: 'practice-test@example-project.iam.gserviceaccount.com', private_key: privateKey };
const SHEET_ID = 'sheet-123';
const TAB = encodeURIComponent("'練習回報'!A1");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeGoogle(opts: { tabs?: string[]; header?: unknown[][]; failAppend?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (u === GOOGLE_TOKEN_URL) return json(200, { access_token: 'tok-1', expires_in: 3600 });
    if (u.includes('?fields=')) return json(200, { sheets: (opts.tabs ?? ['工作表1']).map((title) => ({ properties: { title } })) });
    if (u.endsWith(':batchUpdate')) return json(200, { replies: [{}] });
    if (u.includes(':append')) {
      if (opts.failAppend) return json(opts.failAppend, { error: { message: 'secret body' } });
      return json(200, { updates: { updatedRows: 1 } });
    }
    if (init?.method === 'GET') return json(200, opts.header === undefined ? {} : { values: opts.header });
    return json(404, {});
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const ROW: PracticeFlagRow = {
  at: Date.UTC(2026, 9, 13, 4, 5, 6),
  roomId: 'PRACTICE-ABCDEF1234',
  round: 2,
  attempt: 3,
  botSeat: 10,
  botRole: 'morgana',
  kind: 'team_vote',
  decision: '贊成',
  reason: '贊成：自己在隊上。 規則：莫甘娜在隊上一律贊成（紅方規則）',
  note: '=HYPERLINK("x") 這票怪怪的',
};

afterEach(() => vi.restoreAllMocks());

describe('PracticeReportWriter', () => {
  it('creates the tab with a header when missing, then appends the row (RAW)', async () => {
    const g = fakeGoogle({ tabs: ['工作表1'] });
    const w = new PracticeReportWriter({ sheetId: SHEET_ID, credentials: creds, fetchImpl: g.fetchImpl, now: () => ROW.at });
    await w.appendFlag(ROW);

    expect(g.calls.map((c) => `${c.method} ${c.url.replace(SHEETS_API_BASE, 'API')}`)).toEqual([
      `POST ${GOOGLE_TOKEN_URL}`,
      `GET API/${SHEET_ID}?fields=${encodeURIComponent('sheets.properties.title')}`,
      `POST API/${SHEET_ID}:batchUpdate`,
      `POST API/${SHEET_ID}/values/${TAB}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    ]);
    const tokenBody = new URLSearchParams(g.calls[0].body);
    expect(tokenBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(tokenBody.get('assertion')?.split('.')).toHaveLength(3);
    expect(JSON.parse(g.calls[2].body!)).toEqual({ requests: [{ addSheet: { properties: { title: '練習回報' } } }] });
    expect(g.calls[3].headers.Authorization).toBe('Bearer tok-1');
    const appended = JSON.parse(g.calls[3].body!) as { values: unknown[][] };
    expect(appended.values[0]).toEqual([...PRACTICE_REPORT_HEADER]);
    expect(appended.values[1]).toEqual([
      '2026-10-13 12:05:06',
      'PRACTICE-ABCDEF1234',
      2,
      3,
      '0家',
      '莫甘娜',
      '投票',
      '贊成',
      ROW.reason,
      ROW.note,
    ]);

    // Second flag: token cached, tab known → a single append, no header.
    await w.appendFlag({ ...ROW, note: '' });
    expect(g.calls).toHaveLength(5);
    expect(g.calls[4].url).toContain(':append');
    expect((JSON.parse(g.calls[4].body!) as { values: unknown[][] }).values).toHaveLength(1);
  });

  it('existing tab with a header → no addSheet, no header row', async () => {
    const g = fakeGoogle({ tabs: ['練習回報'], header: [[...PRACTICE_REPORT_HEADER]] });
    await new PracticeReportWriter({ sheetId: SHEET_ID, credentials: creds, fetchImpl: g.fetchImpl }).appendFlag(ROW);
    expect(g.calls.some((c) => c.url.endsWith(':batchUpdate'))).toBe(false);
    const append = g.calls.find((c) => c.url.includes(':append'))!;
    expect((JSON.parse(append.body!) as { values: unknown[][] }).values).toHaveLength(1);
  });

  it('existing but empty tab → header is written', async () => {
    const g = fakeGoogle({ tabs: ['練習回報'] });
    await new PracticeReportWriter({ sheetId: SHEET_ID, credentials: creds, fetchImpl: g.fetchImpl }).appendFlag(ROW);
    const append = g.calls.find((c) => c.url.includes(':append'))!;
    expect((JSON.parse(append.body!) as { values: unknown[][] }).values[0]).toEqual([...PRACTICE_REPORT_HEADER]);
  });

  it('errors carry step + status only (no body, no note)', async () => {
    const g = fakeGoogle({ tabs: ['練習回報'], header: [['x']], failAppend: 403 });
    const w = new PracticeReportWriter({ sheetId: SHEET_ID, credentials: creds, fetchImpl: g.fetchImpl });
    const err = await w.appendFlag(ROW).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('練習回報 append failed (HTTP 403)');
    expect((err as Error).message).not.toContain('secret');
    expect((err as Error).message).not.toContain('怪怪的');
  });

  it('formats +08 time and long cells', () => {
    expect(formatTaipeiTime(Date.UTC(2026, 11, 31, 16, 0, 0))).toBe('2027-01-01 00:00:00');
    const long = flagRowValues({ ...ROW, note: 'x'.repeat(60_000) });
    expect(String(long[9]).length).toBeLessThan(50_000);
  });
});

describe('createPracticeReportWriter', () => {
  const key = JSON.stringify({ type: 'service_account', ...creds });

  it('needs GOOGLE_SERVICE_ACCOUNT_JSON', () => {
    expect(createPracticeReportWriter({} as NodeJS.ProcessEnv).status).toBe('no-credentials');
    expect(createPracticeReportWriter({ GOOGLE_SERVICE_ACCOUNT_JSON: 'nope' } as NodeJS.ProcessEnv).status).toBe('bad-credentials');
    expect(practiceReportUnavailableReason('no-credentials')).toMatch(/無法儲存/);
  });

  it('defaults to the private sheet and can be switched off', async () => {
    const g = fakeGoogle({ tabs: ['練習回報'], header: [['x']] });
    const built = createPracticeReportWriter({ GOOGLE_SERVICE_ACCOUNT_JSON: key } as NodeJS.ProcessEnv, g.fetchImpl);
    expect(built.status).toBe('ok');
    await built.writer!.appendFlag(ROW);
    expect(g.calls[1].url).toContain(`/${DEFAULT_PRACTICE_REPORT_SHEET_ID}?`);
    expect(createPracticeReportWriter({ GOOGLE_SERVICE_ACCOUNT_JSON: key, PRACTICE_REPORT_SHEET_ID: 'off' } as NodeJS.ProcessEnv).status).toBe('disabled');
    const other = createPracticeReportWriter({ GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(key).toString('base64'), PRACTICE_REPORT_SHEET_ID: 'other-id' } as NodeJS.ProcessEnv);
    expect(other.status).toBe('ok');
  });
});
