/**
 * 分析各分頁的 module 級快取，依篩選分開存 (stats/statsFilter.ts 的 key；'' = 不篩選)：改了篩選就拿那個篩選的
 * 資料，切回不篩選時直接用原本那份，不重打。失敗不快取，下次重試。
 */
import { currentStatsFilter } from './statsFilter';

export interface FilterScopedLoader<T> {
  /** 目前篩選的資料 (force = 重抓)。 */
  load: (force?: boolean) => Promise<T>;
  /** 目前篩選已經有的資料 (沒有 = null)。 */
  peek: () => T | null;
}

const KEEP = 6;

export function filterScopedLoader<T>(fetcher: () => Promise<T>): FilterScopedLoader<T> {
  const cached = new Map<string, T>();
  const inflight = new Map<string, Promise<T>>();
  return {
    load: (force = false): Promise<T> => {
      const { key } = currentStatsFilter();
      if (!force && cached.has(key)) return Promise.resolve(cached.get(key) as T);
      const running = inflight.get(key);
      if (!force && running) return running;
      const p = fetcher()
        .then((d) => {
          cached.delete(key);
          cached.set(key, d);
          while (cached.size > KEEP) cached.delete(cached.keys().next().value as string);
          return d;
        })
        .finally(() => {
          if (inflight.get(key) === p) inflight.delete(key);
        });
      inflight.set(key, p);
      return p;
    },
    peek: (): T | null => {
      const { key } = currentStatsFilter();
      return cached.has(key) ? (cached.get(key) as T) : null;
    },
  };
}
