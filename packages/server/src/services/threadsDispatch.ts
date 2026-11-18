/**
 * 每天觸發 Threads 每日發文（2026-11-17）。
 *
 * GitHub 自己的 schedule 對這個 repo 很不準：每日排程晚 7–8 小時才跑，
 * threads-publish.yml 每小時的排程（'7 * * * *'）從生效到現在一次都沒跑過。
 * 所以跟每晚記錄員一樣（services/nightlyDispatch.ts），改由 Render 上一直開著的伺服器自己觸發：
 * 台灣時間每天 THREADS_POST_HOUR:07（預設 12:07）到 23:00 之間，觸發一次
 *   threads-publish.yml（ref main，inputs mode=auto、date 空白＝今天）。
 *
 * 一天只觸發一次（2026-11-18 修）：「今天觸發過了」原本只記在這個程序的記憶體（doneDay），
 * 11/18 12:07 觸發了兩次（相隔 4 秒）、12:16 又一次。12:00–12:05 連續合併了四個 PR，Render 一個接一個重新部署：
 * 部署時新舊兩個程序會同時開著一小段時間（新的健康檢查過了才關舊的），各自的記憶體都還沒記今天：
 * 最可能是舊的整分鐘到了觸發一次、新的一啟動（啟動時馬上看一次）又觸發一次（同一個程序有 timer 防重、
 * 每分鐘才看一次，不會 4 秒內觸發兩次）；12:16 是下一次部署（#87）啟動的新程序，記憶體是空的。
 * 所以觸發前先問 GitHub：今天（台北 00:00 以後）已經有 mode=auto 的 workflow_dispatch 執行（沒被取消）就不再觸發。
 * workflow 的 run-name 帶 mode=…／date=…，這裡就是看那個名稱。查不到（網路、權限）就不觸發，下一分鐘再試。
 * 同一個程序裡上一次還沒跑完就不會再開一次（inFlight）。
 *
 * 兩個程序剛好在同一秒查、都還看不到對方的執行，還是可能各觸發一次；這時靠 workflow 擋：
 * concurrency（threads-publish 一組，不取消進行中的）讓後到的排隊，排到時看 threads-state 的狀態檔，
 * 那一天已經發過就跳過（daily.ts／workflow「取出 threads-state 分支」那一步）。
 *
 * 正式發的起始日照樣擋：workflow 的閘門對 mode=auto 的手動觸發也有效，
 * 沒有起始日（主控台設、Claude 同步進 threads_live.json 的 liveFrom；repo 變數 THREADS_LIVE_FROM 有設就蓋過）、
 * 還沒到那一天或 paused，這次觸發只會試跑（docs/THREADS.md〈正式發的開關〉）。
 *
 * GitHub 的 schedule 保留當備援（發過就跳過）。
 *
 * Env：GITHUB_DISPATCH_TOKEN（同 /機器人補位、每晚記錄員，Actions 讀寫；查執行紀錄用 Actions 讀）；THREADS_DISPATCH=off 關閉；
 * THREADS_POST_HOUR=0–22 改幾點（預設 12，跟 workflow 的 repo 變數同名、同預設）。Log 只記狀態碼。
 */

import { dispatchWorkflow, REPO_DEFAULT, taipeiClock } from './nightlyDispatch';

type EnvLike = Record<string, string | undefined>;
/** POST（觸發）與 GET（查今天的執行）都走這個；GET 要有 json()。 */
export type ThreadsFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>;

export const THREADS_WORKFLOW = 'threads-publish.yml';
const POST_MINUTE = 7;
const END_MIN = 23 * 60;
const USER_AGENT = 'avalonpediatw-threads';

export interface ThreadsDispatchState {
  enabled: boolean;
  /** 已經觸發成功（或查到今天已經有人觸發過）的台灣日期（YYYY-MM-DD）。 */
  doneDay: string | null;
  lastError: string | null;
}

/** 開始觸發的分鐘數（台灣時間）：THREADS_POST_HOUR 點 07 分；格式不對就用 12。 */
export function threadsStartMinute(env: EnvLike): number {
  const raw = (env.THREADS_POST_HOUR ?? '').trim();
  const h = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  return (Number.isInteger(h) && h >= 0 && h < 23 ? h : 12) * 60 + POST_MINUTE;
}

/** 台灣日期 day 的 00:00 換成 UTC 的 ISO（不帶毫秒），例如 2026-11-18 → 2026-11-17T16:00:00Z。 */
export function taipeiMidnightIso(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00+08:00`)).toISOString().replace('.000Z', 'Z');
}

/** workflow 的 run-name（"… mode=auto date=today"）是不是伺服器每天那種觸發（mode=auto、今天）。 */
export function isAutoRunTitle(title: string, day: string): boolean {
  const m = /\bmode=(\S+) date=(\S+)\s*$/.exec(title);
  return !!m && m[1] === 'auto' && (m[2] === 'today' || m[2] === day);
}

export type AutoRunCheck = { ok: true; found: boolean } | { ok: false; error: string };

/** 今天（台北 00:00 以後）有沒有 mode=auto 的 workflow_dispatch 執行（被取消的不算）。不丟例外。 */
export async function findAutoRunToday(fetchFn: ThreadsFetchLike, token: string, repo: string, day: string): Promise<AutoRunCheck> {
  const since = taipeiMidnightIso(day);
  const q = new URLSearchParams({ event: 'workflow_dispatch', created: `>=${since}`, per_page: '100' });
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/actions/workflows/${THREADS_WORKFLOW}/runs?${q}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok || !res.json) return { ok: false, error: `runs status=${res.status}` };
    const data = (await res.json()) as { workflow_runs?: unknown };
    if (!Array.isArray(data.workflow_runs)) return { ok: false, error: 'runs bad-body' };
    const sinceMs = Date.parse(since);
    const found = data.workflow_runs.some((r: { display_title?: unknown; conclusion?: unknown; created_at?: unknown; event?: unknown }) =>
      typeof r?.display_title === 'string'
      && isAutoRunTitle(r.display_title, day)
      && r.conclusion !== 'cancelled'
      && (r.event === undefined || r.event === 'workflow_dispatch')
      && (typeof r.created_at !== 'string' || Date.parse(r.created_at) >= sinceMs));
    return { ok: true, found };
  } catch (err) {
    return { ok: false, error: `runs ${err instanceof Error ? err.name : 'error'}` };
  }
}

export class ThreadsDispatcher {
  readonly state: ThreadsDispatchState = { enabled: true, doneDay: null, lastError: null };
  private inFlight = false;
  constructor(
    private readonly env: () => EnvLike = () => process.env,
    private readonly fetchFn: ThreadsFetchLike = (url, init) => fetch(url, init),
    private readonly logger: Pick<Console, 'info' | 'warn'> = console,
  ) {}

  /** 到時間、今天還沒觸發過（這個程序和 GitHub 上都沒有）就觸發；回傳這次有沒有觸發成功。 */
  async tick(now = Date.now()): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      return await this.tickOnce(now);
    } finally {
      this.inFlight = false;
    }
  }

  private async tickOnce(now: number): Promise<boolean> {
    const env = this.env();
    if (['off', 'false', '0', 'no'].includes((env.THREADS_DISPATCH ?? '').trim().toLowerCase())) { this.state.enabled = false; return false; }
    this.state.enabled = true;
    const token = (env.GITHUB_DISPATCH_TOKEN ?? '').trim();
    if (!token) return false;
    const { day, minute } = taipeiClock(now);
    if (minute < threadsStartMinute(env) || minute >= END_MIN) return false;
    if (this.state.doneDay === day) return false;
    const repo = (env.GITHUB_DISPATCH_REPO ?? '').trim() || REPO_DEFAULT;
    // 別的程序（部署時新舊並存、重啟前的自己）今天可能已經觸發過：先問 GitHub。
    const seen = await findAutoRunToday(this.fetchFn, token, repo, day);
    if (!seen.ok) {
      this.state.lastError = seen.error;
      this.logger.warn(`[threads-dispatch] could not list today's ${THREADS_WORKFLOW} runs (${seen.error}); retry next minute`);
      return false;
    }
    if (seen.found) {
      this.state.doneDay = day;
      this.logger.info(`[threads-dispatch] ${THREADS_WORKFLOW} mode=auto already dispatched today (${day}); skip`);
      return false;
    }
    const r = await dispatchWorkflow(this.fetchFn, token, repo, THREADS_WORKFLOW, { mode: 'auto', date: '' }, USER_AGENT);
    if (r.ok) {
      this.state.doneDay = day;
      this.logger.info(`[threads-dispatch] dispatched ${THREADS_WORKFLOW} (status=${r.status})`);
      return true;
    }
    this.state.lastError = r.status !== undefined ? `status=${r.status}` : (r.error ?? 'error');
    this.logger.warn(`[threads-dispatch] dispatch ${THREADS_WORKFLOW} failed (${this.state.lastError})`);
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export const threadsDispatcher = new ThreadsDispatcher();

/** 每分鐘看一次時間（index.ts 啟動時呼叫）。 */
export function startThreadsDispatch(): void {
  if (timer) return;
  timer = setInterval(() => { void threadsDispatcher.tick(); }, 60_000);
  timer.unref?.();
  void threadsDispatcher.tick();
}
