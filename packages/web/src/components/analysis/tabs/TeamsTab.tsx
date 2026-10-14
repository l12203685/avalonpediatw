import { useTranslation } from 'react-i18next';
import CaptainAnalysis from '../CaptainAnalysis';
import RoundsAnalysis from '../RoundsAnalysis';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';
import SectionTitle from './SectionTitle';

/** 派隊：隊長分析 + 1-1 派票 (RoundsAnalysis) + L139 (forced P5，選擇偏誤)。 */
export default function TeamsTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <div>
        <SectionTitle>{t('analytics.analysis.section.captain')}</SectionTitle>
        <CaptainAnalysis />
      </div>
      <div>
        <SectionTitle>{t('analytics.analysis.section.firstVote')}</SectionTitle>
        <RoundsAnalysis />
      </div>
      <div>
        <SectionTitle>{t('analytics.analysis.section.feature')}</SectionTitle>
        <FeatureStudyCard loopId="L139" defaultOpen />
      </div>
    </div>
  );
}
