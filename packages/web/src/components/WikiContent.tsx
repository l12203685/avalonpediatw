import { useState, useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Eye, Calendar } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

// Markdown renderer — uses react-markdown + remark-gfm for GitHub-Flavored Markdown
// (tables, strikethrough, task lists, autolinks). Styled via Tailwind utility classes
// directly on each node to avoid dependency on @tailwindcss/typography plugin.
const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }): JSX.Element => (
    <h1 className="text-lg font-bold text-white mt-4 mb-2">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }): JSX.Element => (
    <h2 className="text-base font-bold text-yellow-400 mt-3 mb-1.5">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }): JSX.Element => (
    <h3 className="text-sm font-semibold text-gray-200 mt-2.5 mb-1">{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }): JSX.Element => (
    <h4 className="text-xs font-semibold text-gray-300 mt-2 mb-0.5">{children}</h4>
  ),
  p: ({ children }: { children?: ReactNode }): JSX.Element => (
    <p className="text-sm text-gray-200 leading-snug mb-2">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }): JSX.Element => (
    <ul className="list-disc list-outside ml-5 mb-2 text-sm text-gray-200">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }): JSX.Element => (
    <ol className="list-decimal list-outside ml-5 mb-2 text-sm text-gray-200">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }): JSX.Element => (
    <li className="leading-snug">{children}</li>
  ),
  strong: ({ children }: { children?: ReactNode }): JSX.Element => (
    <strong className="font-bold text-white">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }): JSX.Element => (
    <em className="italic text-gray-100">{children}</em>
  ),
  a: ({ children, href }: { children?: ReactNode; href?: string }): JSX.Element => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-yellow-400 underline hover:text-yellow-300"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }: { children?: ReactNode }): JSX.Element => (
    <blockquote className="border-l-4 border-yellow-500 bg-yellow-500/5 pl-3 py-1.5 my-2 text-sm text-gray-300 italic leading-snug">
      {children}
    </blockquote>
  ),
  code: ({ inline, children }: { inline?: boolean; children?: ReactNode }): JSX.Element =>
    inline ? (
      <code className="bg-gray-800 text-yellow-300 px-1 py-0.5 rounded text-xs font-mono">
        {children}
      </code>
    ) : (
      <code className="font-mono">{children}</code>
    ),
  pre: ({ children }: { children?: ReactNode }): JSX.Element => (
    <pre className="bg-gray-900 border border-gray-700 rounded-md p-2.5 overflow-x-auto my-2 text-xs text-gray-200">
      {children}
    </pre>
  ),
  hr: (): JSX.Element => <hr className="border-gray-700 my-3" />,
  // Table renderers — the main fix. Wraps in overflow container for narrow modals.
  table: ({ children }: { children?: ReactNode }): JSX.Element => (
    <div className="overflow-x-auto my-2">
      <table className="w-full border-collapse border border-gray-700 text-xs">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }): JSX.Element => (
    <thead className="bg-avalon-dark/60">{children}</thead>
  ),
  tbody: ({ children }: { children?: ReactNode }): JSX.Element => (
    <tbody className="divide-y divide-gray-700">{children}</tbody>
  ),
  tr: ({ children }: { children?: ReactNode }): JSX.Element => (
    <tr className="hover:bg-avalon-card/40 transition-colors">{children}</tr>
  ),
  th: ({ children }: { children?: ReactNode }): JSX.Element => (
    <th className="border border-gray-700 px-2 py-1 text-left font-semibold text-yellow-400 bg-avalon-dark/40">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }): JSX.Element => (
    <td className="border border-gray-700 px-2 py-1 text-gray-200 align-top">{children}</td>
  ),
  img: ({ src, alt }: { src?: string; alt?: string }): JSX.Element => (
    <img src={src} alt={alt ?? ''} className="max-w-full rounded-md my-2 border border-gray-700" />
  ),
};

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
    <div className="bg-gradient-to-b from-avalon-dark to-black px-3 py-3">
      <div className="max-w-6xl mx-auto space-y-3">
        {/* 搜索欄 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative"
        >
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜尋百科內容..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-avalon-card/50 border border-gray-600 rounded-lg pl-9 pr-9 py-2 text-sm text-white placeholder-gray-400 focus:border-yellow-400 focus:outline-none transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </motion.div>

        {/* 分類過濾 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="flex flex-wrap gap-2"
        >
          <button
            onClick={() => setActiveCategory('')}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
              !activeCategory
                ? 'bg-yellow-500 text-black shadow-lg'
                : 'bg-avalon-card/50 text-gray-300 hover:bg-avalon-card border border-gray-600'
            }`}
          >
            全部
          </button>

          {WIKI_CATEGORIES.map((category) => (
            <button
              key={category.id}
              onClick={() => setActiveCategory(category.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all flex items-center gap-1.5 ${
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
            className="text-sm text-gray-400"
          >
            找到 <span className="text-yellow-400 font-bold">{filteredArticles.length}</span> 篇文章
          </motion.div>
        )}

        {/* 文章列表 — 格狀，點擊用 modal 呈現（不跳走） */}
        {filteredArticles.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-8"
          >
            <p className="text-gray-400 text-base">未找到相關文章</p>
            <p className="text-gray-500 text-xs mt-1">試試其他搜尋詞或選擇不同的分類</p>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredArticles.map((article, index) => (
              <motion.button
                key={article.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index * 0.03, 0.3) }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setSelectedArticle(article)}
                className="text-left p-3 rounded-lg border-2 transition-all bg-avalon-card/30 border-gray-600 hover:border-yellow-400 hover:bg-avalon-card/50"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-bold text-white mb-1 leading-snug">{article.title}</h3>
                    <p className="text-gray-300 text-xs mb-2 line-clamp-3 leading-snug">{article.excerpt}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {article.tags.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="inline-block bg-gray-700/50 text-gray-200 text-[10px] px-1.5 py-0.5 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-gray-400 mt-2 pt-2 border-t border-gray-700">
                  <div className="flex items-center gap-1">
                    <Eye size={12} />
                    {article.views.toLocaleString()} 次閱讀
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar size={12} />
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
              <div className="sticky top-0 z-10 flex items-start justify-between p-3 bg-avalon-card border-b border-gray-700">
                <h2 className="text-base md:text-lg font-bold text-white flex-1 pr-3 leading-snug">{selectedArticle.title}</h2>
                <button
                  onClick={() => setSelectedArticle(null)}
                  className="text-gray-400 hover:text-white shrink-0"
                  aria-label="Close article"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="px-3 py-3 md:px-4 md:py-4">
                <div className="flex flex-wrap gap-3 text-[10px] text-gray-400 pb-2 border-b border-gray-700 mb-3">
                  <div className="flex items-center gap-1">
                    <Eye size={12} />
                    {selectedArticle.views.toLocaleString()}
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar size={12} />
                    {selectedArticle.updatedAt.toLocaleDateString('zh-TW')}
                  </div>
                  <span>{selectedArticle.author}</span>
                </div>

                <div className="max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownComponents}
                  >
                    {selectedArticle.content}
                  </ReactMarkdown>
                </div>

                {/* Role stats card for character articles */}
                {ARTICLE_TO_ROLE[selectedArticle.id] && ROLE_STATS[ARTICLE_TO_ROLE[selectedArticle.id]] && (
                  <div className="mt-4">
                    <RoleStatsCard role={ROLE_STATS[ARTICLE_TO_ROLE[selectedArticle.id]]} />
                  </div>
                )}
                {/* Role short video */}
                {ARTICLE_TO_ROLE[selectedArticle.id] && VIDEO_BY_ROLE[ARTICLE_TO_ROLE[selectedArticle.id]] && (
                  <div className="mt-4">
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
