import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, BarChart3, Users, Target, Swords, Map, Compass, Droplets, Shuffle, Crown } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import OverviewPanel from '../components/analysis/OverviewPanel';
import PlayerRadarChart from '../components/analysis/PlayerRadarChart';
import SeatHeatmap from '../components/analysis/SeatHeatmap';
import ChemistryMatrix from '../components/analysis/ChemistryMatrix';
import MissionAnalysis from '../components/analysis/MissionAnalysis';
import RoundsAnalysis from '../components/analysis/RoundsAnalysis';
import LakeAnalysis from '../components/analysis/LakeAnalysis';
import SeatOrderAnalysis from '../components/analysis/SeatOrderAnalysis';
import CaptainAnalysis from '../components/analysis/CaptainAnalysis';

type Tab = 'overview' | 'player' | 'seat' | 'chemistry' | 'mission' | 'rounds' | 'lake' | 'seatOrder' | 'captain';

const TABS: Array<{ id: Tab; label: string; icon: typeof BarChart3 }> = [
  { id: 'overview',   label: '總覽',       icon: BarChart3 },
  { id: 'player',     label: '玩家雷達',   icon: Users },
  { id: 'seat',       label: '座位分析',   icon: Map },
  { id: 'seatOrder',  label: '派梅娜順序', icon: Shuffle },
  { id: 'chemistry',  label: '默契矩陣',   icon: Target },
  { id: 'mission',    label: '任務分析',   icon: Swords },
  { id: 'rounds',     label: '回合分析',   icon: Compass },
  { id: 'lake',       label: '湖中女神',   icon: Droplets },
  { id: 'captain',    label: '隊長分析',   icon: Crown },
];

export default function AnalysisPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  return (
    <div className="min-h-screen p-4 pb-24">
      {/* Header */}
      <div className="max-w-5xl mx-auto mb-6">
        <div className="flex items-center gap-3 mb-4">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setGameState('home')}
            className="p-2 bg-avalon-card/50 rounded-lg border border-gray-600 hover:border-blue-400 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
          </motion.button>
          <div>
            <h1 className="text-2xl font-black text-white">
              數據分析 (Game Analysis)
            </h1>
            <p className="text-xs text-gray-500">2145+ 局實戰數據 from Google Sheets</p>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
                activeTab === id
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                  : 'bg-avalon-card/40 text-gray-400 hover:text-white hover:bg-avalon-card/60 border border-gray-700'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-5xl mx-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'overview' && <OverviewPanel />}
            {activeTab === 'player' && <PlayerRadarChart />}
            {activeTab === 'seat' && <SeatHeatmap />}
            {activeTab === 'chemistry' && <ChemistryMatrix />}
            {activeTab === 'mission' && <MissionAnalysis />}
            {activeTab === 'rounds' && <RoundsAnalysis />}
            {activeTab === 'lake' && <LakeAnalysis />}
            {activeTab === 'seatOrder' && <SeatOrderAnalysis />}
            {activeTab === 'captain' && <CaptainAnalysis />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
