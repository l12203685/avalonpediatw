/**
 * 每天觸發 Threads 每日發文（2026-11-17）。
 *
 * GitHub 自己的 schedule 對這個 repo 很不準：每日排程晚 7–8 小時才跑，
 * threads-publish.yml 每小時的排程（'7 * * * *'）從生效到現在一次都沒跑過。
 * 所以跟每晚記錄員一樣（services/nightlyDispatch.ts），改由 Render 上一直開著的伺服器自己觸發：
 * 台灣時間每天 THREADS_POST_HOUR:07（預設 12:07）到 23:00 之間，觸發一次
 *   threads-publish.yml（ref main，inputs mode=auto、date 空白＝今天）。
 *
 * 不會重複發：workflow 有 concurrency（threads-publish 一組，不取消進行中的），
 * 伺服器重啟後同一天又觸發一次只會排隊；workflow 看 threads-state 的狀態檔，
 * 那一天已經發過就跳過（daily.ts／workflow「取出 threads-state 分支」那一步）。
 *
 * 正式發的起始日照樣擋：workflow 的閘門對 mode=auto 的手動觸發也有效，
 * 沒有起始日（主控台設、Claude 同步進 threads_live.json 的 liveFrom；repo 變數 THREADS_LIVE_FROM 有設就蓋過）、
 * 還沒到那一天或 paused，這次觸發只會試跑（docs/THREADS.md〈正式發的開關〉）。
 *
 * GitHub 的 schedule 保留當備援（發過就跳過）。
 *
 * Env：GITHUB_DISPATCH_TOKEN（同 /機器人補位、每晚記錄員，Actions 讀寫）；THREADS_DISPATCH=off 關閉；
 * THREADS_POST_HOUR=0–22 改幾點（預設 12，跟 workflow 的 repo 變數同名、同預設）。Log 只記狀態碼。
 */

import { dispatchWorkflow, REPO_DEFAULT, taipeiClock, type FetchLike } from './nightlyDispatch';

type EnvLike = Record<string, string | undefined>;

export const THREADS_WORKFLOW = 'threads-publish.yml';
const POST_MINUTE = 7;
const END_MIN = 23 * 60;

export interface ThreadsDispatchState {
  enabled: boolean;
  /** 已經觸發成功的台灣日期（YYYY-MM-DD）。 */
  doneDay: string | null;
  lastError: string | null;
}

/** 開始觸發的分鐘數（台灣時間）：THREADS_POST_HOUR 點 07 分；格式不對就用 12。 */
export function threadsStartMinute(env: EnvLike): number {
  const raw = (env.THREADS_POST_HOUR ?? '').trim();
  const h = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  return (Number.isInteger(h) && h >= 0 && h < 23 ? h : 12) * 60 + POST_MINUTE;
}

export class ThreadsDispatcher {
  readonly state: ThreadsDispatchState = { enabled: true, doneDay: null, lastError: null };
  constructor(
    private readonly env: () => EnvLike = () => process.env,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly logger: Pick<Console, 'info' | 'warn'> = console,
  ) {}

  /** 到時間、今天還沒觸發過就觸發；回傳這次有沒有觸發成功。 */
  async tick(now = Date.now()): Promise<boolean> {
    const env = this.env();
    if (['off', 'false', '0', 'no'].includes((env.THREADS_DISPATCH ?? '').trim().toLowerCase())) { this.state.enabled = false; return false; }
    this.state.enabled = true;
    const token = (env.GITHUB_DISPATCH_TOKEN ?? '').trim();
    if (!token) return false;
    const { day, minute } = taipeiClock(now);
    if (minute < threadsStartMinute(env) || minute >= END_MIN) return false;
    if (this.state.doneDay === day) return false;
    const repo = (env.GITHUB_DISPATCH_REPO ?? '').trim() || REPO_DEFAULT;
    const r = await dispatchWorkflow(this.fetchFn, token, repo, THREADS_WORKFLOW, { mode: 'auto', date: '' }, 'avalonpediatw-threads');
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
