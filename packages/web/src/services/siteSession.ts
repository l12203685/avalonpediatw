/**
 * 不用登入的訪客身分（App 進站時、「與機器人練習」頁重試時共用）。
 *
 * 順序：guest_session cookie 續簽 → 失敗就 mint 新訪客 JWT（名字沿用本機暫存的 avalon_player_name，
 * 沒有就 Guest_<6 位>）→ 用它起 socket。同時只跑一個（重試按鈕不會跟 App 自己的流程互相拆 socket）。
 */
import { getGuestToken, resumeGuestFromCookie } from './auth';
import { initializeSocket, getStoredToken } from './socket';

let inFlight: Promise<boolean> | null = null;

// 最近一次嘗試是否失敗（伺服器沒開／回錯）：練習頁據此直接顯示「連不上」＋重新連線，不用等滿 60 秒。
let lastFailed = false;
const listeners = new Set<(failed: boolean) => void>();
function setFailed(failed: boolean): void {
  lastFailed = failed;
  listeners.forEach((fn) => fn(failed));
}
export function sessionFailed(): boolean {
  return lastFailed;
}
export function subscribeSessionFailed(fn: (failed: boolean) => void): () => void {
  listeners.add(fn);
  return (): void => { listeners.delete(fn); };
}

async function runGuestSession(): Promise<boolean> {
  try {
    const resumed = await resumeGuestFromCookie();
    if (resumed) {
      await initializeSocket(resumed.token);
      return true;
    }
  } catch {
    // network error — keep falling through to a fresh mint
  }
  try {
    let savedName: string | undefined;
    try { savedName = localStorage.getItem('avalon_player_name')?.trim(); } catch { /* storage blocked */ }
    const displayName = savedName && savedName.length > 0
      ? savedName
      : `Guest_${Math.floor(Math.random() * 900000 + 100000)}`;
    const token = await getGuestToken(displayName);
    await initializeSocket(token);
    return true;
  } catch {
    return false;
  }
}

/** 續簽或新建訪客 session 並連上 socket；true = 已連上。 */
export function startGuestSession(): Promise<boolean> {
  if (!inFlight) {
    setFailed(false);
    inFlight = runGuestSession()
      .then((ok) => { setFailed(!ok); return ok; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * 「重試連線」：先用已存的 token（登入過的人保留原身分），不行再走訪客。
 * 進行中的嘗試會被沿用，不另開一條。
 */
export async function retrySiteSession(): Promise<boolean> {
  if (inFlight) return inFlight;
  const stored = getStoredToken();
  if (stored) {
    setFailed(false);
    try {
      await initializeSocket(stored);
      return true;
    } catch {
      // expired / rejected → guest
    }
  }
  return startGuestSession();
}
