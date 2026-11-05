/**
 * 網站「百科AI 對局」頁 ⇄ 伺服器（packages/server/src/routes/aiGames.ts）。不用登入。
 *   - fetchAiGames：最近的百科AI 對局（DC 論壇的討論串）
 *   - fetchAiGame：一局的 trace（每個百科AI 決定與理由）
 *   - flagAiDecision：「這步怪怪的」→ 伺服器貼成那篇 DC 討論串的回覆
 */
import type { AiGameListItem, AiGameTrace } from '../utils/aiGames';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3001';

/** 伺服器回的錯誤（帶狀態碼：503 還沒設定或 DC 暫時讀不到、404 找不到、429 太頻繁）。 */
export class AiGamesError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AiGamesError';
    this.status = status;
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!res.ok || body.ok === false) throw new AiGamesError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function fetchAiGames(): Promise<{ games: AiGameListItem[]; stale: boolean }> {
  const res = await fetch(`${SERVER_URL}/api/ai-games`);
  return readJson<{ games: AiGameListItem[]; stale: boolean }>(res);
}

export async function fetchAiGame(id: string): Promise<{ trace: AiGameTrace; thread: { id: string; name: string; url: string } }> {
  const res = await fetch(`${SERVER_URL}/api/ai-games/${encodeURIComponent(id)}`);
  return readJson<{ trace: AiGameTrace; thread: { id: string; name: string; url: string } }>(res);
}

export async function flagAiDecision(id: string, decisionId: number, note: string, name: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/ai-games/${encodeURIComponent(id)}/flag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisionId, note, name }),
  });
  await readJson<Record<string, unknown>>(res);
}

/** 錯誤 → 給玩家看的中文。 */
export function aiGamesErrorText(err: unknown): string {
  if (err instanceof AiGamesError) {
    if (err.status === 429) return '送太快了，請等一分鐘再試';
    if (err.status === 404) return '找不到這一局（可能已在 DC 刪除）';
    if (err.status === 503) return '暫時讀不到 DC（伺服器可能還在喚醒），請稍後再試';
    if (err.status === 400) return '這一步找不到，請重新整理';
  }
  return '連不到伺服器，請稍後再試';
}
