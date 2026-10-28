import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { outcomeBlocks, theorySettings, type OutcomeBlocks } from '../../services/api';
import { StatTable, Term, OUTCOME_COLORS, type StatColumn, type StatTermKey, type Tone } from './ui';
import { useAnalysisOverview } from './useAnalysisOverview';

/**
 * OutcomeBlocksTable — 「某一組局」的三塊結果表 (2026-10-14 Edward：比率要用條件機率、
 * 每個比率附正確的分母與 n；能用表格就不用圖)。給 任務 (第 k 輪通過／失敗)、湖中女神
 * (持湖陣營、持湖角色、被湖角色)、刺殺 (座位) 這種「沒有自己陣營」的分組用：一律從紅方看。
 *
 *   任務結果  三紅 ÷ 局數                         (n = 這組局數)
 *   刺殺結果  三藍死 ÷ 三藍局 (三藍死＋三藍活)     (n = 這組打到三藍的局數，另外顯示)
 *   遊戲結果  (三紅＋三藍死) ÷ 局數 = 紅方最終勝   (n = 這組局數)
 *
 * 藍方的數字 = 100% − 同一格 (分母相同)，表下註明。數字一律由 @avalon/shared 的 outcomeBlocks
 * 算 (services/api 轉出)，這裡只顯示。舊做法 (OutcomeBar) 把三藍死除以全部局，是 Edward 指出不對的口徑。
 * 淡色門檻 = 快取 theoryConfig.theoryMinCellGames (與理論勝率的補值門檻一致，不寫死)。
 */

/** outcomeBlocks 收的局數形狀 ({三紅, 三藍死, 三藍活} 或 OutcomeBreakdown 的英文鍵)。 */
export type OutcomeCountsLike = Parameters<typeof outcomeBlocks>[0];

export interface OutcomeGroup {
  key: string;
  label: ReactNode;
  /** 三種結果局數；{三紅, 三藍死, 三藍活} 或 OutcomeBreakdown 的英文鍵都可以。 */
  counts: OutcomeCountsLike;
  /** 標籤顏色 (紅方、藍方的分組)。 */
  tone?: Tone;
  title?: string;
  /** 對照列 (例：全部局)，整列加底色。 */
  reference?: boolean;
}

interface Row extends OutcomeGroup {
  blocks: OutcomeBlocks;
}

export interface OutcomeBlocksTableProps {
  rows: readonly OutcomeGroup[];
  caption?: ReactNode;
  /** 接在預設說明後面。 */
  footnote?: ReactNode;
  groupLabel?: ReactNode;
  maxHeight?: number | string;
  className?: string;
}

function BlockHeader({ name, rule, term }: { name: string; rule: string; term: StatTermKey }): JSX.Element {
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="text-[11px] font-semibold text-zinc-300">{name}</span>
      <span className="block whitespace-nowrap text-[10px] font-normal leading-snug text-zinc-500"><Term term={term}>{rule}</Term></span>
    </span>
  );
}

/** 快取設定的少樣本門檻 (theoryMinCellGames；舊快取缺鍵時用產生器預設值)。 */
export function useMinCellGames(): number {
  const { overview } = useAnalysisOverview();
  return theorySettings(overview?.theoryConfig).theoryMinCellGames;
}

export default function OutcomeBlocksTable({
  rows, caption, footnote, groupLabel, maxHeight, className = '',
}: OutcomeBlocksTableProps): JSX.Element {
  const { t } = useTranslation('common');
  const min = useMinCellGames();
  const k = 'analytics.r6.tabsa.outcomeTable';
  const data: Row[] = rows.map(r => ({ ...r, blocks: outcomeBlocks(r.counts, 'red') }));

  const columns: StatColumn<Row>[] = [
    {
      key: 'label',
      label: groupLabel ?? t(`${k}.group`),
      format: (_v, row) => row.label,
      tone: row => row.tone,
    },
    {
      key: 'games',
      label: t(`${k}.games`),
      title: t(`${k}.gamesTitle`),
      format: 'int',
      value: row => row.blocks.mission.n,
      className: 'text-zinc-400',
    },
    {
      key: 'mission',
      label: <BlockHeader name={t(`${k}.mission`)} rule={t(`${k}.missionRule`)} term="threeRedRate" />,
      title: t(`${k}.missionTitle`),
      align: 'right',
      format: 'pct',
      value: row => row.blocks.mission.win,
      lowSample: min,
      n: row => (row.blocks.mission.n < min ? row.blocks.mission.n : null),
      tone: 'red',
      bar: { color: OUTCOME_COLORS.三紅 },
    },
    {
      key: 'assassination',
      label: <BlockHeader name={t(`${k}.assassination`)} rule={t(`${k}.assassinationRule`)} term="killRate" />,
      title: t(`${k}.assassinationTitle`),
      align: 'right',
      format: 'pct',
      value: row => row.blocks.assassination.win,
      n: row => row.blocks.assassination.n,
      lowSample: min,
      tone: 'amber',
      bar: { color: OUTCOME_COLORS.三藍死 },
    },
    {
      key: 'final',
      label: <BlockHeader name={t(`${k}.final`)} rule={t(`${k}.finalRule`)} term="redGameWinRate" />,
      title: t(`${k}.finalTitle`),
      align: 'right',
      format: 'pct',
      value: row => row.blocks.final.win,
      lowSample: min,
      n: row => (row.blocks.final.n < min ? row.blocks.final.n : null),
      tone: 'red',
      emphasis: true,
      bar: { color: OUTCOME_COLORS.三紅 },
    },
  ];

  return (
    <StatTable
      className={className}
      columns={columns}
      rows={data}
      rowKey={row => row.key}
      rowTitle={row => row.title}
      highlightRow={row => row.reference === true}
      caption={caption}
      maxHeight={maxHeight}
      footnote={
        <>
          {t(`${k}.note`)} {t(`${k}.lowSample`, { min })}
          {footnote && <> {footnote}</>}
        </>
      }
    />
  );
}
