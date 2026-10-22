import { useTranslation } from 'react-i18next';
import LeaderboardBoards from '../LeaderboardBoards';
import LeaderboardV3Table from '../../LeaderboardV3Table';

/**
 * 排行：角色理論勝率排行等各榜 (LeaderboardBoards) + 精算榜 (V3 8-metric)。
 * (2026-10-14 從 AnalyticsPage 的 BoardsSection 拆成獨立檔案，內容不變)
 * (2026-10-14 Edward：「頁面不要拉太長，最好分頁切過去一頁可以顯示全部該分頁的內容」)
 *   各榜改成小分頁、一次一個榜；精算榜不再接在各榜下面，改成最後一個小分頁
 *   (LeaderboardBoards 載入失敗時照樣切得到)。
 */
export default function BoardsTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <LeaderboardBoards
      precision={{ label: t('analytics.r6.boards.tab.precision'), content: <LeaderboardV3Table /> }}
    />
  );
}
