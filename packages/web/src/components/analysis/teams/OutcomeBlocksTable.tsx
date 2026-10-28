import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StatTable, Term, type StatColumn, type StatTermKey, type Tone } from '../ui';
import { outcomeBlocks, type OutcomeBlocks, type OutcomeBreakdown } from '../../../services/api';

/**
 * 一組「局」的三塊結果表 — 派隊各小分頁共用 (2026-10-14 Edward：結果比率一律用條件機率，每個比率附 n)。
 *
 * 和 ui/MetricBlocks 的差別：MetricBlocks 的列是「某一方」(紅方場、藍方場、某角色)，每格看那一組自己陣營；
 * 這裡的列是一組局面 (1-1 隊裡有梅林、任務 1 失敗、紅方隊長且任務失敗、某條任務路徑…)，沒有「自己陣營」，
 * 所以整張表固定從紅方看 (藍方 = 100% − 紅方)，表頭直接寫 三紅率／刺中率／紅方勝率；
 * 三塊前面可以插這組自己的欄位 (例：任務 1 成功率、佔比)。三塊的數字一律由 @avalon/shared 的
 * outcomeBlocks(counts, 'red') 算，這裡不重算：
 *
 *   任務結果 = 三紅 ÷ 全部            (n = 全部)
 *   刺殺結果 = 三藍死 ÷ 三藍局        (n = 三藍局；三紅局沒有刺殺，n = 0 時顯示「—」)
 *   遊戲結果 = (三紅 + 三藍死) ÷ 全部 (n = 全部)
 *
 * 舊快取 (raw 牌譜重建，61b7398) 的 rounds 沒有 outcomes、只有 redWinRate (任務結算口徑 = 三紅率)：
 * 任務結果用它 (n = 場數)，刺殺／遊戲結果顯示「—」，頁底 (OutcomeBlocksNote pending) 註明下次每日更新後提供。
 */

export type OutcomeBlockKey = 'mission' | 'assassination' | 'final';

export interface OutcomeGroupRow {
  key: string;
  label: ReactNode;
  /** 第一欄文字顏色。 */
  tone?: Tone;
  /** 這組的局數 (隊長表是任務數)。 */
  n: number;
  /** 三種結果的局數；舊快取沒有時 null / undefined。 */
  outcomes?: OutcomeBreakdown | null;
  /** outcomes 缺時的任務結算紅勝率 (0–100，= 三紅率)。 */
  missionRedRate?: number | null;
  title?: string;
}

/** 表格實際用的列：原本的列 + 算好的三塊 (outcomes 缺時 null)。 */
export type OutcomeGroupRowWithBlocks<R extends OutcomeGroupRow> = R & { blocks: OutcomeBlocks | null };

export interface OutcomeBlocksTableProps<R extends OutcomeGroupRow> {
  rows: readonly R[];
  caption?: ReactNode;
  /** 第一欄表頭。 */
  groupLabel: ReactNode;
  /** 自訂第一欄內容 (預設 row.label)。 */
  renderLabel?: (row: R) => ReactNode;
  /** 插在第一欄與三塊之間的欄位。 */
  leadColumns?: readonly StatColumn<OutcomeGroupRowWithBlocks<R>>[];
  /** n 低於這個值的格子變淡 (傳快取的 theoryMinCellGames)。 */
  lowSample?: number;
  maxHeight?: number | string;
  footnote?: ReactNode;
  className?: string;
}

const BLOCKS: readonly OutcomeBlockKey[] = ['mission', 'assassination', 'final'];

/** 三紅 → 紅、三藍死 (刺中) → 琥珀、紅方勝 → 紅 (與 OutcomeBar / Donut 的顏色一致)。 */
const BLOCK_TONE: Readonly<Record<OutcomeBlockKey, Tone>> = {
  mission: 'red',
  assassination: 'amber',
  final: 'red',
};

/** 三塊副標的名詞說明 (2026-10-28 Edward：每個指標都要白話的定義與算法)。 */
export const BLOCK_TERM: Readonly<Record<OutcomeBlockKey, StatTermKey>> = {
  mission: 'threeRedRate',
  assassination: 'killRate',
  final: 'redGameWinRate',
};

/** 兩行表頭：塊名 + 這格算的是什麼 (固定寬度，窄螢幕不撐開)。 */
export function BlockHeader({ name, sub }: { name: ReactNode; sub: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <span className="text-[11px] font-semibold text-zinc-300">{name}</span>
      <span className="block max-w-[7.5rem] whitespace-normal text-[10px] font-normal leading-snug text-zinc-500">{sub}</span>
    </span>
  );
}

/** 有 outcomes 的列算三塊；沒有時 null。 */
function withBlocks<R extends OutcomeGroupRow>(rows: readonly R[]): OutcomeGroupRowWithBlocks<R>[] {
  return rows.map(r => ({ ...r, blocks: r.outcomes ? outcomeBlocks(r.outcomes, 'red') : null }));
}

function blockWin<R extends OutcomeGroupRow>(row: OutcomeGroupRowWithBlocks<R>, block: OutcomeBlockKey): number | null {
  if (row.blocks) return row.blocks[block].win;
  if (block === 'mission' && typeof row.missionRedRate === 'number' && Number.isFinite(row.missionRedRate)) {
    return row.missionRedRate;
  }
  return null;
}

function blockN<R extends OutcomeGroupRow>(row: OutcomeGroupRowWithBlocks<R>, block: OutcomeBlockKey): number | null {
  if (row.blocks) return row.blocks[block].n;
  return block === 'mission' && blockWin(row, block) !== null ? row.n : null;
}

export default function OutcomeBlocksTable<R extends OutcomeGroupRow>({
  rows,
  caption,
  groupLabel,
  renderLabel,
  leadColumns = [],
  lowSample,
  maxHeight,
  footnote,
  className = '',
}: OutcomeBlocksTableProps<R>): JSX.Element {
  const { t } = useTranslation('common');
  const computed = useMemo(() => withBlocks(rows), [rows]);
  const min = lowSample !== undefined && lowSample > 0 ? lowSample : undefined;

  const columns: StatColumn<OutcomeGroupRowWithBlocks<R>>[] = [
    {
      key: 'label',
      label: groupLabel,
      format: (_v, row) => (renderLabel ? renderLabel(row) : row.label),
      tone: row => row.tone,
    },
    ...leadColumns,
    ...BLOCKS.map((block): StatColumn<OutcomeGroupRowWithBlocks<R>> => ({
      key: `block-${block}`,
      label: (
        <BlockHeader
          name={t(`analytics.r6.teams.blocks.${block}`)}
          sub={<Term term={BLOCK_TERM[block]}>{t(`analytics.r6.teams.blocks.${block}Sub`)}</Term>}
        />
      ),
      title: t(`analytics.r6.teams.blocks.${block}Hint`),
      align: 'center',
      format: 'pct',
      value: row => blockWin(row, block),
      n: row => blockN(row, block),
      lowSample: min,
      tone: BLOCK_TONE[block],
      emphasis: block === 'final',
      bar: { max: 100 },
    })),
  ];

  return (
    <StatTable
      className={className}
      caption={caption}
      columns={columns}
      rows={computed}
      rowKey={row => row.key}
      rowTitle={row => row.title}
      maxHeight={maxHeight}
      footnote={footnote}
    />
  );
}

/** 這些列裡有沒有缺 outcomes 的 (舊快取) — 給 OutcomeBlocksNote 的 pending。 */
export function lacksOutcomes(...lists: ReadonlyArray<readonly OutcomeGroupRow[]>): boolean {
  return lists.some(rows => rows.some(r => !r.outcomes));
}

/**
 * 每個小分頁底下一行說明：三塊各怎麼算 (都從紅方看)、n 是分母、淡色門檻 (快取的 theoryMinCellGames；0 = 不標)；
 * pending (舊快取沒有三種結果的局數) 時再加一句「刺殺與遊戲結果下次每日更新後提供」。
 * 放在頁面底部一次，不在每張表下重複。
 */
export function OutcomeBlocksNote({
  lowSample, extra, pending = false,
}: { lowSample?: number; extra?: ReactNode; pending?: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <p className="text-[10px] leading-relaxed text-zinc-500">
      {pending && <span className="text-amber-300/80">{t('analytics.r6.teams.blocks.pendingNote')} </span>}
      {t('analytics.r6.teams.blocks.note')}
      {lowSample !== undefined && lowSample > 0 && <> {t('analytics.r6.teams.blocks.lowSample', { min: lowSample })}</>}
      {extra && <> {extra}</>}
    </p>
  );
}
