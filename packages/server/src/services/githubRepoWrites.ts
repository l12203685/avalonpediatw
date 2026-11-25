/**
 * 同一個 GitHub repo 的同一個分支，一次只送一個「寫檔」請求（2026-11-25）。
 *
 * GitHub Contents API 的每一次 PUT 都是一個 commit；同一個分支同時來兩個，後到的那個會被拒絕（409），
 * 就算寫的是不同的檔案。帳號庫（services/githubAuthAccounts.ts：註冊、改密碼）和機器人的狀態檔
 * （bots/conceptDaily/store.ts 的 GitHubJsonFile：每日小觀念、模擬瓦進行中的題目）寫的是同一個 private repo，
 * 模擬瓦的題目有人玩的時候最多每 25 秒寫一次——不排隊的話，剛好同一瞬間註冊的人會註冊失敗。
 *
 * 只在這一台伺服器裡排隊（記憶體）；前一個寫入最久等 `maxWaitMs`，之後照樣送（不會卡死）。`fn` 丟的錯照樣往外丟。
 */

const tails = new Map<string, Promise<void>>();

/** 排隊用的 key：`owner/repo@branch`（不分大小寫）。 */
export function repoWriteKey(repo: string, branch: string): string {
  return `${repo}@${branch}`.toLowerCase();
}

export async function serializeRepoWrite<T>(key: string, fn: () => Promise<T>, maxWaitMs = 5_000): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([prev, new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
