import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader, AlertCircle } from 'lucide-react';
import {
  DECISIVE_ABNORMAL, DECISIVE_GROUP_MIN, DECISIVE_GROUPS, DECISIVE_MIN_N, DECISIVE_RANK_SCOPES, DECISIVE_ROLES, DECISIVE_SHRINK_K,
  DECISIVE_SORT_KEYS,
  decisiveRate, decisiveSlice, sortDecisiveRows, sumDecisive,
  type DecisiveCell, type DecisiveGrid, type DecisiveGroup, type DecisivePlayerRow, type DecisiveRankScope,
  type DecisiveReport, type DecisiveRole, type DecisiveSortKey,
} from '@avalon/shared/stats';
import { useGameStore } from '../../../store/gameStore';
import { useStatsFiltered } from '../../../stats/statsFilter';
import { InfoTip, SectionTabs, StatTable, Term, useSectionTab, type SectionTabItem, type StatColumn, type StatTermKey } from '../ui';
import {
  DECISIVE_GROUP_TERMS, DECISIVE_MIN_FILTERED, DECISIVE_MIN_OPTIONS, DECISIVE_ROLE_COLORS, DECISIVE_SCOPE_KEY,
} from './decisiveLayout';
import { useDecisiveReport } from './useDecisiveReport';

/**
 * 數據排行「關鍵外白／內黑」（社群點子「最佳第六人」，Edward 2026-11-11 擴大成「關鍵 場外／場內 × 白／黑 × 對／錯」）：
 * 真的決定了提議過不過的藍方投票（剛好 6 票過關時投白、剛好 5 票沒過時投黑），依投的人在不在隊上、投白投黑、隊伍是全好
 * 還是會失敗分成八格（第 4 局單紅的隊是中性，不算對錯）。定義與算法在 @avalon/shared stats/decisiveVotes.ts。
 *
 *  - 範圍：兩紅之後（預設，原本的點子）／第 3～5 局；跟著上方的篩選（統計 Worker 裡算）。第 1～2 局「一律投黑」就比平均準，不排名。
 *  - 上方：全體（含沒寫名字的座位）依角色的對率／份額／每次機會，與四組的一行說明；梅林另外一行（莫德雷德他看不到）。
 *  - 表：名次、玩家、關鍵票正確率（收縮後＋原始）、關鍵票張數、白票／黑票對率、四組對率（異常的內黑、外白加底色）、
 *    場內比例、角色組成。預設依收縮後的正確率排序、至少 DECISIVE_MIN_N 張（有篩選時 DECISIVE_MIN_FILTERED）；點表頭換排序。
 *  - 門檻與收縮的理由（說明裡寫給玩家看）：每人的局隨機分兩半，30 張以上的常客兩半對不起來（差距大多是運氣），算進 15～29 張
 *    的人才有小幅正相關；門檻 30 是為了涵蓋率，k = 150 是選定的收縮強度、不是估計值（decisiveVotes.ts 檔頭有數字）。
 *  - 一律白／一律黑／照常投的正確率即時算（report.all.baselines），篩選後不一定都低於平均，說明跟著換句子。
 */

type Translate = (key: string, opts?: Record<string, unknown>) => string;

const K = 'analytics.decisive';
/** 表身在框裡捲 (表頭固定)。 */
const TABLE_MAX_HEIGHT = 'max(15rem, calc(100vh - 25rem))';

/** 0..1 → 百分比字串，只四捨五入一次；null → —。 */
const pct = (x: number | null, digits = 0): string => (x === null ? '—' : `${(x * 100).toFixed(digits)}%`);
const share = (k: number, n: number, digits = 0): string => pct(n > 0 ? k / n : null, digits);

function rankClass(rank: number): string {
  if (rank === 1) return 'text-amber-300';
  if (rank === 2) return 'text-gray-200';
  if (rank === 3) return 'text-orange-300';
  return 'text-zinc-500';
}

const nonNeutral = (c: Pick<DecisiveCell, 'right' | 'wrong'>): number => c.right + c.wrong;

/** 一組的格子：大字對率、小字對／錯張數；不到 DECISIVE_GROUP_MIN 張變淡。 */
function GroupCell({ cell, t, extraTitle }: { cell: DecisiveCell; t: Translate; extraTitle?: string }): JSX.Element {
  const n = nonNeutral(cell);
  const low = n < DECISIVE_GROUP_MIN;
  const title = [
    t(`${K}.cellTitle`, { right: cell.right, wrong: cell.wrong, neutral: cell.neutral }),
    low && n > 0 ? t(`${K}.groupLow`, { min: DECISIVE_GROUP_MIN }) : null,
    extraTitle ?? null,
  ].filter(Boolean).join(' · ');
  return (
    <span className={`inline-flex flex-col items-end leading-tight ${low ? 'opacity-50' : ''}`} title={title}>
      <span className="font-semibold">{pct(decisiveRate(cell))}</span>
      <span className="text-[10px] font-normal text-zinc-500">{t(`${K}.rightWrong`, { right: cell.right, wrong: cell.wrong })}</span>
    </span>
  );
}

/** 表頭：名詞說明 + 排序鍵。 */
function SortHeader({
  term, label, sortKey, active, onSort, abnormal = false,
}: {
  term: StatTermKey; label: string; sortKey: DecisiveSortKey; active: boolean; onSort: (k: DecisiveSortKey) => void; abnormal?: boolean;
}): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <span className="inline-flex items-center gap-0.5">
      <Term term={term} className={active ? 'text-amber-300' : abnormal ? 'text-amber-200/90' : ''}>{label}</Term>
      {abnormal && <span className="rounded bg-amber-500/15 px-1 text-[9px] font-semibold text-amber-300">{t(`${K}.abnormal`)}</span>}
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-pressed={active}
        aria-label={t(`${K}.sortByCol`, { col: label })}
        className={`px-0.5 hover:text-zinc-200 ${active ? 'text-amber-300' : 'text-zinc-600'}`}
        data-testid={`decisive-sort-${sortKey}`}
      >
        {active ? '▾' : '↕'}
      </button>
    </span>
  );
}

/** 角色組成：三段小長條（忠臣／派西維爾／梅林的非中性關鍵票）。 */
function RoleBar({ byRole, t }: { byRole: Record<DecisiveRole, DecisiveGrid>; t: Translate }): JSX.Element {
  const counts = DECISIVE_ROLES.map((role) => [role, nonNeutral(sumDecisive(byRole[role]))] as const);
  const total = counts.reduce((s, [, n]) => s + n, 0);
  const byName = Object.fromEntries(counts) as Record<DecisiveRole, number>;
  const order: DecisiveRole[] = ['忠臣', '派西維爾', '梅林'];
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={t(`${K}.roleSplitTitle`, { loyal: byName['忠臣'], percival: byName['派西維爾'], merlin: byName['梅林'] })}
    >
      <span aria-hidden className="inline-flex h-2 w-14 overflow-hidden rounded-full bg-zinc-800">
        {total > 0 && order.map((role) => (
          <span key={role} className="block h-full" style={{ width: `${(100 * byName[role]) / total}%`, backgroundColor: DECISIVE_ROLE_COLORS[role] }} />
        ))}
      </span>
      <span className="text-[10px] text-zinc-500">
        {order.map((role, i) => (
          <span key={role} style={{ color: DECISIVE_ROLE_COLORS[role] }}>{i > 0 ? '／' : ''}{byName[role]}</span>
        ))}
      </span>
    </span>
  );
}

// ── 全體：依角色 ───────────────────────────────────────────────────────

type RoleView = 'rate' | 'share' | 'chance';

interface RoleRow {
  key: DecisiveRole | 'all';
  grid: DecisiveGrid;
  opportunities: number;
}

/** 八格（份額表的列）：組 × 對錯。 */
const CELLS: ReadonlyArray<{ group: DecisiveGroup; outcome: 'right' | 'wrong' }> = DECISIVE_GROUPS.flatMap((group) => [
  { group, outcome: 'right' as const }, { group, outcome: 'wrong' as const },
]);

function RoleBreakdown({ report }: { report: DecisiveReport }): JSX.Element {
  const { t } = useTranslation('common');
  const viewItems: SectionTabItem<RoleView>[] = useMemo(() => (['rate', 'share', 'chance'] as const).map((id) => ({
    id, label: t(`${K}.roles.view.${id}`),
  })), [t]);
  const [view = 'rate', setView] = useSectionTab(viewItems, { persistKey: 'boards.decisive.roleView' });
  const { all } = report;
  const roleLabel = (key: RoleRow['key']): string => t(`${K}.roles.role.${key}`);
  const rows: RoleRow[] = [
    ...(['忠臣', '派西維爾', '梅林'] as DecisiveRole[]).map((role) => ({ key: role, grid: all.byRole[role].grid, opportunities: all.byRole[role].opportunities })),
    { key: 'all', grid: all.grid, opportunities: all.opportunities },
  ];
  const nameCol: StatColumn<RoleRow> = {
    key: 'key',
    label: t(`${K}.roles.colRole`),
    format: (_v, r) => (
      <span className={r.key === 'all' ? 'font-bold text-amber-200' : ''} style={r.key !== 'all' ? { color: DECISIVE_ROLE_COLORS[r.key] } : undefined}>
        {roleLabel(r.key)}
      </span>
    ),
  };
  /** 這一組的對票由各角色投出的份額（格子的滑鼠提示）。 */
  const rightShareTitle = (group: DecisiveGroup): string => {
    const tot = all.grid[group].right;
    return t(`${K}.roles.rightShareTitle`, {
      loyal: share(all.byRole['忠臣'].grid[group].right, tot),
      percival: share(all.byRole['派西維爾'].grid[group].right, tot),
      merlin: share(all.byRole['梅林'].grid[group].right, tot),
    });
  };

  let table: JSX.Element;
  if (view === 'share') {
    type ShareRow = { id: string; label: string; abnormal: boolean; counts: Record<DecisiveRole, number> };
    const shareRows: ShareRow[] = [
      {
        id: 'chances', label: t(`${K}.roles.chances`), abnormal: false,
        counts: { 忠臣: all.byRole['忠臣'].opportunities, 派西維爾: all.byRole['派西維爾'].opportunities, 梅林: all.byRole['梅林'].opportunities },
      },
      ...CELLS.map(({ group, outcome }) => ({
        id: `${group}-${outcome}`,
        label: t(`${K}.cells.${group}.${outcome}`),
        abnormal: DECISIVE_ABNORMAL.has(group),
        counts: {
          忠臣: all.byRole['忠臣'].grid[group][outcome],
          派西維爾: all.byRole['派西維爾'].grid[group][outcome],
          梅林: all.byRole['梅林'].grid[group][outcome],
        },
      })),
    ];
    const total = (r: ShareRow): number => DECISIVE_ROLES.reduce((s, role) => s + r.counts[role], 0);
    const columns: StatColumn<ShareRow>[] = [
      {
        key: 'label',
        label: t(`${K}.roles.colCell`),
        format: (_v, r) => <span className={r.id === 'chances' ? 'text-zinc-400' : r.abnormal ? 'text-amber-200' : ''}>{r.label}</span>,
      },
      ...(['忠臣', '派西維爾', '梅林'] as DecisiveRole[]).map((role): StatColumn<ShareRow> => ({
        key: role,
        label: <span style={{ color: DECISIVE_ROLE_COLORS[role] }}>{roleLabel(role)}</span>,
        align: 'right',
        format: (_v, r) => (
          <span title={t(`${K}.roles.countTitle`, { count: r.counts[role] })}>
            {share(r.counts[role], total(r))}
            <span className="ml-1 text-[10px] font-normal text-zinc-500">{r.counts[role]}</span>
          </span>
        ),
      })),
      { key: 'total', label: t(`${K}.roles.colTotal`), align: 'right', value: total, format: 'int', className: 'text-zinc-400' },
    ];
    table = <StatTable columns={columns} rows={shareRows} rowKey={(r) => r.id} highlightRow={(r) => r.id === 'chances'} />;
  } else if (view === 'chance') {
    // 關鍵外白／內黑每次機會不到 1%，多給一位小數才看得出角色的差別。
    const per = (k: number, r: RoleRow, digits = 1): ReactNode => (
      <span title={t(`${K}.roles.perChanceTitle`, { k, n: r.opportunities })}>{share(k, r.opportunities, digits)}</span>
    );
    const columns: StatColumn<RoleRow>[] = [
      nameCol,
      { key: 'opportunities', label: t(`${K}.roles.chances`), align: 'right', format: 'int', className: 'text-zinc-400' },
      {
        key: 'decisive', label: <Term term="decisiveVote">{t(`${K}.roles.colDecisive`)}</Term>, align: 'right',
        format: (_v, r): ReactNode => { const c = sumDecisive(r.grid); return per(c.right + c.wrong + c.neutral, r); },
      },
      {
        key: 'right', label: <Term term="decisivePerChance">{t(`${K}.roles.colRightPer`)}</Term>, align: 'right', tone: 'blue', emphasis: true,
        format: (_v, r) => per(sumDecisive(r.grid).right, r),
      },
      {
        key: 'wrong', label: t(`${K}.roles.colWrongPer`), align: 'right', tone: 'red',
        format: (_v, r) => per(sumDecisive(r.grid).wrong, r),
      },
      {
        key: 'offYesRight', label: <span className="text-amber-200">{t(`${K}.cells.offYes.right`)}</span>, align: 'right',
        format: (_v, r) => per(r.grid.offYes.right, r, 2),
      },
      {
        key: 'onNoRight', label: <span className="text-amber-200">{t(`${K}.cells.onNo.right`)}</span>, align: 'right',
        format: (_v, r) => per(r.grid.onNo.right, r, 2),
      },
    ];
    table = <StatTable columns={columns} rows={rows} rowKey={(r) => r.key} highlightRow={(r) => r.key === 'all'} />;
  } else {
    const columns: StatColumn<RoleRow>[] = [
      nameCol,
      {
        key: 'acc', label: <Term term="decisiveAccuracy">{t(`${K}.col.accuracy`)}</Term>, align: 'right', emphasis: true, tone: 'amber',
        format: (_v, r): ReactNode => {
          const c = sumDecisive(r.grid);
          return <span title={t(`${K}.cellTitle`, { ...c })}>{pct(decisiveRate(c), 1)}<span className="ml-1 text-[10px] font-normal text-zinc-500">{nonNeutral(c)}</span></span>;
        },
      },
      ...DECISIVE_GROUPS.map((group): StatColumn<RoleRow> => ({
        key: group,
        label: <Term term={DECISIVE_GROUP_TERMS[group]} className={DECISIVE_ABNORMAL.has(group) ? 'text-amber-200/90' : ''}>{t(`${K}.col.${group}`)}</Term>,
        align: 'right',
        className: DECISIVE_ABNORMAL.has(group) ? 'bg-amber-400/[0.06]' : undefined,
        format: (_v, r) => <GroupCell cell={r.grid[group]} t={t} extraTitle={rightShareTitle(group)} />,
      })),
      {
        key: 'yes', label: <Term term="decisiveYesRate">{t(`${K}.col.yes`)}</Term>, align: 'right',
        format: (_v, r) => <GroupCell cell={sumDecisive(r.grid, ['onYes', 'offYes'])} t={t} />,
      },
      {
        key: 'no', label: <Term term="decisiveNoRate">{t(`${K}.col.no`)}</Term>, align: 'right',
        format: (_v, r) => <GroupCell cell={sumDecisive(r.grid, ['onNo', 'offNo'])} t={t} />,
      },
    ];
    table = <StatTable columns={columns} rows={rows} rowKey={(r) => r.key} highlightRow={(r) => r.key === 'all'} />;
  }

  const merlin = all.byRole['梅林'];
  const loyal = all.byRole['忠臣'];
  const merlinAll = sumDecisive(merlin.grid);
  const loyalAll = sumDecisive(loyal.grid);
  return (
    <section className="space-y-1.5" data-testid="decisive-roles">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-xs font-bold text-zinc-300">{t(`${K}.roles.title`)}</h4>
        <InfoTip title={t(`${K}.roles.title`)}>
          <p>{t(`${K}.roles.help.rate`)}</p>
          <p>{t(`${K}.roles.help.share`)}</p>
          <p>{t(`${K}.roles.help.chance`)}</p>
        </InfoTip>
        <SectionTabs items={viewItems} value={view} onChange={setView} size="sm" ariaLabel={t(`${K}.roles.viewLabel`)} />
      </div>
      <p className="text-[11px] text-zinc-500">{t(`${K}.roles.viewNote.${view}`)}</p>
      {table}
      <p className="px-1 text-[11px] text-zinc-400" data-testid="decisive-merlin">
        {t(`${K}.roles.merlinNote`, {
          merlin: pct(decisiveRate(merlinAll)), loyal: pct(decisiveRate(loyalAll)),
          mo: pct(decisiveRate(merlin.mordredOnly)), moN: nonNeutral(merlin.mordredOnly),
          lo: pct(decisiveRate(loyal.mordredOnly)), loN: nonNeutral(loyal.mordredOnly),
        })}
      </p>
    </section>
  );
}

// ── 主元件 ─────────────────────────────────────────────────────────────

export default function DecisiveBoard(): JSX.Element {
  const { t } = useTranslation('common');
  const filtered = useStatsFiltered();
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  const scopeItems: SectionTabItem<DecisiveRankScope>[] = useMemo(() => DECISIVE_RANK_SCOPES.map((id) => ({
    id, label: t(`${K}.scope.${id}`),
  })), [t]);
  const [scope = 'twoRed', setScope] = useSectionTab(scopeItems, { persistKey: DECISIVE_SCOPE_KEY });
  const [minN, setMinN] = useState<number>(filtered ? DECISIVE_MIN_FILTERED : DECISIVE_MIN_N);
  const [sortKey, setSortKey] = useState<DecisiveSortKey>('score');
  const state = useDecisiveReport(scope);
  const report = state.status === 'ok' ? state.report : null;

  const rows = useMemo(
    () => (report ? sortDecisiveRows(report.players.filter((p) => p.n >= minN), sortKey) : []),
    [report, minN, sortKey],
  );

  // 三種固定投法在同一批關鍵位置上的正確率（即時算，跟著篩選與範圍）：都低於全體平均才能說分數不獎勵單邊投票。
  const baselineNote = useMemo(() => {
    if (!report) return null;
    const { approve, reject, usual } = report.all.baselines;
    const p0 = report.all.p0;
    if (approve === null || reject === null || usual === null || p0 === null) return null;
    const below = approve < p0 && reject < p0 && usual < p0;
    return t(`${K}.help.${below ? 'baselineBelow' : 'baselineNotBelow'}`, {
      approve: pct(approve), reject: pct(reject), usual: pct(usual), p0: pct(p0),
    });
  }, [report, t]);

  const header = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <h3 className="text-sm font-bold text-white">{t(`${K}.title`)}</h3>
      <InfoTip title={t(`${K}.title`)} testId="decisive-info">
        <p>{t(`${K}.help.what`)}</p>
        <p>{t(`${K}.help.cells`)}</p>
        <p>{t(`${K}.help.abnormal`)}</p>
        <p>{t(`${K}.help.scope`)}</p>
        <p>{t(`${K}.help.rank`, { k: report?.k ?? DECISIVE_SHRINK_K })}</p>
        {baselineNote && <p data-testid="decisive-baselines">{baselineNote}</p>}
        <p>{t(`${K}.help.honest`)}</p>
        <p>{t(`${K}.help.data`)}</p>
        <p className="text-zinc-400">{t('analytics.r6.boards.clickHint')}</p>
      </InfoTip>
      <SectionTabs items={scopeItems} value={scope} onChange={setScope} size="sm" ariaLabel={t(`${K}.scopeLabel`)} />
      <label className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
        {t(`${K}.minN`)}
        <select
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
          value={minN}
          onChange={(e) => setMinN(Number(e.target.value))}
          data-testid="decisive-min-n"
        >
          {DECISIVE_MIN_OPTIONS.map((n) => <option key={n} value={n}>{t(`${K}.minNOption`, { count: n })}</option>)}
        </select>
      </label>
      <label className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
        {t(`${K}.sortBy`)}
        <select
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as DecisiveSortKey)}
          data-testid="decisive-sort"
        >
          {DECISIVE_SORT_KEYS.map((k) => <option key={k} value={k}>{t(`${K}.sort.${k}`)}</option>)}
        </select>
      </label>
    </div>
  );

  if (state.status === 'error') {
    return (
      <div className="space-y-2">
        {header}
        <div className="flex items-center justify-center gap-3 py-10 text-red-400">
          <AlertCircle size={20} /> {t(`${K}.error`, { message: state.message })}
        </div>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="space-y-2">
        {header}
        <div className="flex items-center justify-center gap-3 py-10 text-gray-400">
          <Loader size={20} className="animate-spin" /> {t(`${K}.loading`)}
        </div>
      </div>
    );
  }

  const tot = sumDecisive(report.all.grid);
  const namedN = report.players.reduce((s, p) => s + p.n, 0);
  const listedN = rows.reduce((s, p) => s + p.n, 0);
  const sortCtl = (key: DecisiveSortKey): { active: boolean; onSort: (k: DecisiveSortKey) => void } => ({ active: sortKey === key, onSort: setSortKey });
  const tone = (key: DecisiveSortKey): 'amber' | undefined => (sortKey === key ? 'amber' : undefined);

  const columns: StatColumn<DecisivePlayerRow>[] = [
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
      key: 'score',
      label: <SortHeader term="decisiveShrunk" label={t(`${K}.col.score`)} sortKey="score" {...sortCtl('score')} />,
      align: 'right',
      emphasis: sortKey === 'score',
      tone: tone('score') ?? 'amber',
      format: (_v, r) => (
        <span className="inline-flex flex-col items-end leading-tight" title={t(`${K}.scoreTitle`, { right: r.right, n: r.n, raw: pct(r.raw, 1), score: pct(r.score, 1), p0: pct(report.all.p0, 1), k: report.k })}>
          <span>{pct(r.score, 1)}</span>
        </span>
      ),
    },
    {
      key: 'raw',
      label: <SortHeader term="decisiveAccuracy" label={t(`${K}.col.raw`)} sortKey="raw" {...sortCtl('raw')} />,
      align: 'right',
      emphasis: sortKey === 'raw',
      tone: tone('raw'),
      format: (_v, r) => <span title={t(`${K}.cellTitle`, { right: r.right, wrong: r.wrong, neutral: r.neutral })}>{pct(r.raw)}</span>,
    },
    {
      key: 'n',
      label: <SortHeader term="decisiveVote" label={t(`${K}.col.n`)} sortKey="n" {...sortCtl('n')} />,
      align: 'right',
      emphasis: sortKey === 'n',
      tone: tone('n'),
      format: (_v, r) => (
        <span title={t(`${K}.nTitle`, { n: r.n, neutral: r.neutral, games: r.games })}>
          {r.n}
          {r.neutral > 0 && <span className="ml-1 text-[10px] font-normal text-zinc-500">+{r.neutral}</span>}
        </span>
      ),
    },
    ...DECISIVE_GROUPS.map((group): StatColumn<DecisivePlayerRow> => ({
      key: group,
      label: (
        <SortHeader term={DECISIVE_GROUP_TERMS[group]} label={t(`${K}.col.${group}`)} sortKey={group} abnormal={DECISIVE_ABNORMAL.has(group)} {...sortCtl(group)} />
      ),
      align: 'right',
      tone: tone(group),
      emphasis: sortKey === group,
      className: DECISIVE_ABNORMAL.has(group) ? 'bg-amber-400/[0.06]' : undefined,
      format: (_v, r) => <GroupCell cell={r.grid[group]} t={t} />,
    })),
    ...(['yes', 'no'] as const).map((key): StatColumn<DecisivePlayerRow> => ({
      key,
      label: <SortHeader term={key === 'yes' ? 'decisiveYesRate' : 'decisiveNoRate'} label={t(`${K}.col.${key}`)} sortKey={key} {...sortCtl(key)} />,
      align: 'right',
      tone: tone(key),
      emphasis: sortKey === key,
      format: (_v, r) => <GroupCell cell={decisiveSlice(r, key)} t={t} />,
    })),
    {
      key: 'onShare',
      label: <Term term="decisiveOnShare">{t(`${K}.col.onShare`)}</Term>,
      align: 'right',
      className: 'text-zinc-400',
      format: (_v, r): ReactNode => {
        const on = nonNeutral(sumDecisive(r.grid, ['onYes', 'onNo']));
        return <span title={t(`${K}.onShareTitle`, { on, off: r.n - on })}>{share(on, r.n)}</span>;
      },
    },
    {
      key: 'roles',
      label: t(`${K}.col.roles`),
      format: (_v, r) => <RoleBar byRole={r.byRole} t={t} />,
    },
  ];

  return (
    <div className="space-y-3" data-testid="decisive-board">
      {header}
      <p className="text-xs text-zinc-400">
        {t(`${K}.summary`, {
          proposals: report.all.proposals,
          votes: tot.right + tot.wrong + tot.neutral,
          neutral: tot.neutral,
          p0: pct(report.all.p0, 1),
          unnamed: report.all.unnamed,
        })}
      </p>
      <ul className="grid gap-1 text-[11px] sm:grid-cols-2 lg:grid-cols-4" data-testid="decisive-legend">
        {DECISIVE_GROUPS.map((group) => (
          <li
            key={group}
            className={`rounded-md border px-2 py-1 ${DECISIVE_ABNORMAL.has(group) ? 'border-amber-700/60 bg-amber-950/30 text-amber-100' : 'border-zinc-800 bg-zinc-950/60 text-zinc-300'}`}
          >
            <Term term={DECISIVE_GROUP_TERMS[group]} className="font-semibold">{t(`${K}.col.${group}`)}</Term>
            <span className="ml-1">{t(`${K}.legend.${group}`)}</span>
            <span className="ml-1 text-zinc-500">{t(`${K}.legendRate`, { rate: pct(decisiveRate(report.all.grid[group])), right: report.all.grid[group].right, wrong: report.all.grid[group].wrong })}</span>
          </li>
        ))}
      </ul>
      <RoleBreakdown report={report} />
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <h4 className="text-xs font-bold text-zinc-300">{t(`${K}.tableTitle`)}</h4>
          <span className="text-[11px] text-zinc-500" data-testid="decisive-min-note">
            {t(`${K}.minNote`, {
              min: minN, def: filtered ? DECISIVE_MIN_FILTERED : DECISIVE_MIN_N,
              count: rows.length, coverage: share(listedN, namedN), k: report.k,
            })}
          </span>
        </div>
        <StatTable
          columns={columns}
          rows={rows}
          maxHeight={TABLE_MAX_HEIGHT}
          rowKey={(r) => `decisive-${r.name}`}
          onRowClick={(r) => openPlayerStats(r.name)}
          empty={t(`${K}.empty`, { min: minN })}
        />
      </div>
    </div>
  );
}
