import { useTranslation } from 'react-i18next';
import { Crown, FlaskConical, Route, Vote } from 'lucide-react';
import CaptainAnalysis from '../CaptainAnalysis';
import RoundsAnalysis from '../RoundsAnalysis';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';
import { SectionTabs, type SectionTabItem } from '../ui';
import { useAnalysisOverview } from '../useAnalysisOverview';
import { theorySettings } from '../../../services/api';

/**
 * 派隊：隊長分析 + 1-1 派票 + 任務進程 + L139 (forced P5，選擇偏誤)。
 *
 * (2026-10-14 Edward：派隊「分析很好但太散」，同類的放一起；頁面不要拉長，一頁一屏、用小分頁切)
 * 原本一路往下疊 隊長分析 (三張卡) → 1-1 派票 (五張卡) → L139，約五屏。改成四個小分頁，每頁一屏：
 *   - 隊長：各任務隊長陣營 + 隊長陣營 × 任務結果 → 整局結果 (CaptainAnalysis)
 *   - 1-1 派票：1-1 隊裡有誰、1-1 隊裡的紅方人數 (RoundsAnalysis section='firstVote')
 *   - 任務進程：各任務成功率、任務 1 成功／失敗之後、完整任務路徑 (RoundsAnalysis section='progression')
 *   - 研究 L139：特徵研究卡 (FeatureStudiesPanel 的元件，另一條線負責，這裡只擺放)
 * 結果比率一律是三塊條件結果並附 n (teams/OutcomeBlocksTable)；樣本少變淡的門檻讀快取的
 * theoryMinCellGames (overview.theoryConfig，舊快取用產生器預設值)，不寫死。
 */
type TeamsSection = 'captain' | 'firstVote' | 'progression' | 'study';

export default function TeamsTab(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview } = useAnalysisOverview();
  const lowSample = theorySettings(overview?.theoryConfig).theoryMinCellGames;

  const items: SectionTabItem<TeamsSection>[] = [
    { id: 'captain', label: t('analytics.r6.teams.tabs.captain'), icon: Crown },
    { id: 'firstVote', label: t('analytics.r6.teams.tabs.firstVote'), icon: Vote },
    { id: 'progression', label: t('analytics.r6.teams.tabs.progression'), icon: Route },
    { id: 'study', label: t('analytics.r6.teams.tabs.study'), icon: FlaskConical },
  ];

  return (
    <SectionTabs
      items={items}
      persistKey="analysis.teams"
      ariaLabel={t('analytics.r6.teams.tabsLabel')}
    >
      {active => {
        switch (active) {
          case 'captain':     return <CaptainAnalysis lowSample={lowSample} />;
          case 'firstVote':   return <RoundsAnalysis section="firstVote" lowSample={lowSample} />;
          case 'progression': return <RoundsAnalysis section="progression" lowSample={lowSample} />;
          case 'study':       return <FeatureStudyCard loopId="L139" defaultOpen />;
        }
      }}
    </SectionTabs>
  );
}
