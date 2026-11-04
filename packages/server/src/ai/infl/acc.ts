/**
 * 可合併的平均值累加器（資訊流研究腳本分子行程跑、最後合併；2026-11-04）。
 * key → { n, 各指標的總和 }；平均 = 總和 / n（每個指標各自的 n，缺值不算）。
 */
export interface AccCell { n: number; sum: Record<string, number>; cnt: Record<string, number> }
export type AccStore = Record<string, AccCell>;

export class Acc {
  readonly store: AccStore;
  constructor(store: AccStore = {}) { this.store = store; }

  add(keys: readonly string[], metrics: Record<string, number | null | undefined>): void {
    for (const key of keys) {
      const c = (this.store[key] ??= { n: 0, sum: {}, cnt: {} });
      c.n++;
      for (const [m, v] of Object.entries(metrics)) {
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        c.sum[m] = (c.sum[m] ?? 0) + v;
        c.cnt[m] = (c.cnt[m] ?? 0) + 1;
      }
    }
  }

  mean(key: string, m: string): number | null {
    const c = this.store[key];
    if (!c || !c.cnt[m]) return null;
    return c.sum[m] / c.cnt[m];
  }

  count(key: string, m?: string): number {
    const c = this.store[key];
    if (!c) return 0;
    return m ? c.cnt[m] ?? 0 : c.n;
  }

  merge(other: AccStore): void {
    for (const [key, o] of Object.entries(other)) {
      const c = (this.store[key] ??= { n: 0, sum: {}, cnt: {} });
      c.n += o.n;
      for (const [m, v] of Object.entries(o.sum)) c.sum[m] = (c.sum[m] ?? 0) + v;
      for (const [m, v] of Object.entries(o.cnt)) c.cnt[m] = (c.cnt[m] ?? 0) + v;
    }
  }
}

export const fmtPct = (x: number | null, d = 1): string => (x === null ? '—' : `${(100 * x).toFixed(d)}%`);
export const fmtNum = (x: number | null, d = 3): string => (x === null ? '—' : x.toFixed(d));

/** 簡單的等寬表格。 */
export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => [...(r[i] ?? '')].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0))));
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));
  return rows.map((r) => r.map((c, i) => pad(c, widths[i])).join('  ')).join('\n');
}
