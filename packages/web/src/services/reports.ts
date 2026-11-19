/**
 * 網站「回報與修正」頁 ⇄ 伺服器（packages/server/src/routes/reports.ts）。不用登入。
 *   - fetchReports：最近的百科回報與處理狀態（沒有暱稱）
 * 送出回報用 services/api.ts 的 submitFeedback（同右下角「問題回報」）。
 */
import type { PublicReport } from '../utils/reports';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3001';

export class ReportsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ReportsError';
    this.status = status;
  }
}

/** fresh＝不用瀏覽器快取（剛送出回報後重讀）。 */
export async function fetchReports(fresh = false): Promise<{ reports: PublicReport[]; stale: boolean; fetchedAt: string | null }> {
  const res = await fetch(`${SERVER_URL}/api/reports`, fresh ? { cache: 'no-cache' } : undefined);
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; reports?: PublicReport[]; stale?: boolean; fetchedAt?: string };
  if (!res.ok || body.ok !== true || !Array.isArray(body.reports)) throw new ReportsError(res.status, body.error ?? `HTTP ${res.status}`);
  return { reports: body.reports, stale: Boolean(body.stale), fetchedAt: body.fetchedAt ?? null };
}

export function reportsErrorText(err: unknown): string {
  if (err instanceof ReportsError) {
    if (err.status === 429) return '讀太快了，請等一分鐘再試';
    if (err.status === 503) return '暫時讀不到回報清單（伺服器可能還在喚醒），請稍後再試';
  }
  return '連不到伺服器，請稍後再試';
}
