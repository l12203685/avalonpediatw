import { useEffect, useState } from 'react';
import type { DecisiveReport, DecisiveScope } from '@avalon/shared/stats';
import { decisiveReport } from '../../../stats/statsEngine';
import { useStatsFilter } from '../../../stats/statsFilter';

export type DecisiveState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; report: DecisiveReport };

/** 目前篩選下一個範圍的關鍵票報表（統計 Worker 裡算，stats/statsEngine decisiveReport）。 */
export function useDecisiveReport(scope: DecisiveScope): DecisiveState {
  const filter = useStatsFilter((s) => s.filter);
  const filterKey = useStatsFilter((s) => `${s.key}|${s.nonce}`);
  const key = `${filterKey}|${scope}`;
  const [result, setResult] = useState<{ key: string; state: DecisiveState } | null>(null);
  useEffect(() => {
    let cancelled = false;
    decisiveReport(filter, filterKey, scope)
      .then((report) => { if (!cancelled) setResult({ key, state: { status: 'ok', report } }); })
      .catch((err: unknown) => {
        if (!cancelled) setResult({ key, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } });
      });
    return (): void => { cancelled = true; };
  }, [filter, filterKey, scope, key]);
  return result && result.key === key ? result.state : { status: 'loading' };
}
