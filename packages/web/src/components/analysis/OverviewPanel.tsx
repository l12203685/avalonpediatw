import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AnalysisOverview } from '../../services/api';
import { useAnalysisOverview, deriveStages } from './useAnalysisOverview';
import { SectionTabs, type SectionTabItem } from './ui';
import SummaryStrip from './overview/SummaryStrip';
import OutcomeGamesBlock from './overview/OutcomeGamesBlock';
import TheoryRankings, { TheoryRankingPanel, useTheoryRankings, type TheoryKind } from './overview/TheoryRankings';
import { useMediaQuery } from './overview/useMediaQuery';

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
 *  - TheoryRankings：角色理論 (各角色近 10 場、忠臣近 40 場) / 位置理論 (近 100 場) / 整體理論 (生涯 ≥ 250 場)
 *    三個數字表並排；視窗與門檻讀 theoryConfig
 *  手機／平板 (< lg) 改成四個小分頁 (結果與場次、角色理論、位置理論、整體理論)，每頁約一屏。
 *  schemaVersion 3 的快取 (沒有每人三種結果、位置／整體理論榜) 顯示「下次每日更新後提供」，不畫成 0%。
 */
export default function OverviewPanel(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();
  // 桌機 (≥ lg，Tailwind 的 1024px) 左右兩塊一屏放完；更窄改成小分頁。
  const desktop = useMediaQuery('(min-width: 1024px)');

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
      {desktop ? (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-5 min-w-0">
            <OutcomeGamesBlock overview={overview} />
          </div>
          <div className="col-span-7 min-w-0">
            <TheoryRankings overview={overview} />
          </div>
        </div>
      ) : (
        <OverviewSubPages overview={overview} />
      )}
    </div>
  );
}

type SubPage = 'outcomes' | TheoryKind;

/**
 * 手機／平板 (< lg)：結果與場次、角色理論、位置理論、整體理論 四個小分頁，一次一個 (每頁約一屏)；
 * 三段結算那一列留在小分頁上面。
 */
function OverviewSubPages({ overview }: { overview: AnalysisOverview }): JSX.Element {
  const { t } = useTranslation('common');
  const info = useTheoryRankings(overview);
  const items: SectionTabItem<SubPage>[] = [
    { id: 'outcomes', label: t('analytics.r6.overview.tabs.outcomes') },
    ...info.rankings.map(r => ({ id: r.kind, label: r.label })),
  ];
  return (
    <SectionTabs
      items={items}
      persistKey="analysis.overview.sub"
      ariaLabel={t('analytics.r6.overview.tabs.label')}
      stretch
    >
      {id => (id === 'outcomes'
        ? <OutcomeGamesBlock overview={overview} />
        : <TheoryRankingPanel info={info} kind={id} />)}
    </SectionTabs>
  );
}
