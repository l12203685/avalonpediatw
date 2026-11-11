import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader, AlertCircle } from 'lucide-react';
import {
  TWO_RED_CATEGORIES, TWO_RED_ROLES, TWO_RED_ROUNDS, TWO_RED_TOTAL_INDEX, twoRedShare,
  type TwoRedCategory, type TwoRedCounts, type TwoRedReport, type TwoRedRole, type TwoRedRound,
} from '@avalon/shared/stats';
import { twoRedReport } from '../../../stats/statsEngine';
import { useStatsFilter } from '../../../stats/statsFilter';
import { InfoTip, SectionTabs, StatTable, type SectionTabItem, type StatColumn } from '../ui';
import { TWO_RED_MIN_N, TWO_RED_TERMS, TWO_RED_TONES } from './twoRedLayout';

/**
 * 玩家雷達 >「兩紅之後」小分頁（Edward 2026-11-11：「兩紅代表所有玩家都至少給過一次任務組合，並且湖中也至少使用過
 * 一次」）：這位玩家當梅林／派西維爾／忠臣隊長、紅方已經贏兩個任務時派出的隊，第 3、4、5 局各一張表，列 = 該局第
 * 1～4 次提議、尾派（第 5 次）與合計，欄 = 次數與各分類（互斥，每列加起來 100%）的比率與次數；每格下面小字是全體
 * （篩選範圍內所有隊長）同一格的比率。第 3、5 局：全好／全沒拇指但派到莫德雷德／派到至少一根拇指；第 4 局：全好／
 * 全沒拇指但派到莫德雷德／只含一拇指／含兩壞以上（2026-11-11 Edward 定案）。
 * 分類的定義與算法在 @avalon/shared stats/twoRed.ts；名詞與門檻在 twoRedLayout.ts（次數不到 TWO_RED_MIN_N 的列變淡）。
 * 跟著上方的篩選（統計 Worker 裡算，stats/statsEngine twoRedReport），不等雷達資料。
 */

interface Row {
  /** 0..4 = 第 1～4 次、尾派；5 = 合計。 */
  index: number;
  mine: TwoRedCounts;
  all: TwoRedCounts;
}

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

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v)}%`);

function RoundTable({ round, mine, all }: { round: TwoRedRound; mine: TwoRedCounts[]; all: TwoRedCounts[] }): JSX.Element {
  const { t } = useTranslation('common');
  const rows: Row[] = mine.map((m, index) => ({ index, mine: m, all: all[index] }));
  const label = (index: number): string => (index === TWO_RED_TOTAL_INDEX
    ? t('analytics.r6.radar.twoRed.total')
    : index === 4 ? t('analytics.r6.radar.twoRed.forced') : t('analytics.r6.radar.twoRed.attempt', { n: index + 1 }));

  const shareCell = (key: TwoRedCategory) => (_v: unknown, row: Row): ReactNode => {
    const low = row.mine.n < TWO_RED_MIN_N;
    const mineShare = twoRedShare(row.mine[key], row.mine.n);
    const allShare = twoRedShare(row.all[key], row.all.n);
    return (
      <span
        className={`inline-flex flex-col items-end leading-tight ${low ? 'opacity-50' : ''}`}
        title={t('analytics.r6.radar.twoRed.cellTitle', {
          k: row.mine[key], n: row.mine.n, allK: row.all[key], allN: row.all.n,
        }) + (low && row.mine.n > 0 ? ` · ${t('analytics.ui.table.lowSample', { min: TWO_RED_MIN_N })}` : '')}
      >
        <span>
          <span className={row.index === TWO_RED_TOTAL_INDEX ? 'font-bold' : 'font-semibold'}>{pct(mineShare)}</span>
          {row.mine.n > 0 && <span className="ml-1 text-[10px] font-normal text-zinc-500">{row.mine[key]}</span>}
        </span>
        <span className="text-[10px] font-normal text-zinc-500">{t('analytics.r6.radar.twoRed.allShort', { pct: pct(allShare) })}</span>
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
          <span className="text-[10px] font-normal text-zinc-500">{t('analytics.r6.radar.twoRed.allN', { n: row.all.n })}</span>
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

  return (
    <StatTable
      caption={t('analytics.r6.radar.twoRed.roundCaption', { round })}
      columns={columns}
      rows={rows}
      rowKey={(row) => String(row.index)}
      highlightRow={(row) => row.index === TWO_RED_TOTAL_INDEX}
      footnote={t(round === 4 ? 'analytics.r6.radar.twoRed.round4Note' : 'analytics.r6.radar.twoRed.round35Note', { round })}
    />
  );
}

export default function TwoRedPanel({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation('common');
  const state = useTwoRedReport(name);
  const report = state.status === 'ok' ? state.report : null;

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
          <p>{t('analytics.r6.radar.twoRed.help.scope')}</p>
        </InfoTip>
        <span>
          {t('analytics.r6.radar.twoRed.summary', {
            games: report.playerGames, twoRed: report.twoRedGames, skipped: report.skippedGames,
          })}
        </span>
      </div>
      <SectionTabs items={tabs} persistKey="analysis.players.twoRed" ariaLabel={t('analytics.r6.radar.twoRed.roleTabs')} size="sm">
        {(role) => (
          <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)_minmax(0,5fr)]">
            {TWO_RED_ROUNDS.map((round) => (
              <RoundTable key={round} round={round} mine={report.player[role][round]} all={report.all[role][round]} />
            ))}
          </div>
        )}
      </SectionTabs>
    </div>
  );
}
