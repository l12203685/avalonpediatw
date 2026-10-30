import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameStore } from '../../store/gameStore';
import { InfoTip, StatTable, Term, STAT_TERMS, type StatColumn, type StatTermKey } from './ui';
import BoardInfo from './BoardInfo';
import { fmtPct, fmtTheoryPct, type AnalysisLeaderboardBoard, type AnalysisLeaderboardRow } from '../../services/api';

/**
 * 理論勝率：一張表 (Edward 2026-10-28「位置理論跟整體理論還是可以合併吧? 我不知道為什麼要分兩個頁面? 是因為條件不同嗎?
 * 但條件我不是說應該要都可以選嗎?」)。讀快取的 `theory` 榜 (generate_cache.compute_leaderboard)：每列一位玩家，
 * 角色理論 / 位置理論 / 整體理論 / 最終勝率 / 任務勝率 / 刺殺勝率 / 場數；「排序依」或點表頭換排序 (預設角色理論)。
 * 誰上榜由上方的「上榜條件」決定 (篩選的 options.leaderboard)。
 *
 * 窗撐不起的數字不混用：整體理論生涯不到 overallMinGames 場 = —；角色窗沒打滿的角色理論、最近 N 場不夠的
 * 位置理論 / 最終 / 任務 / 刺殺變淡；有格子用全體勝率補值的也變淡 (同其他榜)。整體理論後面的小字 = 全體補值的比重。
 * 欄位 key 固定 (roleTheory、positionTheory、overallTheory、finalWinRate、missionWinRate、assassinWinRate)，表頭是名詞說明 (Term)。
 *
 * (2026-10-30 Edward：「理論勝率的右邊 上綁文字說明有點太過冗長 … 用滑鼠移過去再顯示定義跟算法就好」) 標題旁的期間副標、
 * 表格右邊整欄的上榜條件與定義、表格下方的灰字註腳都收進標題旁的 ⓘ (InfoTip)，完整版在說明頁；表格本身不變。
 */

type Row = AnalysisLeaderboardRow;
export type TheorySortKey =
  | 'roleTheory' | 'positionTheory' | 'overallTheory' | 'finalWinRate' | 'missionWinRate' | 'assassinWinRate' | 'careerGames';

export const THEORY_SORT_KEYS: readonly TheorySortKey[] = [
  'roleTheory', 'positionTheory', 'overallTheory', 'finalWinRate', 'missionWinRate', 'assassinWinRate', 'careerGames',
];

const SORT_STORAGE_KEY = 'avalon.boards.theorySort';
/** 表身在框裡捲 (表頭固定)，整頁一屏。 */
const TABLE_MAX_HEIGHT = 'max(15rem, calc(100vh - 25rem))';

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function readSort(): TheorySortKey {
  try {
    const v = window.localStorage.getItem(SORT_STORAGE_KEY);
    return (THEORY_SORT_KEYS as readonly string[]).includes(v ?? '') ? (v as TheorySortKey) : 'roleTheory';
  } catch {
    return 'roleTheory';
  }
}

function writeSort(key: TheorySortKey): void {
  try {
    window.localStorage.setItem(SORT_STORAGE_KEY, key);
  } catch {
    // 私密視窗等：不記也沒關係
  }
}

/** 依 key 排序：大的在前、沒有值的排最後；同值看生涯場數 (多的先)、名字。 */
export function sortTheoryRows(rows: readonly Row[], key: TheorySortKey): Row[] {
  const val = (r: Row): number | null => {
    const v = r[key];
    return isNum(v) ? v : null;
  };
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (va !== vb) {
      return vb - va;
    }
    const ca = a.careerGames ?? 0;
    const cb = b.careerGames ?? 0;
    if (ca !== cb) return cb - ca;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function rankClass(rank: number): string {
  if (rank === 1) return 'text-amber-300';
  if (rank === 2) return 'text-gray-200';
  if (rank === 3) return 'text-orange-300';
  return 'text-zinc-500';
}

export default function TheoryTable({
  board, isEn, minCell,
}: {
  board: AnalysisLeaderboardBoard;
  isEn: boolean;
  minCell: number;
}): JSX.Element {
  const { t } = useTranslation('common');
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  const [sortKey, setSortKey] = useState<TheorySortKey>(readSort);
  const choose = (key: TheorySortKey): void => {
    setSortKey(key);
    writeSort(key);
  };
  const windowGames = isNum(board.windowGames) ? board.windowGames : 0;
  const overallMin = isNum(board.overallMinGames) ? board.overallMinGames : null;
  const rows = useMemo(() => sortTheoryRows(board.rows, sortKey), [board.rows, sortKey]);
  const label = (key: string): string => t(`analytics.boards.theory.col.${key}`);
  const short = (r: Row): boolean => windowGames > 0 && r.games < windowGames;

  /** 比率格；`dim` 時變淡並附原因。`theory`：角色／位置／整體理論一位小數，其他勝率整數 (Edward 2026-10-30)。 */
  const pct = (v: unknown, dim: string | null, extra?: ReactNode, theory = false): ReactNode => (
    <span className={dim ? 'opacity-50' : undefined} title={dim ?? undefined}>
      {(theory ? fmtTheoryPct : fmtPct)(isNum(v) ? v : null)}
      {extra}
    </span>
  );
  const shortNote = (r: Row): string | null => (short(r) ? t('analytics.boards.theory.shortWindow', { games: r.games, window: windowGames }) : null);

  // 名稱 = 名詞說明 (Term，移上去或點一下看定義、算法)；旁邊的箭頭 = 依這欄排序。
  const header = (key: TheorySortKey): ReactNode => (
    <span className="inline-flex items-center gap-0.5">
      {(STAT_TERMS as readonly string[]).includes(key)
        ? <Term term={key as StatTermKey} className={sortKey === key ? 'text-amber-300' : ''}>{label(key)}</Term>
        : label(key)}
      <button
        type="button"
        onClick={() => choose(key)}
        aria-pressed={sortKey === key}
        aria-label={label(key)}
        className={`px-0.5 hover:text-zinc-200 ${sortKey === key ? 'text-amber-300' : 'text-zinc-600'}`}
        data-testid={`theory-sort-${key}`}
      >
        {sortKey === key ? '▾' : '↕'}
      </button>
    </span>
  );
  const tone = (key: TheorySortKey): 'amber' | undefined => (sortKey === key ? 'amber' : undefined);

  const columns: StatColumn<Row>[] = [
    {
      key: 'name',
      label: t('analytics.r6.boards.col.rankName'),
      format: (_v, row, i) => (
        <span className="inline-flex items-baseline gap-1.5">
          <span className={`inline-block w-5 text-right font-black ${rankClass(i + 1)}`}>{i + 1}</span>
          <span className="font-semibold text-white">{row.name}</span>
        </span>
      ),
    },
    {
      key: 'roleTheory',
      label: header('roleTheory'),
      align: 'right',
      tone: tone('roleTheory'),
      emphasis: sortKey === 'roleTheory',
      format: (v, r) => pct(v, r.fullWindows === false
        ? t('analytics.boards.theory.notFull', { games: r.roleGames ?? r.games })
        : (r.sparseRoles ?? 0) > 0 ? t('analytics.r6.boards.sparseCell', { count: r.sparseRoles, min: minCell }) : null, undefined, true),
    },
    {
      key: 'positionTheory',
      label: header('positionTheory'),
      align: 'right',
      tone: tone('positionTheory'),
      emphasis: sortKey === 'positionTheory',
      format: (v, r) => pct(v, shortNote(r)
        ?? ((r.sparseSeats ?? 0) > 0 ? t('analytics.r6.boards.sparseCell', { count: r.sparseSeats, min: minCell }) : null), undefined, true),
    },
    {
      key: 'overallTheory',
      label: header('overallTheory'),
      align: 'right',
      tone: tone('overallTheory'),
      emphasis: sortKey === 'overallTheory',
      format: (v, r) => (isNum(v)
        ? pct(v, null, isNum(r.populationShare) ? (
          <span
            className="ml-1 text-[10px] font-normal text-zinc-500"
            title={t('analytics.boards.theory.populationShare', { share: r.populationShare, cells: r.sparseCells ?? 0, min: minCell })}
          >
            {t('analytics.boards.theory.shareShort', { share: Math.round(r.populationShare) })}
          </span>
        ) : null, true)
        : <span className="text-zinc-600" title={overallMin !== null ? t('analytics.boards.theory.overallLocked', { min: overallMin }) : undefined}>—</span>),
    },
    {
      key: 'finalWinRate',
      label: header('finalWinRate'),
      align: 'right',
      tone: tone('finalWinRate'),
      emphasis: sortKey === 'finalWinRate',
      format: (v, r) => pct(v, shortNote(r)),
    },
    {
      key: 'missionWinRate',
      label: header('missionWinRate'),
      align: 'right',
      tone: tone('missionWinRate'),
      emphasis: sortKey === 'missionWinRate',
      format: (v, r) => pct(v, shortNote(r), (
        <span
          className="ml-1 text-[10px] font-normal text-zinc-500"
          title={t('analytics.boards.theory.missionSplit', { red: fmtPct(r.missionRedWinRate ?? null), blue: fmtPct(r.missionBlueWinRate ?? null) })}
        >
          <span className="text-red-300/70">{isNum(r.missionRedWinRate) ? Math.round(r.missionRedWinRate) : '—'}</span>
          /
          <span className="text-blue-300/70">{isNum(r.missionBlueWinRate) ? Math.round(r.missionBlueWinRate) : '—'}</span>
        </span>
      )),
    },
    {
      key: 'assassinWinRate',
      label: header('assassinWinRate'),
      align: 'right',
      tone: tone('assassinWinRate'),
      emphasis: sortKey === 'assassinWinRate',
      n: 'threeBlueGames',
      format: (v, r) => pct(v, shortNote(r)),
    },
    {
      key: 'games',
      label: label('games'),
      align: 'right',
      className: 'text-zinc-400',
      value: (r) => r.games,
      format: (_v, r) => (r.games === r.careerGames
        ? String(r.careerGames)
        : <span title={t('analytics.boards.theory.gamesTip', { games: r.games, career: r.careerGames })}>{r.games}<span className="text-zinc-600">/{r.careerGames}</span></span>),
    },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
        <h3 className="text-sm font-bold text-white">{t('analytics.boards.theory.title')}</h3>
        <InfoTip title={t('analytics.boards.theory.title')} testId="theory-info">
          <BoardInfo board={board} isEn={isEn}>
            <p className="text-zinc-400">{t('analytics.boards.theory.footnote', { min: minCell })}</p>
            <p className="text-zinc-400">{t('analytics.r6.boards.clickHint')}</p>
          </BoardInfo>
        </InfoTip>
        <label className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-400">
          {t('analytics.boards.theory.sortBy')}
          <select
            value={sortKey}
            onChange={(e) => choose(e.target.value as TheorySortKey)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200"
            data-testid="theory-sort"
          >
            {THEORY_SORT_KEYS.map((k) => <option key={k} value={k}>{label(k)}</option>)}
          </select>
        </label>
      </div>
      <StatTable
        columns={columns}
        rows={rows}
        maxHeight={TABLE_MAX_HEIGHT}
        rowKey={(row) => `theory-${row.name}`}
        onRowClick={(row) => openPlayerStats(row.name)}
      />
    </div>
  );
}
