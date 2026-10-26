import { useCallback, useEffect, useState } from 'react';
import type { FilterMeta } from '@avalon/shared/stats';
import { filteredStats, loadFilterVocab } from '../../../stats/statsEngine';
import type { FilterVocab } from '../../../stats/statsCompute';
import { useStatsFilter } from '../../../stats/statsFilter';

export type FilterStatus =
  | { state: 'idle' }
  | { state: 'computing' }
  | { state: 'ready'; meta: FilterMeta }
  | { state: 'error'; message: string };

/**
 * 目前篩選的計算狀態與 meta (局數、排除人數、各條件丟掉的局數、提醒)。和分析各分頁的資料用同一份結果
 * (statsEngine 依篩選快取)，不會多算一次。
 */
export function useFilterResult(): { status: FilterStatus; retry: () => void } {
  const filter = useStatsFilter((s) => s.filter);
  const key = useStatsFilter((s) => s.key);
  // 結果記著是哪個篩選、第幾次嘗試的；和目前不同 = 還在算
  const [done, setDone] = useState<{ key: string; attempt: number; status: FilterStatus } | null>(null);
  const attempt = useStatsFilter((s) => s.nonce);
  const bump = useStatsFilter((s) => s.retry);
  useEffect(() => {
    if (!filter || !key) return undefined;
    let cancelled = false;
    const finish = (status: FilterStatus): void => { if (!cancelled) setDone({ key, attempt, status }); };
    filteredStats(filter, key)
      .then((r) => finish({ state: 'ready', meta: r.meta }))
      .catch((e: unknown) => finish({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    return (): void => { cancelled = true; };
  }, [filter, key, attempt]);
  const retry = useCallback(() => bump(), [bump]);
  if (!filter || !key) return { status: { state: 'idle' }, retry };
  const status: FilterStatus = done && done.key === key && done.attempt === attempt ? done.status : { state: 'computing' };
  return { status, retry };
}

/** 篩選面板的選項 (打開面板時才載入；失敗 = null，面板照樣能用，只是沒有名單提示)。 */
export function useFilterVocab(enabled: boolean): FilterVocab | null {
  const [vocab, setVocab] = useState<FilterVocab | null>(null);
  useEffect(() => {
    if (!enabled || vocab) return undefined;
    let cancelled = false;
    loadFilterVocab().then((v) => { if (!cancelled) setVocab(v); }, () => undefined);
    return (): void => { cancelled = true; };
  }, [enabled, vocab]);
  return vocab;
}
