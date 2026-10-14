import { useTranslation } from 'react-i18next';
import LeaderboardBoards from '../LeaderboardBoards';
import LeaderboardV3Table from '../../LeaderboardV3Table';
import SectionTitle from './SectionTitle';

/**
 * 排行：角色理論勝率排行 (LeaderboardBoards) + 精算榜 (V3 8-metric)。
 * (2026-10-14 從 AnalyticsPage 的 BoardsSection 拆成獨立檔案，內容不變)
 */
export default function BoardsTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <LeaderboardBoards />
      <div>
        <SectionTitle>{t('analytics.boards.precisionTitle')}</SectionTitle>
        <LeaderboardV3Table />
      </div>
    </div>
  );
}
