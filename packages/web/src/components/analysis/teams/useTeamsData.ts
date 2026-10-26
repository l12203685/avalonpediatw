import { useEffect, useState } from 'react';
import {
  fetchAnalysisCaptain,
  fetchAnalysisRounds,
  getErrorMessage,
  isAnalysisNotGenerated,
  type CaptainAnalysisData,
  type RoundsAnalysisData,
} from '../../../services/api';
import { filterScopedLoader, type FilterScopedLoader } from '../../../stats/filterScopedLoader';

/**
 * 派隊分頁的資料 (2026-10-14 Edward：派隊「分析很好但太散」→ 依主題拆成小分頁)。
 *
 * /api/analysis/captain 與 /api/analysis/rounds 各只打一次 (module 級快取)：小分頁一次只掛一頁，
 * 切來切去、離開派隊再回來都不重打。失敗不快取，下次掛載重試。
 */
export interface TeamsResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 快取還沒有這段 (503 "not yet generated")：顯示「下次每日更新後提供」而不是錯誤。 */
  notGenerated: boolean;
}

type Loader<T> = FilterScopedLoader<T>;

const captainLoader = filterScopedLoader(fetchAnalysisCaptain);
const roundsLoader = filterScopedLoader(fetchAnalysisRounds);

function useResource<T>(loader: Loader<T>): TeamsResource<T> {
  const [state, setState] = useState<TeamsResource<T>>(() => {
    const cached = loader.peek();
    return { data: cached, loading: cached === null, error: null, notGenerated: false };
  });

  useEffect(() => {
    if (loader.peek()) return;
    let cancelled = false;
    loader.load()
      .then(d => {
        if (!cancelled) setState({ data: d, loading: false, error: null, notGenerated: false });
      })
      .catch(err => {
        if (!cancelled) {
          setState({ data: null, loading: false, error: getErrorMessage(err), notGenerated: isAnalysisNotGenerated(err) });
        }
      });
    return (): void => { cancelled = true; };
  }, [loader]);

  return state;
}

/** 隊長分析 (/captain)。 */
export function useCaptainData(): TeamsResource<CaptainAnalysisData> {
  return useResource(captainLoader);
}

/** 回合分析 (/rounds)：1-1 派票、各任務成功率、任務 1 之後、完整任務路徑。 */
export function useRoundsData(): TeamsResource<RoundsAnalysisData> {
  return useResource(roundsLoader);
}
