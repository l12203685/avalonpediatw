import { useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Trophy, Users, Bot, BarChart3 } from 'lucide-react';
import { useGameStore } from '../store/gameStore';

type AnalyticsTab = 'leaderboard' | 'radar' | 'aiSelfplay' | 'deepAnalysis';

interface TabConfig {
  id: AnalyticsTab;
  labelKey: string;
  icon: typeof Trophy;
}

const TABS: TabConfig[] = [
  { id: 'leaderboard',   labelKey: 'analytics.tab.leaderboard',   icon: Trophy },
  { id: 'radar',         labelKey: 'analytics.tab.radar',         icon: Users },
  { id: 'aiSelfplay',    labelKey: 'analytics.tab.aiSelfplay',    icon: Bot },
  { id: 'deepAnalysis',  labelKey: 'analytics.tab.deepAnalysis',  icon: BarChart3 },
];

export default function AnalyticsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState } = useGameStore();
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('leaderboard');

  return (
    <div className="min-h-screen bg-black p-4 pb-24">
      <div className="max-w-5xl mx-auto">
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

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-6 border-b border-zinc-800 pb-2">
          {TABS.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <motion.button
                key={tab.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-colors ${
                  isActive
                    ? 'bg-white text-black'
                    : 'bg-zinc-900/70 border border-zinc-700 text-zinc-300 hover:border-white hover:text-white'
                }`}
              >
                <Icon size={16} />
                {t(tab.labelKey)}
              </motion.button>
            );
          })}
        </div>

        {/* Placeholder content */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-zinc-900/60 border border-zinc-700 rounded-xl p-12 text-center"
        >
          <p className="text-zinc-400 text-lg">{t('settings.comingSoon')}</p>
          <p className="text-zinc-600 text-sm mt-2">
            {t(TABS.find(x => x.id === activeTab)?.labelKey ?? 'analytics.tab.leaderboard')}
          </p>
        </motion.div>
      </div>
    </div>
  );
}
