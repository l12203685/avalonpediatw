/**
 * 基準列的資料與開關（Edward 2026-11-03「你可以預設讓以下幾個呈現在所有排行跟數據分析的最上列嗎 [散客 < 30場]
 * [排除散客後全體] [排除散客後 PR50+] [排除散客後 PR50-]」，同日改成依當局 Elo PR 三等分：前1/3／中間1/3／後1/3）。
 *
 * - 數字：瀏覽器端引擎 computeStats 的 `benchmarks`（@avalon/shared/stats benchmarks.ts）。有篩選時就是那個篩選的
 *   結果（各表本來就用它）；不篩選時 analysis_cache.json 沒有這一段，用空篩選在 Worker 裡算一次全部局（同一份
 *   /api/analysis/games，結果依篩選快取，切回來不重算）。資料集拿不到或算不出來 = 沒有基準列，表格照常顯示。
 * - 開關「顯示基準列」：預設開，記在 localStorage（私密視窗等讀寫失敗時就是預設開、不記）。全站一份，任一張表的
 *   開關都會改到全部的表。
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { BenchmarksSection, GameFilter } from '@avalon/shared/stats';
import { filteredStats } from './statsEngine';
import { filterScopedLoader } from './filterScopedLoader';
import { currentStatsFilter } from './statsFilter';

const STORAGE_KEY = 'avalon.stats.benchmarkRows';
const EMPTY_FILTER: GameFilter = { v: 1, clauses: [] };

function readShow(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeShow(show: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, show ? '1' : '0');
  } catch {
    // 私密視窗等：不記也沒關係
  }
}

interface BenchmarkToggleState {
  show: boolean;
  setShow: (show: boolean) => void;
}

export const useBenchmarkToggle = create<BenchmarkToggleState>((set) => ({
  show: readShow(),
  setShow: (show: boolean): void => {
    writeShow(show);
    set({ show });
  },
}));

const loader = filterScopedLoader<BenchmarksSection | null>(() => {
  const { filter, key } = currentStatsFilter();
  return filteredStats(key && filter ? filter : EMPTY_FILTER, key)
    .then((r) => r.benchmarks ?? null);
});

/** 目前篩選的基準列；關掉、還沒算好或拿不到時 null。 */
export function useBenchmarks(): BenchmarksSection | null {
  const show = useBenchmarkToggle((s) => s.show);
  const [data, setData] = useState<BenchmarksSection | null>(() => loader.peek());
  useEffect(() => {
    if (!show || loader.peek()) return undefined;
    let cancelled = false;
    loader.load()
      .then((b) => { if (!cancelled) setData(b); })
      .catch(() => { if (!cancelled) setData(null); });
    return (): void => { cancelled = true; };
  }, [show]);
  // 別張表先算好的 (同一個篩選) 直接用
  return show ? data ?? loader.peek() : null;
}
