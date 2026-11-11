import { useEffect, useState } from 'react';
import type { DecisiveCohortData, DecisiveScope, TwoRedCohortData } from '@avalon/shared/stats';
import { decisiveCohort, twoRedCohort } from '../../../stats/statsEngine';
import { useStatsFilter } from '../../../stats/statsFilter';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: T };

/** 目前篩選下的一份資料（key 換了就重拿；舊的結果不會蓋掉新的）。 */
function useFilterScoped<T>(extra: string, load: (filter: ReturnType<typeof useStatsFilter.getState>['filter'], filterKey: string) => Promise<T>): LoadState<T> {
  const filter = useStatsFilter((s) => s.filter);
  const filterKey = useStatsFilter((s) => `${s.key}|${s.nonce}`);
  const key = `${filterKey}|${extra}`;
  const [result, setResult] = useState<{ key: string; state: LoadState<T> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    load(filter, filterKey)
      .then((data) => { if (!cancelled) setResult({ key, state: { status: 'ok', data } }); })
      .catch((err: unknown) => {
        if (!cancelled) setResult({ key, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } });
      });
    return (): void => { cancelled = true; };
  }, [filter, filterKey, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return result && result.key === key ? result.state : { status: 'loading' };
}

/** 「兩紅之後的派隊」分組的資料（統計 Worker 裡算，stats/statsEngine twoRedCohort）。 */
export function useTwoRedCohort(): LoadState<TwoRedCohortData> {
  return useFilterScoped('twoRedCohort', (filter, filterKey) => twoRedCohort(filter, filterKey));
}

/** 「關鍵外白／內黑」分組的資料（一個範圍；stats/statsEngine decisiveCohort）。 */
export function useDecisiveCohort(scope: DecisiveScope): LoadState<DecisiveCohortData> {
  return useFilterScoped(`decisiveCohort|${scope}`, (filter, filterKey) => decisiveCohort(filter, filterKey, scope));
}
