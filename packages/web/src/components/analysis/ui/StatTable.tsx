import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TONE_HEX, TONE_TEXT, formatInt, formatRate, formatText, toPercent,
  type PctScale, type Tone,
} from './tokens';
import Term from './Term';
import InfoTip from './InfoTip';
import type { StatTermKey } from './statTerms';

/**
 * StatTable — 密集的數字表 (2026-10-14 Edward：「有些可以用表格數字，不一定要用圖」)。
 *
 *  - 欄位設定 StatColumn：format 'pct' (一位小數 + %) / 'int' (千分位) / 'text' / 自訂函式；
 *    null、NaN 一律顯示「—」。
 *  - n：另一個欄位 (或函式) 當樣本數，小字接在比率後面；lowSample：n 低於門檻時整格變淡並提示樣本不足。
 *  - bar：比率後面 (或背後) 的小長條，max 預設 100；顏色可給 hex 或 tone。
 *  - tone：'red' / 'blue' / 'amber' (或依列決定的函式) 決定文字顏色。
 *  - 第一欄固定 (sticky)、tabular-nums、斑馬紋、緊湊間距；寬度不夠時只在表格自己的容器裡橫捲，
 *    不會撐寬頁面 (320px 也一樣)。給 maxHeight 時表頭固定、表身在容器內直捲，整頁不必拉長。
 *  - caption (表格上方標題) / footnote (表格說明) / empty (沒有資料時的文字)。
 *    (2026-10-30 Edward：說明太冗長) footnote 不再印在表格下面：有 caption 時是標題旁的 ⓘ，沒有時是表格右下角
 *    一個小「ⓘ 說明」，滑過／點一下才顯示，末尾連到說明頁。
 */

export type StatFormat<R> =
  | 'pct'
  | 'int'
  | 'text'
  | ((value: unknown, row: R, index: number) => ReactNode);

export interface StatColumnBar {
  /** 滿格的值 (與欄位同刻度，pct 欄預設 100、fraction 刻度預設 1)。 */
  max?: number;
  /** hex 色碼或 tone；預設跟欄位的 tone，沒有 tone 時灰色。 */
  color?: string | Tone;
  /** 'behind'：淡色長條墊在數字後面 (不佔寬度，預設)；'after'：數字右邊一條細長條。 */
  placement?: 'behind' | 'after';
}

export interface StatColumn<R> {
  /** 列物件裡的欄位名 (也當 React key)；有 value 時只當 key 用。 */
  key: string;
  label: ReactNode;
  /** 表頭的滑鼠提示 (完整說明)。 */
  title?: string;
  /** 統計名詞：表頭變成可以滑鼠移上去／點開看定義、算法、怎麼看 (Term)。 */
  term?: StatTermKey;
  /** 對齊；預設 text 靠左、數字靠右。 */
  align?: 'left' | 'right' | 'center';
  format?: StatFormat<R>;
  /** 取值函式 (覆蓋 key)。 */
  value?: (row: R) => unknown;
  /** pct 欄的刻度 (預設跟表格的 pctScale)。 */
  scale?: PctScale;
  bar?: StatColumnBar;
  /** 樣本數：列物件的欄位名或函式；顯示成比率後面的小字 n=…。 */
  n?: string | ((row: R) => number | null | undefined);
  /** n 低於這個值時整格變淡並提示樣本不足。 */
  lowSample?: number;
  tone?: Tone | ((row: R) => Tone | undefined);
  /** 粗體 (主要指標)。 */
  emphasis?: boolean;
  /** 額外的 class，表頭與每格都加 (例：寬度 'w-12'、允許換行 'whitespace-normal'、手機隱藏 'hidden sm:table-cell')。 */
  className?: string;
}

export interface StatTableProps<R> {
  columns: readonly StatColumn<R>[];
  rows: readonly R[];
  rowKey?: (row: R, index: number) => string;
  caption?: ReactNode;
  footnote?: ReactNode;
  /** 沒有資料時顯示 (預設「沒有資料」)。 */
  empty?: ReactNode;
  /** 固定第一欄 (預設 true)。 */
  stickyFirstColumn?: boolean;
  /** pct 欄的預設刻度 (預設 'percent' = 0–100，快取的慣例)。 */
  pctScale?: PctScale;
  /** 表身在容器內直捲的最大高度 (px 或 CSS 長度)；給了表頭就固定。 */
  maxHeight?: number | string;
  onRowClick?: (row: R, index: number) => void;
  /** 列的滑鼠提示。 */
  rowTitle?: (row: R, index: number) => string | undefined;
  /** 強調某些列 (例：目前查看的玩家)。 */
  highlightRow?: (row: R, index: number) => boolean;
  /** 外框 (圓角 + 邊框 + 底色，預設 true)；放進已有外框的卡片時傳 false。 */
  framed?: boolean;
  className?: string;
}

const ALIGN_CLASS = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

function cellValue<R>(col: StatColumn<R>, row: R): unknown {
  if (col.value) return col.value(row);
  return (row as Record<string, unknown>)[col.key];
}

function sampleSize<R>(col: StatColumn<R>, row: R): number | null {
  if (col.n === undefined) return null;
  const v = typeof col.n === 'function' ? col.n(row) : (row as Record<string, unknown>)[col.n];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function columnTone<R>(col: StatColumn<R>, row: R): Tone | undefined {
  return typeof col.tone === 'function' ? col.tone(row) : col.tone;
}

function barColor(color: string | Tone | undefined, tone: Tone | undefined): string {
  if (color && color in TONE_HEX) return TONE_HEX[color as Tone];
  if (color) return color;
  return tone ? TONE_HEX[tone] : '#71717a';
}

function defaultAlign<R>(col: StatColumn<R>): 'left' | 'right' | 'center' {
  if (col.align) return col.align;
  return col.format === 'pct' || col.format === 'int' ? 'right' : 'left';
}

/** 長條寬度 (0–100%)；值不是數字時 null。 */
function barWidth<R>(col: StatColumn<R>, raw: unknown, scale: PctScale): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const isPct = col.format === 'pct';
  const value = isPct ? toPercent(raw, scale) ?? 0 : raw;
  const max = col.bar?.max !== undefined
    ? (isPct ? toPercent(col.bar.max, scale) ?? 100 : col.bar.max)
    : 100;
  if (!(max > 0)) return null;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

export default function StatTable<R>({
  columns,
  rows,
  rowKey,
  caption,
  footnote,
  empty,
  stickyFirstColumn = true,
  pctScale = 'percent',
  maxHeight,
  onRowClick,
  rowTitle,
  highlightRow,
  framed = true,
  className = '',
}: StatTableProps<R>): JSX.Element {
  const { t } = useTranslation('common');
  const captionId = useId();
  const stickyHeader = maxHeight !== undefined;

  const renderValue = (col: StatColumn<R>, row: R, index: number): ReactNode => {
    const raw = cellValue(col, row);
    const fmt = col.format ?? 'text';
    if (typeof fmt === 'function') return fmt(raw, row, index);
    if (fmt === 'pct') return formatRate(raw, col.scale ?? pctScale);
    if (fmt === 'int') return formatInt(raw);
    return formatText(raw);
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: R, i: number): void => {
    if (!onRowClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick(row, i);
    }
  };

  const frame = framed ? 'rounded-xl border border-zinc-800 bg-zinc-950' : '';

  return (
    <div className={`min-w-0 ${className}`}>
      {caption && (
        <div className="mb-1.5 flex items-center gap-1">
          <div id={captionId} className="text-sm font-bold text-zinc-400">{caption}</div>
          {footnote && <InfoTip title={caption}>{footnote}</InfoTip>}
        </div>
      )}
      <div
        className={`max-w-full overflow-x-auto overscroll-x-contain ${stickyHeader ? 'overflow-y-auto' : ''} ${frame}`}
        style={stickyHeader ? { maxHeight } : undefined}
      >
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">{empty ?? t('analytics.ui.table.empty')}</p>
        ) : (
          <table
            className="w-full border-separate border-spacing-0 text-xs tabular-nums"
            aria-labelledby={caption ? captionId : undefined}
          >
            <thead>
              <tr>
                {columns.map((col, ci) => {
                  const sticky = stickyFirstColumn && ci === 0;
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      title={col.title}
                      className={`${ALIGN_CLASS[defaultAlign(col)]} px-2 py-1.5 first:pl-3 last:pr-3 align-bottom whitespace-nowrap text-[11px] font-semibold text-zinc-500 bg-zinc-950 border-b border-zinc-800 ${
                        stickyHeader ? 'sticky top-0' : ''
                      } ${sticky ? 'sticky left-0 z-20 shadow-[inset_-1px_0_0_#27272a]' : stickyHeader ? 'z-10' : ''} ${col.className ?? ''}`}
                    >
                      {col.term ? <Term term={col.term}>{col.label}</Term> : col.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                const highlighted = highlightRow?.(row, ri) ?? false;
                const zebra = highlighted ? 'bg-zinc-800' : ri % 2 === 1 ? 'bg-zinc-900' : 'bg-zinc-950';
                const clickable = Boolean(onRowClick);
                return (
                  <tr
                    key={rowKey ? rowKey(row, ri) : ri}
                    title={rowTitle?.(row, ri)}
                    className={`${zebra} ${clickable ? 'cursor-pointer hover:bg-zinc-800 focus-visible:outline-none focus-visible:bg-zinc-800' : ''}`}
                    onClick={clickable ? (): void => onRowClick?.(row, ri) : undefined}
                    onKeyDown={clickable ? (e): void => onRowKey(e, row, ri) : undefined}
                    tabIndex={clickable ? 0 : undefined}
                  >
                    {columns.map((col, ci) => {
                      const sticky = stickyFirstColumn && ci === 0;
                      const tone = columnTone(col, row);
                      const n = sampleSize(col, row);
                      const low = col.lowSample !== undefined && n !== null && n < col.lowSample;
                      const raw = cellValue(col, row);
                      const width = col.bar ? barWidth(col, raw, col.scale ?? pctScale) : null;
                      const color = col.bar ? barColor(col.bar.color, tone) : undefined;
                      const placement = col.bar?.placement ?? 'behind';
                      const align = defaultAlign(col);
                      const Tag = sticky ? 'th' : 'td';
                      return (
                        <Tag
                          key={col.key}
                          scope={sticky ? 'row' : undefined}
                          title={low ? t('analytics.ui.table.lowSample', { min: col.lowSample }) : undefined}
                          className={`${ALIGN_CLASS[align]} px-2 py-1 first:pl-3 last:pr-3 whitespace-nowrap border-b border-zinc-900 ${
                            sticky ? 'sticky left-0 z-10 bg-inherit font-semibold shadow-[inset_-1px_0_0_#27272a]' : 'relative'
                          } ${tone ? TONE_TEXT[tone] : sticky ? 'text-white' : 'text-zinc-300'} ${
                            col.emphasis ? 'font-bold' : ''
                          } ${col.className ?? ''}`}
                        >
                          {width !== null && placement === 'behind' && (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-y-1 left-1 rounded-sm opacity-20"
                              style={{ width: `calc((100% - 0.5rem) * ${width / 100})`, backgroundColor: color }}
                            />
                          )}
                          <span className={`relative inline-flex items-baseline gap-1 ${align === 'right' ? 'justify-end' : ''} ${low ? 'opacity-50' : ''}`}>
                            <span>{renderValue(col, row, ri)}</span>
                            {low && <span className="sr-only">{t('analytics.ui.table.lowSample', { min: col.lowSample })}</span>}
                            {n !== null && (
                              <span className="text-[10px] font-normal text-zinc-500" title={t('analytics.ui.table.nTitle', { n })}>
                                {t('analytics.ui.table.n', { n })}
                              </span>
                            )}
                            {width !== null && placement === 'after' && (
                              <span aria-hidden className="ml-1 inline-block h-1.5 w-10 self-center overflow-hidden rounded-full bg-zinc-800">
                                <span className="block h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
                              </span>
                            )}
                          </span>
                        </Tag>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {footnote && !caption && (
        <div className="mt-1 flex justify-end">
          <InfoTip text={t('analytics.ui.info.label')}>{footnote}</InfoTip>
        </div>
      )}
    </div>
  );
}
