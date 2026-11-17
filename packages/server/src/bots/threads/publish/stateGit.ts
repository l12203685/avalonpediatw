/**
 * 把 threads-state 的工作目錄（CI 先 clone 下來的 threads-state 分支）commit＋push 上去：
 * 自動發佈每次真的發出東西就呼叫一次（postDaily 的 checkpoint），中途中斷也不會丟掉「已經發了」的紀錄。
 *
 * push 被拒（遠端比較新）就 fetch＋merge 再推；網路問題照 2／4／8／16 秒重試。沒有東西要 commit 也照樣確認推上去了。
 */

import { execFileSync } from 'child_process';

export type GitRunner = (args: string[], cwd: string) => string;

const defaultRunner: GitRunner = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function gitCheckpoint(
  dir: string,
  message: string,
  opts: { branch?: string; run?: GitRunner; sleep?: (ms: number) => Promise<void>; backoff?: readonly number[] } = {},
): Promise<void> {
  const run = opts.run ?? defaultRunner;
  const sleep = opts.sleep ?? defaultSleep;
  const backoff = opts.backoff ?? [2000, 4000, 8000, 16000];
  const branch = opts.branch ?? 'threads-state';
  run(['add', '-A'], dir);
  if (run(['status', '--porcelain'], dir).trim()) {
    run(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-q', '-m', message], dir);
  }
  let last: unknown = null;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1]);
    try {
      run(['push', '-q', 'origin', `HEAD:${branch}`], dir);
      return;
    } catch (err) {
      last = err;
      try {
        run(['fetch', '-q', 'origin', branch], dir);
        run(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'merge', '-q', '--no-edit', 'FETCH_HEAD'], dir);
      } catch {
        /* 遠端還沒有這個分支或網路問題：下一輪再推 */
      }
    }
  }
  // 遠端網址可能帶權杖（x-access-token）：訊息裡的帳密遮掉（CI 紀錄是公開的）。
  const why = String((last as Error)?.message ?? last).split('\n')[0].replace(/\/\/[^/\s@]+@/g, '//***@');
  throw new Error(`threads-state 推不上去：${why}`);
}
