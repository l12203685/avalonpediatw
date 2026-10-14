import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import StatTable, { type StatColumn } from './StatTable';
import type { PctScale, Tone } from './tokens';

/**
 * MetricBlocks — 三塊條件結果表 (2026-10-14 Edward：「角色勝率那邊應該分三塊」+「用條件機率」)。
 *
 *   任務結果：三藍＝藍勝、三紅＝紅勝；分母 = 該組全部場次
 *   刺殺結果：只看三藍局，三藍活＝藍勝、三藍死＝紅勝；分母 = 該組的三藍局 (三藍死＋三藍活)
 *   遊戲結果：三藍活＝藍勝、其餘＝紅勝；分母 = 該組全部場次
 *
 * 列 = 分組 (紅方、藍方、各角色、各座位…)，欄 = 三塊；每格是該組「自己陣營」的勝率 + n (分母)。
 * 這裡只負責顯示：數字由 packages/shared 的純函式 helper 算好 ({win, n}，n = 0 時 win = null)，
 * 不在元件裡重算。win 的刻度預設 0–100 (scale='percent')，helper 回 0–1 時傳 scale='fraction'。
 */

export interface MetricCell {
  /** 該組自己陣營的勝率；n = 0 時 null (顯示「—」)。 */
  win: number | null | undefined;
  /** 分母場數。 */
  n: number | null | undefined;
}

export type MetricBlockKey = 'mission' | 'assassination' | 'final';

/** 三塊的結果 (與 shared helper 回傳的形狀相同)。 */
export type MetricBlockValues = Record<MetricBlockKey, MetricCell>;

export interface MetricBlockRow extends MetricBlockValues {
  key: string;
  label: ReactNode;
  /** 分組的陣營色 (紅方 'red'、藍方 'blue')；標籤與數字都用這個顏色。 */
  tone?: Tone;
  /** 列的滑鼠提示。 */
  title?: string;
}

export interface MetricBlocksProps {
  rows: readonly MetricBlockRow[];
  /** win 的刻度 (預設 'percent' = 0–100)。 */
  scale?: PctScale;
  /** n 低於這個值的格子變淡 (預設不標)。 */
  lowSample?: number;
  caption?: ReactNode;
  /** 接在預設說明後面的補充。 */
  footnote?: ReactNode;
  /** 第一欄的表頭 (預設「分組」)。 */
  groupLabel?: ReactNode;
  /** 表頭下的一行規則說明 (預設 true)。 */
  showRules?: boolean;
  /** 比率背後的淡色長條 (預設 true)。 */
  bars?: boolean;
  /** 沒有資料時顯示。 */
  empty?: ReactNode;
  maxHeight?: number | string;
  framed?: boolean;
  onRowClick?: (row: MetricBlockRow, index: number) => void;
  highlightRow?: (row: MetricBlockRow, index: number) => boolean;
  className?: string;
}

const BLOCKS: readonly MetricBlockKey[] = ['mission', 'assassination', 'final'];

function BlockHeader({ name, rule }: { name: string; rule: string | null }): JSX.Element {
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <span className="text-[11px] font-semibold text-zinc-300">{name}</span>
      {rule && (
        <span className="block min-w-[6.5rem] max-w-[8.5rem] whitespace-normal text-[10px] font-normal leading-snug text-zinc-500">
          {rule}
        </span>
      )}
    </span>
  );
}

export default function MetricBlocks({
  rows,
  scale = 'percent',
  lowSample,
  caption,
  footnote,
  groupLabel,
  showRules = true,
  bars = true,
  empty,
  maxHeight,
  framed = true,
  onRowClick,
  highlightRow,
  className = '',
}: MetricBlocksProps): JSX.Element {
  const { t } = useTranslation('common');

  const columns: StatColumn<MetricBlockRow>[] = [
    {
      key: 'label',
      label: groupLabel ?? t('analytics.ui.blocks.group'),
      format: (_v, row) => row.label,
      tone: row => row.tone,
    },
    ...BLOCKS.map((block): StatColumn<MetricBlockRow> => ({
      key: block,
      label: (
        <BlockHeader
          name={t(`analytics.ui.blocks.${block}`)}
          rule={showRules ? t(`analytics.ui.blocks.${block}Rule`) : null}
        />
      ),
      title: t(`analytics.ui.blocks.${block}Hint`),
      align: 'center',
      format: 'pct',
      scale,
      value: row => row[block].win,
      n: row => row[block].n,
      lowSample,
      tone: row => row.tone,
      emphasis: block === 'final',
      bar: bars ? { max: scale === 'fraction' ? 1 : 100 } : undefined,
    })),
  ];

  return (
    <StatTable
      className={className}
      columns={columns}
      rows={rows}
      rowKey={row => row.key}
      rowTitle={row => row.title}
      caption={caption}
      empty={empty}
      maxHeight={maxHeight}
      framed={framed}
      onRowClick={onRowClick}
      highlightRow={highlightRow}
      footnote={
        <>
          {t('analytics.ui.blocks.cellNote')}
          {lowSample !== undefined && lowSample > 0 && <> {t('analytics.ui.blocks.lowSampleNote', { min: lowSample })}</>}
          {footnote && <> {footnote}</>}
        </>
      }
    />
  );
}
