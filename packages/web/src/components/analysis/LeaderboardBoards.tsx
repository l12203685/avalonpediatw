import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader, AlertCircle, RefreshCw, Clock, Trophy, MapPin, Layers, History, TrendingUp, Crosshair,
  Sparkles, Crown, Calculator, ListOrdered, type LucideIcon,
} from 'lucide-react';
import { useGameStore } from '../../store/gameStore';
import { SectionTabs, StatTable, type SectionTabItem, type StatColumn } from './ui';
import {
  fetchAnalysisLeaderboard,
  getErrorMessage,
  isAnalysisNotGenerated,
  isAnalysisRouteMissing,
  isTheoryBoard,
  fmtPct,
  fmtSignedPoints,
  theorySettings,
  type AnalysisLeaderboardData,
  type AnalysisLeaderboardBoard,
  type AnalysisLeaderboardRow,
} from '../../services/api';

/**
 * 排行 (docs/stats/two_stage_outcome.md `leaderboard` 段，Edward 2026-10-13)：
 *  「條件篩選可以是近期，但資料篩選不能少場」— 誰上榜看近 activeDays (90) 天有沒有出賽，
 *  數字一律是各人自己的最近 N 場，不用短期日期區間。說明文字的天數、場數讀 leaderboard.config。
 *  - 舊快取的榜 (沒有 metric，超額勝率)：不顯示，提示下次每日更新後提供
 *  - 快取尚無此段 (503 "Leaderboard not yet generated")：顯示「排行尚未產生（每日 03:47 重算）」
 *  - 舊後端沒有此路由 (404，網站先於伺服器部署)：顯示「後端尚未更新」
 *    兩者都附重試鍵；其他 503 (載入快取失敗、代理層) 走一般錯誤並顯示伺服器訊息。
 * 全部由 generate_cache.py 算好；這裡只讀不重算。
 *
 * (2026-10-14 Edward：「近 50 場太少」「頁面不要拉太長，最好分頁切過去一頁可以顯示全部該分頁的內容」
 *  「有些可以用表格數字，不一定要用圖」)
 *  - 一個榜一個小分頁 (SectionTabs)，一次只顯示一個榜：角色理論 (各角色近 10 場、忠臣近 40 場) /
 *    位置理論 (近 100 場) / 整體理論 (生涯 ≥ 250 場) / 進步 / 刺客 / 新人 / 角色王 / 精算榜。
 *    快取有哪些榜就列哪些 (依 id 排順序；schemaVersion 3 的「近 50 場」照樣顯示，未知 id 排最後並用
 *    快取的標題當標籤)；標題、期間、說明一律讀快取。精算榜 (LeaderboardV3Table) 由 BoardsTab 傳進來，
 *    從各榜下方改成最後一個小分頁。
 *  - 榜的內容是數字表 (StatTable)：名次＋名字 (點一列開該玩家的玩家雷達)、榜的數字、該榜帶的其他欄
 *    (每一欄只在該榜有資料時出現)，一位小數。說明放在表格旁 (手機在表格下)，不另外拉長頁面。
 *  - 用全體勝率補值的格子 (有角色／位置不到 theoryMinCellGames 場) 變淡；門檻讀 leaderboard.config。
 *  - 角色王同率各給 (decisions lane)：同一個角色可能有好幾列，標「並列」。
 */

/** 小分頁順序；不在這裡的 id 依快取順序排在後面。 */
const BOARD_ORDER = ['main', 'position', 'overall', 'last50', 'improved', 'assassin', 'newcomers', 'roleTitles'];

const BOARD_ICONS: Record<string, LucideIcon> = {
  main: Trophy,
  position: MapPin,
  overall: Layers,
  last50: History,
  improved: TrendingUp,
  assassin: Crosshair,
  newcomers: Sparkles,
  roleTitles: Crown,
};

/** 精算榜的小分頁 id (不會跟快取的榜 id 撞到)。 */
const PRECISION_TAB = '__precision';
/** 排行還沒有資料 (載入中／尚未產生／錯誤) 時，第一個小分頁顯示狀態。 */
const STATUS_TAB = 'main';

const RED_ROLES = new Set(['刺客', '莫甘娜', '莫德雷德', '奧伯倫']);

type Row = AnalysisLeaderboardRow;
type Translate = (key: string, opts?: Record<string, unknown>) => string;

function useIsEn(): boolean {
  const { i18n } = useTranslation('common');
  return Boolean(i18n.language?.toLowerCase().startsWith('en'));
}

function boardTitle(board: AnalysisLeaderboardBoard, isEn: boolean): string {
  return isEn && board.titleEn ? board.titleEn : board.title;
}

function boardPeriod(board: AnalysisLeaderboardBoard, isEn: boolean): string {
  return isEn && board.periodEn ? board.periodEn : board.period;
}

function boardNote(board: AnalysisLeaderboardBoard, isEn: boolean): string | undefined {
  return isEn && board.noteEn ? board.noteEn : board.note;
}

/** 說明拆成子句 (；/ ;)：第一句是誰上榜，後面是視窗與定義。 */
function noteClauses(note: string | undefined): string[] {
  if (!note) return [];
  return note.split(/[；;]/).map(s => s.trim()).filter(Boolean);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function hasField(rows: readonly Row[], key: keyof Row): boolean {
  return rows.some(r => isNum(r[key]));
}

function rankClass(rank: number): string {
  if (rank === 1) return 'text-amber-300';
  if (rank === 2) return 'text-gray-200';
  if (rank === 3) return 'text-orange-300';
  return 'text-zinc-500';
}

function deltaClass(v: unknown): string {
  if (!isNum(v)) return 'text-zinc-500';
  if (v > 0) return 'text-emerald-300';
  if (v < 0) return 'text-rose-300';
  return 'text-zinc-300';
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  const pos = (b: T): number => {
    const i = BOARD_ORDER.indexOf(b.id);
    return i === -1 ? BOARD_ORDER.length : i;
  };
  // Array.prototype.sort is stable: unknown ids keep the cache's order.
  return [...items].sort((a, b) => pos(a) - pos(b));
}

/**
 * schemaVersion 3 的快取 (產生器還沒有 overallMinGames) 沒有這兩個榜：小分頁照列，
 * 內容是「下次每日更新後提供」與定義，場數用產生器預設值 (theorySettings)。
 */
const PENDING_IDS = ['position', 'overall'] as const;
type PendingId = (typeof PENDING_IDS)[number];

/** 一個小分頁：快取的榜，或舊快取還沒有的榜 (pending)。 */
type TabEntry = { id: string; board: AnalysisLeaderboardBoard } | { id: PendingId; board?: undefined };

/** 非錯誤的「暫時沒有排行」狀態：快取尚未產生 / 後端版本過舊 / 快取還是改版前的格式。 */
type BoardsNotice = 'notGenerated' | 'backendOutdated' | 'upgrading';

export interface LeaderboardBoardsProps {
  /** 最後一個小分頁 (精算榜)；排行載入失敗時照樣可以切過去。 */
  precision?: { label: ReactNode; content: ReactNode };
}

export default function LeaderboardBoards({ precision }: LeaderboardBoardsProps): JSX.Element {
  const { t } = useTranslation('common');
  const isEn = useIsEn();
  const [data, setData] = useState<AnalysisLeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<BoardsNotice | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 天數、場數、補值門檻讀快取的 leaderboard.config (舊快取沒有這些鍵 → 產生器預設值)。
  const settings = theorySettings(data?.config);

  useEffect(() => {
    let cancelled = false;
    fetchAnalysisLeaderboard()
      .then(d => {
        if (cancelled) return;
        setData(d);
        setError(null);
        const boards = Array.isArray(d.boards) ? d.boards : [];
        // 改版前的快取：榜都沒有 metric (超額勝率) → 不顯示，等每日重算。
        setNotice(boards.length > 0 && !boards.some(isTheoryBoard) ? 'upgrading' : null);
      })
      .catch(e => {
        if (cancelled) return;
        if (isAnalysisNotGenerated(e)) {
          setNotice('notGenerated');
        } else if (isAnalysisRouteMissing(e)) {
          setNotice('backendOutdated');
        } else {
          setError(getErrorMessage(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retry = (): void => {
    setLoading(true);
    setError(null);
    setNotice(null);
    setReloadKey(k => k + 1);
  };

  const entries = useMemo((): TabEntry[] => {
    const boards = (data && Array.isArray(data.boards) ? data.boards : [])
      .filter(isTheoryBoard)
      .filter(b => Array.isArray(b.rows) && b.rows.length > 0);
    const legacy = !isNum(data?.config?.overallMinGames);
    const pending = boards.length > 0 && legacy
      ? PENDING_IDS.filter(id => !boards.some(b => b.id === id))
      : [];
    return sortById<TabEntry>([...boards.map(b => ({ id: b.id, board: b })), ...pending.map(id => ({ id }))]);
  }, [data]);
  const showBoards = !loading && !notice && !error && entries.length > 0;

  const tabLabel = (entry: TabEntry): string =>
    BOARD_ORDER.includes(entry.id) || !entry.board
      ? t(`analytics.r6.boards.tab.${entry.id}`)
      : boardTitle(entry.board, isEn);

  const items: SectionTabItem[] = [
    ...(showBoards
      ? entries.map(e => ({ id: e.id, label: tabLabel(e), icon: BOARD_ICONS[e.id] ?? ListOrdered }))
      : [{ id: STATUS_TAB, label: t('analytics.r6.boards.tab.main'), icon: Trophy }]),
    ...(precision ? [{ id: PRECISION_TAB, label: precision.label, icon: Calculator }] : []),
  ];

  const retryButton = (
    <button
      onClick={retry}
      className="mt-1 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700"
    >
      <RefreshCw size={12} /> {t('analytics.boards.retry')}
    </button>
  );

  const statusPanel = (): ReactNode => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-10 text-gray-400 gap-3">
          <Loader size={20} className="animate-spin" /> {t('analytics.boards.loading')}
        </div>
      );
    }
    if (notice) {
      return (
        <div className="flex items-center gap-3 flex-wrap px-4 py-4 rounded-xl border border-amber-800/40 bg-amber-900/10 text-amber-300 text-sm">
          <Clock size={18} className="flex-shrink-0" />
          <span className="flex-1">{t(`analytics.boards.${notice}`, { games: settings.mainGames })}</span>
          {retryButton}
        </div>
      );
    }
    if (error || !data) {
      return (
        <div className="flex flex-col items-center justify-center py-10 gap-3 text-red-400">
          <AlertCircle size={24} />
          <p className="text-sm">{t('analytics.boards.loadFailed')}</p>
          {error && <p className="text-xs text-gray-500 max-w-md text-center">{error}</p>}
          {retryButton}
        </div>
      );
    }
    return (
      <div className="px-4 py-4 rounded-xl border border-gray-700 bg-avalon-card/30 text-sm text-gray-500">
        {t('analytics.boards.empty', { days: settings.activeDays, games: settings.mainGames })}
      </div>
    );
  };

  return (
    <div>
      {showBoards && data && (
        <p className="text-[11px] text-zinc-500 mb-2">
          {t('analytics.boards.asOf', { date: data.asOf })}
          {data.dates && (
            <> · {t('analytics.boards.datesNote', { parsed: data.dates.parsed, unparsed: data.dates.unparsed })}</>
          )}
        </p>
      )}
      <SectionTabs
        items={items}
        persistKey="boards"
        ariaLabel={t('analytics.r6.boards.tabsLabel')}
      >
        {active => {
          if (active === PRECISION_TAB) {
            return (
              <div>
                <h3 className="text-sm font-bold text-white mb-1.5">{t('analytics.boards.precisionTitle')}</h3>
                {precision?.content}
              </div>
            );
          }
          const entry = showBoards ? entries.find(e => e.id === active) : undefined;
          if (!entry) return statusPanel();
          if (!entry.board) {
            return (
              <PendingPanel
                id={entry.id}
                games={entry.id === 'overall' ? settings.overallMinGames : settings.positionGames}
              />
            );
          }
          return (
            <BoardPanel
              board={entry.board}
              isEn={isEn}
              minCell={settings.theoryMinCellGames}
              activeDays={settings.activeDays}
            />
          );
        }}
      </SectionTabs>
    </div>
  );
}

function rowTip(t: Translate, row: Row): string {
  return [
    isNum(row.careerGames) ? t('analytics.boards.tip.career', { count: row.careerGames }) : null,
    row.from && row.to ? t('analytics.boards.tip.span', { from: row.from, to: row.to }) : null,
    (row.sparseRoles ?? 0) > 0 || (row.sparseSeats ?? 0) > 0
      ? t('analytics.boards.tip.sparse', { roles: row.sparseRoles ?? 0, seats: row.sparseSeats ?? 0 })
      : null,
  ].filter(Boolean).join(' · ');
}

/** 舊快取還沒有的榜：下次每日更新後提供 + 定義。 */
function PendingPanel({ id, games }: { id: PendingId; games: number }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-bold text-white">{t(`analytics.r6.boards.pending.${id}Title`)}</h3>
      <div className="flex items-center gap-3 px-4 py-4 rounded-xl border border-amber-800/40 bg-amber-900/10 text-amber-300 text-sm">
        <Clock size={18} className="flex-shrink-0" />
        <span>{t(`analytics.r6.boards.pending.${id}`, { games })}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-500">{t(`analytics.r6.boards.pending.${id}Def`)}</p>
    </div>
  );
}

function BoardPanel({
  board, isEn, minCell, activeDays,
}: {
  board: AnalysisLeaderboardBoard;
  isEn: boolean;
  minCell: number;
  activeDays: number;
}): JSX.Element {
  const { t } = useTranslation('common');
  // 點一列 → 該玩家的玩家雷達 (不用登入)。
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  const rows = board.rows;
  const { columns, sparse } = useMemo(() => boardColumns(board, t, minCell), [board, t, minCell]);
  const [who, ...rest] = noteClauses(boardNote(board, isEn));

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap">
        <h3 className="text-sm font-bold text-white">{boardTitle(board, isEn)}</h3>
        <span className="text-xs text-zinc-400">{boardPeriod(board, isEn)}</span>
        {board.allGames && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-800/50 text-amber-300">
            {t('analytics.boards.exception')}
          </span>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <StatTable
          columns={columns}
          rows={rows}
          rowKey={(row, i) => `${board.id}-${row.rank}-${row.role ?? ''}-${row.name}-${i}`}
          onRowClick={row => openPlayerStats(row.name)}
          rowTitle={row => rowTip(t, row) || undefined}
          footnote={
            <>
              {sparse && <>{t('analytics.r6.boards.sparseNote', { min: minCell })} </>}
              {t('analytics.r6.boards.clickHint')}
            </>
          }
        />
        <aside className="text-[11px] leading-relaxed text-zinc-500 space-y-1.5 min-w-0">
          {who && (
            <p>
              <span className="font-semibold text-zinc-300">{t('analytics.r6.boards.who')}</span>
              {who}
            </p>
          )}
          {rest.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5 marker:text-zinc-700">
              {rest.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
          <p className="text-zinc-600">{t('analytics.boards.principle', { days: activeDays })}</p>
        </aside>
      </div>
    </div>
  );
}

// ── 欄位 ───────────────────────────────────────────────────────────────

type TheoryField = 'roleTheory' | 'positionTheory' | 'finalWinRate' | 'overallTheory';

/** 該榜數字以外的理論欄，固定這個順序。 */
const THEORY_FIELDS: readonly TheoryField[] = ['roleTheory', 'positionTheory', 'finalWinRate', 'overallTheory'];

function isTheoryField(metric: unknown): metric is TheoryField {
  return typeof metric === 'string' && (THEORY_FIELDS as readonly string[]).includes(metric);
}

/**
 * 這一格用全體勝率補了幾格。快取的 sparseSeats 一定是這一列位置理論的；sparseRoles 是這個榜排序用的
 * 角色理論 (main / newcomers 的各角色視窗、overall 的生涯)，跟其他欄 (例：main 的整體理論) 無關。
 * 最終勝率不補。
 */
function sparseCells(row: Row, field: TheoryField, metric: TheoryField | undefined): number {
  if (field === 'positionTheory') return row.sparseSeats ?? 0;
  if (field === metric && (field === 'roleTheory' || field === 'overallTheory')) return row.sparseRoles ?? 0;
  return 0;
}

function boardColumns(
  board: AnalysisLeaderboardBoard,
  t: Translate,
  minCell: number,
): { columns: StatColumn<Row>[]; sparse: boolean } {
  const rows = board.rows;
  const label = (key: string): string => t(`analytics.r6.boards.col.${key}`);
  const metric = isTheoryField(board.metric) ? board.metric : undefined;

  /** 比率格：一位小數；有補值的格子變淡並附提示。 */
  const pctCell = (field?: TheoryField) => (v: unknown, row: Row): ReactNode => {
    const filled = field ? sparseCells(row, field, metric) : 0;
    return filled > 0 ? (
      <span className="opacity-50" title={t('analytics.r6.boards.sparseCell', { count: filled, min: minCell })}>
        {fmtPct(isNum(v) ? v : null)}
      </span>
    ) : (
      fmtPct(isNum(v) ? v : null)
    );
  };

  const nameCol: StatColumn<Row> = {
    key: 'name',
    label: label('rankName'),
    format: (_v, row) => (
      <span className="inline-flex items-baseline gap-1.5">
        <span className={`inline-block w-5 text-right font-black ${rankClass(row.rank)}`}>{row.rank}</span>
        <span className="font-semibold text-white">{row.name}</span>
      </span>
    ),
  };
  const careerCol: StatColumn<Row>[] = hasField(rows, 'careerGames')
    ? [{ key: 'careerGames', label: label('careerGames'), format: 'int', className: 'text-zinc-400' }]
    : [];

  // 角色王：每個角色一列 (同率各給 → 同一個角色可能好幾列)。
  if (board.id === 'roleTitles' || (board.metric === 'finalWinRate' && rows.some(r => r.role))) {
    const perRole = new Map<string, number>();
    rows.forEach(r => perRole.set(r.role ?? '', (perRole.get(r.role ?? '') ?? 0) + 1));
    const columns: StatColumn<Row>[] = [
      {
        key: 'role',
        label: label('role'),
        format: (_v, row) => (
          <span className="inline-flex items-baseline gap-1">
            <span className={RED_ROLES.has(row.role ?? '') ? 'text-red-300' : 'text-blue-300'}>{row.role ?? '—'}</span>
            {(perRole.get(row.role ?? '') ?? 0) > 1 && (
              <span className="text-[10px] font-normal text-zinc-500">{label('tie')}</span>
            )}
          </span>
        ),
      },
      {
        key: 'name',
        label: label('name'),
        format: v => <span className="font-semibold text-white">{String(v ?? '—')}</span>,
      },
      { key: 'value', label: label('finalWinRate'), format: pctCell(), align: 'right', emphasis: true, tone: 'amber' },
      ...(hasField(rows, 'wins')
        ? [{
            key: 'wins',
            label: label('winsGames'),
            align: 'right' as const,
            value: (r: Row): string => `${r.wins ?? '—'}/${r.games}`,
          }]
        : []),
      ...(hasField(rows, 'careerRoleGames')
        ? [{ key: 'careerRoleGames', label: label('careerRoleGames'), format: 'int' as const, className: 'text-zinc-400' }]
        : []),
    ];
    return { columns, sparse: false };
  }

  // 進步榜：角色理論的差，單位是百分點 (不是相對成長 %)。
  if (board.metric === 'roleTheoryDelta') {
    const pct = (key: keyof Row): StatColumn<Row>[] =>
      hasField(rows, key) ? [{ key, label: label(key), format: pctCell(), align: 'right' }] : [];
    const columns: StatColumn<Row>[] = [
      nameCol,
      {
        key: 'value',
        label: label('delta'),
        align: 'right',
        emphasis: true,
        format: v => <span className={deltaClass(v)}>{fmtSignedPoints(isNum(v) ? v : null)}</span>,
      },
      ...pct('recentRoleTheory'),
      ...pct('priorRoleTheory'),
      ...pct('recentFinalWinRate'),
      ...pct('priorFinalWinRate'),
      ...(hasField(rows, 'recentGames')
        ? [{
            key: 'recentGames',
            label: label('recentPriorGames'),
            align: 'right' as const,
            value: (r: Row): string => `${r.recentGames ?? r.games} / ${isNum(r.priorGames) ? r.priorGames : '—'}`,
          }]
        : []),
      ...careerCol,
    ];
    return { columns, sparse: false };
  }

  // 刺客：刺中率 = 三藍死 /（三藍死 + 三藍活），分母是刺殺次數。
  if (board.metric === 'hitRate') {
    const columns: StatColumn<Row>[] = [
      nameCol,
      { key: 'value', label: label('hitRate'), format: pctCell(), align: 'right', emphasis: true, tone: 'amber' },
      ...(hasField(rows, 'hits')
        ? [{
            key: 'hits',
            label: label('hitsAttempts'),
            align: 'right' as const,
            value: (r: Row): string => `${r.hits}/${isNum(r.attempts) ? r.attempts : r.games}`,
          }]
        : []),
      ...careerCol,
    ];
    return { columns, sparse: false };
  }

  // 角色理論／位置理論／整體理論 (main、position、overall、newcomers、schemaVersion 3 的 last50) 與未知 metric。
  const field = metric;
  const columns: StatColumn<Row>[] = [
    nameCol,
    {
      key: 'value',
      label: field ? label(field) : label('value'),
      value: r => (field && isNum(r[field]) ? r[field] : r.value),
      format: pctCell(field),
      align: 'right',
      emphasis: true,
      tone: 'amber',
    },
    ...THEORY_FIELDS
      .filter(f => f !== field && hasField(rows, f))
      .map((f): StatColumn<Row> => ({ key: f, label: label(f), format: pctCell(f), align: 'right' })),
    // 視窗場數只在跟生涯場數不同時才列 (整體理論、新人 = 全部場次)。
    ...(hasField(rows, 'games') && rows.some(r => r.games !== r.careerGames)
      ? [{ key: 'games', label: label('windowGames'), format: 'int' as const }]
      : []),
    ...careerCol,
    ...(rows.some(r => r.firstPlayed)
      ? [{ key: 'firstPlayed', label: label('firstPlayed'), className: 'text-zinc-400' }]
      : []),
    // 新人以第一次打滿門檻場數的日子為準 (Edward 2026-10-26)；舊快取沒有這欄
    ...(rows.some(r => r.qualifiedOn)
      ? [{ key: 'qualifiedOn', label: label('qualifiedOn'), className: 'text-zinc-400' }]
      : []),
  ];
  // 表上有補值 (變淡) 的格子才放註腳。
  const shown = THEORY_FIELDS.filter(f => f === field || columns.some(c => c.key === f));
  return { columns, sparse: rows.some(r => shown.some(f => sparseCells(r, f, metric) > 0)) };
}
