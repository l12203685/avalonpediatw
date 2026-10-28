import { useTranslation } from 'react-i18next';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';
import VotingOverview from '../VotingOverview';
import { SectionTabs } from '../ui';

type VotesView = 'overview' | 'flip';

/**
 * 投票。
 *
 * (2026-10-14 Edward：一頁一屏、表格優先) L136 的發散長條圖改成數字表 (FeatureStudiesPanel)。
 * (2026-10-28 Edward：「投票…應該可以呈現更直觀的結果 一樣需要名詞解釋跟定義」) 加「投票概況」小分頁放在前面：
 *  全部玩家的票加總 —— 有紅方的隊伍多常被投反對、全藍的隊伍多常被投贊成、第 3 個任務起忠臣與紅方多常投反對
 *  (VotingOverview，一句話結論 + 兩張表，名詞可點開看定義)；L136 (改隊後翻票) 移到第二個小分頁。
 */
export default function VotesTab(): JSX.Element {
  const { t } = useTranslation('common');
  const items: { id: VotesView; label: string }[] = [
    { id: 'overview', label: t('analytics.r7.votes.tabs.overview') },
    { id: 'flip', label: t('analytics.r7.votes.tabs.flip') },
  ];
  return (
    <SectionTabs items={items} persistKey="analysis.votes" ariaLabel={t('analytics.analysis.tabs.votes')}>
      {(view) => (view === 'flip' ? <FeatureStudyCard loopId="L136" defaultOpen /> : <VotingOverview />)}
    </SectionTabs>
  );
}
