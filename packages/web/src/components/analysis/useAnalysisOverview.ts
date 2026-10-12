import { useCallback, useEffect, useState } from 'react';
import {
  fetchAnalysisOverview,
  getErrorMessage,
  type AnalysisOverview,
  type AssassinationStageSummary,
  type FinalOutcomeSummary,
  type MissionStageSummary,
} from '../../services/api';

/**
 * 深度分析各分頁共用的 /api/analysis/overview 資料 — module 級快取，整個
 * AnalyticsPage 只打一次 API：分析副標的場數、總覽卡、刺殺結算卡、位置勝率圖、
 * 各角色最終勝率表都讀這裡。
 */
let cached: AnalysisOverview | null = null;
let inflight: Promise<AnalysisOverview> | null = null;

export function loadAnalysisOverview(force = false): Promise<AnalysisOverview> {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && inflight) return inflight;
  const p = fetchAnalysisOverview()
    .then(d => {
      cached = d;
      return d;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

export interface AnalysisOverviewState {
  overview: AnalysisOverview | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAnalysisOverview(): AnalysisOverviewState {
  const [overview, setOverview] = useState<AnalysisOverview | null>(cached);
  const [loading, setLoading] = useState<boolean>(cached === null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadAnalysisOverview(reloadKey > 0)
      .then(d => {
        if (cancelled) return;
        setOverview(d);
        setError(null);
      })
      .catch(e => {
        if (!cancelled) setError(getErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback((): void => {
    setLoading(true);
    setError(null);
    setReloadKey(k => k + 1);
  }, []);

  return { overview, loading, error, reload };
}

/**
 * Round to one decimal with ties to even, exactly like Python's round() in
 * generate_cache.py (rnd1): 56.25 → 56.2, 56.35 → 56.4. Math.round would give
 * 56.3 and make the fallback differ from the cache by 0.1 on exact ties.
 */
function rnd1(n: number): number {
  const scaled = n * 10;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  if (frac === 0.5) return (floor % 2 === 0 ? floor : floor + 1) / 10;
  return Math.round(scaled) / 10;
}

function pctOf(n: number, d: number): number {
  return d > 0 ? rnd1((n / d) * 100) : 0;
}

export interface StageSummaries {
  mission: MissionStageSummary;
  assassination: AssassinationStageSummary;
  final: FinalOutcomeSummary;
  /** true = 舊快取缺三段欄位，由 outcomeBreakdown 現場算。 */
  derived: boolean;
}

/**
 * 三段結算 (docs/stats/two_stage_outcome.md)：快取有 missionStage /
 * assassinationStage / final 就直接用；舊快取由三種結果分布
 * (三紅 / 三藍死 / 三藍活) 現場算，公式同 generate_cache.py：
 *   任務結算 = 三紅 vs 三藍 (死或活)；刺殺結算 = 三藍局中 三藍死 vs 三藍活；
 *   最終：紅勝 = 三紅 + 三藍死、藍勝 = 三藍活。
 */
export function deriveStages(ov: AnalysisOverview): StageSummaries {
  if (ov.missionStage && ov.assassinationStage && ov.final) {
    return { mission: ov.missionStage, assassination: ov.assassinationStage, final: ov.final, derived: false };
  }
  const ob = ov.outcomeBreakdown;
  const threeRed = ob?.threeRed ?? 0;
  const dead = ob?.threeBlueDead ?? 0;
  const alive = ob?.threeBlueAlive ?? 0;
  const games = threeRed + dead + alive;
  const threeBlue = dead + alive;
  return {
    mission: {
      games,
      threeRed,
      threeBlue,
      redPct: pctOf(threeRed, games),
      bluePct: pctOf(threeBlue, games),
    },
    assassination: {
      games: threeBlue,
      merlinKilled: dead,
      merlinSurvived: alive,
      killPct: pctOf(dead, threeBlue),
      survivePct: pctOf(alive, threeBlue),
    },
    final: {
      games,
      redWins: threeRed + dead,
      blueWins: alive,
      redPct: pctOf(threeRed + dead, games),
      bluePct: pctOf(alive, games),
    },
    derived: true,
  };
}
