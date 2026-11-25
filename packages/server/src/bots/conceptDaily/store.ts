/**
 * 每日小觀念 — 要撐過重啟的狀態：每一天發了哪張卡、每個群組今天發過沒、bot 發出的那一則的訊息 id（認引用回覆用）。
 *
 * 機器人原本沒有資料庫（每週排行靠很窄的時間窗；模擬瓦的題目 2026-11-25 起用同一套存，simulation/persist.ts）；Render 是「GitHub-only」架構，
 * Firestore 沒有設定。所以這份狀態是一個 JSON 檔，放在 private repo（預設跟帳號庫同一個，GITHUB_ACCOUNTS_*，
 * 見 config.ts conceptStateRepoConfig），用 GitHub Contents API 讀寫（帶 sha，衝突就重讀合併再寫）。
 * 裡面沒有聊天內容、沒有名字：群組 id 是雜湊過的（hashChatId），卡片 id、日期與 bot 自己那則的訊息 id。
 * 沒有設定 repo 時只放記憶體（重啟後當天可能再發一次；開機 log 會寫）。
 */

import { createHash } from 'crypto';
import { repoWriteKey, serializeRepoWrite } from '../../services/githubRepoWrites';
import type { ConceptPlatform, ConceptStateRepoConfig } from './config';
import type { DayPlan } from './plan';

export const CONCEPT_STATE_VERSION = 1;
/** 留幾天的每日結果（輪替要看完整的一輪；卡庫約 100 張）。 */
export const KEEP_DAYS = 400;
/** 留幾則 bot 發出的訊息 id（認引用回覆用）。 */
export const KEEP_MESSAGES = 120;

export interface SentMessage {
  cardId: string;
  date: string;
  platform: ConceptPlatform;
  /** hashChatId 過的群組／頻道。 */
  chat: string;
}

export interface ConceptDailyState {
  version: number;
  /** 日期 → 那一天的小觀念。 */
  days: Record<string, DayPlan>;
  /** `<平台>:<雜湊過的群組>` → 最後一次發的日期。 */
  sent: Record<string, string>;
  /** `<平台>:<bot 那一則的訊息 id>` → 哪一張卡。 */
  messages: Record<string, SentMessage>;
}

export function emptyState(): ConceptDailyState {
  return { version: CONCEPT_STATE_VERSION, days: {}, sent: {}, messages: {} };
}

/** 群組／頻道／使用者 id 的雜湊（12 碼）：狀態檔與回饋裡都只放這個。 */
export function hashChatId(id: string, salt = process.env.CONCEPT_ID_SALT || 'avalon-concept-daily'): string {
  return createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 12);
}

export function sentKey(platform: ConceptPlatform, chatId: string): string {
  return `${platform}:${hashChatId(chatId)}`;
}

export function messageKey(platform: ConceptPlatform, messageId: string): string {
  return `${platform}:${messageId}`;
}

/** 讀進來的檔案 → 狀態（壞的欄位丟掉）。 */
export function normalizeState(raw: unknown): ConceptDailyState {
  const s = emptyState();
  const r = raw as Partial<ConceptDailyState> | null;
  if (!r || typeof r !== 'object') return s;
  for (const [d, p] of Object.entries(r.days ?? {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && p && typeof p === 'object' && typeof p.cardId === 'string' && p.link && typeof p.link.url === 'string') s.days[d] = p;
  }
  for (const [k, d] of Object.entries(r.sent ?? {})) if (typeof d === 'string') s.sent[k] = d;
  for (const [k, m] of Object.entries(r.messages ?? {})) if (m && typeof m === 'object' && typeof m.cardId === 'string') s.messages[k] = m;
  return s;
}

/** 合併兩份（重啟前後、或寫入衝突時）：每天的結果先到先贏，發送日期取較新的，訊息 id 聯集；再修剪。 */
export function mergeStates(base: ConceptDailyState, mine: ConceptDailyState): ConceptDailyState {
  const out: ConceptDailyState = {
    version: CONCEPT_STATE_VERSION,
    days: { ...mine.days, ...base.days },
    sent: { ...base.sent },
    messages: { ...base.messages, ...mine.messages },
  };
  for (const [k, d] of Object.entries(mine.sent)) if (!out.sent[k] || out.sent[k] < d) out.sent[k] = d;
  return pruneState(out);
}

export function pruneState(s: ConceptDailyState): ConceptDailyState {
  const days = Object.keys(s.days).sort();
  for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete s.days[d];
  const msgs = Object.entries(s.messages).sort(([, a], [, b]) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const [k] of msgs.slice(0, Math.max(0, msgs.length - KEEP_MESSAGES))) delete s.messages[k];
  return s;
}

/** 狀態放哪裡：load 讀整份（沒有就 null），save 寫整份（version = load 拿到的版本；衝突回 'conflict'）。 */
export interface StateBackend {
  readonly name: string;
  load(): Promise<{ state: ConceptDailyState; version: string | null } | null>;
  save(state: ConceptDailyState, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }>;
}

export class MemoryBackend implements StateBackend {
  readonly name = 'memory';
  private data: string | null = null;
  private v = 0;
  async load(): Promise<{ state: ConceptDailyState; version: string | null } | null> {
    return this.data ? { state: normalizeState(JSON.parse(this.data)), version: String(this.v) } : null;
  }
  async save(state: ConceptDailyState, version: string | null): Promise<{ ok: true; version: string } | { ok: false; conflict: boolean }> {
    if (this.data !== null && version !== String(this.v)) return { ok: false, conflict: true };
    this.data = JSON.stringify(state);
    this.v += 1;
    return { ok: true, version: String(this.v) };
  }
}

type Fetch = typeof fetch;

/**
 * GitHub Contents API 上的一個 JSON 檔（private repo）：讀回內容與 sha；寫入帶 sha（別人先寫了 → conflict）。
 * 每日小觀念（下面的 GitHubBackend）和模擬瓦進行中的題目（simulation/persist.ts）共用。log 只寫狀態碼。
 * `timeoutMs`：每個請求最久等多久（沒給 = 不設）。
 */
export class GitHubJsonFile {
  constructor(private readonly cfg: ConceptStateRepoConfig, private readonly fetchImpl: Fetch = fetch, private readonly timeoutMs?: number) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'avalonpediatw-bot' };
  }

  private url(withRef: boolean): string {
    const base = `${this.cfg.api}/repos/${this.cfg.repo}/contents/${this.cfg.path.split('/').map(encodeURIComponent).join('/')}`;
    return withRef ? `${base}?ref=${encodeURIComponent(this.cfg.branch)}` : base;
  }

  private signal(): { signal?: AbortSignal } {
    return this.timeoutMs ? { signal: AbortSignal.timeout(this.timeoutMs) } : {};
  }

  /** 檔案不存在 → null；讀不到（網路、權杖）→ 丟錯（訊息只有狀態碼）。`json` 是 JSON.parse 的結果（空檔 = null）。 */
  async read(): Promise<{ json: unknown; sha: string | null } | null> {
    const res = await this.fetchImpl(this.url(true), { headers: this.headers(), ...this.signal() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`state GET ${res.status}`);
    const body = (await res.json()) as { content?: string; sha?: string };
    const json = Buffer.from(body.content ?? '', 'base64').toString('utf8');
    return { json: json ? JSON.parse(json) : null, sha: body.sha ?? null };
  }

  /** 寫整份（`text` 是檔案內容）。`sha` = read() 拿到的；檔案被別人改過（409／422）→ conflict。 */
  async write(text: string, message: string, sha: string | null): Promise<{ ok: true; sha: string | null } | { ok: false; conflict: boolean }> {
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: this.cfg.branch,
    };
    if (sha) body.sha = sha;
    // 同一個 repo 的寫入排隊（帳號庫的註冊、改密碼也寫這個 repo；同時寫會有一個被 GitHub 拒絕）。
    const res = await serializeRepoWrite(repoWriteKey(this.cfg.repo, this.cfg.branch), () => this.fetchImpl(this.url(false), {
      method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...this.signal(),
    }));
    if (res.ok) {
      const out = (await res.json().catch(() => ({}))) as { content?: { sha?: string } };
      return { ok: true, sha: out.content?.sha ?? null };
    }
    return { ok: false, conflict: res.status === 409 || res.status === 422 };
  }
}

/** 每日小觀念的狀態檔（GitHub）。 */
export class GitHubBackend implements StateBackend {
  readonly name = 'github';
  private readonly file: GitHubJsonFile;
  constructor(cfg: ConceptStateRepoConfig, fetchImpl: Fetch = fetch) {
    this.file = new GitHubJsonFile(cfg, fetchImpl);
  }

  async load(): Promise<{ state: ConceptDailyState; version: string | null } | null> {
    const got = await this.file.read();
    return got ? { state: normalizeState(got.json), version: got.sha } : null;
  }

  async save(state: ConceptDailyState, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }> {
    const message = `bot-state: concept daily ${Object.keys(state.days).sort().pop() ?? ''}`.trim();
    const res = await this.file.write(`${JSON.stringify(state, null, 2)}\n`, message, version);
    return res.ok ? { ok: true, version: res.sha } : res;
  }
}

/**
 * 狀態本身：開機讀一次（之後都用記憶體裡的），每次改動排隊寫回（一次只寫一個；衝突就重讀、合併、再寫一次）。
 * 讀不到（網路、權杖）就從空的開始，寫回時再合併。
 */
export class ConceptStateStore {
  private state: ConceptDailyState = emptyState();
  private version: string | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    readonly backend: StateBackend,
    private readonly logger: { warn: (m: string) => void } = { warn: (m) => console.warn(`[concept-daily] ${m}`) },
  ) {}

  /** 讀一次（重複呼叫等同一個）。 */
  ready(): Promise<void> {
    this.loading ??= (async (): Promise<void> => {
      try {
        const got = await this.backend.load();
        if (got) {
          this.state = mergeStates(got.state, this.state);
          this.version = got.version;
        }
      } catch (err) {
        this.logger.warn(`loading state from ${this.backend.name} failed (${err instanceof Error ? err.message.slice(0, 80) : typeof err})`);
      }
      this.loaded = true;
    })();
    return this.loading;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  get(): ConceptDailyState {
    return this.state;
  }

  /** 改動記憶體裡的狀態，然後排隊寫回。回傳寫完的 promise（測試等它；正式不用等）。 */
  update(fn: (s: ConceptDailyState) => void): Promise<void> {
    fn(this.state);
    pruneState(this.state);
    this.dirty = true;
    this.writing = this.writing.then(() => this.flush());
    return this.writing;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.backend.save(this.state, this.version);
        if (res.ok) {
          this.version = res.version;
          return;
        }
        if (!res.conflict) break;
        const fresh = await this.backend.load();
        if (fresh) {
          this.state = mergeStates(fresh.state, this.state);
          this.version = fresh.version;
        } else {
          this.version = null;
        }
      } catch (err) {
        this.logger.warn(`saving state to ${this.backend.name} failed (${err instanceof Error ? err.message.slice(0, 80) : typeof err})`);
        break;
      }
    }
    this.dirty = true; // 下一次改動時再試
  }
}
