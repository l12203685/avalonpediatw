import { Loader, AlertCircle, ArrowRight, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAnalysisOverview, deriveStages } from './useAnalysisOverview';
import SummaryStrip from './overview/SummaryStrip';
import OutcomeGamesBlock from './overview/OutcomeGamesBlock';
import { rememberSectionTab } from './ui/SectionTabs';
import { BOARDS_PERSIST_KEY } from './decisive/decisiveLayout';
import { useGameStore } from '../../store/gameStore';

/**
 * 總覽右邊原本的理論勝率排行（overview/TheoryRankings，檔案保留）跟戰績排行 › 理論勝率幾乎一樣，2026-11-16
 * （Edward「數據分析太多太亂」）改成一張連到戰績排行 › 理論勝率的卡片（那裡可以調上榜條件）。
 */
function TheoryBoardLink(): JSX.Element {
  const { t } = useTranslation('common');
  const go = (): void => {
    rememberSectionTab(BOARDS_PERSIST_KEY, 'theory');
    useGameStore.setState({ gameState: 'analytics', statsFocus: null });
    window.scrollTo({ top: 0 });
  };
  return (
    <button
      type="button"
      onClick={go}
      className="flex w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-left hover:border-blue-700"
      data-testid="overview-theory-link"
    >
      <Trophy size={16} className="shrink-0 text-amber-300" />
      <span className="min-w-0 text-sm text-zinc-300">{t('analytics.analysis.overviewTheoryLink')}</span>
      <ArrowRight size={14} className="ml-auto shrink-0 text-blue-300" />
    </button>
  );
}

/**
 * 總覽 (2026-10-12 兩段結算改版, docs/stats/two_stage_outcome.md)：
 *  - 卡片：總場次、玩家數、三段結算 (任務結算 → 刺殺結算 → 最終)
 *  - 排行 (2026-10-13 Edward 定義)：「角色理論勝率排行」— 生涯 100 場以上的玩家、
 *    各人最近 100 場的角色理論勝率 (overview.topPlayersByRoleTheory，不限近期出賽；
 *    近期的排行在「排行」分頁)。
 *  - 三種結果分布、場次排行保留；位置勝率圖搬到「位置」分頁 (SeatPositionChart)
 *
 * (2026-10-14 Edward：「三種結果 & 場次排行結合成大圓餅的小圓餅」「角色理論旁邊再呈現位置理論 (100 場)
 *  & 整體理論 (生涯 250 場以上)」「能用表格數字就不用圖」「一頁顯示全部，不要拉長」) 改成三塊，桌機 1280×800
 *  一屏放得下：
 *  - SummaryStrip：總場次、玩家數、三段結算收成一列 (每段附分母 n，刺殺結算的分母是三藍局)
 *  - OutcomeGamesBlock：(2026-10-28 改) 每位玩家一列四條比例 (遊戲結果切贏輸、任務、刺殺、最終)；可切「表格」
 *  - TheoryRankings：角色理論 / 位置理論 / 整體理論三個數字表並排 —— 2026-11-16 拿掉，改成連到戰績排行 › 理論勝率的
 *    卡片 (TheoryBoardLink；手機原本的四個小分頁一起拿掉)。
 *  schemaVersion 3 的快取 (沒有每人三種結果、位置／整體理論榜) 顯示「下次每日更新後提供」，不畫成 0%。
 */
export default function OverviewPanel(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SummaryStrip totalGames={overview.totalGames} totalPlayers={overview.totalPlayers} stages={deriveStages(overview)} />
      <OutcomeGamesBlock overview={overview} />
      <TheoryBoardLink />
    </div>
  );
}
