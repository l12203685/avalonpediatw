import { useTranslation } from 'react-i18next';
import AssassinationCard from '../AssassinationCard';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';
import SectionTitle from './SectionTitle';

/** 刺殺：刺殺結算卡 + L143 (刺客目標座位偏好)。 */
export default function AssassinationTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <AssassinationCard />
      <div>
        <SectionTitle>{t('analytics.analysis.section.feature')}</SectionTitle>
        <FeatureStudyCard loopId="L143" defaultOpen />
      </div>
    </div>
  );
}
