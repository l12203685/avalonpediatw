/**
 * 分析頁共用 UI 元件 (2026-10-14 round 6)：與資料無關，給各分析分頁一頁一屏、表格優先用。
 *  - SectionTabs：分頁內的小分頁 (segmented control + 內容切換)
 *  - StatTable：密集數字表 (比率 + n、樣本不足變淡、小長條、固定第一欄)
 *  - Donut：三種結果組成甜甜圈 (lg 全體 / sm 每位玩家)
 *  - MetricBlocks：任務結果 / 刺殺結果 / 遊戲結果 三塊條件結果表
 */
export { default as SectionTabs, useSectionTab } from './SectionTabs';
export type { SectionTabItem, SectionTabsProps } from './SectionTabs';
export { default as StatTable } from './StatTable';
export type { StatColumn, StatColumnBar, StatFormat, StatTableProps } from './StatTable';
export { default as Donut } from './Donut';
export type { DonutProps } from './Donut';
export { default as MetricBlocks } from './MetricBlocks';
export type { MetricBlockKey, MetricBlockRow, MetricBlockValues, MetricBlocksProps, MetricCell } from './MetricBlocks';
export {
  OUTCOME_COLORS, OUTCOME_LABEL_KEYS, OUTCOME_ORDER, TONE_HEX, TONE_TEXT,
  formatInt, formatRate, formatText, outcomeTotal, toPercent,
} from './tokens';
export type { OutcomeCounts, OutcomeKey, PctScale, Tone } from './tokens';
