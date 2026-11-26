/**
 * 伺服器更新時保存進度（站長 2026-11-26：「…或是會影響就會儲存進度」）——存在哪裡。
 *
 * 正式機（Render）今天就有、不用新設定的地方只有 Google 試算表（GOOGLE_SERVICE_ACCOUNT_JSON，練習回報、遊戲內回饋
 * 都寫這個）：Firestore／Supabase 沒有設定，GitHub 的 private 狀態 repo（GITHUB_ACCOUNTS_TOKEN）也沒有設定。所以：
 * 私人那份試算表（預設跟「練習回報」同一份）多一個分頁「伺服器暫存」，一個用途一列：
 *
 *   A 用途（rooms＝對局房間、sim＝模擬瓦題目）  B 版本（每寫一次換一個）  C 存的時間（+08）  D 幾段  E… 內容
 *
 * 內容先 gzip、再用 AES-256-GCM 加密（金鑰從伺服器本來就有的 JWT_SECRET 導出，HKDF），最後 base64、每 45,000 字
 * 切一段（一格最多 50,000 字）。所以看得到那份試算表的人也看不到進行中對局的角色、名字或任何內容；JWT_SECRET 換了
 * 就解不開（當成沒有存檔）。房間的存檔一被讀回來就清空；超過 15 分鐘的不讀（rooms 那邊判斷）。
 *
 * 環境變數（都不用設）：
 *   LIVE_STATE_SHEET_ID   要寫哪一份試算表；預設 PRACTICE_REPORT_SHEET_ID（沒設就是練習回報那份）；off＝不存（照舊只在記憶體）
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { a1Range, createSheetsClient, type CellValue, type SheetTab } from '../bots/digest/sheets';
import { DEFAULT_PRACTICE_REPORT_SHEET_ID, formatTaipeiTime } from '../practice/PracticeReportWriter';

export const LIVE_STATE_TAB = '伺服器暫存';
export const LIVE_STATE_HEADER = ['用途', '版本', '存的時間(+08)', '幾段', '內容（加密過，看不懂是正常的）'];
/** 分頁寬度：前 4 欄是說明，其餘放內容。 */
const COLUMNS = 64;
const CHUNK_CHARS = 45_000;
const DATA_COLUMNS = COLUMNS - 4;
/** 一個用途最多存多少字（加密、base64 之後）。 */
export const LIVE_STATE_MAX_CHARS = CHUNK_CHARS * DATA_COLUMNS;

export type LiveSlot = 'rooms' | 'sim';
const SLOT_ROW: Record<LiveSlot, number> = { rooms: 2, sim: 3 };

/** 試算表裡用得到的幾個動作（GoogleSheetsClient，或測試用的假的）。 */
export interface LiveStateSheets {
  listTabs(): Promise<SheetTab[]>;
  addTab(title: string, opts?: { frozenRows?: number; columns?: number }): Promise<number>;
  readValues(range: string): Promise<unknown[][]>;
  updateValues(range: string, values: CellValue[][]): Promise<void>;
}

/** 讀得到、但解不開（JWT_SECRET 換了、格式壞了）。 */
export class LiveStateUnreadableError extends Error {
  constructor() {
    super('live state unreadable');
    this.name = 'LiveStateUnreadableError';
  }
}

const SEAL_PREFIX = 'v1.';

export function deriveLiveStateKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('avalonpediatw-live-state'), Buffer.from('v1'), 32));
}

/** JSON → gzip → AES-256-GCM → 'v1.' + base64(iv | tag | 密文)。 */
export function sealJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(value), 'utf8'))), cipher.final()]);
  return SEAL_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** sealJson 的反過來；解不開 → LiveStateUnreadableError。 */
export function openJson(text: string, key: Buffer): unknown {
  try {
    if (!text.startsWith(SEAL_PREFIX)) throw new Error('prefix');
    const raw = Buffer.from(text.slice(SEAL_PREFIX.length), 'base64');
    if (raw.length < 29) throw new Error('short');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(gunzipSync(plain).toString('utf8')) as unknown;
  } catch {
    throw new LiveStateUnreadableError();
  }
}

function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const LAST_COLUMN = columnLetter(COLUMNS);

export interface LiveStateStoreOptions {
  now?: () => number;
  tab?: string;
}

export class LiveStateStore {
  private readonly now: () => number;
  private readonly tab: string;
  private tabReady: Promise<void> | null = null;
  /** 一次只做一個讀寫（同一列不會兩個寫同時進行）。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly sheets: LiveStateSheets, private readonly key: Buffer, opts: LiveStateStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.tab = opts.tab ?? LIVE_STATE_TAB;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ensureTab(): Promise<void> {
    this.tabReady ??= (async (): Promise<void> => {
      const tabs = await this.sheets.listTabs();
      if (!tabs.some((t) => t.title === this.tab)) {
        await this.sheets.addTab(this.tab, { frozenRows: 1, columns: COLUMNS });
        await this.sheets.updateValues(a1Range(this.tab, 'A1:E1'), [LIVE_STATE_HEADER]);
      }
    })().catch((err: unknown) => {
      this.tabReady = null;
      throw err;
    });
    return this.tabReady;
  }

  private async readRow(slot: LiveSlot): Promise<unknown[] | null> {
    await this.ensureTab();
    const row = SLOT_ROW[slot];
    const values = await this.sheets.readValues(a1Range(this.tab, `A${row}:${LAST_COLUMN}${row}`));
    const cells = values[0];
    return Array.isArray(cells) && typeof cells[1] === 'string' && cells[1] !== '' ? cells : null;
  }

  /** 讀一個用途：沒有存檔 → null；解不開 → LiveStateUnreadableError；網路、權限 → 丟出原本的錯。 */
  read(slot: LiveSlot): Promise<{ json: unknown; version: string } | null> {
    return this.serial(async () => {
      const cells = await this.readRow(slot);
      if (!cells) return null;
      const parts = Number(cells[3]);
      if (!Number.isInteger(parts) || parts < 1 || parts > DATA_COLUMNS) throw new LiveStateUnreadableError();
      const text = cells.slice(4, 4 + parts).map((c) => (typeof c === 'string' ? c : '')).join('');
      return { json: openJson(text, this.key), version: String(cells[1]) };
    });
  }

  /**
   * 整列換掉。`expectVersion`：undefined＝不管現在是哪一版；string/null＝現在必須是這一版（null＝沒有存檔），
   * 不是 → { ok: false, conflict: true }。`json` 為 null＝清空這一列。網路、權限 → 丟出原本的錯。
   */
  write(slot: LiveSlot, json: unknown, expectVersion?: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }> {
    return this.serial(async () => {
      if (expectVersion !== undefined) {
        const cells = await this.readRow(slot);
        const current = cells ? String(cells[1]) : null;
        if (current !== expectVersion) return { ok: false, conflict: true } as const;
      } else {
        await this.ensureTab();
      }
      const row: CellValue[] = new Array<CellValue>(COLUMNS).fill('');
      let version: string | null = null;
      if (json !== null) {
        const text = sealJson(json, this.key);
        if (text.length > LIVE_STATE_MAX_CHARS) return { ok: false, conflict: false } as const;
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS));
        version = randomBytes(6).toString('hex');
        row[0] = slot;
        row[1] = version;
        row[2] = formatTaipeiTime(this.now());
        row[3] = chunks.length;
        chunks.forEach((c, i) => { row[4 + i] = c; });
      } else {
        row[0] = slot;
      }
      const r = SLOT_ROW[slot];
      await this.sheets.updateValues(a1Range(this.tab, `A${r}:${LAST_COLUMN}${r}`), [row]);
      return { ok: true, version } as const;
    });
  }
}

export type LiveStateStatus = 'ok' | 'disabled' | 'no-credentials' | 'bad-credentials' | 'no-secret';

/** 照環境變數建；不能用時 store = null，status 說為什麼。 */
export function createLiveStateStore(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): { store: LiveStateStore | null; status: LiveStateStatus } {
  const own = (env.LIVE_STATE_SHEET_ID ?? '').trim();
  if (own.toLowerCase() === 'off') return { store: null, status: 'disabled' };
  const practice = (env.PRACTICE_REPORT_SHEET_ID ?? '').trim();
  const sheetId = own || (practice && practice.toLowerCase() !== 'off' ? practice : DEFAULT_PRACTICE_REPORT_SHEET_ID);
  const secret = env.JWT_SECRET ?? '';
  if (!secret) return { store: null, status: 'no-secret' };
  const { client, reason } = createSheetsClient(sheetId, env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl);
  if (!client) return { store: null, status: reason === 'bad-credentials' ? 'bad-credentials' : 'no-credentials' };
  return { store: new LiveStateStore(client, deriveLiveStateKey(secret)), status: 'ok' };
}

let shared: { store: LiveStateStore | null; status: LiveStateStatus } | null = null;

/** 全程序一個（模擬瓦與房間共用）。 */
export function getLiveStateStore(): { store: LiveStateStore | null; status: LiveStateStatus } {
  shared ??= createLiveStateStore();
  return shared;
}

/** 測試用。 */
export function __setLiveStateStoreForTests(value: { store: LiveStateStore | null; status: LiveStateStatus } | null): void {
  shared = value;
}
