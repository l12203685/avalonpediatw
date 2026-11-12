import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  OFF_TEAM_MEASURES, PLAYER_TIERS,
  offTeamCohortGrid, offTeamCounts, offTeamRatio,
  type CohortCell, type CohortCuts, type DecisiveRole, type DecisiveSeatRecord, type OffTeamMeasure,
} from '@avalon/shared/stats';
import { StatTable, type StatColumn } from '../ui';
import CohortGrid, { type CohortMeasure } from './CohortGrid';
import { COHORT_MIN_N, K, cohortPct, playerTierKey } from './cohortFormat';

/**
 * 「關鍵外白／內黑」分組的第二個小分頁：場外藍票的外白率／外黑率（Edward 2026-11-12：「玩家程度 × 強度組成 × 不同角色 ×
 * 外黑率／外白率 × 是否關鍵（也一樣分兩紅／第 3～5 局）」）。只看不在提議的隊上的藍方票（第 1～4 次提議）：
 *  - 表：強者／一般人／新手／全體 各一列：場外票數、外白率、依隊伍品質拆的外白率（全好／會失敗／第 4 局單紅）、外白對率、外黑對率。
 *    外黑率 = 100% − 外白率（每一欄都是），所以表只寫外白，九宮格可以選外黑。
 *  - 九宮格：選一個指標（外白率、外黑率、各品質的外白率／外黑率、外白對率、外黑對率），看（玩家分層 × 桌分層）。
 * 票的種類（關鍵票／全部投票）、角色、範圍、切點由上一層（DecisiveCohortView）給；算法在 @avalon/shared decisiveVotes.ts offTeam*。
 */

interface TierRow {
  tier: (typeof PLAYER_TIERS)[number] | 'all';
  cell: CohortCell;
}

const ratioOf = (measure: OffTeamMeasure) => (cell: Pick<CohortCell, 'counts'>): { k: number; n: number } =>
  offTeamRatio(offTeamCounts(cell), measure);

function PctCell({ k, n }: { k: number; n: number }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <span
      className={`inline-flex flex-col items-end leading-tight ${n < COHORT_MIN_N ? 'opacity-50' : ''}`}
      title={t(`${K}.offTeam.cellTitle`, { k, n })}
    >
      <span className="font-semibold">{cohortPct(k, n)}</span>
      <span className="text-[10px] font-normal text-zinc-500">{t(`${K}.offTeam.kOfN`, { k, n })}</span>
    </span>
  );
}

export interface OffTeamCohortPanelProps {
  records: readonly DecisiveSeatRecord[];
  cuts: CohortCuts;
  role: DecisiveRole | null;
  /** 九宮格標題用：票的種類、範圍、角色的文字。 */
  kindLabel: string;
  scopeLabel: string;
  roleLabel: string;
}

export default function OffTeamCohortPanel({ records, cuts, role, kindLabel, scopeLabel, roleLabel }: OffTeamCohortPanelProps): JSX.Element {
  const { t } = useTranslation('common');
  const [measure, setMeasure] = useState<OffTeamMeasure>('yes');
  // 表：全部場外票（任何一個指標的分母都在裡面）
  const table = useMemo(() => offTeamCohortGrid(records, cuts, 'yes', role), [records, cuts, role]);
  // 九宮格：只留這個指標分母 > 0 的筆，格子上的人數 = 真的有票算進這個比率的人
  const grid = useMemo(() => offTeamCohortGrid(records, cuts, measure, role), [records, cuts, measure, role]);
  const unit = t(`${K}.decisive.unit`);
  const label = (m: OffTeamMeasure): string => t(`${K}.offTeam.measure.${m}`);

  const rows: TierRow[] = [...PLAYER_TIERS.map((tier) => ({ tier, cell: table.rows[tier] })), { tier: 'all' as const, cell: table.all }];
  const pctColumn = (m: OffTeamMeasure, head: ReactNode, emphasis = false): StatColumn<TierRow> => ({
    key: m,
    label: head,
    align: 'right',
    emphasis,
    tone: emphasis ? 'amber' : undefined,
    format: (_v, r) => <PctCell {...ratioOf(m)(r.cell)} />,
  });
  const columns: StatColumn<TierRow>[] = [
    {
      key: 'tier',
      label: t(`${K}.twoRed.colTier`),
      format: (_v, r) => <span className={r.tier === 'all' ? 'font-bold text-amber-200' : 'font-semibold'}>{t(playerTierKey(r.tier))}</span>,
    },
    { key: 'players', label: t(`${K}.decisive.colPlayers`), align: 'right', format: (_v, r) => r.cell.players },
    { key: 'votes', label: t(`${K}.offTeam.colVotes`), align: 'right', format: (_v, r) => ratioOf('yes')(r.cell).n },
    pctColumn('yes', t(`${K}.offTeam.col.yes`), true),
    pctColumn('yesGood', t(`${K}.offTeam.col.yesGood`)),
    pctColumn('yesBad', t(`${K}.offTeam.col.yesBad`)),
    pctColumn('yesNeutral', t(`${K}.offTeam.col.yesNeutral`)),
    pctColumn('yesRight', t(`${K}.offTeam.col.yesRight`)),
    pctColumn('noRight', t(`${K}.offTeam.col.noRight`)),
  ];

  const measures: CohortMeasure[] = OFF_TEAM_MEASURES.map((m) => ({ id: m, label: label(m), ratio: ratioOf(m) }));

  return (
    <div className="space-y-2" data-testid="offteam-cohort">
      <p className="text-[11px] text-zinc-400" data-testid="offteam-cohort-note">{t(`${K}.offTeam.note`)}</p>
      <StatTable columns={columns} rows={rows} rowKey={(r) => r.tier} highlightRow={(r) => r.tier === 'all'} />
      <p className="text-[11px] text-zinc-500">{t(`${K}.offTeam.tableNote`, { n: ratioOf('yes')(table.rows.unrated).n })}</p>
      <CohortGrid
        grid={grid}
        measures={measures}
        measure={measure}
        onMeasure={(id) => setMeasure(id as OffTeamMeasure)}
        unit={unit}
        caption={t(`${K}.offTeam.gridCaption`, { kind: kindLabel, scope: scopeLabel, role: roleLabel })}
        help={(
          <>
            <p>{t(`${K}.help.grid`)}</p>
            <p>{t(`${K}.offTeam.help.gridN`)}</p>
            <p>{t(`${K}.help.causality`)}</p>
          </>
        )}
        testId="offteam-cohort-grid"
      />
    </div>
  );
}
