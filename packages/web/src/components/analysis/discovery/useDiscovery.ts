import { useEffect, useState } from 'react';
import type { DiscoveryResult } from '@avalon/shared/stats';
import { discoveryResult } from '../../../stats/statsEngine';
import { useStatsFilter } from '../../../stats/statsFilter';

export type DiscoveryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; result: DiscoveryResult };

/** 自動發現的結果：跟著上方的篩選，在統計 Worker 裡掃描（同一個篩選只算一次，各分頁共用）。 */
export function useDiscovery(): DiscoveryState {
  const filter = useStatsFilter((s) => s.filter);
  const key = useStatsFilter((s) => `${s.key}|${s.nonce}`);
  const [result, setResult] = useState<{ key: string; state: DiscoveryState } | null>(null);
  useEffect(() => {
    let cancelled = false;
    discoveryResult(filter, key)
      .then((r) => { if (!cancelled) setResult({ key, state: { status: 'ok', result: r } }); })
      .catch((err: unknown) => {
        if (!cancelled) setResult({ key, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } });
      });
    return (): void => { cancelled = true; };
  }, [filter, key]);
  return result && result.key === key ? result.state : { status: 'loading' };
}
