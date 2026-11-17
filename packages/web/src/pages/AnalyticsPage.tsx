import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { BarChart3, Swords, Droplets, Vote, SlidersHorizontal } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { useAnalysisOverview } from '../components/analysis/useAnalysisOverview';
import BoardsTab from '../components/analysis/tabs/BoardsTab';
import StartHere, { type StartHereTarget } from '../components/analysis/StartHere';
import { useDiscoveryNav } from '../components/analysis/discovery/discoveryNav';
import FeatureStudyReportHost from '../components/analytics/FeatureStudyReport';
import { STUDY_HOME_TAB, studyInLocation } from '../components/analytics/studyLink';
import StatsFilterBar from '../components/analysis/filter/StatsFilterBar';
import { useStatsFilter } from '../stats/statsFilter';
import { useFilterHashSync } from '../stats/sharedFilter';
import { rememberTarget, resolveTab, type CoreTab, type CoreTarget } from '../components/analysis/core/coreTabs';
import {
  AdvancedCoreTab, LakeCoreTab, MissionsCoreTab, OverviewCoreTab, TeamsVotesCoreTab,
} from '../components/analysis/core/CoreTabViews';

/**
 * #98 (2026-04-23) IA 重整：數據排行頁拆成兩大區 —
 *  - 勝率排行：原本 LeaderboardPage 的排名清單；點玩家彈出雷達彈窗
 *  - 深度分析 (Deep Analysis)：把 AnalysisPage 的分頁內容直接搬進來
 * 「玩家雷達」不再獨立 tab，融進勝率排行的點擊體驗。
 *
 * (2026-04-27) 新增第三 tab「特徵研究」: 把 v7 features 研究 (loops 136/139/141/
 * 142/143) 萃取成可瀏覽的玩家信號頁。
 *
 * (2026-04-27 23:42 batch) V3 表加入當時的 ELO 欄、砍分層瀏覽 (2026-10-30 舊 ELO 全部移除，見下)
 *
 * (2026-10-12 兩段結算 / 排行改版, docs/stats/two_stage_outcome.md)
 *   top tab 改成兩個：
 *   - 排行：上方 LeaderboardBoards (/api/analysis/leaderboard；當時是超額勝率 main 榜 +
 *     近 90 天 / 進步 / 本週刺殺 / 新人 / 上月角色稱號小卡，2026-10-13 起改版，見下)，
 *     下方保留 LeaderboardV3Table
 *   - 分析：子分頁依玩家決策分區 — 總覽、派隊、投票、任務、湖中女神、刺殺、位置、
 *     角色與默契、玩家雷達；原「特徵研究」五張卡依主題放進對應分頁 (預設展開)
 *   副標的場數改讀 overview.totalGames，不再寫死。
 *   「玩家雷達」(PlayerRadarChart，讀 /players/:name 的新 radar 契約) 原本掛在已刪除的
 *   AnalysisPage，改為「分析」的最後一個子分頁，不然雷達改版沒有入口。
 *
 * (2026-10-13 Edward：角色理論／位置理論、各人最近 N 場) 排行改成角色理論勝率 main 榜
 *   (各人最近 100 場) + 近 50 場 / 進步 / 刺客 / 新人 (例外：全部場次) / 角色王小卡；
 *   超額勝率不再顯示。總覽與玩家雷達同步改用角色理論／位置理論。
 * (2026-10-30 Edward：「新版把網站上的 ELO 都完全統一成你研發的版本」) 舊 LeaderboardPage (含「傳統 ELO 分層」) 刪除，
 * 'leaderboard' route 改開戰績排行；網站唯一的 Elo 是戰績排行的「Elo」小分頁與玩家雷達的「Elo／理論走勢」。
 *
 * (2026-10-14 第六輪分工前置) 各分頁內容拆到 components/analysis/tabs/ 下各自一個檔案
 *   (BoardsTab、OverviewTab、TeamsTab … PlayersTab)，一個分頁只有一個負責的檔案；
 *   這裡只留頁面外框、上層兩個 tab 與「分析」子分頁切換。
 *
 * (2026-10-14 Edward：「查看完整研究」大多點不開) 掛一個 FeatureStudyReportHost：網址 #study=<id>
 *   時顯示那項特徵研究的完整研究 (各分頁卡片的連結都打開它)；從 #study= 連結直接進來時，
 *   先切到 分析 → 該研究卡片所在的分頁 (STUDY_HOME_TAB)，關掉研究後就在卡片旁邊。
 *
 * (2026-10-26 複合篩選畫面，Edward 2026-10-14 要求、四季 10-26 轉達) 上層 tab 下面掛 StatsFilterBar：兩個 tab
 *   都跟著篩選 (stats/statsFilter.ts；資料請求在 services/api.ts 改用瀏覽器端引擎的結果)。分頁內容以篩選的 key
 *   重新掛載，各元件照原本的方式再拿一次資料；網址列跟著篩選 (#stats?f=…，可直接分享)。
 */
/*
 * (2026-11-17 Edward：「現在的網站數據有多過於發散了…應用比較重要 先看大方向就好 真的要看細節才深入去看 要符合我們的核心:
 *  任務結果 > 湖中女神 > 隊伍派票組合 & 黑白球投票 > 發言資訊 & 狀態」) 12 個分頁改成照核心優先序的 5 個（coreTabs.ts）：
 *  總覽（三層大方向＋可以怎麼做）→ 任務結果 → 湖中女神 → 派隊與投票 → 進階。同日「發言與狀態不是屬於數據的一環吧…局勢樹
 *  比較像 任務結果 x 湖中女神」：沒有發言與狀態分頁，局勢樹是任務結果的小分頁「任務 × 湖中（局勢樹）」。舊分頁的內容都搬進新分頁的小分頁，
 *  舊 id（研究連結、從這裡開始、自動發現跳轉、排行點名字）經 coreTabs.LEGACY_TABS 導到對的小分頁。
 */
interface AnalysisTabDef { id: CoreTab; labelKey: string; icon: typeof BarChart3 }

// Tab labels are sourced from i18n so the bilingual switch covers them. 順序 = 核心優先序。
const ANALYSIS_TABS: AnalysisTabDef[] = [
  { id: 'overview',   labelKey: 'analytics.analysis.core.tabs.overview',   icon: BarChart3 },
  { id: 'missions',   labelKey: 'analytics.analysis.core.tabs.missions',   icon: Swords },
  { id: 'lake',       labelKey: 'analytics.analysis.core.tabs.lake',       icon: Droplets },
  { id: 'teamsVotes', labelKey: 'analytics.analysis.core.tabs.teamsVotes', icon: Vote },
  { id: 'advanced',   labelKey: 'analytics.analysis.core.tabs.advanced',   icon: SlidersHorizontal },
];

export default function AnalyticsPage(): JSX.Element {
  // 2026-10-30 Edward：頁籤直接分成 戰績排行／數據分析（導覽列），這頁不再有自己的「排行／分析」切換。
  // gameState 'analysis' = 數據分析；其餘（'analytics'、舊 'leaderboard'）= 戰績排行。
  // openPlayerStats（排行的名字、#player= 連結）與 #study= 連結都直接進 'analysis'。
  const gameState = useGameStore((s) => s.gameState);
  const setGameState = useGameStore((s) => s.setGameState);
  const statsFocus = useGameStore((s) => s.statsFocus);
  const filterKey = useStatsFilter((s) => `${s.key}|${s.nonce}`);
  useFilterHashSync();
  const view: 'boards' | 'analysis' = gameState === 'analysis' ? 'analysis' : 'boards';
  useEffect(() => {
    if (view === 'boards' && (statsFocus || studyInLocation())) setGameState('analysis');
  }, [view, statsFocus, setGameState]);

  return (
    <div className="min-h-screen p-4 pb-24">
      <div className="max-w-6xl mx-auto">
        <StatsFilterBar />

        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {view === 'boards'   && <BoardsTab key={filterKey} />}
            {view === 'analysis' && <AnalysisSection focus={statsFocus} />}
          </motion.div>
        </AnimatePresence>
      </div>
      <FeatureStudyReportHost />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 分析：子分頁依玩家決策分區 (各分頁內容見 components/analysis/tabs/)
// ──────────────────────────────────────────────────────────────

/** 初始分頁：排行點名字 → 進階 › 玩家雷達；#study= → 那項研究所在的舊分頁對應的新分頁；其他 → 總覽。 */
function initialTarget(focus: { name: string; seq: number } | null): CoreTarget {
  if (focus) return resolveTab('players') as CoreTarget;
  const study = studyInLocation();
  return resolveTab(study ? STUDY_HOME_TAB[study] : null) ?? { tab: 'overview' };
}

function AnalysisSection({ focus }: { focus: { name: string; seq: number } | null }): JSX.Element {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<CoreTab>(() => {
    const target = initialTarget(focus);
    rememberTarget(target);
    return target.tab;
  });
  // 同一個分頁內換小分頁時，要重新掛載才會讀到記下的小分頁
  const [jump, setJump] = useState(0);
  const goTo = (target: CoreTarget | null): void => {
    if (!target) return;
    rememberTarget(target);
    setTab(target.tab);
    setJump((n) => n + 1);
  };
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    if (focus) goTo(resolveTab('players'));
  }
  // 自動發現的「看全部」「在組成比較打開」、玩家雷達的「看各組」：切到對的分頁（小分頁由那一頁看 discoveryNav 切）
  const navTab = useDiscoveryNav((s) => s.tab);
  const navNonce = useDiscoveryNav((s) => s.nonce);
  const [seenNav, setSeenNav] = useState(navNonce);
  if (navNonce !== seenNav) {
    setSeenNav(navNonce);
    if (navTab) setTab(navTab);
  }
  const { overview } = useAnalysisOverview();
  const totalGames = overview?.totalGames;
  const filterKey = useStatsFilter((s) => `${s.key}|${s.nonce}`);
  // 「從這裡開始」的按鈕（舊分頁 id）：經 coreTabs 導到新分頁；兩紅派隊分組、自動發現經 discoveryNav
  const goStartHere = (target: StartHereTarget): void => {
    if (target === 'findings:twoRedCohort') useDiscoveryNav.getState().openView('twoRedCohort');
    else if (target === 'findings:discovery') useDiscoveryNav.getState().openList(null);
    else goTo(resolveTab(target));
  };
  const goTab = (id: CoreTab): void => goTo({ tab: id });

  return (
    <div>
      <p className="text-xs text-zinc-500 mb-3">
        {typeof totalGames === 'number'
          ? `${t('analytics.analysis.subtitle', { count: totalGames })} · `
          : ''}
        {t('analytics.deep.subtitleSource')}
      </p>
      <StartHere onGo={goStartHere} />
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 scrollbar-hide" role="tablist">
        {ANALYSIS_TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => goTab(id)}
            data-testid={`analysis-tab-${id}`}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
              tab === id
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                : id === 'advanced'
                  ? 'bg-transparent text-zinc-500 hover:text-white border border-dashed border-zinc-700'
                  : 'bg-avalon-card/40 text-gray-400 hover:text-white hover:bg-avalon-card/60 border border-gray-700'
            }`}
          >
            <Icon size={14} />
            {t(labelKey)}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={`${tab}|${filterKey}|${jump}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {/* 每個分頁一句「怎麼用」：這一頁幫你做哪一種決定 */}
          <p className="mb-3 text-xs leading-relaxed text-zinc-400" data-testid="analysis-howto">{t(`analytics.analysis.core.howTo.${tab}`)}</p>
          {tab === 'overview'   && <OverviewCoreTab onGo={goTab} />}
          {tab === 'missions'   && <MissionsCoreTab />}
          {tab === 'lake'       && <LakeCoreTab onJump={goTo} />}
          {tab === 'teamsVotes' && <TeamsVotesCoreTab />}
          {tab === 'advanced'   && <AdvancedCoreTab focus={focus} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
