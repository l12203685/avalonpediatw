import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader } from 'lucide-react';
import {
  DECISIVE_ABNORMAL, DECISIVE_GROUPS, DECISIVE_RANK_SCOPES, DECISIVE_ROLES, PLAYER_TIERS,
  decisiveCohortGrid, decisiveGridOf, sumDecisive,
  type CohortCell, type DecisiveCell, type DecisiveCohortData, type DecisiveGroup, type DecisiveRankScope, type DecisiveRole,
} from '@avalon/shared/stats';
import { useCohortCuts } from '../../../stats/cohortCuts';
import { InfoTip, SectionTabs, StatTable, Term, useSectionTab, type SectionTabItem, type StatColumn } from '../ui';
import { DECISIVE_COHORT_KIND_KEY, DECISIVE_COHORT_VIEW_KEY, DECISIVE_GROUP_TERMS, DECISIVE_ROLE_COLORS } from '../decisive/decisiveLayout';
import CohortGrid, { type CohortMeasure } from './CohortGrid';
import CohortCutsControl from './CohortCutsControl';
import OffTeamCohortPanel from './OffTeamCohortPanel';
import AbnormalCohortView from './AbnormalCohortView';
import { COHORT_MIN_N, K, cohortPct, playerTierKey } from './cohortFormat';
import { useDecisiveCohort } from './useCohortData';

/**
 * 數據排行「關鍵外白／內黑」的分組（Edward 2026-11-11：個人的關鍵票太少，改看 PR 分組／S × PR 九宮格），放在個人排行上面：
 *  - 票：關鍵票（決定了提議過不過的那一票）或全部投票（每一張藍方票，同樣的八格與對率）。全部投票的樣本大得多，
 *    個人的正確率也比較穩（每人的局隨機分兩半，200 種分法平均的兩半相關：全部投票約 0.2–0.4、關鍵票約 0；看分法與門檻會跳），所以兩種都給。
 *  - 表：強者／一般人／新手／全體 各一列：人數、票數、正確率、四組（場內白／場內黑／場外白／場外黑）的對率與對／錯張數（= 八格）。
 *  - 角色：全部／忠臣／派西維爾／梅林。
 *  - 九宮格：選一個對率，看（玩家分層 × 桌分層）。
 *  - (2026-11-12 Edward) 第二個小分頁「場外藍票」：不在隊上的藍方票的外白率／外黑率（依隊伍品質拆）與外白／外黑對率
 *    （OffTeamCohortPanel）；票的種類、角色、範圍、切點兩個小分頁共用。範圍的切換跟排行上面的範圍是同一個。
 *  - (2026-11-12 站長) 第三個小分頁「異常票（內黑／外白）」（AbnormalCohortView）：站長定義的情境、關鍵外白／關鍵內黑與正確與否，
 *    自己的資料（@avalon/shared abnormalVotes.ts）與自己的「全部／關鍵」切換；前兩個小分頁的「決定性票」（翻過來結果就改變）是另一種票。
 * 筆（依局、座位合起來）在 Worker 裡算好（@avalon/shared decisiveCohortData），切點換了只在這裡重數。
 */

type VoteKind = 'decisive' | 'all';
type RoleChoice = 'all' | DecisiveRole;
/** 小分頁：cells 八格對率（原本的）、offTeam 場外藍票的外白率／外黑率、abnormal 異常票（內黑／外白，站長的定義）。 */
type CohortView = 'cells' | 'offTeam' | 'abnormal';
const COHORT_VIEWS: readonly CohortView[] = ['cells', 'offTeam', 'abnormal'];
type DecisiveView = Exclude<CohortView, 'abnormal'>;

interface ScopeProps {
  scope: DecisiveRankScope;
  onScope: (scope: DecisiveRankScope) => void;
}

interface TierRow {
  tier: (typeof PLAYER_TIERS)[number] | 'all';
  cell: CohortCell;
}

const nonNeutral = (c: Pick<DecisiveCell, 'right' | 'wrong'>): number => c.right + c.wrong;

function RateCell({ cell, low }: { cell: DecisiveCell; low?: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const n = nonNeutral(cell);
  const faded = low ?? n < COHORT_MIN_N;
  return (
    <span
      className={`inline-flex flex-col items-end leading-tight ${faded ? 'opacity-50' : ''}`}
      title={t('analytics.decisive.cellTitle', { right: cell.right, wrong: cell.wrong, neutral: cell.neutral })}
    >
      <span className="font-semibold">{cohortPct(cell.right, n)}</span>
      <span className="text-[10px] font-normal text-zinc-500">{t('analytics.decisive.rightWrong', { right: cell.right, wrong: cell.wrong })}</span>
    </span>
  );
}

interface ViewProps {
  view: DecisiveView;
  viewTabs: ReactNode;
}

function Body({ data, scope, onScope, view, viewTabs }: { data: DecisiveCohortData } & ScopeProps & ViewProps): JSX.Element {
  const { t } = useTranslation('common');
  const cuts = useCohortCuts((s) => s.cuts);
  const scopeItems: SectionTabItem<DecisiveRankScope>[] = useMemo(() => DECISIVE_RANK_SCOPES.map((id) => ({
    id, label: t(`analytics.decisive.scope.${id}`),
  })), [t]);
  const kindItems: SectionTabItem<VoteKind>[] = useMemo(() => (['decisive', 'all'] as const).map((id) => ({
    id, label: t(`${K}.decisive.kind.${id}`),
  })), [t]);
  const [kind = 'decisive', setKind] = useSectionTab(kindItems, { persistKey: DECISIVE_COHORT_KIND_KEY });
  const [role, setRole] = useState<RoleChoice>('all');
  const [measure, setMeasure] = useState<string>('acc');
  const records = kind === 'all' ? data.all : data.decisive;
  const grid = useMemo(() => decisiveCohortGrid(records, cuts, role === 'all' ? null : role), [records, cuts, role]);
  const unit = t(`${K}.decisive.unit`);

  const rows: TierRow[] = [...PLAYER_TIERS.map((tier) => ({ tier, cell: grid.rows[tier] })), { tier: 'all' as const, cell: grid.all }];
  const columns: StatColumn<TierRow>[] = [
    {
      key: 'tier',
      label: t(`${K}.twoRed.colTier`),
      format: (_v, r) => <span className={r.tier === 'all' ? 'font-bold text-amber-200' : 'font-semibold'}>{t(playerTierKey(r.tier))}</span>,
    },
    {
      key: 'players',
      label: t(`${K}.decisive.colPlayers`),
      align: 'right',
      format: (_v, r) => r.cell.players,
    },
    {
      key: 'votes',
      label: t(`${K}.decisive.colVotes`),
      align: 'right',
      format: (_v, r): ReactNode => {
        const g = sumDecisive(decisiveGridOf(r.cell));
        return (
          <span title={t(`${K}.decisive.votesTitle`, { n: nonNeutral(g), neutral: g.neutral, games: r.cell.games })}>
            {nonNeutral(g)}
            {g.neutral > 0 && <span className="ml-1 text-[10px] font-normal text-zinc-500">+{g.neutral}</span>}
          </span>
        );
      },
    },
    {
      key: 'acc',
      label: <Term term={kind === 'all' ? 'allVoteAccuracy' : 'decisiveAccuracy'}>{t(`${K}.decisive.colAcc`)}</Term>,
      align: 'right',
      emphasis: true,
      tone: 'amber',
      format: (_v, r) => <RateCell cell={sumDecisive(decisiveGridOf(r.cell))} />,
    },
    ...DECISIVE_GROUPS.map((group): StatColumn<TierRow> => ({
      key: group,
      label: <Term term={DECISIVE_GROUP_TERMS[group]} className={DECISIVE_ABNORMAL.has(group) ? 'text-amber-200/90' : ''}>{t(`analytics.decisive.col.${group}`)}</Term>,
      align: 'right',
      className: DECISIVE_ABNORMAL.has(group) ? 'bg-amber-400/[0.06]' : undefined,
      format: (_v, r) => <RateCell cell={decisiveGridOf(r.cell)[group]} />,
    })),
  ];

  const ratioOf = (groups: readonly DecisiveGroup[]) => (cell: CohortCell): { k: number; n: number } => {
    const c = sumDecisive(decisiveGridOf(cell), groups);
    return { k: c.right, n: nonNeutral(c) };
  };
  const measures: CohortMeasure[] = [
    { id: 'acc', label: t(`${K}.decisive.colAcc`), ratio: ratioOf(DECISIVE_GROUPS) },
    ...DECISIVE_GROUPS.map((group) => ({ id: group, label: t(`analytics.decisive.col.${group}`), ratio: ratioOf([group]) })),
  ];
  const roleLabel = (r: RoleChoice): string => t(`analytics.decisive.roles.role.${r}`);

  const roleSelect: ReactNode = (
    <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
      {t(`${K}.decisive.role`)}
      <select
        className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100"
        value={role}
        onChange={(e) => setRole(e.target.value as RoleChoice)}
        data-testid="decisive-cohort-role"
      >
        {(['all', ...DECISIVE_ROLES] as RoleChoice[]).map((r) => (
          <option key={r} value={r} style={r !== 'all' ? { color: DECISIVE_ROLE_COLORS[r] } : undefined}>{roleLabel(r)}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2" data-testid="decisive-cohort">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-xs font-bold text-zinc-200">{t(`${K}.decisive.title`)}</h4>
        <InfoTip title={t(`${K}.decisive.title`)} testId="decisive-cohort-info">
          {view === 'offTeam' ? (
            <>
              <p>{t(`${K}.offTeam.help.what`)}</p>
              <p>{t(`${K}.offTeam.help.rate`)}</p>
              <p>{t(`${K}.offTeam.help.quality`)}</p>
              <p>{t(`${K}.offTeam.help.right`)}</p>
              <p>{t(`${K}.offTeam.help.decisive`)}</p>
            </>
          ) : (
            <>
              <p>{t(`${K}.decisive.help.what`)}</p>
              <p>{t(`${K}.decisive.help.all`)}</p>
            </>
          )}
          <p>{t(`${K}.decisive.help.tiers`)}</p>
          <p>{t(`${K}.help.causality`)}</p>
        </InfoTip>
        {viewTabs}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* 範圍小分頁只放在場外藍票：八格對率維持原樣，用排行上面的範圍 */}
        {view === 'offTeam' && (
          <SectionTabs items={scopeItems} value={scope} onChange={onScope} size="sm" ariaLabel={t('analytics.decisive.scopeLabel')} />
        )}
        <SectionTabs items={kindItems} value={kind} onChange={setKind} size="sm" ariaLabel={t(`${K}.decisive.kindLabel`)} />
        {roleSelect}
      </div>
      <p className="text-[11px] font-semibold text-amber-200/90" data-testid="decisive-cohort-note">{t(`${K}.decisive.reliableNote`)}</p>
      <CohortCutsControl histogram={data.histogram} />
      {view === 'offTeam' ? (
        <OffTeamCohortPanel
          records={records}
          cuts={cuts}
          role={role === 'all' ? null : role}
          kindLabel={t(`${K}.decisive.kind.${kind}`)}
          scopeLabel={t(`analytics.decisive.scope.${scope}`)}
          roleLabel={roleLabel(role)}
        />
      ) : (
        <>
          <StatTable columns={columns} rows={rows} rowKey={(r) => r.tier} highlightRow={(r) => r.tier === 'all'} />
          <p className="text-[11px] text-zinc-500">
            {t(`${K}.decisive.unrated`, { n: nonNeutral(sumDecisive(decisiveGridOf(grid.rows.unrated))) })}
          </p>
          <CohortGrid
            grid={grid}
            measures={measures}
            measure={measure}
            onMeasure={setMeasure}
            unit={unit}
            caption={t(`${K}.decisive.gridCaption`, { kind: t(`${K}.decisive.kind.${kind}`), role: roleLabel(role) })}
            help={(
              <>
                <p>{t(`${K}.help.grid`)}</p>
                <p>{t(`${K}.decisive.help.gridN`)}</p>
                <p>{t(`${K}.help.causality`)}</p>
              </>
            )}
            testId="decisive-cohort-grid"
          />
        </>
      )}
    </section>
  );
}

/** 八格對率／場外藍票（決定性票與全部投票）：跟著排行的範圍。算不出來時不顯示（不擋排行）。 */
function DecisiveCohortSection({ scope, onScope, view, viewTabs }: ScopeProps & ViewProps): JSX.Element | null {
  const { t } = useTranslation('common');
  const state = useDecisiveCohort(scope);
  if (state.status === 'error') return null;
  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-gray-400">
        <Loader size={14} className="animate-spin" /> {t(`${K}.loading`)}
      </div>
    );
  }
  return <Body data={state.data} scope={scope} onScope={onScope} view={view} viewTabs={viewTabs} />;
}

/** 個人排行上面的分組區塊：三個小分頁（八格對率、場外藍票、異常票）。 */
export default function DecisiveCohortView({ scope, onScope }: ScopeProps): JSX.Element | null {
  const { t } = useTranslation('common');
  const viewItems: SectionTabItem<CohortView>[] = useMemo(() => COHORT_VIEWS.map((id) => ({
    id, label: t(`${K}.decisive.view.${id}`),
  })), [t]);
  const [view = 'cells', setView] = useSectionTab(viewItems, { persistKey: DECISIVE_COHORT_VIEW_KEY });
  const viewTabs = <SectionTabs items={viewItems} value={view} onChange={setView} size="sm" ariaLabel={t(`${K}.decisive.viewLabel`)} />;
  if (view === 'abnormal') return <AbnormalCohortView viewTabs={viewTabs} />;
  return <DecisiveCohortSection scope={scope} onScope={onScope} view={view} viewTabs={viewTabs} />;
}
