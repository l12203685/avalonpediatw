/**
 * 陣容強度篩選的畫面狀態（Edward 2026-10-31：「可以同時給出篩選功能：S = 場上 PR 的平均，直接用 S 來篩選；或是人數：
 * PR X 有 Y 人以上，X 跟 Y 都可以調整；而且這兩個條件都可以複選（且／或）」「當局的紅方／忠臣各自的最高／最低
 * ELO & PR，以及派西／梅林的 ELO & PR，也可以是分析維度或標籤」）。牌譜紀錄頁籤與統計頁的「更多篩選」共用。
 *
 * 判斷本身在 @avalon/shared/stats 的 matchesLineup；這裡只管開關與數字（關掉的條件也記得上次的數字）。
 * 純函式，packages/server/src/__tests__/WebRecords.test.ts 測。
 */
import type { LineupCondition } from '@avalon/shared/stats';

/** 角色條件：開關與數字（條件鍵 → 畫面上的字）。 */
export const ROLE_CONDITIONS = [
  { key: 'merlinPrMin', label: '梅林 PR ≥', min: 0, max: 100, fallback: 70 },
  { key: 'percivalPrMin', label: '派西 PR ≥', min: 0, max: 100, fallback: 70 },
  { key: 'redMinPrMin', label: '紅方最低 PR ≥', min: 0, max: 100, fallback: 30 },
  { key: 'loyalMinPrMin', label: '忠臣最低 PR ≥', min: 0, max: 100, fallback: 30 },
  { key: 'gapMin', label: '紅方平均 − 藍方平均 PR ≥', min: -100, max: 100, fallback: 10 },
] as const;

export type RoleConditionKey = (typeof ROLE_CONDITIONS)[number]['key'];

export interface LineupFilterState {
  /** S ≥ sMin 這個條件開了沒。 */
  sOn: boolean;
  sMin: number;
  /** 「PR strongPr 以上至少 strongCount 人」開了沒。 */
  countOn: boolean;
  strongPr: number;
  strongCount: number;
  /** 角色條件：開了哪些、各自的數字。 */
  roleOn: Record<RoleConditionKey, boolean>;
  roleValue: Record<RoleConditionKey, number>;
  /** 兩個以上條件都開時：且／或。 */
  combine: 'and' | 'or';
  /** 沒評分的局也列出來。 */
  includeUnscored: boolean;
}

const ROLE_OFF = Object.fromEntries(ROLE_CONDITIONS.map((r) => [r.key, false])) as Record<RoleConditionKey, boolean>;
const ROLE_DEFAULTS = Object.fromEntries(ROLE_CONDITIONS.map((r) => [r.key, r.fallback])) as Record<RoleConditionKey, number>;

/** 預設數字：S ≥ 65（歷史約 8% 的局）、PR 70 以上至少 6 人；角色條件見 ROLE_CONDITIONS。 */
export const DEFAULT_LINEUP_FILTER: LineupFilterState = {
  sOn: false, sMin: 65, countOn: false, strongPr: 70, strongCount: 6,
  roleOn: ROLE_OFF, roleValue: ROLE_DEFAULTS, combine: 'and', includeUnscored: false,
};

/** 高強度（S ≥ 65）／偏強（≥ 55）：清單徽章的顏色分級。 */
export const LINEUP_HIGH_S = 65;
export const LINEUP_STRONG_S = 55;

export function lineupTier(s: number): 'high' | 'strong' | 'normal' {
  return s >= LINEUP_HIGH_S ? 'high' : s >= LINEUP_STRONG_S ? 'strong' : 'normal';
}

function enabledCount(state: LineupFilterState): number {
  return (state.sOn ? 1 : 0) + (state.countOn ? 1 : 0) + ROLE_CONDITIONS.filter((r) => state.roleOn[r.key]).length;
}

/** 條件有沒有開（清除篩選的按鈕、符合幾局的說明用）。 */
export function lineupFilterActive(state: LineupFilterState): boolean {
  return enabledCount(state) > 0;
}

/** 畫面狀態 → 篩選條件（只放開著的條件；都關 = {}，不篩）。 */
export function lineupCondition(state: LineupFilterState): LineupCondition {
  const c: LineupCondition = {};
  if (state.sOn) c.sMin = state.sMin;
  if (state.countOn) {
    c.strongPr = state.strongPr;
    c.strongCount = state.strongCount;
  }
  for (const r of ROLE_CONDITIONS) if (state.roleOn[r.key]) c[r.key] = state.roleValue[r.key];
  if (enabledCount(state) >= 2 && state.combine === 'or') c.combine = 'or';
  if (enabledCount(state) > 0 && state.includeUnscored) c.includeUnscored = true;
  return c;
}

/** 篩選條件 → 畫面狀態（沒開的條件用預設數字）。 */
export function lineupStateFromCondition(c: LineupCondition | null | undefined): LineupFilterState {
  if (!c) return { ...DEFAULT_LINEUP_FILTER };
  const sOn = typeof c.sMin === 'number';
  const countOn = typeof c.strongPr === 'number' && typeof c.strongCount === 'number';
  const roleOn = { ...ROLE_OFF };
  const roleValue = { ...ROLE_DEFAULTS };
  for (const r of ROLE_CONDITIONS) {
    const v = c[r.key];
    if (typeof v === 'number') {
      roleOn[r.key] = true;
      roleValue[r.key] = v;
    }
  }
  return {
    sOn,
    sMin: sOn ? (c.sMin as number) : DEFAULT_LINEUP_FILTER.sMin,
    countOn,
    strongPr: countOn ? (c.strongPr as number) : DEFAULT_LINEUP_FILTER.strongPr,
    strongCount: countOn ? (c.strongCount as number) : DEFAULT_LINEUP_FILTER.strongCount,
    roleOn,
    roleValue,
    combine: c.combine === 'or' ? 'or' : 'and',
    includeUnscored: c.includeUnscored === true,
  };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

/** 從儲存（或輸入框）來的值整理成合法狀態：S、PR 是 0–100 的整數，人數 1–10，紅藍差 −100–100。 */
export function sanitizeLineupState(raw: unknown): LineupFilterState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_LINEUP_FILTER;
  const on = (r.roleOn && typeof r.roleOn === 'object' ? r.roleOn : {}) as Record<string, unknown>;
  const val = (r.roleValue && typeof r.roleValue === 'object' ? r.roleValue : {}) as Record<string, unknown>;
  const roleOn = { ...ROLE_OFF };
  const roleValue = { ...ROLE_DEFAULTS };
  for (const c of ROLE_CONDITIONS) {
    roleOn[c.key] = on[c.key] === true;
    roleValue[c.key] = clampInt(val[c.key], c.min, c.max, c.fallback);
  }
  return {
    sOn: r.sOn === true,
    sMin: clampInt(r.sMin, 0, 100, d.sMin),
    countOn: r.countOn === true,
    strongPr: clampInt(r.strongPr, 0, 100, d.strongPr),
    strongCount: clampInt(r.strongCount, 1, 10, d.strongCount),
    roleOn,
    roleValue,
    combine: r.combine === 'or' ? 'or' : 'and',
    includeUnscored: r.includeUnscored === true,
  };
}
