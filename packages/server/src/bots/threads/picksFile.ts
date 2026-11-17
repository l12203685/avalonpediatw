/**
 * 站長選的 Threads 題目（2026-11-17）→ 日期 → 題號。
 *
 * 正本是 commit 進 repo 的 `threads_picks.json`（自動發佈 PR #48 的格式）：
 *   { "version": 1, "picks": { "2026-11-19": "K7Q2M-3-5" } }
 * 每天的工作把選局頁資料庫的 `picks/<日期>` 同步進這個檔（docs/THREADS.md）。
 * 也接受選局頁資料庫匯出的 [{ "date": …, "exerciseId": … }]（或 { id, data: {…} }）與平的 { 日期: 題號 }。
 * 日期或題號格式不對的筆數直接略過。
 */

import { THREADS_POSTED } from './plan';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXERCISE_RE = /^[0-9A-Z]{5,}-(A|[1-5]-[1-5])$/;

export function parsePicks(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const put = (date: unknown, id: unknown): void => {
    if (typeof date === 'string' && typeof id === 'string' && DATE_RE.test(date) && EXERCISE_RE.test(id)) out.set(date, id);
  };
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const o = r as { date?: unknown; exerciseId?: unknown; id?: unknown; data?: { exerciseId?: unknown; date?: unknown } };
      put(o.date ?? o.data?.date ?? o.id, o.exerciseId ?? o.data?.exerciseId);
    }
    return out;
  }
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  const flat = obj.picks && typeof obj.picks === 'object' && !Array.isArray(obj.picks) ? (obj.picks as Record<string, unknown>) : obj;
  for (const [k, v] of Object.entries(flat)) put(k, typeof v === 'string' ? v : (v as { exerciseId?: unknown } | null)?.exerciseId);
  return out;
}

/** threads_picks.json 的內容（#48 的格式，日期排好）。 */
export function picksFileBody(picks: ReadonlyMap<string, string>, comment?: string): string {
  const sorted = Object.fromEntries([...picks].sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${JSON.stringify({ ...(comment ? { _comment: comment } : {}), version: 1, picks: sorted }, null, 2)}\n`;
}

/** 只留還沒貼出去的日子（今天之後）。 */
export function futurePicks(picks: ReadonlyMap<string, string>, today: string): Map<string, string> {
  return new Map([...picks].filter(([d]) => d > today));
}

/**
 * 給產生器的 `pickOverride`：已經貼出去的日子（THREADS_POSTED）固定用貼出去的題號，其他日子用站長選的。
 */
export function pickOverrideOf(picks: ReadonlyMap<string, string>): (date: string) => string | null {
  return (date) => THREADS_POSTED[date] ?? picks.get(date) ?? null;
}
