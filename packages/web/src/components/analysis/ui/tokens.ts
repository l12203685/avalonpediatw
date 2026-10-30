/**
 * 分析頁共用 UI 的顏色與數字格式 (2026-10-14 round 6：每個分析分頁一頁一屏、能用表格就不用圖)。
 *
 * 三種結果的顏色跟 OutcomeBar 一致 (三紅 紅 / 三藍死 琥珀 / 三藍活 藍)，
 * 固定顯示順序 三紅 → 三藍死 → 三藍活。這裡只放與資料無關的常數與格式化，
 * 條件機率本身由 packages/shared 的 helper 算，元件只負責顯示。
 * 不 import services/api (那裡一載入就讀 Vite 環境變數)，格式與 api.ts 的 fmtPct 相同。
 */

/** 三種結果的計數；鍵名跟快取 (players[].roleOutcomes、topPlayersByGames[].outcomes) 一致。 */
export interface OutcomeCounts {
  三紅: number;
  三藍死: number;
  三藍活: number;
}

export type OutcomeKey = keyof OutcomeCounts;

/** 固定顯示順序 (與 rank baseline、OutcomeBar 相同)。 */
export const OUTCOME_ORDER: readonly OutcomeKey[] = ['三紅', '三藍死', '三藍活'];

/** 與 OutcomeBar 的 RED / BLUE_DEAD / BLUE_ALIVE 相同。 */
export const OUTCOME_COLORS: Readonly<Record<OutcomeKey, string>> = {
  三紅: '#ef4444',
  三藍死: '#f59e0b',
  三藍活: '#3b82f6',
};

/** i18n 標籤鍵 (沿用 OutcomeBar 的 analytics.deep.outcomes.*)。 */
export const OUTCOME_LABEL_KEYS: Readonly<Record<OutcomeKey, string>> = {
  三紅: 'analytics.deep.outcomes.threeRed',
  三藍死: 'analytics.deep.outcomes.threeBlueDead',
  三藍活: 'analytics.deep.outcomes.threeBlueAlive',
};

/** 陣營／強調色：紅方、藍方、琥珀 (刺殺、名次第一)。 */
export type Tone = 'red' | 'blue' | 'amber';

export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  red: 'text-red-300',
  blue: 'text-blue-300',
  amber: 'text-amber-300',
};

export const TONE_HEX: Readonly<Record<Tone, string>> = {
  red: OUTCOME_COLORS.三紅,
  blue: OUTCOME_COLORS.三藍活,
  amber: OUTCOME_COLORS.三藍死,
};

/**
 * 比率的刻度：快取的百分比欄位一律是 0–100 ('percent'，預設)；
 * 純函式 helper 若回 0–1 就傳 'fraction'。
 */
export type PctScale = 'percent' | 'fraction';

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 轉成 0–100 的百分比；null / NaN / 非數字回 null。 */
export function toPercent(v: unknown, scale: PctScale = 'percent'): number | null {
  if (!isFiniteNum(v)) return null;
  return scale === 'fraction' ? v * 100 : v;
}

/**
 * 勝率的小數位 (Edward 2026-10-30)：一般勝率整數，只有角色理論／位置理論／整體理論一位小數。
 * 與 services/api.ts 的 RATE_DIGITS / THEORY_DIGITS 相同 (這裡不 import api.ts)。
 */
export const RATE_DIGITS = 0;
export const THEORY_DIGITS = 1;

/** 百分比顯示：預設整數 (理論勝率傳 THEORY_DIGITS)、null 顯示「—」(同 api.ts fmtPct)。 */
export function formatRate(v: unknown, scale: PctScale = 'percent', digits: number = RATE_DIGITS): string {
  const pct = toPercent(v, scale);
  return pct === null ? '—' : `${pct.toFixed(digits)}%`;
}

/** 整數顯示 (千分位)；null 顯示「—」。 */
export function formatInt(v: unknown): string {
  return isFiniteNum(v) ? Math.round(v).toLocaleString() : '—';
}

/** 一般文字；null / undefined / 空字串顯示「—」。 */
export function formatText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return isFiniteNum(v) ? String(v) : '—';
  const s = String(v);
  return s.length > 0 ? s : '—';
}

/** 三種結果的總場數 (缺值當 0)。 */
export function outcomeTotal(counts: Partial<OutcomeCounts> | null | undefined): number {
  if (!counts) return 0;
  return OUTCOME_ORDER.reduce((sum, k) => sum + (isFiniteNum(counts[k]) ? Math.max(0, counts[k] as number) : 0), 0);
}
