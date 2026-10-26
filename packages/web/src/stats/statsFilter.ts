/**
 * 數據分析的篩選狀態 (Edward 2026-10-14「所有數據都有可以複合篩選的功能」)。
 *
 * - 狀態只有一份 (zustand)：分析各分頁的資料請求 (services/api.ts analysisApiFetch) 讀 currentStatsFilter()，
 *   有篩選時改用瀏覽器端引擎的結果 (stats/filteredRoutes.ts)。
 * - 沒有子句、選項都是預設 = 不篩選 (null, key '')：畫面直接讀快取，和以前一樣。
 * - 分享連結：#stats?f=1.<base64url>（docs/stats/filter_engine.md）；#stats?preset=online 等短碼給機器人用，
 *   展開後換成完整連結。
 */
import { create } from 'zustand';
import { canonicalFilterKey, decodeFilter, encodeFilter, presetFilter, type GameFilter } from '@avalon/shared/stats';

export interface StatsFilterState {
  filter: GameFilter | null;
  /** canonicalFilterKey(filter)；'' = 不篩選。 */
  key: string;
  /** 分享連結解碼時丟掉的條件 (給面板顯示)。 */
  warnings: string[];
  /** 「重試」的次數：分析分頁以 key + nonce 重新掛載，重新拿資料。 */
  nonce: number;
  setFilter: (filter: GameFilter | null, warnings?: string[]) => void;
  retry: () => void;
}

function normalize(filter: GameFilter | null): { filter: GameFilter | null; key: string } {
  const key = canonicalFilterKey(filter);
  return key ? { filter, key } : { filter: null, key: '' };
}

export const useStatsFilter = create<StatsFilterState>((set) => ({
  filter: null,
  key: '',
  warnings: [],
  nonce: 0,
  setFilter: (filter, warnings = []): void => set({ ...normalize(filter), warnings }),
  retry: (): void => set((s) => ({ nonce: s.nonce + 1 })),
}));

/** 目前的篩選 (非 React 呼叫端用)。 */
export function currentStatsFilter(): { filter: GameFilter | null; key: string } {
  const { filter, key } = useStatsFilter.getState();
  return { filter, key };
}

/** 篩選的分享 hash；不篩選時 '#stats'。 */
export function filterHash(filter: GameFilter | null): string {
  return filter && canonicalFilterKey(filter) ? `#stats?f=${encodeFilter(filter)}` : '#stats';
}

/** #stats?f=… 的參數 (StatsLink 的 filter / preset)。 */
export interface StatsHashParams {
  filter?: string;
  preset?: string;
}

/** 'f=1.xxx&preset=online' → 參數。 */
export function parseStatsQuery(query: string): StatsHashParams {
  const out: StatsHashParams = {};
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    let v = part.slice(eq + 1);
    try {
      v = decodeURIComponent(v);
    } catch {
      // 壞掉的 % 保留原樣
    }
    if (k === 'f' && v) out.filter = v;
    if (k === 'preset' && v) out.preset = v;
  }
  return out;
}

/**
 * 分享連結的參數 → 篩選。preset 的「近一年」要基準日 (asOf；資料集載入前用今天)。
 * 回傳 null filter = 連結壞掉或沒有篩選。
 */
export function filterFromParams(params: StatsHashParams, asOf: string): { filter: GameFilter | null; warnings: string[] } {
  if (params.filter) return decodeFilter(params.filter);
  if (params.preset) {
    const f = presetFilter(params.preset, asOf);
    return f ? { filter: f, warnings: [] } : { filter: null, warnings: ['unknown preset'] };
  }
  return { filter: null, warnings: [] };
}
