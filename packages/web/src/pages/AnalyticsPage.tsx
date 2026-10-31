import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  BarChart3, Crown, Vote, Swords, Droplets, Crosshair, Map, Users, Radar, Gauge, GitBranch,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { useAnalysisOverview } from '../components/analysis/useAnalysisOverview';
import BoardsTab from '../components/analysis/tabs/BoardsTab';
import OverviewTab from '../components/analysis/tabs/OverviewTab';
import TeamsTab from '../components/analysis/tabs/TeamsTab';
import VotesTab from '../components/analysis/tabs/VotesTab';
import MissionsTab from '../components/analysis/tabs/MissionsTab';
import LakeTab from '../components/analysis/tabs/LakeTab';
import AssassinationTab from '../components/analysis/tabs/AssassinationTab';
import PositionTab from '../components/analysis/tabs/PositionTab';
import RolesTab from '../components/analysis/tabs/RolesTab';
import PlayersTab from '../components/analysis/tabs/PlayersTab';
import StrengthTab from '../components/analysis/tabs/StrengthTab';
import { useDiscoveryNav } from '../components/analysis/discovery/discoveryNav';
import DiscoveryBlock from '../components/analysis/discovery/DiscoveryBlock';
import StateTreeTab from '../components/analysis/tabs/StateTreeTab';
import FeatureStudyReportHost from '../components/analytics/FeatureStudyReport';
import { STUDY_HOME_TAB, studyInLocation } from '../components/analytics/studyLink';
import StatsFilterBar from '../components/analysis/filter/StatsFilterBar';
import { useStatsFilter } from '../stats/statsFilter';
import { useFilterHashSync } from '../stats/sharedFilter';

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
 * 'leaderboard' route 改開戰績排行；網站唯一的 Elo 是戰績排行的「Elo」小分頁與玩家雷達的「Elo 走勢」。
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
type AnalysisTab =
  | 'overview' | 'teams' | 'votes' | 'missions'
  | 'lake' | 'assassination' | 'position' | 'roles' | 'strength' | 'stateTree' | 'players';

interface AnalysisTabDef { id: AnalysisTab; labelKey: string; icon: typeof BarChart3 }

// Tab labels are sourced from i18n so the bilingual switch covers them.
const ANALYSIS_TABS: AnalysisTabDef[] = [
  { id: 'overview',      labelKey: 'analytics.analysis.tabs.overview',      icon: BarChart3 },
  { id: 'teams',         labelKey: 'analytics.analysis.tabs.teams',         icon: Crown },
  { id: 'votes',         labelKey: 'analytics.analysis.tabs.votes',         icon: Vote },
  { id: 'missions',      labelKey: 'analytics.analysis.tabs.missions',      icon: Swords },
  { id: 'lake',          labelKey: 'analytics.analysis.tabs.lake',          icon: Droplets },
  { id: 'assassination', labelKey: 'analytics.analysis.tabs.assassination', icon: Crosshair },
  { id: 'position',      labelKey: 'analytics.analysis.tabs.position',      icon: Map },
  { id: 'roles',         labelKey: 'analytics.analysis.tabs.roles',         icon: Users },
  // 2026-10-31 Edward：陣容強度（走勢、季 × 強度、分層結果、不同組成的過程比較）
  { id: 'strength',      labelKey: 'analytics.analysis.tabs.strength',      icon: Gauge },
  // 2026-10-31 Edward：局勢樹（任務順序 × 湖的宣告 → 結果；components/analysis/stateTree/）
  { id: 'stateTree',     labelKey: 'analytics.analysis.tabs.stateTree',     icon: GitBranch },
  { id: 'players',       labelKey: 'analytics.analysis.tabs.players',       icon: Radar },
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

function AnalysisSection({ focus }: { focus: { name: string; seq: number } | null }): JSX.Element {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<AnalysisTab>(() => {
    if (focus) return 'players';
    const study = studyInLocation();
    const home = study ? STUDY_HOME_TAB[study] : undefined;
    return ANALYSIS_TABS.some(d => d.id === home) ? (home as AnalysisTab) : 'overview';
  });
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    if (focus) setTab('players');
  }
  // 自動發現的「看全部」「在組成比較打開」：切到陣容強度分頁
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

  return (
    <div>
      <p className="text-xs text-zinc-500 mb-3">
        {typeof totalGames === 'number'
          ? `${t('analytics.analysis.subtitle', { count: totalGames })} · `
          : ''}
        {t('analytics.deep.subtitleSource')}
      </p>
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 scrollbar-hide">
        {ANALYSIS_TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
              tab === id
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
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
          key={`${tab}|${filterKey}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {tab === 'overview'      && <OverviewTab />}
          {tab === 'teams'         && <TeamsTab />}
          {tab === 'votes'         && <VotesTab />}
          {tab === 'missions'      && <MissionsTab />}
          {tab === 'lake'          && <LakeTab />}
          {tab === 'assassination' && <AssassinationTab />}
          {tab === 'position'      && <PositionTab />}
          {tab === 'roles'         && <RolesTab />}
          {tab === 'strength'      && <StrengthTab />}
          {tab === 'stateTree'     && <StateTreeTab />}
          {tab === 'players'       && <PlayersTab focus={focus} />}
          {/* 2026-10-31 Edward：每個分析分頁都有「自動發現」（跟這頁指標有關的明顯差異；玩家雷達是個人頁，不放） */}
          {tab !== 'players' && <DiscoveryBlock page={tab} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
