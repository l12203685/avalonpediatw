import { useTranslation } from 'react-i18next';
import AssassinationCard, { AssassinationSeatTable } from '../AssassinationCard';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';
import { SectionTabs } from '../ui';

type AssassinationView = 'summary' | 'seat' | 'target';

/**
 * 刺殺：刺殺結算卡 + L143 (刺客目標座位偏好)。
 *
 * (2026-10-14 Edward：一頁一屏、條件機率附 n) SectionTabs 三頁：刺殺結算 (卡片 + 紅藍三塊結果)、
 * 座位與刺殺 (梅林／刺客坐各位置時三藍局的刺中率)、刺客目標 (L143，數字表)。
 */
export default function AssassinationTab(): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r6.tabsa.assassination.tabs';
  const items: { id: AssassinationView; label: string }[] = [
    { id: 'summary', label: t(`${k}.summary`) },
    { id: 'seat', label: t(`${k}.seat`) },
    { id: 'target', label: t(`${k}.target`) },
  ];
  return (
    <SectionTabs items={items} persistKey="analysis.assassination" ariaLabel={t('analytics.analysis.tabs.assassination')}>
      {(view) => {
        if (view === 'seat') return <AssassinationSeatTable />;
        if (view === 'target') return <FeatureStudyCard loopId="L143" defaultOpen />;
        return <AssassinationCard />;
      }}
    </SectionTabs>
  );
}
