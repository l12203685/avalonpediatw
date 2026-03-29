import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Search, X, Eye, Calendar } from 'lucide-react';
import { WikiArticle, WIKI_ARTICLES, WIKI_CATEGORIES } from '../data/wiki';

interface WikiContentProps {
  selectedCategory?: string;
}

export default function WikiContent({ selectedCategory }: WikiContentProps): JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(selectedCategory || '');
  const [selectedArticle, setSelectedArticle] = useState<WikiArticle | null>(null);

  // 搜索和過濾文章
  const filteredArticles = useMemo(() => {
    return WIKI_ARTICLES.filter((article) => {
      const matchesCategory = !activeCategory || article.category === activeCategory;
      const matchesSearch =
        !searchQuery ||
        article.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.excerpt.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, searchQuery]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black p-4">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* 搜索欄 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative"
        >
          <div className="relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜尋百科內容 (Search wiki)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-avalon-card/50 border border-gray-600 rounded-lg pl-12 pr-4 py-3 text-white placeholder-gray-400 focus:border-yellow-400 focus:outline-none transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white"
              >
                <X size={20} />
              </button>
            )}
          </div>
        </motion.div>

        {/* 分類過濾 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="flex flex-wrap gap-3"
        >
          <button
            onClick={() => setActiveCategory('')}
            className={`px-4 py-2 rounded-lg font-semibold transition-all ${
              !activeCategory
                ? 'bg-yellow-500 text-black shadow-lg'
                : 'bg-avalon-card/50 text-gray-300 hover:bg-avalon-card border border-gray-600'
            }`}
          >
            全部 (All)
          </button>

          {WIKI_CATEGORIES.map((category) => (
            <button
              key={category.id}
              onClick={() => setActiveCategory(category.id)}
              className={`px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 ${
                activeCategory === category.id
                  ? 'bg-yellow-500 text-black shadow-lg'
                  : 'bg-avalon-card/50 text-gray-300 hover:bg-avalon-card border border-gray-600'
              }`}
            >
              <span>{category.icon}</span>
              {category.name}
            </button>
          ))}
        </motion.div>

        {/* 搜索結果提示 */}
        {searchQuery && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-gray-400"
          >
            找到 (Found) <span className="text-yellow-400 font-bold">{filteredArticles.length}</span> 篇文章 (articles)
          </motion.div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* 文章列表 */}
          <div className="lg:col-span-2 space-y-4">
            {filteredArticles.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center py-12"
              >
                <p className="text-gray-400 text-lg">未找到相關文章 (No articles found)</p>
                <p className="text-gray-500 text-sm mt-2">試試其他搜尋詞或選擇不同的分類 (Try different keywords or select another category)</p>
              </motion.div>
            ) : (
              filteredArticles.map((article, index) => (
                <motion.button
                  key={article.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  onClick={() => setSelectedArticle(article)}
                  className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                    selectedArticle?.id === article.id
                      ? 'bg-yellow-500/20 border-yellow-500'
                      : 'bg-avalon-card/30 border-gray-600 hover:border-yellow-400 hover:bg-avalon-card/50'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="text-lg font-bold text-white mb-2">{article.title}</h3>
                      <p className="text-gray-300 text-sm mb-3">{article.excerpt}</p>
                      <div className="flex flex-wrap gap-2">
                        {article.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-block bg-gray-700/50 text-gray-200 text-xs px-2 py-1 rounded"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-400 mt-3 pt-3 border-t border-gray-700">
                    <div className="flex items-center gap-1">
                      <Eye size={14} />
                      {article.views.toLocaleString()} 次閱讀 (views)
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar size={14} />
                      {article.updatedAt.toLocaleDateString('zh-TW')}
                    </div>
                  </div>
                </motion.button>
              ))
            )}
          </div>

          {/* 文章詳情 */}
          <div className="lg:col-span-1">
            {selectedArticle ? (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-avalon-card/50 border border-yellow-500 rounded-lg p-6 sticky top-4 max-h-[calc(100vh-100px)] overflow-y-auto"
              >
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-2xl font-bold text-white flex-1">{selectedArticle.title}</h2>
                    <button
                      onClick={() => setSelectedArticle(null)}
                      className="text-gray-400 hover:text-white"
                    >
                      <X size={24} />
                    </button>
                  </div>

                  {/* 文章元數據 */}
                  <div className="flex flex-wrap gap-4 text-xs text-gray-400 pb-4 border-b border-gray-700">
                    <div className="flex items-center gap-1">
                      <Eye size={14} />
                      {selectedArticle.views.toLocaleString()}
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar size={14} />
                      {selectedArticle.updatedAt.toLocaleDateString('zh-TW')}
                    </div>
                    <span>{selectedArticle.author}</span>
                  </div>
                </div>

                {/* 文章內容 */}
                <div className="prose prose-invert max-w-none text-gray-200">
                  <div
                    className="space-y-4 text-sm leading-relaxed"
                    dangerouslySetInnerHTML={{
                      __html: selectedArticle.content
                        .split('\n')
                        .map((line) => {
                          // 簡單的 Markdown 支持
                          if (line.startsWith('# ')) {
                            return `<h1 class="text-lg font-bold text-white mt-4 mb-2">${line.substring(2)}</h1>`;
                          } else if (line.startsWith('## ')) {
                            return `<h2 class="text-base font-bold text-yellow-400 mt-3 mb-2">${line.substring(3)}</h2>`;
                          } else if (line.startsWith('### ')) {
                            return `<h3 class="text-sm font-semibold text-gray-300 mt-2 mb-1">${line.substring(4)}</h3>`;
                          } else if (line.startsWith('- ')) {
                            return `<li class="ml-4">${line.substring(2)}</li>`;
                          } else if (line.startsWith('❌') || line.startsWith('✅')) {
                            return `<div class="flex items-start gap-2">${line}</div>`;
                          } else if (line.startsWith('**') && line.endsWith('**')) {
                            return `<strong class="text-white">${line.substring(2, line.length - 2)}</strong>`;
                          } else if (line.trim()) {
                            return `<p>${line}</p>`;
                          }
                          return '';
                        })
                        .join(''),
                    }}
                  />
                </div>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="bg-avalon-card/50 border border-gray-600 rounded-lg p-6 text-center text-gray-400 sticky top-4"
              >
                <p className="text-sm">選擇一篇文章查看詳細內容 (Select an article to read)</p>
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
