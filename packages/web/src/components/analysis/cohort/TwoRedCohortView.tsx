import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader } from 'lucide-react';
import {
  PLAYER_TIERS, TWO_RED_CATEGORIES, TWO_RED_CATEGORY_ORDER, TWO_RED_R4_SAFE, TWO_RED_ROLES, TWO_RED_ROUNDS,
  TWO_RED_TOTAL_INDEX, cohortSum, twoRedCohortGrid, twoRedTierTables,
  type TwoRedCategory, type TwoRedCohortCounts, type TwoRedCohortData, type TwoRedRole, type TwoRedRound, type TwoRedTierKey,
} from '@avalon/shared/stats';
import { useCohortCuts } from '../../../stats/cohortCuts';
import { InfoTip, SectionTabs, StatTable, useSectionTab, type SectionTabItem, type StatColumn } from '../ui';
import { TWO_RED_TERMS, TWO_RED_TONES } from '../radar/twoRedLayout';
import CohortGrid, { type CohortMeasure } from './CohortGrid';
import CohortCutsControl from './CohortCutsControl';
import { COHORT_MIN_N, K, cohortPct, playerTierKey } from './cohortFormat';
import { useTwoRedCohort } from './useCohortData';

/**
 * 數據分析 > 陣容強度 >「兩紅派隊分組」（Edward 2026-11-11：每位玩家的提議太少，改看 PR 分組；樣本太小就合併成組，
 * 或切 S × PR 九宮格）：玩家雷達「兩紅之後的派隊」同一批提議（@avalon/shared twoRed.ts），依隊長那一局開打前的 PR 分
 * 強者／一般人／新手（＋全體），每一局一張表；下面是選定的分類在（玩家分層 × 桌分層）九宮格裡的比率。
 * 切點（cohortCuts）換了只在主執行緒重數，不用回 Worker。分組的算法在 twoRedTierTables / twoRedCohortGrid（同一個
 * cohortGrid，表與九宮格的合計一定對得上）。
 */

type SlotId = 'total' | '1' | '2' | '3' | '4' | '5';
const SLOT_IDS: readonly SlotId[] = ['total', '1', '2', '3', '4', '5'];
const slotIndex = (slot: SlotId): number => (slot === 'total' ? TWO_RED_TOTAL_INDEX : Number(slot) - 1);
const ROW_TIERS: readonly TwoRedTierKey[] = [...PLAYER_TIERS, 'all'];

/** 一局的欄：分類＋第 4 局的「最多一個紅方」。 */
type ColumnId = TwoRedCategory | 'r4Safe';
const columnsOf = (round: TwoRedRound): ColumnId[] => (round === 4 ? [...TWO_RED_CATEGORIES[4], 'r4Safe'] : [...TWO_RED_CATEGORIES[round]]);
const hits = (c: TwoRedCohortCounts, col: ColumnId): number => (col === 'r4Safe' ? TWO_RED_R4_SAFE.reduce((s, k) => s + c[k], 0) : c[col]);

interface TierRow {
  tier: TwoRedTierKey;
  c: TwoRedCohortCounts;
}

function useColumnLabel(): (col: ColumnId) => string {
  const { t } = useTranslation('common');
  return (col) => (col === 'r4Safe' ? t(`${K}.twoRed.r4Safe`) : t(`statTerms.${TWO_RED_TERMS[col]}.name`));
}

function TierRoundTable({ round, rows }: { round: TwoRedRound; rows: TierRow[] }): JSX.Element {
  const { t } = useTranslation('common');
  const label = useColumnLabel();
  const columns: StatColumn<TierRow>[] = [
    {
      key: 'tier',
      label: t(`${K}.twoRed.colTier`),
      format: (_v, r) => <span className={r.tier === 'all' ? 'font-bold text-amber-200' : 'font-semibold'}>{t(playerTierKey(r.tier))}</span>,
    },
    {
      key: 'n',
      label: t(`${K}.twoRed.colN`),
      align: 'right',
      format: (_v, r) => (
        <span className={`inline-flex flex-col items-end leading-tight ${r.c.n < COHORT_MIN_N ? 'opacity-50' : ''}`}>
          <span>{r.c.n}</span>
          <span className="text-[10px] font-normal text-zinc-500">{t(`${K}.cellPlayers`, { count: r.c.players })}</span>
        </span>
      ),
    },
    ...columnsOf(round).map((col): StatColumn<TierRow> => ({
      key: col,
      label: label(col),
      term: col === 'r4Safe' ? undefined : TWO_RED_TERMS[col],
      title: col === 'r4Safe' ? t(`${K}.twoRed.r4SafeHint`) : undefined,
      align: 'right',
      className: 'whitespace-normal',
      tone: col === 'r4Safe' ? 'blue' : TWO_RED_TONES[col],
      format: (_v, r): ReactNode => {
        const k = hits(r.c, col);
        const low = r.c.n < COHORT_MIN_N;
        return (
          <span
            className={`inline-flex flex-col items-end leading-tight ${low ? 'opacity-50' : ''}`}
            title={t(`${K}.twoRed.tableCellTitle`, { k, n: r.c.n, players: r.c.players, pct: cohortPct(k, r.c.n, 1) })}
          >
            <span className={r.tier === 'all' ? 'font-bold' : 'font-semibold'}>{cohortPct(k, r.c.n)}</span>
            {r.c.n > 0 && <span className="text-[10px] font-normal text-zinc-500">{k}</span>}
          </span>
        );
      },
    })),
  ];
  return (
    <StatTable
      caption={t('analytics.r6.radar.twoRed.roundCaption', { round })}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.tier}
      highlightRow={(r) => r.tier === 'all'}
      footnote={t(round === 4 ? 'analytics.r6.radar.twoRed.round4Note' : 'analytics.r6.radar.twoRed.round35Note', { round })}
    />
  );
}

function Body({ data }: { data: TwoRedCohortData }): JSX.Element {
  const { t } = useTranslation('common');
  const label = useColumnLabel();
  const cuts = useCohortCuts((s) => s.cuts);
  const roleItems: SectionTabItem<TwoRedRole>[] = useMemo(() => TWO_RED_ROLES.map((role) => ({
    id: role, label: t(`analytics.r6.radar.twoRed.role.${role}`),
  })), [t]);
  const [role = '忠臣', setRole] = useSectionTab(roleItems, { persistKey: 'analysis.cohort.twoRed.role', defaultValue: '忠臣' });
  const [slot, setSlot] = useState<SlotId>('total');
  const [gridRound, setGridRound] = useState<TwoRedRound>(3);
  const [measure, setMeasure] = useState<string>('allGood');
  const tiers = useMemo(() => twoRedTierTables(data.proposals, cuts), [data, cuts]);
  const grid = useMemo(
    () => twoRedCohortGrid(data.proposals, cuts, { role, round: gridRound, slot: slot === 'total' ? 'total' : Number(slot) }),
    [data, cuts, role, gridRound, slot],
  );
  const measures: CohortMeasure[] = columnsOf(gridRound).map((col) => ({
    id: col,
    label: label(col),
    ratio: (cell) => ({
      k: cohortSum(cell, (col === 'r4Safe' ? TWO_RED_R4_SAFE : [col]).map((c) => TWO_RED_CATEGORY_ORDER.indexOf(c))),
      n: cell.n,
    }),
  }));
  const measureId = measures.some((m) => m.id === measure) ? measure : measures[0].id;
  const slotLabel = (s: SlotId): string => (s === 'total'
    ? t('analytics.r6.radar.twoRed.total')
    : s === '5' ? t('analytics.r6.radar.twoRed.forced') : t('analytics.r6.radar.twoRed.attempt', { n: Number(s) }));

  const summary: ReactNode = (
    <span data-testid="two-red-cohort-summary">
      {[...PLAYER_TIERS, 'unrated' as const].map((tier) => t(`${K}.twoRed.tierSummary`, {
        tier: t(playerTierKey(tier)), players: tiers.players[tier], n: tiers.proposals[tier],
      })).join(' · ')}
    </span>
  );

  return (
    <div className="space-y-3" data-testid="two-red-cohort">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-sm font-bold text-zinc-100">{t(`${K}.twoRed.title`)}</h4>
        <InfoTip title={t(`${K}.twoRed.title`)} testId="two-red-cohort-info">
          <p>{t(`${K}.twoRed.help.what`)}</p>
          <p>{t('analytics.r6.radar.twoRed.help.categories')}</p>
          <p>{t(`${K}.twoRed.help.tiers`)}</p>
          <p>{t(`${K}.help.causality`)}</p>
          <p>{t(`${K}.twoRed.help.radar`)}</p>
        </InfoTip>
        <span className="text-xs text-zinc-400">
          {t(`${K}.twoRed.scope`, { games: data.twoRedGames, skipped: data.skippedGames, n: tiers.proposals.all })}
        </span>
      </div>
      <p className="text-[11px] text-zinc-400">{t(`${K}.note`)}</p>
      <CohortCutsControl histogram={data.histogram} />
      <div className="text-[11px] text-zinc-400">{summary}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SectionTabs items={roleItems} value={role} onChange={setRole} size="sm" ariaLabel={t('analytics.r6.radar.twoRed.roleTabs')} />
        <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
          {t(`${K}.twoRed.slot`)}
          <select
            className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100"
            value={slot}
            onChange={(e) => setSlot(e.target.value as SlotId)}
            data-testid="two-red-cohort-slot"
          >
            {SLOT_IDS.map((s) => <option key={s} value={s}>{slotLabel(s)}</option>)}
          </select>
        </label>
      </div>
      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)_minmax(0,5fr)]">
        {TWO_RED_ROUNDS.map((round) => (
          <TierRoundTable
            key={round}
            round={round}
            rows={ROW_TIERS.map((tier) => ({ tier, c: tiers.tables[tier][role][round][slotIndex(slot)] }))}
          />
        ))}
      </div>
      <CohortGrid
        grid={grid}
        measures={measures}
        measure={measureId}
        onMeasure={setMeasure}
        unit={t(`${K}.twoRed.unit`)}
        caption={t(`${K}.twoRed.gridCaption`, {
          round: gridRound, role: t(`analytics.r6.radar.twoRed.role.${role}`), slot: slotLabel(slot),
        })}
        help={(
          <>
            <p>{t(`${K}.help.grid`)}</p>
            <p>{t(`${K}.help.causality`)}</p>
          </>
        )}
        controls={(
          <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
            {t(`${K}.twoRed.round`)}
            <select
              className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100"
              value={gridRound}
              onChange={(e) => setGridRound(Number(e.target.value) as TwoRedRound)}
              data-testid="two-red-cohort-round"
            >
              {TWO_RED_ROUNDS.map((r) => <option key={r} value={r}>{t(`${K}.twoRed.roundN`, { round: r })}</option>)}
            </select>
          </label>
        )}
        testId="two-red-cohort-grid"
      />
    </div>
  );
}

export default function TwoRedCohortView(): JSX.Element {
  const { t } = useTranslation('common');
  const state = useTwoRedCohort();
  if (state.status === 'error') {
    return (
      <div className="flex items-center justify-center gap-3 py-12 text-red-400">
        <AlertCircle size={20} /> {t('analytics.r6.radar.twoRed.error', { message: state.message })}
      </div>
    );
  }
  if (state.status === 'loading') {
    return (
      <div className="flex items-center justify-center gap-3 py-12 text-gray-400">
        <Loader size={20} className="animate-spin" /> {t('analytics.r6.radar.twoRed.loading')}
      </div>
    );
  }
  return <Body data={state.data} />;
}
