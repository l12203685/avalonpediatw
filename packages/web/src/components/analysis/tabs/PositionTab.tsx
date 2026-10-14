import { useTranslation } from 'react-i18next';
import SeatHeatmap from '../SeatHeatmap';
import SeatPositionChart from '../SeatPositionChart';
import SeatOrderAnalysis from '../SeatOrderAnalysis';
import SectionTitle from './SectionTitle';

/** 位置：座位熱圖 + 位置勝率圖 (從總覽搬來) + 派梅娜順序。 */
export default function PositionTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <div>
        <SectionTitle>{t('analytics.analysis.section.seatHeatmap')}</SectionTitle>
        <SeatHeatmap />
      </div>
      <SeatPositionChart />
      <div>
        <SectionTitle>{t('analytics.analysis.section.seatOrder')}</SectionTitle>
        <SeatOrderAnalysis />
      </div>
    </div>
  );
}
