/**
 * 站長在選局頁選的題目（2026-11-17）→ 日期 → 題號。
 * 接受兩種寫法：{ "2026-11-19": "K7Q2M-3-5" }，或選局頁資料庫匯出的
 * [{ "date": "2026-11-19", "exerciseId": "K7Q2M-3-5" }]（也接受 { id: "2026-11-19", data: {...} }）。
 * 日期或題號格式不對的筆數直接略過。
 */

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
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      put(k, typeof v === 'string' ? v : (v as { exerciseId?: unknown } | null)?.exerciseId);
    }
  }
  return out;
}

/** 只留還沒貼出去的日子（今天之後）。 */
export function futurePicks(picks: ReadonlyMap<string, string>, today: string): Map<string, string> {
  return new Map([...picks].filter(([d]) => d > today));
}
