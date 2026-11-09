/**
 * 每晚啟動牌譜記錄員＋百科AI 每晚補位（2026-11-09）。
 *
 * 原本由 Claude 的每日排程在台灣 18:35 用 workflow_dispatch 觸發（GitHub 自己的 schedule 常延後好幾小時，
 * 延到 00:15 以後就直接結束）。11/05–11/08 Claude 撞到週用量上限，四個晚上都沒觸發、也就沒有紀錄。
 * Edward：「如果週用量到 limit 沒有紀錄的問題 要修正」——改成 Render 上一直開著的伺服器自己觸發：
 * 台灣時間每天 START（預設 18:35）到 END（23:00）之間，每天各觸發一次
 *   - signage-recorder.yml（inputs 空＝跑到 00:15）
 *   - signage-player.yml（inputs 空＝每晚補位規則）
 * 兩個 workflow 都有 concurrency（記錄員一組、每晚補位一組）：伺服器重啟後同一天又觸發一次也只會排隊，
 * 等前一個 00:15 結束時已過時間就直接結束，不會重複記錄。Claude 的排程保留當備援（同樣只會排隊）。
 *
 * Env：GITHUB_DISPATCH_TOKEN（同 /機器人補位，Actions 讀寫）；NIGHTLY_DISPATCH=off 關閉；
 * NIGHTLY_DISPATCH_AT=HH:MM 改開始時間。Log 只記狀態碼。
 */

type EnvLike = Record<string, string | undefined>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export const NIGHTLY_WORKFLOWS = ['signage-recorder.yml', 'signage-player.yml'] as const;
const REPO_DEFAULT = 'l12203685/avalonpediatw';
const TAIPEI_MS = 8 * 3600_000;
const END_MIN = 23 * 60;

export interface NightlyState {
  enabled: boolean;
  /** Taipei day (YYYY-MM-DD) → workflows already dispatched that day. */
  done: Record<string, string[]>;
  lastError: string | null;
}

/** 台灣日期與一天中的第幾分鐘。 */
export function taipeiClock(at: number): { day: string; minute: number } {
  const d = new Date(at + TAIPEI_MS);
  return { day: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function startMinute(env: EnvLike): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((env.NIGHTLY_DISPATCH_AT ?? '').trim());
  if (m && Number(m[1]) < 23 && Number(m[2]) < 60) return Number(m[1]) * 60 + Number(m[2]);
  return 18 * 60 + 35;
}

export class NightlyDispatcher {
  readonly state: NightlyState = { enabled: true, done: {}, lastError: null };
  constructor(
    private readonly env: () => EnvLike = () => process.env,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly logger: Pick<Console, 'info' | 'warn'> = console,
  ) {}

  /** 到時間就觸發還沒觸發過的 workflow；回傳這次觸發成功的。 */
  async tick(now = Date.now()): Promise<string[]> {
    const env = this.env();
    if (['off', 'false', '0', 'no'].includes((env.NIGHTLY_DISPATCH ?? '').trim().toLowerCase())) { this.state.enabled = false; return []; }
    const token = (env.GITHUB_DISPATCH_TOKEN ?? '').trim();
    if (!token) return [];
    const { day, minute } = taipeiClock(now);
    if (minute < startMinute(env) || minute >= END_MIN) return [];
    for (const k of Object.keys(this.state.done)) if (k !== day) delete this.state.done[k];
    const done = (this.state.done[day] ??= []);
    const repo = (env.GITHUB_DISPATCH_REPO ?? '').trim() || REPO_DEFAULT;
    const ok: string[] = [];
    for (const wf of NIGHTLY_WORKFLOWS) {
      if (done.includes(wf)) continue;
      try {
        const res = await this.fetchFn(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'avalonpediatw-nightly',
          },
          body: JSON.stringify({ ref: 'main', inputs: {} }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) { done.push(wf); ok.push(wf); this.logger.info(`[nightly] dispatched ${wf} (status=${res.status})`); }
        else { this.state.lastError = `${wf} status=${res.status}`; this.logger.warn(`[nightly] dispatch ${wf} failed (status=${res.status})`); }
      } catch (err) {
        this.state.lastError = `${wf} ${err instanceof Error ? err.name : 'error'}`;
        this.logger.warn(`[nightly] dispatch ${wf} got no answer (${err instanceof Error ? err.name : 'error'})`);
      }
    }
    return ok;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export const nightlyDispatcher = new NightlyDispatcher();

/** 每分鐘看一次時間（index.ts 啟動時呼叫）。 */
export function startNightlyDispatch(): void {
  if (timer) return;
  timer = setInterval(() => { void nightlyDispatcher.tick(); }, 60_000);
  timer.unref?.();
  void nightlyDispatcher.tick();
}
