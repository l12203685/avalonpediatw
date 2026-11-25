/**
 * 模擬瓦 — 進行中的題目存檔（2026-11-25）。
 *
 * Edward 2026-11-25：「模擬瓦是不是會因為你的更新而中斷？有些人送出後發現正在進行的未公布的結束了」。
 * 原因：題目只在記憶體；render.yaml 是「後端的檔案一合併就自動部署」，每部署一次伺服器就重啟一次、題目全清
 * （那一天 09:14–16:30 有 9 次）。免費方案閒置 15 分鐘休眠也會清。
 *
 * 做法（跟每日小觀念同一套，conceptDaily/store.ts）：一個 JSON 檔放在 **private** repo（預設跟帳號庫同一個，
 * `bot-state/sim-sessions.json`，見 simStateRepoConfig），用 GitHub Contents API 讀寫（帶 sha；別人先寫了就
 * 重讀、合併、再寫）。不用新的環境變數、不用新的權杖。沒有設定那個 repo → 照舊只在記憶體，開機 log 會寫。
 *
 *   - 開機：先把檔案讀回來（讀不到再試兩次），讀完之前模擬指令先等、等不到就回「請過幾秒再打一次」（session.ts）。
 *   - 寫：有變動才寫，最多每 25 秒一次（變動後先等 2 秒）；只有「最後一次動的時間」變了不單獨寫。
 *   - 關機：SIGTERM 時把還沒寫的寫完（flush()；server 的 index.ts 接 SIGTERM）。
 *   - 新舊兩台伺服器會同時活一小段（Render 先開新的、再關舊的）：舊的關機前最後寫的那一次，新的那台可能已經
 *     讀過檔案了。所以新的那台開機後的 3 分鐘內，每個模擬指令回答之前先看一眼檔案有沒有被改過（catchUp()；
 *     沒改過就什麼都不做），之後在 5 分、10 分再各看一次；改過就跟自己手上的合併（mergeSnapshots：每一題取
 *     比較晚動過的那一份；已經 /公布、/結束 的不會被舊的一份救回來）。寫入衝突時也是同一個合併。
 *     已知的限制：那一小段時間裡，同一題的指令如果兩台輪流收到（Discord 兩台都連著時才會），較早那一台多記的
 *     那一步會被較晚動過的那一份蓋掉——整份取代，不逐筆合併答案。
 *   - 檔案上限 600 KB（GitHub 讀檔上限 1 MB）；放不下時最久沒動的題目不存，改記成「沒能接回來」。
 *   - 存檔格式的版本不同、檔案不在、讀不到 → 從空的開始，之後沒有題目的人打指令時講明「伺服器更新過、題目沒留下來、
 *     怎麼重開」（replies.ts restartLostText）。
 *
 * 隱私：檔案只在 private repo。裡面沒有名字、沒有聊天內容、沒有原本的 id：聊天室、使用者、LINE 事件代號都是
 * 雜湊過的（simIdHash，跟每日小觀念的 hashChatId 同一個）；其餘是題號、座位、角色、派的隊伍、區間、時間。
 * log 只有固定文字和數字（幾題、狀態碼），沒有題號、沒有 id。
 */

import type { Role } from '@avalon/shared';
import { conceptStateRepoConfig, type ConceptStateRepoConfig } from '../conceptDaily/config';
import { GitHubJsonFile, hashChatId } from '../conceptDaily/store';
import type { IntervalGroup } from './commands';
import { SIM_PERSIST_DEBOUNCE_MS, SIM_PERSIST_FIRST_DELAY_MS, SIM_PERSIST_MAX_BYTES } from './config';
import type { EndedInfo, EndedReason, SimAnswer, SimKill, SimPhase, SimSession, SimSessionStore, SimStoreSnapshot } from './session';

export const SIM_SESSIONS_VERSION = 1;
export const SIM_SESSIONS_FILE = 'sim-sessions.json';
/** 存檔裡最多留幾個 LINE 事件代號（重送在幾分鐘內）、幾筆「怎麼結束的」。 */
const PERSIST_EVENTS_MAX = 300;
const PERSIST_ENDED_MAX = 300;
/** 每個 GitHub 請求最久等多久。 */
const REQUEST_TIMEOUT_MS = 8_000;
/** 開機後多久以內，舊的那台伺服器可能還活著、還在收指令（這段時間每個模擬指令先看一眼檔案）。 */
const HANDOVER_MS = 3 * 60 * 1000;

/** 聊天室／使用者／LINE 事件代號的雜湊（12 碼）：記憶體和存檔裡都只放這個。 */
export function simIdHash(id: string): string {
  return hashChatId(id);
}

// ─── 檔案格式 ─────────────────────────────────────────────────────────────

/** 存檔裡的一題：SimSession 去掉 games[] 的索引（重啟後照 gameId 重新對），answers 攤成陣列。 */
type StoredSession = Omit<SimSession, 'game' | 'answers'> & { answers: [number, SimAnswer[]][] };

export interface SimSessionsFile {
  version: number;
  savedAt: number;
  sessions: StoredSession[];
  ended: [string, EndedInfo][];
  closed: [string, number][];
  noticed: string[];
  events: string[];
}

const ROLES: readonly Role[] = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];
const PHASES: readonly SimPhase[] = ['answering', 'answered', 'no-more-decisions'];
const REASONS: readonly EndedReason[] = ['expired', 'evicted', 'lost'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isSeat = (v: unknown): v is number => isInt(v, 1, 10);
const isSeats = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 10 && v.every(isSeat);
const optBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
const optStr = (v: unknown): boolean => v === undefined || isStr(v);

function storedSession(s: SimSession): StoredSession {
  const out: Omit<SimSession, 'answers' | 'game'> & { game?: number; answers: [number, SimAnswer[]][] } = { ...s, answers: [...s.answers.entries()] };
  delete out.game;
  return out;
}

/** 存檔裡的一題 → 記憶體裡的一題（game = -1：還沒對過題庫）；有任何欄位不對就整題不要（null）。 */
export function parseStoredSession(raw: unknown): SimSession | null {
  if (!isObj(raw)) return null;
  const r = raw;
  if (!isStr(r.key) || !isStr(r.chatKey) || !optStr(r.userKey) || !isStr(r.exerciseId) || !isStr(r.gameId)) return null;
  if (!isSeat(r.seat) || !ROLES.includes(r.role as Role) || !PHASES.includes(r.phase as SimPhase)) return null;
  if (!isInt(r.decision, 0, 200) || !isInt(r.cursor, 0, 1000) || !isInt(r.version, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (!isTime(r.startedAt) || !isTime(r.lastActiveAt)) return null;
  if (!optBool(r.assassin) || !optBool(r.intervalByCoAnswer)) return null;
  if (!Array.isArray(r.answers)) return null;
  const answers = new Map<number, SimAnswer[]>();
  for (const entry of r.answers) {
    if (!Array.isArray(entry) || !isInt(entry[0], 0, 200) || !Array.isArray(entry[1])) return null;
    const list: SimAnswer[] = [];
    for (const a of entry[1]) {
      if (!isObj(a) || !isSeats(a.team) || typeof a.coAnswer !== 'boolean' || !optStr(a.by)) return null;
      list.push({ team: [...a.team], coAnswer: a.coAnswer, ...(a.by !== undefined ? { by: a.by as string } : {}) });
    }
    answers.set(entry[0], list);
  }
  let interval: IntervalGroup[] | undefined;
  if (r.interval !== undefined) {
    if (!Array.isArray(r.interval) || r.interval.length > 20) return null;
    interval = [];
    for (const g of r.interval) {
      if (!isObj(g) || !isSeats(g.seats) || !isInt(g.min, 0, 10) || !isInt(g.max, 0, 10)) return null;
      interval.push({ seats: [...g.seats], min: g.min, max: g.max });
    }
  }
  let intervalWorlds: number[] | undefined;
  if (r.intervalWorlds !== undefined) {
    if (!Array.isArray(r.intervalWorlds) || r.intervalWorlds.length > 2000 || !r.intervalWorlds.every((w) => isInt(w, 0, 1 << 11))) return null;
    intervalWorlds = [...(r.intervalWorlds as number[])];
  }
  let kill: SimSession['kill'];
  if (r.kill !== undefined) {
    if (!isObj(r.kill) || !isSeat(r.kill.target) || typeof r.kill.coAnswer !== 'boolean') return null;
    kill = { target: r.kill.target, coAnswer: r.kill.coAnswer };
  }
  let kills: SimKill[] | undefined;
  if (r.kills !== undefined) {
    if (!Array.isArray(r.kills) || r.kills.length > 500) return null;
    kills = [];
    for (const k of r.kills) {
      if (!isObj(k) || !isSeat(k.target) || typeof k.coAnswer !== 'boolean' || !optStr(k.by)) return null;
      kills.push({ target: k.target, coAnswer: k.coAnswer, ...(k.by !== undefined ? { by: k.by as string } : {}) });
    }
  }
  return {
    key: r.key,
    chatKey: r.chatKey,
    ...(r.userKey !== undefined ? { userKey: r.userKey as string } : {}),
    exerciseId: r.exerciseId,
    gameId: r.gameId,
    game: -1,
    seat: r.seat,
    role: r.role as Role,
    decision: r.decision,
    cursor: r.cursor,
    answers,
    ...(interval ? { interval } : {}),
    ...(r.intervalByCoAnswer !== undefined ? { intervalByCoAnswer: r.intervalByCoAnswer as boolean } : {}),
    ...(intervalWorlds ? { intervalWorlds } : {}),
    phase: r.phase as SimPhase,
    ...(r.assassin !== undefined ? { assassin: r.assassin as boolean } : {}),
    ...(kill ? { kill } : {}),
    ...(kills ? { kills } : {}),
    startedAt: r.startedAt,
    lastActiveAt: r.lastActiveAt,
    version: r.version,
  };
}

/**
 * store 的內容 → 檔案文字（一行 JSON）。超過 `maxBytes` 時從最久沒動的題目開始不存，改記進「怎麼結束的」
 * （'lost'：重啟後那個人會被告知是哪一題沒能接回來）。
 */
export function snapshotToFileText(snap: SimStoreSnapshot, now: number, maxBytes: number = SIM_PERSIST_MAX_BYTES): string {
  const stored = snap.sessions.map(storedSession);
  const sizes = stored.map((s) => Buffer.byteLength(JSON.stringify(s), 'utf8') + 1);
  const file: SimSessionsFile = {
    version: SIM_SESSIONS_VERSION,
    savedAt: now,
    sessions: [],
    ended: snap.ended.slice(-PERSIST_ENDED_MAX),
    closed: snap.closed,
    noticed: snap.noticed.slice(-PERSIST_ENDED_MAX),
    events: snap.events.slice(-PERSIST_EVENTS_MAX),
  };
  let size = Buffer.byteLength(JSON.stringify(file), 'utf8') + sizes.reduce((n, x) => n + x, 0);
  let from = 0;
  while (from < stored.length && size > maxBytes) {
    const dropped = stored[from];
    // 比這一題最後一次動早 1 毫秒：這台伺服器手上還開著的同一題，合併時不會被這一筆蓋掉。
    file.ended.push([dropped.key, { exerciseId: dropped.exerciseId, reason: 'lost', at: dropped.lastActiveAt - 1 }]);
    size += 150 - sizes[from];
    from += 1;
  }
  file.sessions = stored.slice(from);
  return `${JSON.stringify(file)}\n`;
}

/** 檔案內容 → store 的內容；'version' = 存檔格式的版本不是這一版（不讀）。壞掉的題目丟掉並計數。 */
export function snapshotFromFile(json: unknown): { snapshot: SimStoreSnapshot; dropped: number } | 'version' {
  if (!isObj(json) || json.version !== SIM_SESSIONS_VERSION) return 'version';
  const snapshot: SimStoreSnapshot = { sessions: [], ended: [], closed: [], noticed: [], events: [] };
  let dropped = 0;
  const seen = new Set<string>();
  for (const raw of Array.isArray(json.sessions) ? json.sessions : []) {
    const s = parseStoredSession(raw);
    if (!s || seen.has(s.key)) { dropped += 1; continue; }
    seen.add(s.key);
    snapshot.sessions.push(s);
  }
  for (const e of Array.isArray(json.ended) ? json.ended : []) {
    const info: unknown = Array.isArray(e) ? e[1] : null;
    if (!Array.isArray(e) || !isStr(e[0]) || !isObj(info) || !isStr(info.exerciseId) || !REASONS.includes(info.reason as EndedReason) || !isTime(info.at)) continue;
    snapshot.ended.push([e[0], { exerciseId: info.exerciseId, reason: info.reason as EndedReason, at: info.at }]);
  }
  for (const c of Array.isArray(json.closed) ? json.closed : []) {
    if (Array.isArray(c) && isStr(c[0]) && isTime(c[1])) snapshot.closed.push([c[0], c[1]]);
  }
  for (const k of Array.isArray(json.noticed) ? json.noticed : []) if (isStr(k)) snapshot.noticed.push(k);
  for (const k of Array.isArray(json.events) ? json.events : []) if (isStr(k)) snapshot.events.push(k);
  return { snapshot, dropped };
}

/**
 * 合併兩份（開機後回頭再讀、或寫入衝突時）：`remote` 是檔案裡的，`local` 是這台伺服器手上的。
 *   - 同一個 key 的題目取比較晚動過的那一份（一樣晚取 version 大的，再一樣取 local——同一個物件，進行中的回覆照常 commit）；
 *   - 任何一邊記著這個 key 在那之後已經 /公布、/結束（closed）或過期／被擠掉（ended）→ 這一題不留；
 *   - 「怎麼結束的」取比較新的；之後又開了新題、或已經講過了（closed）→ 不留；
 *   - 其餘（講過結束說明的人、LINE 事件代號）取聯集。
 */
export function mergeSnapshots(remote: SimStoreSnapshot, local: SimStoreSnapshot): SimStoreSnapshot {
  const closed = new Map<string, number>();
  for (const [k, at] of [...remote.closed, ...local.closed]) if ((closed.get(k) ?? -1) < at) closed.set(k, at);
  const ended = new Map<string, EndedInfo>();
  for (const [k, info] of [...remote.ended, ...local.ended]) {
    const have = ended.get(k);
    if (!have || have.at <= info.at) { ended.delete(k); ended.set(k, info); }
  }
  const sessions = new Map<string, SimSession>();
  for (const s of [...remote.sessions, ...local.sessions]) {
    const have = sessions.get(s.key);
    if (!have || have.lastActiveAt < s.lastActiveAt || (have.lastActiveAt === s.lastActiveAt && have.version <= s.version)) sessions.set(s.key, s);
  }
  for (const [k, s] of sessions) {
    const gone = Math.max(closed.get(k) ?? -1, ended.get(k)?.at ?? -1);
    if (gone >= s.lastActiveAt) sessions.delete(k);
    else ended.delete(k);
  }
  for (const [k, info] of ended) if ((closed.get(k) ?? -1) >= info.at) ended.delete(k);
  return {
    sessions: [...sessions.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt),
    ended: [...ended.entries()].sort((a, b) => a[1].at - b[1].at),
    closed: [...closed.entries()].sort((a, b) => a[1] - b[1]),
    noticed: [...new Set([...remote.noticed, ...local.noticed])].filter((k) => !sessions.has(k)),
    events: [...new Set([...remote.events, ...local.events])],
  };
}

// ─── 放哪裡 ───────────────────────────────────────────────────────────────

/** load：檔案內容（JSON.parse 過）與版本；沒有檔案 → null；讀不到 → 丟錯。save：寫整份；別人先寫了 → conflict。 */
export interface SimStateBackend {
  readonly name: string;
  load(): Promise<{ json: unknown; version: string | null } | null>;
  save(text: string, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }>;
}

/**
 * 跟每日小觀念同一個 private repo、同一個資料夾，檔名 sim-sessions.json（預設 `bot-state/sim-sessions.json`）。
 * 沒有設定（沒有權杖或 repo）→ null：題目只在記憶體。
 */
export function simStateRepoConfig(env: NodeJS.ProcessEnv = process.env): ConceptStateRepoConfig | null {
  const base = conceptStateRepoConfig(env);
  if (!base) return null;
  const dir = base.path.includes('/') ? base.path.slice(0, base.path.lastIndexOf('/') + 1) : '';
  return { ...base, path: `${dir}${SIM_SESSIONS_FILE}` };
}

export class GitHubSimBackend implements SimStateBackend {
  readonly name = 'github';
  private readonly file: GitHubJsonFile;
  constructor(cfg: ConceptStateRepoConfig, fetchImpl: typeof fetch = fetch) {
    this.file = new GitHubJsonFile(cfg, fetchImpl, REQUEST_TIMEOUT_MS);
  }

  async load(): Promise<{ json: unknown; version: string | null } | null> {
    const got = await this.file.read();
    return got ? { json: got.json, version: got.sha } : null;
  }

  async save(text: string, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }> {
    const res = await this.file.write(text, 'bot-state: sim sessions', version);
    return res.ok ? { ok: true, version: res.sha } : res;
  }
}

// ─── 讀回來、排隊寫、關機寫完 ─────────────────────────────────────────────

/**
 * 開機讀檔的結果：
 *   'memory-only' 沒設定 repo（只在記憶體）；'restored' 讀回來了；
 *   'empty' 檔案不在（第一次上線，或被刪了）；'version' 存檔格式的版本不同；'unreadable' 讀不到（網路、權杖）。
 * 後三種 = 重啟前的題目沒能讀回來；之後回頭再讀、或寫入衝突時讀到了一份讀得懂的，就改成 'restored'。
 */
export type RestoreOutcome = 'memory-only' | 'restored' | 'empty' | 'version' | 'unreadable';

export interface SimPersistenceOptions {
  backend: SimStateBackend | null;
  now?: () => number;
  debounceMs?: number;
  firstDelayMs?: number;
  maxBytes?: number;
  /** 開機讀不到時，隔多久再試（毫秒）。 */
  loadRetryDelaysMs?: readonly number[];
  /** 開機後隔多久回頭再讀一次（毫秒；接住舊伺服器關機前最後寫的那一次）。 */
  catchUpDelaysMs?: readonly number[];
  /** 開機後多久以內每個模擬指令先看一眼檔案（毫秒；0 = 不看）。 */
  handoverMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export interface SimPersistenceStatus {
  /** 有設定存檔的 repo。 */
  configured: boolean;
  /** 開機的讀檔做完了。 */
  ready: boolean;
  /** 重啟前的題目有讀回來（false = 沒設定、還在讀、或沒能讀回來）。 */
  restored: boolean;
  restoredSessions: number;
  droppedSessions: number;
  writes: number;
  writeFailures: number;
  conflicts: number;
  /** 有還沒寫進檔案的變動。 */
  pending: boolean;
}

/** 兩份內容「題目、結束紀錄」一不一樣（只看 key、時間、version；LINE 事件代號那些不算）。 */
function signature(snap: SimStoreSnapshot): string {
  return JSON.stringify([
    snap.sessions.map((s) => `${s.key}|${s.lastActiveAt}|${s.version}`).sort(),
    snap.ended.map(([k, e]) => `${k}|${e.at}`).sort(),
    snap.closed.map(([k, at]) => `${k}|${at}`).sort(),
  ]);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

export class SimPersistence {
  private readonly backend: SimStateBackend | null;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly firstDelayMs: number;
  private readonly maxBytes: number;
  private readonly logger: { info: (m: string) => void; warn: (m: string) => void };
  private store: SimSessionStore | null = null;
  private version: string | null = null;
  private outcome: RestoreOutcome | null = null;
  private restoring: Promise<void> | null = null;
  private readonly bootAt: number;
  private readyAt = Number.NEGATIVE_INFINITY;
  private readonly handoverMs: number;
  /** 有任何還沒寫的變動；`wanted` = 其中有值得馬上排一次寫的。 */
  private dirty = false;
  private wanted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly catchUps: ReturnType<typeof setTimeout>[] = [];
  /** 寫入和回頭再讀排一條隊（一次只做一個）。 */
  private queue: Promise<void> = Promise.resolve();
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** 連續寫失敗幾次（失敗越多次隔越久再試，最久約 5 分鐘）。 */
  private failStreak = 0;
  private stopped = false;
  private readonly counts = { restoredSessions: 0, droppedSessions: 0, writes: 0, writeFailures: 0, conflicts: 0 };

  constructor(private readonly opts: SimPersistenceOptions) {
    this.backend = opts.backend;
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.debounceMs ?? SIM_PERSIST_DEBOUNCE_MS;
    this.firstDelayMs = opts.firstDelayMs ?? SIM_PERSIST_FIRST_DELAY_MS;
    this.maxBytes = opts.maxBytes ?? SIM_PERSIST_MAX_BYTES;
    this.logger = opts.logger ?? {
      info: (m): void => { console.log(`[sim] ${m}`); },
      warn: (m): void => { console.warn(`[sim] ${m}`); },
    };
    this.handoverMs = opts.handoverMs ?? HANDOVER_MS;
    this.bootAt = this.now();
    if (!this.backend) this.outcome = 'memory-only';
  }

  /** 引擎建好 store 之後接上來（一個存檔只接一個 store）。 */
  attach(store: SimSessionStore): void {
    this.store = store;
  }

  /** 有設定存檔（重啟不會清掉題目）。 */
  keeps(): boolean {
    return !!this.backend;
  }

  /** 開機的讀檔做完了（沒設定存檔時一開始就是 true）。 */
  isReady(): boolean {
    return this.outcome !== null;
  }

  /** 重啟前的題目沒能讀回來 → 這次開機的時間；讀回來了（或沒設定存檔）→ null。 */
  lostAt(): number | null {
    return this.outcome === 'empty' || this.outcome === 'version' || this.outcome === 'unreadable' ? this.bootAt : null;
  }

  /**
   * 剛開機、舊的那台伺服器可能還活著：這段時間每個模擬指令回答之前先 catchUp()（session.ts），不然會拿開機時
   * 讀到的那一份回答——那之後在舊的那台開的題目、作的答，要等舊的那台關機寫檔才看得到。
   */
  inHandover(): boolean {
    return !!this.backend && this.outcome !== null && !this.stopped && this.now() - this.readyAt < this.handoverMs;
  }

  /** 開機讀一次（重複呼叫等同一個）。從不丟錯。 */
  restore(): Promise<void> {
    this.restoring ??= this.doRestore();
    return this.restoring;
  }

  private async doRestore(): Promise<void> {
    const backend = this.backend;
    if (!backend) {
      this.logger.warn('no state repo configured: open 模擬 exercises live in memory only (a restart or deploy clears them)');
      return;
    }
    let got: { json: unknown; version: string | null } | null = null;
    let failure: string | null = null;
    for (const delay of [0, ...(this.opts.loadRetryDelaysMs ?? [1_500, 4_000])]) {
      if (delay > 0) await sleep(delay);
      try {
        got = await backend.load();
        failure = null;
        break;
      } catch (err) {
        failure = err instanceof Error ? err.message.slice(0, 80) : typeof err;
      }
    }
    if (failure !== null) {
      this.logger.warn(`reading open exercises from ${backend.name} failed (${failure}); starting empty`);
      this.outcome = 'unreadable';
    } else if (!got) {
      this.logger.info(`no saved exercises in ${backend.name} yet; starting empty`);
      this.outcome = 'empty';
    } else {
      this.version = got.version;
      let adopted: false | 'same' | 'ahead' = false;
      try {
        adopted = this.adopt(got.json, true);
      } catch {
        // 檔案內容讓合併出錯（不該發生）：當成讀不懂，從空的開始，不能讓模擬指令永遠卡在「正在讀」。
      }
      this.outcome = adopted ? 'restored' : 'version';
      if (this.outcome === 'version') this.logger.warn('saved exercises have another format version; starting empty');
      else this.logger.info(`restored ${this.counts.restoredSessions} open exercises from ${backend.name}`);
    }
    this.readyAt = this.now();
    // 檔案不在或版本不同：寫一份現在的（下次開機就讀得到，不會再說「沒能留下來」）。
    if (this.outcome !== 'restored') this.dirty = true;
    this.wanted = this.wanted || this.dirty;
    this.schedule();
    for (const delay of this.opts.catchUpDelaysMs ?? [300_000, 600_000]) {
      const t = setTimeout(() => { void this.catchUp(); }, delay);
      t.unref?.();
      this.catchUps.push(t);
    }
  }

  /**
   * 把檔案內容併進 store；版本不同 → false（不動 store）。'same' = 合併的結果跟檔案裡的一樣（不用寫回去），
   * 'ahead' = 這台伺服器手上有檔案裡沒有的。
   */
  private adopt(json: unknown, boot: boolean): false | 'same' | 'ahead' {
    const parsed = snapshotFromFile(json);
    if (parsed === 'version' || !this.store) return false;
    const merged = mergeSnapshots(parsed.snapshot, this.store.snapshot());
    this.store.replace(merged);
    if (boot) {
      this.counts.restoredSessions = parsed.snapshot.sessions.length;
      this.counts.droppedSessions = parsed.dropped;
    }
    return signature(merged) === signature(parsed.snapshot) ? 'same' : 'ahead';
  }

  /**
   * 開機後回頭再讀一次：檔案在這之後被改過（舊伺服器關機前最後寫的那一次）就合併進來；這台手上有檔案裡沒有的
   * 才排一次寫。檔案沒被改過 → 什麼都不做。開機時讀不到的，這裡讀到了也算讀回來。從不丟錯。
   */
  catchUp(): Promise<void> {
    this.queue = this.queue.then(async () => {
      const backend = this.backend;
      if (!backend || this.stopped || this.outcome === null) return;
      try {
        const got = await backend.load();
        if (!got || got.version === this.version) return;
        this.version = got.version;
        const adopted = this.adopt(got.json, false);
        if (!adopted) return;
        this.outcome = 'restored';
        if (adopted === 'ahead') this.touch(true);
      } catch {
        // 讀不到就算了：下一次再讀，或寫入衝突時再合併。
      }
    });
    return this.queue;
  }

  /** store 變了（session.ts 的 onChange）。`hard` = 值得排一次寫。 */
  touch(hard: boolean): void {
    if (!this.backend) return;
    this.dirty = true;
    if (!hard) return;
    this.wanted = true;
    this.schedule();
  }

  private schedule(): void {
    if (!this.backend || this.stopped || this.outcome === null || this.timer || !this.wanted) return;
    const gap = this.debounceMs * Math.min(2 ** this.failStreak, 12);
    const delay = Math.max(this.firstDelayMs, this.lastAttemptAt + gap - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, delay);
    this.timer.unref?.();
  }

  private enqueueWrite(): Promise<void> {
    this.queue = this.queue.then(() => this.write()).then(() => { this.schedule(); });
    return this.queue;
  }

  private async write(): Promise<void> {
    const backend = this.backend;
    const store = this.store;
    if (!backend || !store || !this.dirty) return;
    this.dirty = false;
    this.wanted = false;
    this.lastAttemptAt = this.now();
    let failure = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await backend.save(snapshotToFileText(store.snapshot(), this.now(), this.maxBytes), this.version);
        if (res.ok) {
          this.version = res.version;
          this.counts.writes += 1;
          this.failStreak = 0;
          return;
        }
        if (!res.conflict) { failure = 'rejected'; break; }
        // 檔案被別人改過（另一台伺服器）：重讀、合併、再寫。
        this.counts.conflicts += 1;
        failure = 'conflict';
        const fresh = await backend.load();
        this.version = fresh ? fresh.version : null;
        if (fresh && this.adopt(fresh.json, false)) this.outcome = 'restored';
      } catch (err) {
        failure = err instanceof Error ? err.message.slice(0, 80) : typeof err;
        break;
      }
    }
    this.counts.writeFailures += 1;
    this.failStreak += 1;
    this.logger.warn(`saving open exercises to ${backend.name} failed (${failure}); will retry`);
    // 之後再試（25 秒起，連續失敗就隔久一點）。
    this.dirty = true;
    this.wanted = true;
  }

  /** 關機：把還沒寫的寫完（正在寫的等它寫完）。從不丟錯。 */
  async flush(): Promise<void> {
    if (!this.backend) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.outcome === null) return; // 還沒讀回來：手上沒有東西可以寫，也不能把檔案蓋掉。
    this.queue = this.queue.then(() => this.write());
    await this.queue;
  }

  /** 關機或測試結束：不再排寫入、不再回頭讀。 */
  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const t of this.catchUps.splice(0)) clearTimeout(t);
  }

  /** 狀態頁：只有數字和布林。 */
  status(): SimPersistenceStatus {
    return {
      configured: !!this.backend,
      ready: this.outcome !== null,
      restored: this.outcome === 'restored',
      ...this.counts,
      pending: this.dirty,
    };
  }
}
