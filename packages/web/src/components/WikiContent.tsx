import { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Eye, Calendar } from 'lucide-react';
import { WikiArticle, WIKI_ARTICLES, WIKI_CATEGORIES } from '../data/wiki';
import { fetchWikiArticles } from '../services/api';
import type { WikiArticleApi } from '../services/api';
import { ARTICLE_TO_ROLE, ROLE_STATS } from '../data/roleStats';
import { VIDEO_BY_ROLE } from '../data/roleVideos';
import RoleStatsCard from './RoleStatsCard';
import RoleVideoCard from './RoleVideoCard';

function apiToWikiArticle(a: WikiArticleApi): WikiArticle {
  return {
    id: a.id,
    title: a.title,
    category: a.category,
    content: a.content,
    excerpt: a.excerpt,
    tags: a.tags,
    author: a.source === 'hackmd' ? 'HackMD Archive' : 'Avalon Wiki',
    updatedAt: new Date('2024-01-01'),
    views: 0,
  };
}

interface WikiContentProps {
  selectedCategory?: string;
}

function renderArticleBody(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (line.startsWith('# ')) return `<h1 class="text-lg font-bold text-white mt-4 mb-2">${line.substring(2)}</h1>`;
      if (line.startsWith('## ')) return `<h2 class="text-base font-bold text-yellow-400 mt-3 mb-2">${line.substring(3)}</h2>`;
      if (line.startsWith('### ')) return `<h3 class="text-sm font-semibold text-gray-300 mt-2 mb-1">${line.substring(4)}</h3>`;
      if (line.startsWith('- ')) return `<li class="ml-4">${line.substring(2)}</li>`;
      if (line.startsWith('❌') || line.startsWith('✅')) return `<div class="flex items-start gap-2">${line}</div>`;
      if (line.startsWith('**') && line.endsWith('**')) return `<strong class="text-white">${line.substring(2, line.length - 2)}</strong>`;
      if (line.trim()) return `<p>${line}</p>`;
      return '';
    })
    .join('');
}

export default function WikiContent({ selectedCategory }: WikiContentProps): JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(selectedCategory || '');
  const [selectedArticle, setSelectedArticle] = useState<WikiArticle | null>(null);
  const [allArticles, setAllArticles] = useState<WikiArticle[]>(WIKI_ARTICLES);

  // Fetch wiki articles from API, merge with hardcoded
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const { articles } = await fetchWikiArticles();
        if (!cancelled && articles.length > 0) {
          const apiArticles = articles.map(apiToWikiArticle);
          // Merge: hardcoded first (they have better formatting), then API articles not already present
          const existingIds = new Set(WIKI_ARTICLES.map(a => a.title.toLowerCase()));
          const newArticles = apiArticles.filter(a => !existingIds.has(a.title.toLowerCase()));
          setAllArticles([...WIKI_ARTICLES, ...newArticles]);
        }
      } catch {
        // API not available, use hardcoded only
      }
    };
    void run();
    return (): void => { cancelled = true; };
  }, []);

  // Note: parent WikiPage uses `key={selectedCategory}` on this component, so a
  // new category prop remounts us and the useState(selectedCategory || '')
  // initializer handles sync — no effect needed.

  // Close modal on ESC
  useEffect(() => {
    if (!selectedArticle) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelectedArticle(null);
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [selectedArticle]);

  // Lock body scroll while modal open
  useEffect(() => {
    if (selectedArticle) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return (): void => { document.body.style.overflow = prev; };
    }
  }, [selectedArticle]);

  // 搜索和過濾文章
  const filteredArticles = useMemo(() => {
    return allArticles.filter((article) => {
      const matchesCategory = !activeCategory || article.category === activeCategory;
      const matchesSearch =
        !searchQuery ||
        article.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.excerpt.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, searchQuery, allArticles]);

  return (
    <div className="bg-gradient-to-b from-avalon-dark to-black p-4">
      <div className="max-w-6xl mx-auto space-y-6">
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

        {/* 文章列表 — 格狀，點擊用 modal 呈現（不跳走） */}
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredArticles.map((article, index) => (
              <motion.button
                key={article.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index * 0.03, 0.3) }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setSelectedArticle(article)}
                className="text-left p-4 rounded-lg border-2 transition-all bg-avalon-card/30 border-gray-600 hover:border-yellow-400 hover:bg-avalon-card/50"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="text-lg font-bold text-white mb-2">{article.title}</h3>
                    <p className="text-gray-300 text-sm mb-3 line-clamp-3">{article.excerpt}</p>
                    <div className="flex flex-wrap gap-2">
                      {article.tags.slice(0, 4).map((tag) => (
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
            ))}
          </div>
        )}
      </div>

      {/* Article Modal — 文章點開不跳頁，疊在當前 tab 上，關閉後回到列表 */}
      <AnimatePresence>
        {selectedArticle && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 flex items-start md:items-center justify-center p-3 md:p-6 overflow-y-auto"
            onClick={() => setSelectedArticle(null)}
            role="dialog"
            aria-modal="true"
            aria-label={selectedArticle.title}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-avalon-card border border-yellow-500 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto my-auto"
            >
              {/* Header (sticky) */}
              <div className="sticky top-0 z-10 flex items-start justify-between p-4 bg-avalon-card border-b border-gray-700">
                <h2 className="text-xl md:text-2xl font-bold text-white flex-1 pr-4">{selectedArticle.title}</h2>
                <button
                  onClick={() => setSelectedArticle(null)}
                  className="text-gray-400 hover:text-white shrink-0"
                  aria-label="Close article"
                >
                  <X size={24} />
                </button>
              </div>

              <div className="p-4 md:p-6">
                <div className="flex flex-wrap gap-4 text-xs text-gray-400 pb-4 border-b border-gray-700 mb-4">
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

                <div className="prose prose-invert max-w-none text-gray-200">
                  <div
                    className="space-y-4 text-sm leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: renderArticleBody(selectedArticle.content) }}
                  />
                </div>

                {/* Role stats card for character articles */}
                {ARTICLE_TO_ROLE[selectedArticle.id] && ROLE_STATS[ARTICLE_TO_ROLE[selectedArticle.id]] && (
                  <div className="mt-6">
                    <RoleStatsCard role={ROLE_STATS[ARTICLE_TO_ROLE[selectedArticle.id]]} />
                  </div>
                )}
                {/* Role short video */}
                {ARTICLE_TO_ROLE[selectedArticle.id] && VIDEO_BY_ROLE[ARTICLE_TO_ROLE[selectedArticle.id]] && (
                  <div className="mt-6">
                    <RoleVideoCard video={VIDEO_BY_ROLE[ARTICLE_TO_ROLE[selectedArticle.id]]} />
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
