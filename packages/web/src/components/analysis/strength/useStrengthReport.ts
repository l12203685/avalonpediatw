import { useEffect, useState } from 'react';
import type { StrengthGrouping, StrengthReport } from '@avalon/shared/stats';
import { strengthReport } from '../../../stats/statsEngine';
import { useStatsFilter } from '../../../stats/statsFilter';

export type StrengthState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; report: StrengthReport };

/**
 * 數據分析「陣容強度」的資料：跟著上方的篩選（沒有篩選 = 全部局），在統計 Worker 裡算（stats/statsEngine strengthReport）。
 * 換分組只重算分組比較（每局的指標在 Worker 裡快取）。
 */
export function useStrengthReport(grouping: StrengthGrouping): StrengthState {
  const filter = useStatsFilter((s) => s.filter);
  const key = useStatsFilter((s) => `${s.key}|${s.nonce}`);
  const groupingKey = JSON.stringify(grouping);
  const requestKey = `${key}|${groupingKey}`;
  const [result, setResult] = useState<{ key: string; state: StrengthState } | null>(null);
  useEffect(() => {
    let cancelled = false;
    strengthReport(filter, key, JSON.parse(groupingKey) as StrengthGrouping)
      .then((report) => { if (!cancelled) setResult({ key: `${key}|${groupingKey}`, state: { status: 'ok', report } }); })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult({ key: `${key}|${groupingKey}`, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } });
        }
      });
    return (): void => { cancelled = true; };
  }, [filter, key, groupingKey]);
  if (result && (result.key === requestKey || result.state.status === 'ok')) return result.state; // 換分組時先留著上一份
  return { status: 'loading' };
}
