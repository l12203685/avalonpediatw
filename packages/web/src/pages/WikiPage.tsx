import { motion } from 'framer-motion';
import WikiContent from '../components/WikiContent';
import { Users, Lightbulb } from 'lucide-react';
import { useState } from 'react';

/**
 * 百科攻略頁。2026-10-30 Edward：頂端的「Avalon 百科」標題與三格統計拿掉（直接看內容）；
 * 「線上實戰直播 & 數據分析回放」搬成導覽列自己的頁籤（StreamsPage）。
 */
export default function WikiPage(): JSX.Element {
  const [selectedCategory, setSelectedCategory] = useState('');
  const [showContributeMsg, setShowContributeMsg] = useState(false);

  return (
    <div className="min-h-screen">
      {/* Wiki 文章（心智圖／列表）+ modal 呈現（不跳頁） — 分類 chip 在 WikiContent 內 */}
      <div id="wiki-content">
        <WikiContent selectedCategory={selectedCategory} key={selectedCategory} />
      </div>

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
