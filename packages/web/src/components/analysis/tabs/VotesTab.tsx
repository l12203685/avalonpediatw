import { useTranslation } from 'react-i18next';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';

/**
 * 投票：目前只有改隊後翻轉率 (L136) 一項。
 *
 * (2026-10-14 Edward：一頁一屏、表格優先) L136 的發散長條圖改成數字表 (FeatureStudiesPanel)，
 * 整頁在桌機一個螢幕內，不必再分小分頁；「查看完整研究」打開站內的完整研究 (#study=l136)。
 */
export default function VotesTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500 leading-relaxed">{t('analytics.analysis.votesNote')}</p>
      <FeatureStudyCard loopId="L136" defaultOpen />
    </div>
  );
}
