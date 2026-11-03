import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { BenchmarkGroup, BenchmarksSection } from '@avalon/shared/stats';
import { useBenchmarkToggle, useBenchmarks } from '../../stats/benchmarkRows';
import type { AnalysisLeaderboardRow } from '../../services/api';
import type { PlayerWithSeatStats } from './seatRoleBlocks';

/**
 * 基準列的共用元件（Edward 2026-11-03「[散客 < 30場] [排除散客後全體] [排除散客後 PR50+] [排除散客後 PR50-]」呈現在
 * 所有排行跟數據分析的最上列；同日改成「如果改成 前1/3 中間1/3 後1/3呢」：PR 列換成依當局 Elo PR 三等分）。數字見 @avalon/shared/stats benchmarks.ts、
 * 資料與開關見 stats/benchmarkRows.ts。
 *
 *  - BenchmarkName：組名 + 「基準」小標 (表格第一欄、取代名次＋名字)。
 *  - BenchmarkToggle：「顯示基準列」開關 (全站一份)。
 *  - useBenchmarkGroups()：有座位的組 (沒有座位的組不列)；關掉或還沒算好時 []。
 */

type TFn = (key: string, opts?: Record<string, unknown>) => string;

const K = 'analytics.benchmark';

const DEFAULT_LABEL: Record<BenchmarkGroup['id'], string> = {
  casual: '散客（<{{n}}場）',
  regular: '排除散客後全體',
  prTop: '排除散客後 前1/3',
  prMid: '排除散客後 中間1/3',
  prBottom: '排除散客後 後1/3',
};

const DEFAULT_SHORT: Record<BenchmarkGroup['id'], string> = {
  casual: '散客 <{{n}}',
  regular: '全體（排除散客）',
  prTop: '前1/3',
  prMid: '中間1/3',
  prBottom: '後1/3',
};

const DEFAULT_TIP: Record<BenchmarkGroup['id'], string> = {
  casual: '生涯未滿 {{n}} 場的玩家的座位（{{players}} 人、{{seats}} 個座位）。',
  regular: '散客以外的所有座位（{{players}} 人、{{seats}} 個座位）。',
  prTop: '散客以外、那一局開打前 Elo PR ≥ 200/3（66.7）的座位，PR 排前三分之一（{{players}} 人、{{seats}} 個座位）。暫定與沒評分的座位不算。',
  prMid: '「一般玩家」的基準：散客以外、那一局開打前 Elo PR 在 100/3（33.3）以上、未滿 200/3（66.7）的座位，PR 排中間三分之一（{{players}} 人、{{seats}} 個座位）。暫定與沒評分的座位不算。',
  prBottom: '散客以外、那一局開打前 Elo PR 未滿 100/3（33.3）的座位，PR 排後三分之一（{{players}} 人、{{seats}} 個座位）。暫定與沒評分的座位不算。',
};

function labelVars(section: BenchmarksSection, group: BenchmarkGroup): Record<string, unknown> {
  return {
    n: section.maxGames,
    players: group.players, seats: group.seats,
  };
}

/** 組名 (完整；short = 窄表用的短名)。 */
export function benchmarkName(t: TFn, section: BenchmarksSection, group: BenchmarkGroup, short = false): string {
  const kind = short ? 'short' : 'label';
  return t(`${K}.${kind}.${group.id}`, {
    defaultValue: (short ? DEFAULT_SHORT : DEFAULT_LABEL)[group.id], ...labelVars(section, group),
  });
}

/** 滑鼠提示：這組是誰 + 基準列的共同說明。 */
export function benchmarkTip(t: TFn, section: BenchmarksSection, group: BenchmarkGroup): string {
  return [
    benchmarkName(t, section, group),
    t(`${K}.tip.${group.id}`, { defaultValue: DEFAULT_TIP[group.id], ...labelVars(section, group) }),
    t(`${K}.tip.common`, {
      defaultValue: '基準列：逐座位合併計算（一局有兩位散客就算兩場），看篩選後這組的全部座位（理論勝率也是，不是最近 N 場）；不排名、不受排序影響、不算進人數。',
    }),
  ].join('\n');
}

export function BenchmarkBadge(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <span className="not-italic whitespace-nowrap rounded border border-sky-800/60 bg-sky-950/60 px-1 py-px text-[9px] font-semibold leading-none text-sky-300">
      {t(`${K}.badge`, { defaultValue: '基準' })}
    </span>
  );
}

/** 表格第一欄的組名 + 「基準」小標 (`indent`：對齊名次欄的寬度)。 */
export function BenchmarkName({
  section, group, short = false, indent,
}: {
  section: BenchmarksSection;
  group: BenchmarkGroup;
  short?: boolean;
  /** 名次欄的寬度 class (例 'w-5')：基準列沒有名次，小標放在那個位置。short 沒給時：手機短名、桌機完整名稱。 */
  indent?: string;
}): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <span className="inline-flex items-baseline gap-1.5" data-testid={`benchmark-${group.id}`}>
      {indent ? <span className={`inline-flex justify-end ${indent}`}><BenchmarkBadge /></span> : <BenchmarkBadge />}
      {short ? (
        <span className="font-semibold text-zinc-300">{benchmarkName(t, section, group, true)}</span>
      ) : (
        // 手機用短名 (第一欄固定，長名字會吃掉大半個螢幕)；完整名稱在滑鼠提示
        <>
          <span className="hidden font-semibold text-zinc-300 sm:inline">{benchmarkName(t, section, group)}</span>
          <span className="font-semibold text-zinc-300 sm:hidden">{benchmarkName(t, section, group, true)}</span>
        </>
      )}
    </span>
  );
}

/** 「顯示基準列」開關 (全站一份，記在 localStorage)。 */
export function BenchmarkToggle({ className = '' }: { className?: string }): JSX.Element {
  const { t } = useTranslation('common');
  const show = useBenchmarkToggle((s) => s.show);
  const setShow = useBenchmarkToggle((s) => s.setShow);
  return (
    <label className={`inline-flex cursor-pointer select-none items-center gap-1 text-xs text-zinc-400 ${className}`}>
      <input
        type="checkbox"
        checked={show}
        onChange={(e) => setShow(e.target.checked)}
        className="h-3 w-3 accent-sky-500"
        data-testid="benchmark-toggle"
      />
      {t(`${K}.toggle`, { defaultValue: '顯示基準列' })}
    </label>
  );
}

/** 有座位的組 (依顯示順序)；開關關掉、還沒算好或拿不到時 []。 */
export function useBenchmarkGroups(): { section: BenchmarksSection | null; groups: BenchmarkGroup[] } {
  const section = useBenchmarks();
  const groups = useMemo(() => (section ? section.groups.filter((g) => g.seats > 0 && g.row) : []), [section]);
  return { section, groups };
}

/**
 * 理論表／各榜形狀的一列 (rank 0 = 不排名)：篩選後這組的全部座位 (生涯版的理論勝率、任務／刺殺勝率)；
 * 刺客榜的刺中率放在 hits / attempts。
 */
export function benchmarkBoardRow(group: BenchmarkGroup): AnalysisLeaderboardRow {
  const th = group.theory;
  return {
    rank: 0,
    name: group.label,
    value: th?.roleTheory ?? 0,
    ...(th
      ? {
          roleTheory: th.roleTheory,
          positionTheory: th.positionTheory,
          overallTheory: th.overallTheory,
          finalWinRate: th.finalWinRate,
          missionWinRate: th.missionWinRate,
          missionRedWinRate: th.missionRedWinRate,
          missionBlueWinRate: th.missionBlueWinRate,
          assassinWinRate: th.assassinWinRate,
          threeBlueGames: th.threeBlueGames,
          sparseRoles: th.sparseRoles,
          sparseSeats: th.sparseSeats,
          sparseCells: th.sparseCells,
          populationShare: th.populationShare,
          from: th.from,
          to: th.to,
        }
      : {}),
    games: group.seats,
    careerGames: group.seats,
    hits: group.assassin.hits,
    attempts: group.assassin.attempts,
  } as AnalysisLeaderboardRow;
}

/** players 區塊形狀的一列 (勝率表、玩家 × 位置、三種結果)。 */
export function benchmarkPlayerRow(group: BenchmarkGroup): PlayerWithSeatStats {
  return group.row as unknown as PlayerWithSeatStats;
}

export interface PinnedProps<R> {
  pinnedRows: R[];
  pinnedRowKey: (row: R) => string;
  pinnedLabel: (row: R) => ReactNode;
  pinnedTitle: (row: R) => string | undefined;
}

/**
 * StatTable 的基準列 props：`toRow` 把一組轉成這張表的列 (例：benchmarkBoardRow、benchmarkPlayerRow)；第一欄 = 組名 +
 * 「基準」小標。開關關掉或還沒算好時 pinnedRows = []。
 */
export function useBenchmarkPinned<R>(
  toRow: (group: BenchmarkGroup) => R,
  options: { short?: boolean; indent?: string; filter?: (group: BenchmarkGroup) => boolean } = {},
): { props: PinnedProps<R>; groupOf: (row: R) => BenchmarkGroup | undefined } {
  const { t } = useTranslation('common');
  const { section, groups } = useBenchmarkGroups();
  const { short, indent, filter } = options;
  const pinned = useMemo(
    () => groups.filter((g) => !filter || filter(g)).map((g) => ({ group: g, row: toRow(g) })),
    // toRow / filter 是呼叫端每次 render 新建的函式；組不變時列也不變
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups],
  );
  const groupOf = (row: R): BenchmarkGroup | undefined => pinned.find((p) => p.row === row)?.group;
  return {
    groupOf,
    props: {
      pinnedRows: pinned.map((p) => p.row),
      pinnedRowKey: (row) => `benchmark-${groupOf(row)?.id ?? ''}`,
      pinnedLabel: (row): ReactNode => {
        const g = groupOf(row);
        return g && section ? <BenchmarkName section={section} group={g} short={short} indent={indent} /> : null;
      },
      pinnedTitle: (row): string | undefined => {
        const g = groupOf(row);
        return g && section ? benchmarkTip(t, section, g) : undefined;
      },
    },
  };
}
