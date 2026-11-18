/**
 * 每日小觀念 — 台北時間的「今天」與起始時間。台灣沒有日光節約時間，固定 +08；
 * 用 epoch 毫秒加 8 小時再讀 getUTC*()，不受主機時區影響（Render 跑 UTC）。
 */

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface TaipeiNow {
  date: string;
  /** 一天中的第幾分鐘（台北）。 */
  minute: number;
}

export function taipeiNow(epochMs: number): TaipeiNow {
  const d = new Date(epochMs + TAIPEI_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * 這一刻屬於哪一天的小觀念：起始時間（含）以後是今天的日期；起始時間以前（例如 05:59）是 null（還不發，
 * 昨天的已經過了）。06:00:00 整就算。
 */
export function dailyKeyAt(epochMs: number, startMinute: number): string | null {
  const t = taipeiNow(epochMs);
  return t.minute >= startMinute ? t.date : null;
}

/** 提前準備的時間：起始時間前 30 分鐘（最早 00:00）就先把當天的卡算好。 */
export function prepareKeyAt(epochMs: number, startMinute: number, leadMinutes = 30): string | null {
  const t = taipeiNow(epochMs);
  return t.minute >= Math.max(0, startMinute - leadMinutes) ? t.date : null;
}
