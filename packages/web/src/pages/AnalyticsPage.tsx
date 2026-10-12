import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Trophy, BarChart3, Crown, Vote, Swords, Droplets, Crosshair, Map, Users, Radar,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import OverviewPanel from '../components/analysis/OverviewPanel';
import PlayerRadarChart from '../components/analysis/PlayerRadarChart';
import SeatHeatmap from '../components/analysis/SeatHeatmap';
import SeatPositionChart from '../components/analysis/SeatPositionChart';
import ChemistryMatrix from '../components/analysis/ChemistryMatrix';
import RoleFinalWinRates from '../components/analysis/RoleFinalWinRates';
import MissionAnalysis from '../components/analysis/MissionAnalysis';
import RoundsAnalysis from '../components/analysis/RoundsAnalysis';
import LakeAnalysis from '../components/analysis/LakeAnalysis';
import SeatOrderAnalysis from '../components/analysis/SeatOrderAnalysis';
import CaptainAnalysis from '../components/analysis/CaptainAnalysis';
import AssassinationCard from '../components/analysis/AssassinationCard';
import LeaderboardBoards from '../components/analysis/LeaderboardBoards';
import { useAnalysisOverview } from '../components/analysis/useAnalysisOverview';
import { FeatureStudyCard } from '../components/analytics/FeatureStudiesPanel';
import LeaderboardV3Table from '../components/LeaderboardV3Table';

/**
 * #98 (2026-04-23) IA 重整：數據排行頁拆成兩大區 —
 *  - 勝率排行 (ELO Leaderboard)：原本 LeaderboardPage 的排名清單；點玩家彈出雷達彈窗
 *  - 深度分析 (Deep Analysis)：把 AnalysisPage 的分頁內容直接搬進來
 * 「玩家雷達」不再獨立 tab，融進勝率排行的點擊體驗。
 *
 * (2026-04-27) 新增第三 tab「特徵研究」: 把 v7 features 研究 (loops 136/139/141/
 * 142/143) 萃取成可瀏覽的玩家信號頁。
 *
 * (2026-04-27 23:42 batch) Edward「ELO 分數可以直接列在表上, 傳統排行就不用顯示了」
 *   - V3 表加入 ELO 欄 (從 V2 endpoint join), 砍「分層瀏覽 (5 組 ELO 分層)」collapse
 *
 * (2026-10-12 兩段結算 / 排行改版, docs/stats/two_stage_outcome.md)
 *   top tab 改成兩個：
 *   - 排行：上方 LeaderboardBoards (/api/analysis/leaderboard：超額勝率 main 榜 +
 *     近 90 天 / 進步 / 本週刺殺 / 新人 / 上月角色稱號小卡)，下方保留 LeaderboardV3Table
 *   - 分析：子分頁依玩家決策分區 — 總覽、派隊、投票、任務、湖中女神、刺殺、位置、
 *     角色與默契、玩家雷達；原「特徵研究」五張卡依主題放進對應分頁 (預設展開)
 *   副標的場數改讀 overview.totalGames，不再寫死。
 *   「玩家雷達」(PlayerRadarChart，讀 /players/:name 的新 radar 契約) 原本掛在已刪除的
 *   AnalysisPage，改為「分析」的最後一個子分頁，不然雷達改版沒有入口。
 * LeaderboardPage 仍保留供 'leaderboard' route 用作備援/Alternative entry。
 */
type TopTab = 'boards' | 'analysis';
type AnalysisTab =
  | 'overview' | 'teams' | 'votes' | 'missions'
  | 'lake' | 'assassination' | 'position' | 'roles' | 'players';

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
  { id: 'players',       labelKey: 'analytics.analysis.tabs.players',       icon: Radar },
];

export default function AnalyticsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState } = useGameStore();
  const [activeTab, setActiveTab] = useState<TopTab>('boards');

  return (
    <div className="min-h-screen bg-black p-4 pb-24">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setGameState('home')}
            className="p-2 bg-zinc-900/70 rounded-lg border border-zinc-700 hover:border-white text-zinc-300 hover:text-white transition-colors"
            aria-label={t('nav.back')}
          >
            <ArrowLeft size={20} />
          </motion.button>
          <h1 className="text-2xl font-black text-white">{t('nav.analytics')}</h1>
        </div>

        {/* Top-level tabs (2 tabs) */}
        <div className="flex flex-wrap gap-2 mb-6 border-b border-zinc-800 pb-2">
          <TopTabButton
            active={activeTab === 'boards'}
            onClick={() => setActiveTab('boards')}
            icon={Trophy}
            label={t('analytics.tab.boards')}
          />
          <TopTabButton
            active={activeTab === 'analysis'}
            onClick={() => setActiveTab('analysis')}
            icon={BarChart3}
            label={t('analytics.tab.analysis')}
          />
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'boards'   && <BoardsSection />}
            {activeTab === 'analysis' && <AnalysisSection />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function TopTabButton({
  active, onClick, icon: Icon, label,
}: { active: boolean; onClick: () => void; icon: typeof Trophy; label: string }): JSX.Element {
  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-colors ${
        active
          ? 'bg-white text-black'
          : 'bg-zinc-900/70 border border-zinc-700 text-zinc-300 hover:border-white hover:text-white'
      }`}
    >
      <Icon size={16} />
      {label}
    </motion.button>
  );
}

// ──────────────────────────────────────────────────────────────
// 排行：超額勝率排行 (LeaderboardBoards) + 精算榜 (V3 8-metric)
// ──────────────────────────────────────────────────────────────

function BoardsSection(): JSX.Element {
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

// ──────────────────────────────────────────────────────────────
// 分析：子分頁依玩家決策分區
// ──────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <h2 className="text-sm font-bold text-zinc-400 mb-2 mt-1 tracking-wide">{children}</h2>
  );
}

function AnalysisSection(): JSX.Element {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<AnalysisTab>('overview');
  const { overview } = useAnalysisOverview();
  const totalGames = overview?.totalGames;

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
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {tab === 'overview'      && <OverviewPanel />}
          {tab === 'teams'         && <TeamsTab />}
          {tab === 'votes'         && <VotesTab />}
          {tab === 'missions'      && <MissionAnalysis />}
          {tab === 'lake'          && <LakeTab />}
          {tab === 'assassination' && <AssassinationTab />}
          {tab === 'position'      && <PositionTab />}
          {tab === 'roles'         && <RolesTab />}
          {tab === 'players'       && <PlayerRadarChart />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** 派隊：隊長分析 + 1-1 派票 (RoundsAnalysis) + L139 (forced P5，選擇偏誤)。 */
function TeamsTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <div>
        <SectionTitle>{t('analytics.analysis.section.captain')}</SectionTitle>
        <CaptainAnalysis />
      </div>
      <div>
        <SectionTitle>{t('analytics.analysis.section.firstVote')}</SectionTitle>
        <RoundsAnalysis />
      </div>
      <div>
        <SectionTitle>{t('analytics.analysis.section.feature')}</SectionTitle>
        <FeatureStudyCard loopId="L139" defaultOpen />
      </div>
    </div>
  );
}

/** 投票：目前只有改隊後翻轉率 (L136) 一項。 */
function VotesTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500 leading-relaxed">{t('analytics.analysis.votesNote')}</p>
      <FeatureStudyCard loopId="L136" defaultOpen />
    </div>
  );
}

/** 湖中女神：LakeAnalysis + L141 (宣告可信度) + L142 (言行一致度)。 */
function LakeTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <LakeAnalysis />
      <div className="space-y-4">
        <SectionTitle>{t('analytics.analysis.section.feature')}</SectionTitle>
        <FeatureStudyCard loopId="L141" defaultOpen />
        <FeatureStudyCard loopId="L142" defaultOpen />
      </div>
    </div>
  );
}

/** 刺殺：刺殺結算卡 + L143 (刺客目標座位偏好)。 */
function AssassinationTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <AssassinationCard />
      <div>
        <SectionTitle>{t('analytics.analysis.section.feature')}</SectionTitle>
        <FeatureStudyCard loopId="L143" defaultOpen />
      </div>
    </div>
  );
}

/** 位置：座位熱圖 + 位置勝率圖 (從總覽搬來) + 派梅娜順序。 */
function PositionTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <div>
        <SectionTitle>{t('analytics.analysis.section.seatHeatmap')}</SectionTitle>
        <SeatHeatmap />
      </div>
      <SeatPositionChart />
      <div>
        <SectionTitle>{t('analytics.analysis.section.seatOrder')}</SectionTitle>
        <SeatOrderAnalysis />
      </div>
    </div>
  );
}

/** 角色與默契：默契矩陣 + 各角色最終勝率表 (舊快取沒有時隱藏)。 */
function RolesTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <RoleFinalWinRates />
      <div>
        <SectionTitle>{t('analytics.analysis.section.chemistry')}</SectionTitle>
        <ChemistryMatrix />
      </div>
    </div>
  );
}
