import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader } from 'lucide-react';
import {
  ABNORMAL_MEASURES, ABNORMAL_MODES, ABNORMAL_ROLES, ABNORMAL_SITUATIONS,
  abnormalCohortGrid, abnormalCounts, abnormalRatio, abnormalRecords, sumAbnormal,
  type AbnormalCohortData, type AbnormalCounts, type AbnormalMeasure, type AbnormalMode, type AbnormalRole, type AbnormalSituation,
  type CohortCell,
} from '@avalon/shared/stats';
import { useCohortCuts } from '../../../stats/cohortCuts';
import { InfoTip, SectionTabs, StatTable, useSectionTab, type SectionTabItem, type StatColumn } from '../ui';
import { ABNORMAL_MODE_KEY, DECISIVE_ROLE_COLORS } from '../decisive/decisiveLayout';
import CohortGrid, { type CohortMeasure } from './CohortGrid';
import CohortCutsControl from './CohortCutsControl';
import { COHORT_MIN_N, K, cohortPct } from './cohortFormat';
import { useAbnormalCohort } from './useCohortData';

/**
 * 數據排行「關鍵外白／內黑」分組的小分頁「異常票（內黑／外白）」（站長 2026-11-12 的定義，算法在 @avalon/shared abnormalVotes.ts）：
 *  - 表：列 = 情境（兩紅之後、第三局・兩紅、第三局・一藍一紅、第四局・兩紅、第五局），欄 = 內黑率、內黑正確率、外白率、外白正確率
 *    （每格附 張數／分母）；切「關鍵」時四欄換成 關鍵內黑率（每次機會）、關鍵內黑正確率、關鍵外白率、關鍵外白正確率。
 *  - 全部／關鍵、角色（全部／忠臣／派西維爾／梅林）、切點（強者／一般人／新手、高端／普通／歡樂）。
 *  - 九宮格：選一個情境與一個指標，看（玩家分層 × 桌分層）。
 * 筆（依局、座位、情境合起來）在 Worker 裡算好（stats/statsEngine abnormalCohort），這裡只依切點重數。
 */

const C = `${K}.abnormal`;
type RoleChoice = 'all' | AbnormalRole;

interface Row {
  situation: AbnormalSituation;
  counts: AbnormalCounts;
}

function PctCell({ counts, measure, mode }: { counts: AbnormalCounts; measure: AbnormalMeasure; mode: AbnormalMode }): JSX.Element {
  const { t } = useTranslation('common');
  const { k, n } = abnormalRatio(counts, measure, mode);
  return (
    <span
      className={`inline-flex flex-col items-end leading-tight ${n < COHORT_MIN_N ? 'opacity-50' : ''}`}
      title={t(`${C}.cellTitle.${mode}.${measure}`, { k, n })}
    >
      <span className="font-semibold">{cohortPct(k, n)}</span>
      <span className="text-[10px] font-normal text-zinc-500">{t(`${C}.kOfN`, { k, n })}</span>
    </span>
  );
}

function Body({ data, viewTabs }: { data: AbnormalCohortData; viewTabs: ReactNode }): JSX.Element {
  const { t } = useTranslation('common');
  const cuts = useCohortCuts((s) => s.cuts);
  const modeItems: SectionTabItem<AbnormalMode>[] = useMemo(() => ABNORMAL_MODES.map((id) => ({ id, label: t(`${C}.mode.${id}`) })), [t]);
  const [mode = 'all', setMode] = useSectionTab(modeItems, { persistKey: ABNORMAL_MODE_KEY, defaultValue: 'all' });
  const [role, setRole] = useState<RoleChoice>('all');
  const [situation, setSituation] = useState<AbnormalSituation>('twoRed');
  const [measure, setMeasure] = useState<AbnormalMeasure>('inBlack');
  const roleKey = role === 'all' ? null : role;
  const roleLabel = (r: RoleChoice): string => t(`analytics.decisive.roles.role.${r}`);
  const situationLabel = (s: AbnormalSituation): string => t(`${C}.situation.${s}`);
  const measureLabel = (m: AbnormalMeasure): string => t(`${C}.measure.${mode}.${m}`);

  const rows: Row[] = useMemo(() => ABNORMAL_SITUATIONS.map((s) => ({
    situation: s, counts: sumAbnormal(abnormalRecords(data.records, s, roleKey)),
  })), [data.records, roleKey]);
  const grid = useMemo(
    () => abnormalCohortGrid(data.records, cuts, situation, measure, mode, roleKey),
    [data.records, cuts, situation, measure, mode, roleKey],
  );
  // 座位當時沒有 PR 的票（只算在全體）：選的情境與指標，跟九宮格一樣數這個指標的分母
  const unrated = abnormalRatio(abnormalCounts(grid.rows.unrated), measure, mode).n;

  const pctColumn = (m: AbnormalMeasure): StatColumn<Row> => ({
    key: m,
    // 表頭可以換行：手機上四個指標欄才擠得進來
    label: <span className="inline-block max-w-[4.5rem] whitespace-normal leading-tight">{measureLabel(m)}</span>,
    align: 'right',
    emphasis: m === 'inBlack' || m === 'outWhite',
    tone: m === 'inBlack' || m === 'outWhite' ? 'amber' : undefined,
    className: m.startsWith('inBlack') ? 'bg-amber-400/[0.06]' : undefined,
    format: (_v, r) => <PctCell counts={r.counts} measure={m} mode={mode} />,
  });
  const columns: StatColumn<Row>[] = [
    {
      key: 'situation',
      label: t(`${C}.colSituation`),
      format: (_v, r) => (
        <span className={`inline-block max-w-[6.5rem] whitespace-normal leading-tight ${r.situation === 'twoRed' ? 'font-bold text-amber-200' : 'pl-2 font-semibold text-zinc-200'}`}>
          {situationLabel(r.situation)}
        </span>
      ),
    },
    {
      key: 'proposals',
      label: t(`${C}.colProposals`),
      align: 'right',
      // 手機隱藏：讓四個指標欄擠得進 390 px
      className: 'hidden sm:table-cell',
      format: (_v, r) => <span className="text-zinc-400">{data.proposals[r.situation]}</span>,
    },
    ...ABNORMAL_MEASURES.map(pctColumn),
  ];

  const measures: CohortMeasure[] = ABNORMAL_MEASURES.map((m) => ({
    id: m,
    label: measureLabel(m),
    ratio: (cell: CohortCell) => abnormalRatio(abnormalCounts(cell), m, mode),
  }));

  const roleSelect: ReactNode = (
    <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
      {t(`${K}.decisive.role`)}
      <select
        className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100"
        value={role}
        onChange={(e) => setRole(e.target.value as RoleChoice)}
        data-testid="abnormal-cohort-role"
      >
        {(['all', ...ABNORMAL_ROLES] as RoleChoice[]).map((r) => (
          <option key={r} value={r} style={r !== 'all' ? { color: DECISIVE_ROLE_COLORS[r] } : undefined}>{roleLabel(r)}</option>
        ))}
      </select>
    </label>
  );
  const situationSelect: ReactNode = (
    <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
      {t(`${C}.colSituation`)}
      <select
        className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100"
        value={situation}
        onChange={(e) => setSituation(e.target.value as AbnormalSituation)}
        data-testid="abnormal-grid-situation"
      >
        {ABNORMAL_SITUATIONS.map((s) => <option key={s} value={s}>{situationLabel(s)}</option>)}
      </select>
    </label>
  );

  return (
    <section className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2" data-testid="abnormal-cohort">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-xs font-bold text-zinc-200">{t(`${K}.decisive.title`)}</h4>
        <InfoTip title={t(`${C}.title`)} testId="abnormal-cohort-info">
          <p>{t(`${C}.help.what`)}</p>
          <p>{t(`${C}.help.situation`)}</p>
          <p>{t(`${C}.help.all`)}</p>
          <p>{t(`${C}.help.key`)}</p>
          <p>{t(`${C}.help.right`)}</p>
          <p>{t(`${C}.help.notFlip`)}</p>
          <p>{t(`${C}.help.data`)}</p>
          <p>{t(`${K}.decisive.help.tiers`)}</p>
          <p>{t(`${K}.help.causality`)}</p>
        </InfoTip>
        {viewTabs}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SectionTabs items={modeItems} value={mode} onChange={setMode} size="sm" ariaLabel={t(`${C}.modeLabel`)} />
        {roleSelect}
      </div>
      <p className="text-[11px] text-zinc-400" data-testid="abnormal-cohort-note">{t(`${C}.note.${mode}`)}</p>
      <CohortCutsControl histogram={data.histogram} />
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.situation}
        highlightRow={(r) => r.situation === situation}
        onRowClick={(r) => setSituation(r.situation)}
        caption={<span className="text-[11px] text-zinc-500">{t(`${C}.tableCaption`, { mode: t(`${C}.mode.${mode}`), role: roleLabel(role) })}</span>}
      />
      <p className="text-[11px] text-zinc-500" data-testid="abnormal-cohort-unrated">
        {t(`${C}.unrated`, { n: unrated, situation: situationLabel(situation), measure: measureLabel(measure) })}
        {' '}
        {t(`${C}.dropped`, { n: data.inconsistent[situation], situation: situationLabel(situation) })}
      </p>
      <CohortGrid
        grid={grid}
        measures={measures}
        measure={measure}
        onMeasure={(id) => setMeasure(id as AbnormalMeasure)}
        controls={situationSelect}
        unit={t(`${K}.decisive.unit`)}
        caption={t(`${C}.gridCaption`, { situation: situationLabel(situation), mode: t(`${C}.mode.${mode}`), role: roleLabel(role) })}
        help={(
          <>
            <p>{t(`${K}.help.grid`)}</p>
            <p>{t(`${C}.help.gridN`)}</p>
            <p>{t(`${K}.help.causality`)}</p>
          </>
        )}
        testId="abnormal-cohort-grid"
      />
    </section>
  );
}

/** 「異常票（內黑／外白）」小分頁（viewTabs = 上一層的小分頁切換）。算不出來時只留小分頁切換與一行錯誤。 */
export default function AbnormalCohortView({ viewTabs }: { viewTabs: ReactNode }): JSX.Element {
  const { t } = useTranslation('common');
  const state = useAbnormalCohort();
  if (state.status !== 'ok') {
    return (
      <section className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2" data-testid="abnormal-cohort">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="text-xs font-bold text-zinc-200">{t(`${K}.decisive.title`)}</h4>
          {viewTabs}
        </div>
        {state.status === 'loading' ? (
          <div className="flex items-center gap-2 py-3 text-xs text-gray-400">
            <Loader size={14} className="animate-spin" /> {t(`${K}.loading`)}
          </div>
        ) : (
          <p className="text-xs text-red-300">{t('analytics.decisive.error', { message: state.message })}</p>
        )}
      </section>
    );
  }
  return <Body data={state.data} viewTabs={viewTabs} />;
}
