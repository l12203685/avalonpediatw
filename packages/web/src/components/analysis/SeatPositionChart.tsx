import { Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { outcomeBlocks, theorySettings } from '../../services/api';
import { useAnalysisOverview } from './useAnalysisOverview';
import { blockValues, seatFactionCounts, useIsWide } from './seatRoleBlocks';
import { MetricBlocks, type MetricBlockRow } from './ui';

/**
 * 各位置的三塊結果 (全體) — 「位置」分頁的第一個小分頁。
 *
 * (2026-10-12) 從 OverviewPanel 搬到「位置」分頁 (當時是任務結算整體勝率的長條圖 + 各角色 tooltip)。
 * (2026-10-14 Edward：「角色勝率分三塊」「用條件機率」「能用表格就不用圖」) 改成兩張三塊結果表：
 *   坐這個位置當紅方 / 當藍方，每列一個位置，任務結果 (n = 該位置該陣營的局數)、
 *   刺殺結果 (n = 其中打到三藍的局)、遊戲結果。資料 = overview.seatPositionWinRates[].roles[].outcomes
 *   依陣營加總 (seatFactionCounts)，比率由 @avalon/shared 的 outcomeBlocks 算。
 *   舊的長條圖拿掉：10 根都在 50% 上下，形狀看不出表格看不出的東西；每局 10 個位置都有人，
 *   不分陣營的三種結果每個位置都一樣 (2026-10-13「全員 46%」)，所以一定要分陣營看。
 *   快取沒有角色局數時顯示「下次每日更新後提供」。
 */
export default function SeatPositionChart(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();
  // 手機不印三塊的規則說明 (表頭變窄，三塊放得進 390px)；規則在表頭滑鼠提示與表下說明。
  const wide = useIsWide();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }

  const seats = seatFactionCounts(overview);
  if (!seats) {
    return (
      <p className="py-6 text-center text-xs text-zinc-500">
        {error ?? t('analytics.r6.tabsb.pendingUpdate')}
      </p>
    );
  }
  // 少場淡色的門檻讀快取 (overview.theoryConfig)，不寫死。
  const minCell = theorySettings(overview?.theoryConfig).theoryMinCellGames;

  const rowsFor = (faction: 'red' | 'blue'): MetricBlockRow[] => seats.map(s => ({
    key: `${faction}-${s.seat}`,
    label: t('analytics.r6.tabsb.seats.seatLabel', { n: s.seat }),
    tone: faction,
    ...blockValues(outcomeBlocks(s[faction], faction)),
  }));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {(['red', 'blue'] as const).map(faction => (
          <MetricBlocks
            key={faction}
            rows={rowsFor(faction)}
            caption={
              <span className={faction === 'red' ? 'text-red-300' : 'text-blue-300'}>
                {t(`analytics.r6.tabsb.seats.${faction}`)}
              </span>
            }
            groupLabel={t('analytics.r6.tabsb.seats.seatCol')}
            showRules={wide}
            lowSample={minCell > 0 ? minCell : undefined}
          />
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-zinc-500">{t('analytics.r6.tabsb.seats.note')}</p>
    </div>
  );
}
