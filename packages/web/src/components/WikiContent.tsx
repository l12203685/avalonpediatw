import { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Search, X, Eye, Calendar, ChevronDown, ChevronUp, Loader } from 'lucide-react';
import { WikiArticle, WIKI_ARTICLES, WIKI_CATEGORIES } from '../data/wiki';
import { fetchWikiArticles } from '../services/api';
import type { WikiArticleApi } from '../services/api';
import { ARTICLE_TO_ROLE, ROLE_STATS } from '../data/roleStats';
import RoleStatsCard from './RoleStatsCard';

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

export default function WikiContent({ selectedCategory }: WikiContentProps): JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(selectedCategory || '');
  const [selectedArticle, setSelectedArticle] = useState<WikiArticle | null>(null);
  const [mobileListExpanded, setMobileListExpanded] = useState(true);
  const [allArticles, setAllArticles] = useState<WikiArticle[]>(WIKI_ARTICLES);
  const [wikiLoading, setWikiLoading] = useState(true);

  // Fetch wiki articles from API, merge with hardcoded
  useEffect(() => {
    let cancelled = false;
    (async () => {
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
      } finally {
        if (!cancelled) setWikiLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

        {/* Mobile: show article content first when selected */}
        {selectedArticle && (
          <div className="lg:hidden">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-avalon-card/50 border border-yellow-500 rounded-lg p-4 max-h-[70vh] overflow-y-auto"
            >
              <div className="mb-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xl font-bold text-white flex-1">{selectedArticle.title}</h2>
                  <button
                    onClick={() => setSelectedArticle(null)}
                    className="text-gray-400 hover:text-white ml-2"
                  >
                    <X size={22} />
                  </button>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-gray-400 pb-3 border-b border-gray-700">
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
              <div className="prose prose-invert max-w-none text-gray-200">
                <div
                  className="space-y-4 text-sm leading-relaxed"
                  dangerouslySetInnerHTML={{
                    __html: selectedArticle.content
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
                      .join(''),
                  }}
                />
              </div>
              {/* Role stats card for character articles (mobile) */}
              {selectedArticle && ARTICLE_TO_ROLE[selectedArticle.id] && ROLE_STATS[ARTICLE_TO_ROLE[selectedArticle.id]] && (
                <div className="mt-4">
                  <RoleStatsCard role={ROLE_STATS[ARTICLE_TO_ROLE[selectedArticle.id]]} />
                </div>
              )}
            </motion.div>
          </div>
        )}

        {/* Mobile: collapsible article list toggle */}
        <button
          onClick={() => setMobileListExpanded(v => !v)}
          className="lg:hidden flex items-center justify-between w-full bg-avalon-card/50 border border-gray-600 rounded-lg px-4 py-3 text-gray-300 text-sm font-semibold"
        >
          <span>{filteredArticles.length} 篇文章 (articles)</span>
          {mobileListExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Article list -- hidden on mobile when collapsed or when an article is selected */}
          <div className={`lg:col-span-1 space-y-4 ${!mobileListExpanded || selectedArticle ? 'hidden lg:block' : ''}`}>
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
                  onClick={() => {
                    setSelectedArticle(article);
                    setMobileListExpanded(false);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
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

          {/* Article detail -- desktop only (mobile version is above) */}
          <div className="hidden lg:block lg:col-span-2">
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
                <div className="prose prose-invert max-w-none text-gray-200">
                  <div
                    className="space-y-4 text-sm leading-relaxed"
                    dangerouslySetInnerHTML={{
                      __html: selectedArticle.content
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
                        .join(''),
                    }}
                  />
                </div>
                {/* Role stats card for character articles (desktop) */}
                {selectedArticle && ARTICLE_TO_ROLE[selectedArticle.id] && ROLE_STATS[ARTICLE_TO_ROLE[selectedArticle.id]] && (
                  <div className="mt-6">
                    <RoleStatsCard role={ROLE_STATS[ARTICLE_TO_ROLE[selectedArticle.id]]} />
                  </div>
                )}
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
