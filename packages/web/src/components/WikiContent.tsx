import { useState, useMemo, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Calendar, ChevronDown, PencilLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { WIKI_COLOR_SCHEME, normalizeWikiMarkup, wikiExcerpt, wikiUrlTransform } from '../utils/wikiMarkup';
import remarkGfm from 'remark-gfm';
import { WikiArticle, WIKI_ARTICLES, WIKI_ARTICLE_ROLE, WIKI_CATEGORIES, isWikiPending, mergeWikiArticles } from '../data/wiki';
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
    status: a.status === '待完成' ? '待完成' : undefined,
  };
}

interface WikiContentProps {
  selectedCategory?: string;
  /** Reports how many 完成 articles are listed (the page header shows it). */
  onPublishedCountChange?: (count: number) => void;
}

const WIKI_COLOR_CLASS: Record<string, string> = {
  red: 'text-red-400 font-semibold',
  blue: 'text-sky-400 font-semibold',
  orange: 'text-orange-400 font-semibold',
  teal: 'text-teal-400 font-semibold',
};

/** The callout `normalizeWikiMarkup` builds starts with ⚠️. */
function isWarningQuote(node: unknown): boolean {
  const text = (n: unknown): string => {
    const x = n as { type?: string; value?: string; children?: unknown[] } | undefined;
    if (!x) return '';
    if (x.type === 'text') return x.value ?? '';
    return (x.children ?? []).map(text).join('');
  };
  return text(node).trimStart().startsWith('⚠️');
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
  a: ({ children, href }: { children?: ReactNode; href?: string }): JSX.Element => href?.startsWith(WIKI_COLOR_SCHEME) ? (
    // Old HackMD `<font color>` (utils/wikiMarkup.ts): colored emphasis in the site's palette.
    <span className={WIKI_COLOR_CLASS[href.slice(WIKI_COLOR_SCHEME.length)] ?? WIKI_COLOR_CLASS.red}>{children}</span>
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-yellow-400 underline hover:text-yellow-300"
    >
      {children}
    </a>
  ),
  blockquote: ({ children, node }: { children?: ReactNode; node?: unknown }): JSX.Element =>
    isWarningQuote(node) ? (
      // A run of whole-line red text in the old article (utils/wikiMarkup.ts): a warning callout.
      <blockquote className="border-l-4 border-red-500 bg-red-500/10 pl-3 pr-2 py-2 my-2 text-sm text-red-200 not-italic leading-snug rounded-r">
        {children}
      </blockquote>
    ) : (
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

export default function WikiContent({ selectedCategory, onPublishedCountChange }: WikiContentProps): JSX.Element {
  const { t } = useTranslation('common');
  const [searchQuery, setSearchQuery] = useState('');
  const [showPending, setShowPending] = useState(false);
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
          setAllArticles(mergeWikiArticles(WIKI_ARTICLES, apiArticles));
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

  // 完成 articles make the main list; 待完成 ones (stubs / half-written) sit in a collapsed section.
  const [publishedArticles, pendingArticles] = useMemo(() => {
    const published: WikiArticle[] = [];
    const pending: WikiArticle[] = [];
    for (const article of allArticles) (isWikiPending(article) ? pending : published).push(article);
    return [published, pending];
  }, [allArticles]);

  useEffect(() => {
    onPublishedCountChange?.(publishedArticles.length);
  }, [publishedArticles.length, onPublishedCountChange]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const article of publishedArticles) counts.set(article.category, (counts.get(article.category) ?? 0) + 1);
    return counts;
  }, [publishedArticles]);

  // 搜索和過濾文章
  const matchesFilters = useCallback(
    (article: WikiArticle): boolean => {
      const matchesCategory = !activeCategory || article.category === activeCategory;
      const matchesSearch =
        !searchQuery ||
        article.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.excerpt.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      return matchesCategory && matchesSearch;
    },
    [activeCategory, searchQuery],
  );
  const filteredArticles = useMemo(() => publishedArticles.filter(matchesFilters), [publishedArticles, matchesFilters]);
  const filteredPending = useMemo(() => pendingArticles.filter(matchesFilters), [pendingArticles, matchesFilters]);
  const selectedRole = selectedArticle
    ? WIKI_ARTICLE_ROLE[selectedArticle.id] ?? ARTICLE_TO_ROLE[selectedArticle.id]
    : undefined;

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

        {/* 分類過濾 — 緊湊 1-2 列（全部 + 各分類；數字只算完成的文章） */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="flex flex-wrap gap-1.5"
        >
          <button
            onClick={() => setActiveCategory('')}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
              !activeCategory
                ? 'bg-yellow-500 text-black shadow'
                : 'bg-avalon-card/50 text-gray-300 hover:bg-avalon-card border border-gray-600'
            }`}
          >
            {t('wiki.all')}
            <span className="ml-1 opacity-60 tabular-nums">{publishedArticles.length}</span>
          </button>

          {WIKI_CATEGORIES.map((category) => (
            <button
              key={category.id}
              onClick={() => setActiveCategory(category.id)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all inline-flex items-center gap-1 ${
                activeCategory === category.id
                  ? 'bg-yellow-500 text-black shadow'
                  : 'bg-avalon-card/50 text-gray-300 hover:bg-avalon-card border border-gray-600'
              }`}
            >
              <span>{category.icon}</span>
              {t(`wiki.category.${category.id}`, { defaultValue: category.name })}
              <span className="opacity-60 tabular-nums">{categoryCounts.get(category.id) ?? 0}</span>
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
          filteredPending.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center py-8"
            >
              <p className="text-gray-400 text-base">未找到相關文章</p>
              <p className="text-gray-500 text-xs mt-1">試試其他搜尋詞或選擇不同的分類</p>
            </motion.div>
          )
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
                    <p className="text-gray-300 text-xs mb-2 line-clamp-3 leading-snug">{wikiExcerpt(article.excerpt)}</p>
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
                    <Calendar size={12} />
                    {article.updatedAt.toLocaleDateString('zh-TW')}
                  </div>
                </div>
              </motion.button>
            ))}
          </div>
        )}

        {/* 待完成 — stubs and half-written articles, collapsed by default (Edward 2026-10-28) */}
        {filteredPending.length > 0 && (
          <section className="border border-dashed border-gray-600 rounded-lg">
            <button
              type="button"
              onClick={() => setShowPending((v) => !v)}
              aria-expanded={showPending}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-300 hover:text-white"
            >
              <PencilLine size={14} className="text-amber-400 shrink-0" />
              <span className="font-semibold">{t('wiki.pendingToggle', { count: filteredPending.length })}</span>
              <span className="text-[11px] text-gray-500 truncate flex-1 min-w-0">{t('wiki.pendingHint')}</span>
              <ChevronDown size={16} className={`shrink-0 transition-transform ${showPending ? 'rotate-180' : ''}`} />
            </button>
            {showPending && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 px-3 pb-3">
                {filteredPending.map((article) => (
                  <button
                    key={article.id}
                    type="button"
                    onClick={() => setSelectedArticle(article)}
                    className="text-left px-3 py-2 rounded-md border border-gray-700 bg-avalon-card/20 hover:border-amber-400 transition-colors"
                  >
                    <div className="flex items-start gap-2">
                      <h3 className="flex-1 min-w-0 text-sm font-semibold text-gray-200 leading-snug break-words">{article.title}</h3>
                      <span className="shrink-0 text-[10px] font-semibold text-amber-300 border border-amber-500/50 rounded px-1 py-0.5 leading-none">
                        {t('wiki.pendingBadge')}
                      </span>
                    </div>
                    <p className="text-gray-400 text-[11px] mt-1 line-clamp-1 leading-snug">{wikiExcerpt(article.excerpt)}</p>
                  </button>
                ))}
              </div>
            )}
          </section>
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
                {isWikiPending(selectedArticle) && (
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md border border-amber-500/50 bg-amber-500/10 text-xs text-amber-200">
                    <PencilLine size={14} className="shrink-0" />
                    {t('wiki.pendingBanner')}
                  </div>
                )}
                <div className="flex flex-wrap gap-3 text-[10px] text-gray-400 pb-2 border-b border-gray-700 mb-3">
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
                    urlTransform={(url) => wikiUrlTransform(url, defaultUrlTransform)}
                  >
                    {normalizeWikiMarkup(selectedArticle.content)}
                  </ReactMarkdown>
                </div>

                {/* Role stats card for character articles */}
                {selectedRole && ROLE_STATS[selectedRole] && (
                  <div className="mt-4">
                    <RoleStatsCard role={ROLE_STATS[selectedRole]} />
                  </div>
                )}
                {/* Role short video */}
                {selectedRole && VIDEO_BY_ROLE[selectedRole] && (
                  <div className="mt-4">
                    <RoleVideoCard video={VIDEO_BY_ROLE[selectedRole]} />
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
