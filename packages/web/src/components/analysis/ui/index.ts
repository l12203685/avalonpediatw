/**
 * 分析頁共用 UI 元件 (2026-10-14 round 6)：與資料無關，給各分析分頁一頁一屏、表格優先用。
 *  - SectionTabs：分頁內的小分頁 (segmented control + 內容切換)
 *  - StatTable：密集數字表 (比率 + n、樣本不足變淡、小長條、固定第一欄)
 *  - Donut：三種結果組成甜甜圈 (lg 全體 / sm 每位玩家)
 *  - MetricBlocks：任務結果 / 刺殺結果 / 遊戲結果 三塊條件結果表
 *  - Term / InfoTip：名詞說明、表格標題旁的 ⓘ (滑過／點一下才顯示，末尾連到說明頁；2026-10-30)
 *  - Takeaway / VerdictText：小分頁最上面的一句話結論、卡方檢定的白話判讀 (2026-10-28)
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
export { default as Term, TermRows } from './Term';
export { default as InfoTip } from './InfoTip';
export type { InfoTipProps } from './InfoTip';
export type { TermProps } from './Term';
export { STAT_TERMS } from './statTerms';
export { Takeaway, VerdictText } from './Takeaway';
export type { StatTermKey } from './statTerms';
