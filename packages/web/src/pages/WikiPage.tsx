import { motion } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import WikiContent from '../components/WikiContent';
import { WIKI_CATEGORIES } from '../data/wiki';
import { BookOpen, Users, Lightbulb, ArrowLeft } from 'lucide-react';
import { useState } from 'react';

export default function WikiPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [selectedCategory, setSelectedCategory] = useState('');
  const [showContributeMsg, setShowContributeMsg] = useState(false);
  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black">
      {/* 返回按钮 */}
      <div className="absolute top-4 left-4">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setGameState('home')}
          className="flex items-center gap-2 bg-avalon-card/50 hover:bg-avalon-card/80 text-white px-4 py-2 rounded-lg border border-gray-600 transition-all"
        >
          <ArrowLeft size={18} />
          返回
        </motion.button>
      </div>

      {/* Hero 區域 */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-yellow-600/20 to-purple-600/20 border-b border-gray-700 p-8 mb-8"
      >
        <div className="max-w-6xl mx-auto text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <BookOpen size={32} className="text-yellow-400" />
            <h1 className="text-4xl md:text-5xl font-bold text-white">Avalon 百科 (Wiki)</h1>
          </div>
          <p className="text-gray-300 text-lg mb-8">
            完整的遊戲規則、角色指南、策略分析和常見問題解答 (Game rules, role guides, strategy analysis and FAQ)
          </p>

          {/* 快速統計 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <motion.div
              whileHover={{ scale: 1.05 }}
              className="bg-avalon-card/50 border border-gray-600 rounded-lg p-4"
            >
              <div className="text-2xl font-bold text-yellow-400">6</div>
              <div className="text-gray-400 text-sm">個文章分類 (categories)</div>
            </motion.div>
            <motion.div
              whileHover={{ scale: 1.05 }}
              className="bg-avalon-card/50 border border-gray-600 rounded-lg p-4"
            >
              <div className="text-2xl font-bold text-yellow-400">140+</div>
              <div className="text-gray-400 text-sm">篇詳細文章 (articles)</div>
            </motion.div>
            <motion.div
              whileHover={{ scale: 1.05 }}
              className="bg-avalon-card/50 border border-gray-600 rounded-lg p-4"
            >
              <div className="text-2xl font-bold text-yellow-400">100%</div>
              <div className="text-gray-400 text-sm">搜尋功能 (Search)</div>
            </motion.div>
          </div>

          {/* 分類快速導航 */}
          <div className="flex flex-wrap justify-center gap-3">
            {WIKI_CATEGORIES.map((category) => (
              <motion.button
                key={category.id}
                whileHover={{ scale: 1.05 }}
                onClick={() => {
                  setSelectedCategory(category.id);
                  document.getElementById('wiki-content')?.scrollIntoView({ behavior: 'smooth' });
                }}
                className={`inline-flex items-center gap-2 border px-4 py-2 rounded-lg transition-all ${
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
      </motion.div>

      {/* Wiki 內容 */}
      <div id="wiki-content">
        <WikiContent selectedCategory={selectedCategory} key={selectedCategory} />
      </div>

      {/* 貢獻提示 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/50 border-t border-gray-700 p-8 mt-12"
      >
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* 貢獻指南 */}
            <div>
              <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
                <Users size={24} />
                社群貢獻 (Community Contribution)
              </h2>
              <p className="text-gray-300 mb-4">
                幫助改進這個百科！您可以提交新文章或改進現有內容。(Help improve this wiki! You can submit new articles or improve existing content.)
              </p>
              <button
                onClick={() => setShowContributeMsg(v => !v)}
                className="bg-yellow-500 hover:bg-yellow-600 text-black font-bold py-2 px-6 rounded-lg transition-all"
              >
                提交貢獻 (Submit)
              </button>
              {showContributeMsg && (
                <p className="text-sm text-yellow-300 mt-2">
                  歡迎到 GitHub 提交 PR 或在遊戲內點選「回報問題」提交建議！
                </p>
              )}
            </div>

            {/* 提示 */}
            <div>
              <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
                <Lightbulb size={24} />
                遊戲提示 (Game Tips)
              </h2>
              <p className="text-gray-300 mb-4">
                新手玩家？從「遊戲規則 (Rules)」開始，然後探索「角色指南 (Roles)」以瞭解各個角色！(New player? Start with Rules, then explore the Role Guide!)
              </p>
              <button
                onClick={() => {
                  setSelectedCategory('rules');
                  document.getElementById('wiki-content')?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-6 rounded-lg transition-all"
              >
                新手指南 (Beginner Guide)
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
