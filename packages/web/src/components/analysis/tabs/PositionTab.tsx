import { useTranslation } from 'react-i18next';
import SeatHeatmap from '../SeatHeatmap';
import SeatPositionChart from '../SeatPositionChart';
import SeatRoleTable from '../SeatRoleTable';
import SeatOrderAnalysis from '../SeatOrderAnalysis';
import { MoreDetails, SectionTabs, type SectionTabItem } from '../ui';

// 2026-11-16 Edward「數據分析太多太亂」：少用的區塊收進最後一個小分頁「更多細節」（每塊預設收起，內容沒有刪）
type PositionPage = 'seats' | 'seatRoles' | 'more';

/**
 * 位置：各位置三塊結果 / 位置 × 角色 / 玩家 × 位置 / 派梅娜順序。
 *
 * (2026-10-14 Edward：「頁面不要拉太長，最好分頁切過去一頁可以顯示全部該分頁的內容」
 *  「有些可以用表格數字，不一定要用圖」「用條件機率」) 原本四塊上下排 (桌機 2900 px)，
 *  改成 SectionTabs 四個小分頁，一次只掛一頁；每頁都是附 n 的數字表。
 */
export default function PositionTab(): JSX.Element {
  const { t } = useTranslation('common');
  const items: SectionTabItem<PositionPage>[] = [
    { id: 'seats', label: t('analytics.r6.tabsb.position.tabs.seats') },
    { id: 'seatRoles', label: t('analytics.r6.tabsb.position.tabs.seatRoles') },
    { id: 'more', label: t('analytics.analysis.more.tab') },
  ];
  return (
    <SectionTabs
      items={items}
      persistKey="analysis.position"
      ariaLabel={t('analytics.r6.tabsb.position.tabsLabel')}
      size="md"
    >
      {page => {
        switch (page) {
          case 'seats': return <SeatPositionChart />;
          case 'seatRoles': return <SeatRoleTable />;
          default: return (
            <MoreDetails items={[
              { id: 'players', title: t('analytics.r6.tabsb.position.tabs.players'), render: () => <SeatHeatmap /> },
              { id: 'order', title: t('analytics.r6.tabsb.position.tabs.order'), render: () => <SeatOrderAnalysis /> },
            ]} />
          );
        }
      }}
    </SectionTabs>
  );
}
