import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Trophy, BarChart3, Crown,
  Target, Swords, Map, Compass, Droplets, Shuffle, Microscope,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import OverviewPanel from '../components/analysis/OverviewPanel';
import SeatHeatmap from '../components/analysis/SeatHeatmap';
import ChemistryMatrix from '../components/analysis/ChemistryMatrix';
import MissionAnalysis from '../components/analysis/MissionAnalysis';
import RoundsAnalysis from '../components/analysis/RoundsAnalysis';
import LakeAnalysis from '../components/analysis/LakeAnalysis';
import SeatOrderAnalysis from '../components/analysis/SeatOrderAnalysis';
import CaptainAnalysis from '../components/analysis/CaptainAnalysis';
import FeatureStudiesPanel from '../components/analytics/FeatureStudiesPanel';
import LeaderboardV3Table from '../components/LeaderboardV3Table';

/**
 * #98 (2026-04-23) IA 重整：數據排行頁拆成兩大區 —
 *  - 勝率排行 (ELO Leaderboard)：原本 LeaderboardPage 的排名清單；點玩家彈出雷達彈窗
 *  - 深度分析 (Deep Analysis)：把 AnalysisPage 的分頁內容直接搬進來
 * 「玩家雷達」不再獨立 tab，融進勝率排行的點擊體驗。
 *
 * (2026-04-27) 新增第三 tab「特徵研究」: 把 v7 features 研究 (loops 136/139/141/
 * 142/143) 萃取成可瀏覽的玩家信號頁。前 2 張 card 預設展開, 後 3 張收合。
 *
 * (2026-04-27 18:05 整合) Edward「features 跟原本的數據分析怎麼不見了」—
 * AnalyticsPage 三 tab 結構保留: 精算榜 + 深度分析 + 特徵研究。
 *
 * (2026-04-27 23:42 batch) Edward「ELO 分數可以直接列在表上, 傳統排行就不用顯示了」
 *   - V3 表加入 ELO 欄 (從 V2 endpoint join), 砍「分層瀏覽 (5 組 ELO 分層)」collapse
 *   - 第二 tab「深度分析」: 不動 (DeepAnalysisSection 內容保留)
 *   - 第三 tab「特徵研究」: 不動 (FeatureStudiesPanel 保留)
 * LeaderboardPage 仍保留供 'leaderboard' route 用作備援/Alternative entry。
 */
type TopTab = 'leaderboard' | 'deepAnalysis' | 'featureStudies';
type DeepTab =
  | 'overview' | 'seat' | 'seatOrder' | 'chemistry'
  | 'mission' | 'rounds' | 'lake' | 'captain';

interface DeepTabDef { id: DeepTab; labelKey: string; icon: typeof BarChart3 }

// Tab labels are sourced from i18n so the bilingual switch covers them.
const DEEP_TABS: DeepTabDef[] = [
  { id: 'overview',   labelKey: 'analytics.deep.tabs.overview',   icon: BarChart3 },
  { id: 'seat',       labelKey: 'analytics.deep.tabs.seat',       icon: Map },
  { id: 'seatOrder',  labelKey: 'analytics.deep.tabs.seatOrder',  icon: Shuffle },
  { id: 'chemistry',  labelKey: 'analytics.deep.tabs.chemistry',  icon: Target },
  { id: 'mission',    labelKey: 'analytics.deep.tabs.mission',    icon: Swords },
  { id: 'rounds',     labelKey: 'analytics.deep.tabs.rounds',     icon: Compass },
  { id: 'lake',       labelKey: 'analytics.deep.tabs.lake',       icon: Droplets },
  { id: 'captain',    labelKey: 'analytics.deep.tabs.captain',    icon: Crown },
];

export default function AnalyticsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState } = useGameStore();
  const [activeTab, setActiveTab] = useState<TopTab>('leaderboard');

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

        {/* Top-level tabs (3 tabs) */}
        <div className="flex flex-wrap gap-2 mb-6 border-b border-zinc-800 pb-2">
          <TopTabButton
            active={activeTab === 'leaderboard'}
            onClick={() => setActiveTab('leaderboard')}
            icon={Trophy}
            label={t('analytics.tab.leaderboard')}
          />
          <TopTabButton
            active={activeTab === 'deepAnalysis'}
            onClick={() => setActiveTab('deepAnalysis')}
            icon={BarChart3}
            label={t('analytics.tab.deepAnalysis')}
          />
          <TopTabButton
            active={activeTab === 'featureStudies'}
            onClick={() => setActiveTab('featureStudies')}
            icon={Microscope}
            label={t('analytics.tab.featureStudies')}
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
            {activeTab === 'leaderboard'    && <PrecisionBoardSection />}
            {activeTab === 'deepAnalysis'   && <DeepAnalysisSection />}
            {activeTab === 'featureStudies' && <FeatureStudiesPanel />}
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
// 精算榜 (V3 8-metric) — Edward 2026-04-27 砍「分層瀏覽」collapse,
// ELO 分數已直接列在 V3 表中。
// ──────────────────────────────────────────────────────────────

function PrecisionBoardSection(): JSX.Element {
  return (
    <div className="space-y-6">
      <LeaderboardV3Table />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 深度分析：把 AnalysisPage 的子面板展開在這裡
// ──────────────────────────────────────────────────────────────

function DeepAnalysisSection(): JSX.Element {
  const { t } = useTranslation('common');
  const [deepTab, setDeepTab] = useState<DeepTab>('overview');
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-3">
        {t('analytics.deep.subtitle', { count: 2145 })} · {t('analytics.deep.subtitleSource')}
      </p>
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 scrollbar-hide">
        {DEEP_TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setDeepTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
              deepTab === id
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
          key={deepTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {deepTab === 'overview'   && <OverviewPanel />}
          {deepTab === 'seat'       && <SeatHeatmap />}
          {deepTab === 'chemistry'  && <ChemistryMatrix />}
          {deepTab === 'mission'    && <MissionAnalysis />}
          {deepTab === 'rounds'     && <RoundsAnalysis />}
          {deepTab === 'lake'       && <LakeAnalysis />}
          {deepTab === 'seatOrder'  && <SeatOrderAnalysis />}
          {deepTab === 'captain'    && <CaptainAnalysis />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
