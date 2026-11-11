import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader, AlertCircle } from 'lucide-react';
import {
  TWO_RED_CATEGORIES, TWO_RED_ROLES, TWO_RED_ROUNDS, TWO_RED_TOTAL_INDEX, playerTier, twoRedTierTables,
  type PlayerTierKey, type TwoRedCategory, type TwoRedCounts, type TwoRedReport, type TwoRedRole, type TwoRedRound,
} from '@avalon/shared/stats';
import { twoRedReport } from '../../../stats/statsEngine';
import { useStatsFilter } from '../../../stats/statsFilter';
import { useCohortCuts } from '../../../stats/cohortCuts';
import { useGameStore } from '../../../store/gameStore';
import { InfoTip, SectionTabs, StatTable, useSectionTab, type SectionTabItem, type StatColumn } from '../ui';
import { TWO_RED_MIN_N, TWO_RED_TERMS, TWO_RED_TONES } from './twoRedLayout';
import DecisivePlayerLine from '../decisive/DecisivePlayerLine';
import { useTwoRedCohort } from '../cohort/useCohortData';
import { useDiscoveryNav } from '../discovery/discoveryNav';

/**
 * 玩家雷達 >「兩紅之後」小分頁（Edward 2026-11-11：「兩紅代表所有玩家都至少給過一次任務組合，並且湖中也至少使用過
 * 一次」）：這位玩家當梅林／派西維爾／忠臣隊長、紅方已經贏兩個任務時派出的隊，第 3、4、5 局各一張表，列 = 該局第
 * 1～4 次提議、尾派（第 5 次）與合計，欄 = 次數與各分類（互斥，每列加起來 100%）的比率與次數；每格下面小字是全體
 * （篩選範圍內所有隊長）同一格的比率。第 3、5 局：全好／全沒拇指但派到莫德雷德／派到至少一根拇指；第 4 局：全好／
 * 全沒拇指但派到莫德雷德／只含一拇指／含兩壞以上（2026-11-11 Edward 定案）。
 * 分類的定義與算法在 @avalon/shared stats/twoRed.ts；名詞與門檻在 twoRedLayout.ts（次數不到 TWO_RED_MIN_N 的列變淡）。
 * 跟著上方的篩選（統計 Worker 裡算，stats/statsEngine twoRedReport），不等雷達資料。
 * (2026-11-11) 標題下一行是這位玩家兩紅之後的關鍵票（decisive/DecisivePlayerLine），連到數據排行「關鍵外白／內黑」。
 * (2026-11-11 Edward：個人的樣本太小，看 PR 分組) 每格下面的小字預設改成「跟自己的組比」：這位玩家篩選範圍內最近一局的
 * PR 落在哪一組（強者／一般人／新手，切點 stats/cohortCuts.ts），那一組所有隊長同一格的比率；可以切回全體。沒有 PR 的玩家
 * （暫定、沒評分）只能比全體。「看各組」打開陣容強度 >「兩紅派隊分組」（cohort/TwoRedCohortView）。
 */

interface Row {
  /** 0..4 = 第 1～4 次、尾派；5 = 合計。 */
  index: number;
  mine: TwoRedCounts;
  /** 對照：自己的組或全體的同一格。 */
  all: TwoRedCounts;
}

/** 對照組：自己的 PR 組或全體。 */
type CompareMode = 'group' | 'all';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; report: TwoRedReport };

function useTwoRedReport(name: string): State {
  const filter = useStatsFilter((s) => s.filter);
  const filterKey = useStatsFilter((s) => `${s.key}|${s.nonce}`);
  const key = `${filterKey}|${name}`;
  const [result, setResult] = useState<{ key: string; state: State } | null>(null);
  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    twoRedReport(filter, filterKey, name)
      .then((report) => { if (!cancelled) setResult({ key, state: { status: 'ok', report } }); })
      .catch((err: unknown) => {
        if (!cancelled) setResult({ key, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } });
      });
    return (): void => { cancelled = true; };
  }, [filter, filterKey, name, key]);
  return result && result.key === key ? result.state : { status: 'loading' };
}

/** k / n 的百分比，直接四捨五入到整數（只取整一次）；n = 0 → —。 */
const pct = (k: number, n: number): string => (n > 0 ? `${Math.round((100 * k) / n)}%` : '—');

function RoundTable({ round, mine, all, refLabel }: { round: TwoRedRound; mine: TwoRedCounts[]; all: TwoRedCounts[]; refLabel: string }): JSX.Element {
  const { t } = useTranslation('common');
  // 合計列放最上面（樣本最多、最值得看），下面才是第 1～4 次與尾派。
  const byIndex: Row[] = mine.map((m, index) => ({ index, mine: m, all: all[index] }));
  const rows: Row[] = [byIndex[TWO_RED_TOTAL_INDEX], ...byIndex.filter((r) => r.index !== TWO_RED_TOTAL_INDEX)];
  const label = (index: number): string => (index === TWO_RED_TOTAL_INDEX
    ? t('analytics.r6.radar.twoRed.total')
    : index === 4 ? t('analytics.r6.radar.twoRed.forced') : t('analytics.r6.radar.twoRed.attempt', { n: index + 1 }));

  const shareCell = (key: TwoRedCategory) => (_v: unknown, row: Row): ReactNode => {
    const low = row.mine.n < TWO_RED_MIN_N;
    return (
      <span
        className={`inline-flex flex-col items-end leading-tight ${low ? 'opacity-50' : ''}`}
        title={t('analytics.r6.radar.twoRed.cellTitleRef', {
          k: row.mine[key], n: row.mine.n, allK: row.all[key], allN: row.all.n, label: refLabel,
        }) + (low && row.mine.n > 0 ? ` · ${t('analytics.ui.table.lowSample', { min: TWO_RED_MIN_N })}` : '')}
      >
        <span>
          <span className={row.index === TWO_RED_TOTAL_INDEX ? 'font-bold' : 'font-semibold'}>{pct(row.mine[key], row.mine.n)}</span>
          {row.mine.n > 0 && <span className="ml-1 text-[10px] font-normal text-zinc-500">{row.mine[key]}</span>}
        </span>
        <span className="text-[10px] font-normal text-zinc-500">{t('analytics.r6.radar.twoRed.refShort', { label: refLabel, pct: pct(row.all[key], row.all.n) })}</span>
      </span>
    );
  };

  const columns: StatColumn<Row>[] = [
    {
      key: 'slot',
      label: t('analytics.r6.radar.twoRed.colSlot'),
      value: (row) => row.index,
      format: (_v, row) => (
        <span className={row.index === TWO_RED_TOTAL_INDEX ? 'font-bold text-amber-200' : ''}>{label(row.index)}</span>
      ),
    },
    {
      key: 'n',
      label: t('analytics.r6.radar.twoRed.colN'),
      title: t('analytics.r6.radar.twoRed.colNHint'),
      align: 'right',
      format: (_v, row) => (
        <span className={`inline-flex flex-col items-end leading-tight ${row.mine.n < TWO_RED_MIN_N ? 'opacity-50' : ''}`}>
          <span className={row.index === TWO_RED_TOTAL_INDEX ? 'font-bold' : ''}>{row.mine.n}</span>
          <span className="text-[10px] font-normal text-zinc-500">{t('analytics.r6.radar.twoRed.refN', { label: refLabel, n: row.all.n })}</span>
        </span>
      ),
    },
    ...TWO_RED_CATEGORIES[round].map((key): StatColumn<Row> => ({
      key,
      label: t(`statTerms.${TWO_RED_TERMS[key]}.name`),
      term: TWO_RED_TERMS[key],
      align: 'right',
      className: 'whitespace-normal',
      tone: TWO_RED_TONES[key],
      format: shareCell(key),
    })),
  ];

  // 第 4 局要兩張失敗：全好＋只有莫德雷德＋只含一拇指 = 最多一個紅方 = 這支隊出任務一定成功。
  const tot = byIndex[TWO_RED_TOTAL_INDEX];
  const atMostOne = (c: TwoRedCounts): number => c.allGood + c.mordred + c.oneThumb;
  return (
    <div className="space-y-1">
    <StatTable
      caption={t('analytics.r6.radar.twoRed.roundCaption', { round })}
      columns={columns}
      rows={rows}
      rowKey={(row) => String(row.index)}
      highlightRow={(row) => row.index === TWO_RED_TOTAL_INDEX}
      footnote={t(round === 4 ? 'analytics.r6.radar.twoRed.round4Note' : 'analytics.r6.radar.twoRed.round35Note', { round })}
    />
    {round === 4 && (
      <p className={`px-1 text-xs text-zinc-400 ${tot.mine.n < TWO_RED_MIN_N ? 'opacity-50' : ''}`} data-testid="two-red-r4-safe">
        {t('analytics.r6.radar.twoRed.r4SafeRef', {
          pct: pct(atMostOne(tot.mine), tot.mine.n), k: atMostOne(tot.mine), n: tot.mine.n, all: pct(atMostOne(tot.all), tot.all.n), label: refLabel,
        })}
      </p>
    )}
    </div>
  );
}

export default function TwoRedPanel({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation('common');
  const state = useTwoRedReport(name);
  const report = state.status === 'ok' ? state.report : null;
  const cohort = useTwoRedCohort();
  const cuts = useCohortCuts((s) => s.cuts);
  const cohortData = cohort.status === 'ok' ? cohort.data : null;
  const myPr = cohortData ? cohortData.playerPr[name] ?? null : null;
  const tier: PlayerTierKey = playerTier(myPr, cuts);
  // 組的參考值不含這位玩家自己的提議（常當隊長的人在小組裡會占掉一大塊，等於跟自己比）；每次提議照當局的 PR 分組
  const tierTables = useMemo(
    () => (cohortData && tier !== 'unrated'
      ? twoRedTierTables(cohortData.proposals.filter((p) => p.player !== name), cuts)
      : null),
    [cohortData, cuts, tier, name],
  );
  const compareItems: SectionTabItem<CompareMode>[] = useMemo(() => [
    { id: 'group', label: t('analytics.r6.radar.twoRed.compare.group', { tier: t(`analytics.cohort.player.${tier}`) }), disabled: !tierTables },
    { id: 'all', label: t('analytics.r6.radar.twoRed.compare.all') },
  ], [t, tier, tierTables]);
  const [picked = 'group', setPicked] = useSectionTab(compareItems, { persistKey: 'analysis.players.twoRed.compare', defaultValue: 'group' });
  const mode: CompareMode = picked === 'group' && tierTables ? 'group' : 'all';
  const refLabel = mode === 'group' ? t(`analytics.cohort.player.${tier}`) : t('analytics.r6.radar.twoRed.compare.allShort');
  const openGroups = (): void => {
    useGameStore.setState({ gameState: 'analysis' });
    useDiscoveryNav.getState().openView('twoRedCohort');
    window.scrollTo({ top: 0 });
  };

  const roleTotals = useMemo(() => {
    const totals = {} as Record<TwoRedRole, number>;
    for (const role of TWO_RED_ROLES) {
      totals[role] = report ? TWO_RED_ROUNDS.reduce((s, r) => s + report.player[role][r][TWO_RED_TOTAL_INDEX].n, 0) : 0;
    }
    return totals;
  }, [report]);

  const tabs: SectionTabItem<TwoRedRole>[] = useMemo(() => TWO_RED_ROLES.map((role) => ({
    id: role,
    label: t(`analytics.r6.radar.twoRed.role.${role}`),
    badge: report ? t('analytics.r6.radar.twoRed.badge', { count: roleTotals[role] }) : undefined,
  })), [t, report, roleTotals]);

  if (state.status === 'error') {
    return (
      <div className="flex items-center justify-center gap-3 py-16 text-red-400">
        <AlertCircle size={20} /> {t('analytics.r6.radar.twoRed.error', { message: state.message })}
      </div>
    );
  }
  if (!report) {
    return (
      <div className="flex items-center justify-center gap-3 py-16 text-gray-400">
        <Loader size={20} className="animate-spin" /> {t('analytics.r6.radar.twoRed.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="two-red-panel">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400">
        <span className="text-sm font-bold text-zinc-200">{t('analytics.r6.radar.twoRed.title')}</span>
        <InfoTip title={t('analytics.r6.radar.twoRed.title')}>
          <p>{t('analytics.r6.radar.twoRed.help.when')}</p>
          <p>{t('analytics.r6.radar.twoRed.help.leader')}</p>
          <p>{t('analytics.r6.radar.twoRed.help.categories')}</p>
          <p>{t('analytics.r6.radar.twoRed.help.compare', { min: TWO_RED_MIN_N })}</p>
          <p>{t('analytics.r6.radar.twoRed.help.group')}</p>
          <p>{t('analytics.r6.radar.twoRed.help.scope')}</p>
        </InfoTip>
        <span>
          {t('analytics.r6.radar.twoRed.summary', {
            games: report.playerGames, twoRed: report.twoRedGames, skipped: report.skippedGames,
          })}
        </span>
      </div>
      <DecisivePlayerLine name={name} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400" data-testid="two-red-compare">
        <SectionTabs items={compareItems} value={mode} onChange={setPicked} size="sm" ariaLabel={t('analytics.r6.radar.twoRed.compare.label')} />
        <span>
          {cohortData && myPr !== null
            ? t('analytics.r6.radar.twoRed.compare.mine', {
              pr: myPr, tier: t(`analytics.cohort.player.${tier}`), range: t(`analytics.cohort.playerRange.${tier}`, { hi: cuts.prHi, lo: cuts.prLo, top: cuts.prHi - 1 }),
            })
            : cohortData ? t('analytics.r6.radar.twoRed.compare.noPr') : null}
        </span>
        <button type="button" onClick={openGroups} className="text-amber-300 underline-offset-2 hover:underline" data-testid="two-red-groups-link">
          {t('analytics.r6.radar.twoRed.compare.link')}
        </button>
      </div>
      <SectionTabs items={tabs} persistKey="analysis.players.twoRed" ariaLabel={t('analytics.r6.radar.twoRed.roleTabs')} size="sm">
        {(role) => (
          <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)_minmax(0,5fr)]">
            {TWO_RED_ROUNDS.map((round) => (
              <RoundTable
                key={round}
                round={round}
                mine={report.player[role][round]}
                all={mode === 'group' && tierTables ? tierTables.tables[tier][role][round] : report.all[role][round]}
                refLabel={refLabel}
              />
            ))}
          </div>
        )}
      </SectionTabs>
    </div>
  );
}
