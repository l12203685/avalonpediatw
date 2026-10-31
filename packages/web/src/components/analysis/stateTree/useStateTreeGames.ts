import { useEffect, useState } from 'react';
import { stateTreeGames } from '../../../stats/statsEngine';
import { useStatsFilter } from '../../../stats/statsFilter';
import type { StateGamesResult } from './stateTree';

export type StateTreeState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; result: StateGamesResult };

/**
 * 局勢樹的資料：跟著上方的篩選（沒有篩選 = 全部局），在統計 Worker 裡把每局縮成樹要的欄位
 * （stats/statsEngine stateTreeGames）。換湖的分支方式、門檻、顏色都在畫面上重算，不再跑 Worker。
 */
export function useStateTreeGames(): StateTreeState {
  const filter = useStatsFilter((s) => s.filter);
  const key = useStatsFilter((s) => `${s.key}|${s.nonce}`);
  const [result, setResult] = useState<{ key: string; state: StateTreeState } | null>(null);
  useEffect(() => {
    let cancelled = false;
    stateTreeGames(filter, key)
      .then((r) => { if (!cancelled) setResult({ key, state: { status: 'ok', result: r } }); })
      .catch((err: unknown) => {
        if (!cancelled) setResult({ key, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } });
      });
    return (): void => { cancelled = true; };
  }, [filter, key]);
  return result && result.key === key ? result.state : { status: 'loading' };
}
