import { Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { outcomeBlocks, roleFaction, theorySettings, type OutcomeCounts } from '../../services/api';
import { useAnalysisOverview } from './useAnalysisOverview';
import { ROLE_ORDER, seatFactionCounts } from './seatRoleBlocks';
import {
  SectionTabs, StatTable, formatRate, type MetricBlockKey, type SectionTabItem, type StatColumn,
} from './ui';

/**
 * 位置 × 角色 (2026-10-14 Edward：「角色勝率分三塊」「用條件機率」「能用表格就不用圖」)。
 *
 * 舊版位置勝率圖的 tooltip 裡藏著「各角色在這個位置的勝率」(任務結算口徑)。現在攤成一張表：
 * 列 = 位置 (最後一列 = 全部位置)，欄 = 七個角色，每格 = 這個角色坐這個位置時「自己陣營」在選定那一塊的
 * 勝率 + n。三塊用上方的小分頁切換 (任務結果 / 刺殺結果 / 遊戲結果)；刺殺的 n 只算打到三藍的局。
 * 每欄最高的位置加粗。資料 = overview.seatPositionWinRates[].roles[].outcomes，比率由 outcomeBlocks 算。
 */

interface SeatRoleRow {
  key: string;
  label: string;
  total: boolean;
  roles: Record<string, OutcomeCounts>;
}

const BLOCKS: readonly MetricBlockKey[] = ['mission', 'assassination', 'final'];

function addCounts(a: OutcomeCounts | undefined, b: OutcomeCounts): OutcomeCounts {
  return {
    三紅: (a?.三紅 ?? 0) + b.三紅,
    三藍死: (a?.三藍死 ?? 0) + b.三藍死,
    三藍活: (a?.三藍活 ?? 0) + b.三藍活,
  };
}

export default function SeatRoleTable(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }
  const seats = seatFactionCounts(overview);
  if (!seats) {
    return <p className="py-6 text-center text-xs text-zinc-500">{error ?? t('analytics.r6.tabsb.pendingUpdate')}</p>;
  }
  const minCell = theorySettings(overview?.theoryConfig).theoryMinCellGames;

  const allSeats: Record<string, OutcomeCounts> = {};
  for (const s of seats) {
    for (const [role, c] of Object.entries(s.roles)) allSeats[role] = addCounts(allSeats[role], c);
  }
  const roles = [
    ...ROLE_ORDER.filter(r => allSeats[r]),
    ...Object.keys(allSeats).filter(r => !ROLE_ORDER.includes(r)),
  ];
  const rows: SeatRoleRow[] = [
    ...seats.map(s => ({ key: s.seat, label: t('analytics.r6.tabsb.seats.seatLabel', { n: s.seat }), total: false, roles: s.roles })),
    { key: 'all', label: t('analytics.r6.tabsb.seatRoles.allSeats'), total: true, roles: allSeats },
  ];

  const blockItems: SectionTabItem<MetricBlockKey>[] = BLOCKS.map(b => ({ id: b, label: t(`analytics.ui.blocks.${b}`) }));

  const renderTable = (block: MetricBlockKey): JSX.Element => {
    const cell = (row: SeatRoleRow, role: string): { win: number | null; n: number } | null => {
      const c = row.roles[role];
      if (!c) return null;
      const b = outcomeBlocks(c, roleFaction(role))[block];
      return { win: b.win, n: b.n };
    };
    // 每個角色最高的位置 (不含「全部位置」列)。
    const best: Record<string, number> = {};
    for (const role of roles) {
      const vals = rows.filter(r => !r.total).map(r => cell(r, role)?.win).filter((v): v is number => typeof v === 'number');
      if (vals.length > 0) best[role] = Math.max(...vals);
    }
    const columns: StatColumn<SeatRoleRow>[] = [
      { key: 'label', label: t('analytics.r6.tabsb.seats.seatCol') },
      ...roles.map((role): StatColumn<SeatRoleRow> => ({
        key: role,
        label: role,
        align: 'right',
        value: row => cell(row, role)?.win ?? null,
        n: row => cell(row, role)?.n ?? null,
        lowSample: minCell > 0 ? minCell : undefined,
        tone: roleFaction(role),
        format: (v, row) => (
          <span className={!row.total && typeof v === 'number' && v === best[role] ? 'font-bold underline decoration-dotted underline-offset-2' : ''}>
            {formatRate(v)}
          </span>
        ),
      })),
    ];
    return (
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={row => row.key}
        highlightRow={row => row.total}
        footnote={
          <>
            <span className="block">{t(`analytics.ui.blocks.${block}Hint`)}</span>
            {t('analytics.r6.tabsb.seatRoles.note')}
            {minCell > 0 && <> {t('analytics.ui.blocks.lowSampleNote', { min: minCell })}</>}
          </>
        }
      />
    );
  };

  return (
    <SectionTabs
      items={blockItems}
      persistKey="analysis.position.seatRolesBlock"
      ariaLabel={t('analytics.r6.tabsb.seatRoles.blockLabel')}
    >
      {renderTable}
    </SectionTabs>
  );
}
