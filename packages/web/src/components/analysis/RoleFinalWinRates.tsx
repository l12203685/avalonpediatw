import { Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { outcomeBlocks, roleFaction, theorySettings } from '../../services/api';
import { useAnalysisOverview } from './useAnalysisOverview';
import { ROLE_ORDER, blockValues, rolePopulation, useAnalysisPlayerRows, useIsWide } from './seatRoleBlocks';
import { MetricBlocks, type MetricBlockRow } from './ui';

/**
 * 各角色的三塊結果 (全體)。
 *
 * 舊版：overview.roleFinalWinRates 的長條 (紅角 = 三紅 + 三藍死、藍角 = 三藍活)，舊快取沒有時隱藏。
 * (2026-10-14 Edward：「角色勝率那邊應該分三塊」「用條件機率」) 改成三塊結果表，每個角色一列：
 *   任務結果 (n = 該角色全部局)、刺殺結果 (n = 其中打到三藍的局)、遊戲結果 (= roleFinalWinRates)。
 *   局數 = 全部玩家 players[].roleOutcomes 加總 (schemaVersion 4；有名字的座位，與 roleFinalWinRates
 *   同一個分母，兩份數字完全一致)，比率由 @avalon/shared 的 outcomeBlocks 算。
 *   舊快取 (schemaVersion 3，沒有 roleOutcomes)：遊戲結果用 roleFinalWinRates、n 用 Σ rawRoleGames，
 *   任務／刺殺兩塊顯示「—」並註明「下次每日更新後提供」，不拿別的口徑湊數字。
 * 每局七個角色都在場，所以同陣營的角色幾乎一樣 (差別只來自沒有名字的座位)；角色本身的差別看
 * 「位置 × 角色」和玩家雷達。
 */
export default function RoleFinalWinRates(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading: overviewLoading } = useAnalysisOverview();
  const { players, loading: playersLoading } = useAnalysisPlayerRows();
  // 手機不印三塊的規則說明，三塊才放得進 390px (規則在表頭的滑鼠提示與表下說明裡)。
  const wide = useIsWide();

  if (overviewLoading || playersLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }

  const population = rolePopulation(players);
  const rates = overview?.roleFinalWinRates && typeof overview.roleFinalWinRates === 'object'
    ? overview.roleFinalWinRates
    : null;
  const source: Record<string, unknown> = population.counts ?? rates ?? {};
  const roles = [
    ...ROLE_ORDER.filter(r => r in source),
    ...Object.keys(source).filter(r => !ROLE_ORDER.includes(r)),
  ];
  // 補值門檻讀快取 (overview.theoryConfig)；0 = 不補，就不提補值。
  const minCell = theorySettings(overview?.theoryConfig).theoryMinCellGames;

  if (roles.length === 0) {
    return <p className="py-6 text-center text-xs text-zinc-500">{t('analytics.r6.tabsb.pendingUpdate')}</p>;
  }

  const rows: MetricBlockRow[] = roles.map(role => {
    const faction = roleFaction(role);
    const counts = population.counts?.[role];
    if (counts) {
      return { key: role, label: role, tone: faction, ...blockValues(outcomeBlocks(counts, faction)) };
    }
    const v = rates?.[role];
    return {
      key: role,
      label: role,
      tone: faction,
      ...blockValues(null),
      final: { win: typeof v === 'number' ? v : null, n: population.games?.[role] ?? null },
    };
  });

  return (
    <MetricBlocks
      className="max-w-3xl"
      rows={rows}
      caption={t('analytics.r6.tabsb.roleBlocks.title')}
      groupLabel={t('analytics.r6.tabsb.roleBlocks.roleCol')}
      showRules={wide}
      lowSample={minCell > 0 ? minCell : undefined}
      footnote={
        <>
          {!population.counts && <span className="text-amber-300/80">{t('analytics.r6.tabsb.roleBlocks.pending')} </span>}
          {t('analytics.r6.tabsb.roleBlocks.note')}{' '}
          {t('analytics.deep.roleFinal.note')}
          {minCell > 0 && t('analytics.deep.roleFinal.noteTopUp', { n: minCell })}
        </>
      }
    />
  );
}
