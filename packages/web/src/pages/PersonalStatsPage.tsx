import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, BarChart3, History, Users, Swords } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import ProfilePage from './ProfilePage';

/**
 * #86 IA v3 — 2026-04-23 拆頁：個人戰績頁。
 *
 * 大廳「個人戰績」按鈕的終點頁；內容為：
 * - 歷史戰績 (= ProfilePage 既有戰績卡/牌譜列表/ELO 趨勢圖 / 角色勝率 等)
 * - 追蹤列表 (placeholder — TODO Phase 2)
 * - 追蹤對戰成績 (placeholder — TODO Phase 2)
 *
 * 為避免複製 ProfilePage 裡上千行戰績 / 牌譜邏輯，這裡直接 render ProfilePage
 * 作為歷史戰績區塊；header 上方加入頁面識別 + 追蹤列表 / 對戰成績 的 coming-soon
 * 區塊，之後 Phase 2 補實內容。
 */
export default function PersonalStatsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState } = useGameStore();

  return (
    <div className="min-h-screen bg-black">
      {/* Page-level header — identifies this as 個人戰績頁，保留 ProfilePage 內部的返回按鈕
          只是返回主頁（onClick=home）也會把這頁一起關掉，所以加一層 header 方便使用者辨識。 */}
      <div className="max-w-lg mx-auto px-4 pt-4 space-y-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            data-testid="personal-stats-btn-back"
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
            aria-label={t('nav.back')}
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-black text-white flex-1">{t('nav.personalStats')}</h1>
          <button
            onClick={() => setGameState('analytics')}
            data-testid="personal-stats-btn-analytics"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white transition-colors"
            title={t('home.analytics')}
          >
            <BarChart3 size={14} />
            {t('home.analytics')}
          </button>
        </div>
      </div>

      {/* 歷史戰績 — 直接沿用 ProfilePage；它自帶 header / 牌譜 / ELO trend / 角色統計 */}
      <ProfilePage />

      {/* 追蹤列表 / 追蹤對戰成績 — placeholder 區塊 */}
      <div className="max-w-lg mx-auto px-4 pb-12 space-y-4">
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-zinc-900/60 border border-zinc-700 rounded-xl p-6"
        >
          <div className="flex items-center gap-3 mb-3">
            <Users size={18} className="text-white" />
            <h2 className="text-lg font-bold text-white">{t('settings.watchlist')}</h2>
          </div>
          <p className="text-sm text-zinc-500">{t('settings.comingSoon')}</p>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-zinc-900/60 border border-zinc-700 rounded-xl p-6"
        >
          <div className="flex items-center gap-3 mb-3">
            <Swords size={18} className="text-white" />
            <h2 className="text-lg font-bold text-white">{t('settings.pairStats')}</h2>
          </div>
          <p className="text-sm text-zinc-500">{t('settings.comingSoon')}</p>
        </motion.section>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-center text-xs text-zinc-600 pt-2 flex items-center justify-center gap-1.5"
        >
          <History size={12} />
          {t('personalStats.footerHint')}
        </motion.div>
      </div>
    </div>
  );
}
