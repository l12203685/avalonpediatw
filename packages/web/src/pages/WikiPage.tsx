import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import WikiContent from '../components/WikiContent';
import StreamsSection from '../components/StreamsSection';
import { WIKI_CATEGORIES } from '../data/wiki';
import { BookOpen, Users, Lightbulb, ArrowLeft, BarChart3, Youtube } from 'lucide-react';
import { useState } from 'react';
import { TOTAL_UNIQUE_GAMES } from '../data/roleStats';

type WikiTab = 'articles' | 'streams';

export default function WikiPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [activeTab, setActiveTab] = useState<WikiTab>('articles');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [showContributeMsg, setShowContributeMsg] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black">
      {/* 返回按钮 */}
      <div className="absolute top-3 left-3 z-20">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setGameState('home')}
          className="flex items-center gap-1.5 bg-avalon-card/50 hover:bg-avalon-card/80 text-white text-sm px-3 py-1.5 rounded-lg border border-gray-600 transition-all"
        >
          <ArrowLeft size={16} />
          返回
        </motion.button>
      </div>

      {/* Hero 區域 */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-yellow-600/20 to-amber-600/20 border-b border-gray-700 px-5 py-4"
      >
        <div className="max-w-6xl mx-auto text-center">
          <div className="flex items-center justify-center gap-2 mb-1">
            <BookOpen size={24} className="text-yellow-400" />
            <h1 className="text-2xl md:text-3xl font-bold text-white">Avalon 百科</h1>
          </div>
          <p className="text-gray-300 text-sm mb-3">
            完整的遊戲規則、角色指南、策略分析、實戰直播與數據回放
          </p>

          {/* 快速統計 */}
          <div className="grid grid-cols-3 gap-2">
            <motion.div
              whileHover={{ scale: 1.05 }}
              className="bg-avalon-card/50 border border-gray-600 rounded-lg px-3 py-2"
            >
              <div className="text-lg font-bold text-yellow-400 leading-tight">6</div>
              <div className="text-gray-400 text-xs leading-tight">個文章分類</div>
            </motion.div>
            <motion.div
              whileHover={{ scale: 1.05 }}
              className="bg-avalon-card/50 border border-gray-600 rounded-lg px-3 py-2"
            >
              <div className="text-lg font-bold text-yellow-400 leading-tight">140+</div>
              <div className="text-gray-400 text-xs leading-tight">篇詳細文章</div>
            </motion.div>
            <motion.div
              whileHover={{ scale: 1.05 }}
              className="bg-avalon-card/50 border border-gray-600 rounded-lg px-3 py-2"
            >
              <div className="text-lg font-bold text-yellow-400 leading-tight">{TOTAL_UNIQUE_GAMES.toLocaleString()}</div>
              <div className="text-gray-400 text-xs leading-tight">局實戰數據</div>
            </motion.div>
          </div>
        </div>
      </motion.div>

      {/* Tab 切換 — sticky 讓使用者在內容深處仍可切換 */}
      <div className="sticky top-0 z-10 bg-avalon-dark/95 backdrop-blur-sm border-b border-gray-700">
        <div className="max-w-6xl mx-auto px-4 py-2 flex flex-wrap gap-2">
          <button
            onClick={() => setActiveTab('articles')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
              activeTab === 'articles'
                ? 'bg-yellow-500 text-black shadow-lg'
                : 'bg-avalon-card/50 text-gray-300 hover:bg-avalon-card border border-gray-600'
            }`}
          >
            <BookOpen size={16} />
            阿瓦隆百科文章
          </button>
          <button
            onClick={() => setActiveTab('streams')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
              activeTab === 'streams'
                ? 'bg-yellow-500 text-black shadow-lg'
                : 'bg-avalon-card/50 text-gray-300 hover:bg-avalon-card border border-gray-600'
            }`}
          >
            <Youtube size={16} />
            線上實戰直播 & 數據分析回放
          </button>
        </div>
      </div>

      {/* Tab 內容 */}
      <AnimatePresence mode="wait">
        {activeTab === 'articles' ? (
          <motion.div
            key="articles"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
          >
            {/* 分類快速導航（只在文章 tab 顯示） */}
            <div className="max-w-6xl mx-auto px-4 pt-3">
              <div className="flex flex-wrap justify-center gap-2">
                {WIKI_CATEGORIES.map((category) => (
                  <motion.button
                    key={category.id}
                    whileHover={{ scale: 1.05 }}
                    onClick={() => setSelectedCategory(category.id)}
                    className={`inline-flex items-center gap-1.5 border px-3 py-1.5 rounded-lg text-sm transition-all ${
                      selectedCategory === category.id
                        ? 'bg-yellow-500 text-black border-yellow-500'
                        : 'bg-yellow-500/20 hover:bg-yellow-500/40 border-yellow-600/50 text-yellow-300'
                    }`}
                  >
                    <span>{category.icon}</span>
                    {category.name}
                  </motion.button>
                ))}
              </div>
            </div>

            {/* Wiki 文章列表 + modal 呈現（不跳頁） */}
            <div id="wiki-content">
              <WikiContent selectedCategory={selectedCategory} key={selectedCategory} />
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="streams"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
          >
            {/* 直播回顧 */}
            <StreamsSection />

            {/* 進入數據分析頁的入口 */}
            <div className="max-w-6xl mx-auto px-4 pb-5">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setGameState('analysis')}
                className="w-full bg-gradient-to-r from-blue-600/30 to-amber-600/30 hover:from-blue-600/50 hover:to-amber-600/50 border border-blue-500/50 rounded-lg p-3 text-left transition-all group"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-500/20 rounded-lg border border-blue-400/40 shrink-0">
                    <BarChart3 size={22} className="text-blue-300" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-bold text-white leading-tight">
                      完整數據分析 →
                    </h3>
                    <p className="text-xs text-gray-300 leading-snug mt-0.5">
                      {TOTAL_UNIQUE_GAMES.toLocaleString()} 局實戰：總覽 / 玩家雷達 / 座位 / 默契 / 任務 / 回合 / 湖中女神 / 隊長分析
                    </p>
                  </div>
                </div>
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 貢獻提示 — 全頁底部 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/50 border-t border-gray-700 px-5 py-4 mt-6"
      >
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 貢獻指南 */}
            <div>
              <h2 className="text-base font-bold text-white mb-1.5 flex items-center gap-1.5">
                <Users size={18} />
                社群貢獻
              </h2>
              <p className="text-sm text-gray-300 mb-2 leading-snug">
                幫助改進這個百科！您可以提交新文章或改進現有內容。
              </p>
              <button
                onClick={() => setShowContributeMsg(v => !v)}
                className="bg-yellow-500 hover:bg-yellow-600 text-black text-sm font-bold py-1.5 px-4 rounded-lg transition-all"
              >
                提交貢獻
              </button>
              {showContributeMsg && (
                <p className="text-xs text-yellow-300 mt-1.5 leading-snug">
                  歡迎到 GitHub 提交 PR 或在遊戲內點選「回報問題」提交建議！
                </p>
              )}
            </div>

            {/* 提示 */}
            <div>
              <h2 className="text-base font-bold text-white mb-1.5 flex items-center gap-1.5">
                <Lightbulb size={18} />
                遊戲提示
              </h2>
              <p className="text-sm text-gray-300 mb-2 leading-snug">
                新手玩家？從「遊戲規則」開始，然後探索「角色指南」以瞭解各個角色！
              </p>
              <button
                onClick={() => {
                  setActiveTab('articles');
                  setSelectedCategory('rules');
                  document.getElementById('wiki-content')?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold py-1.5 px-4 rounded-lg transition-all"
              >
                新手指南
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
