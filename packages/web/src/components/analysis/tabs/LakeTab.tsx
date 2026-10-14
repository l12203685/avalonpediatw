import { useTranslation } from 'react-i18next';
import LakeAnalysis from '../LakeAnalysis';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';
import SectionTitle from './SectionTitle';

/** 湖中女神：LakeAnalysis + L141 (宣告可信度) + L142 (言行一致度)。 */
export default function LakeTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <LakeAnalysis />
      <div className="space-y-4">
        <SectionTitle>{t('analytics.analysis.section.feature')}</SectionTitle>
        <FeatureStudyCard loopId="L141" defaultOpen />
        <FeatureStudyCard loopId="L142" defaultOpen />
      </div>
    </div>
  );
}
