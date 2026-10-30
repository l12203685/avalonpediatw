import { useTranslation } from 'react-i18next';
import LeaderboardBoards from '../LeaderboardBoards';
import PeriodWinRates from '../PeriodWinRates';

/**
 * 排行：角色理論勝率排行等各榜 (LeaderboardBoards)。
 * (2026-10-14 從 AnalyticsPage 的 BoardsSection 拆成獨立檔案，內容不變)
 * (2026-10-14 Edward：「頁面不要拉太長，最好分頁切過去一頁可以顯示全部該分頁的內容」)
 *   各榜改成小分頁、一次一個榜。
 * (2026-10-26 篩選) 各榜隨篩選重算。
 * (2026-10-28 Edward：「精算榜呈現的內容是不是跟前面有點重複 應該可以合併? … 精準勝率怎麼算的有點看不懂 …
 *   倒是可以加 任務勝率 … 刺殺勝率」) 精算榜不再是排行的小分頁：期望勝與最終勝率重複、精準勝率是舊的任務口徑
 *   (三藍死算藍勝) 又不隨每日重算的口徑更新；任務勝率／刺殺勝率併進「理論勝率」表。LeaderboardV3Table 與
 *   /api/leaderboard/v3 保留，要恢復把 precision 傳回 LeaderboardBoards 即可。
 */
export default function BoardsTab(): JSX.Element {
  const { t } = useTranslation('common');
  return <LeaderboardBoards winRates={{ label: t('analytics.winRates.tab'), content: <PeriodWinRates /> }} />;
}
