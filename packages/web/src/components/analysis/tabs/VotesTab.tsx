import { useTranslation } from 'react-i18next';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';

/** 投票：目前只有改隊後翻轉率 (L136) 一項。 */
export default function VotesTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500 leading-relaxed">{t('analytics.analysis.votesNote')}</p>
      <FeatureStudyCard loopId="L136" defaultOpen />
    </div>
  );
}
