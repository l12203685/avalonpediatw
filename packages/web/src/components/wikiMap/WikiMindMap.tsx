import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { WIKI_CATEGORIES } from '../../data/wiki';
import type { WikiArticle } from '../../data/wiki';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { buildWikiGraph } from '../../utils/wikiGraph';
import type { WikiGraphCategory } from '../../utils/wikiGraph';
import WikiMindMapCanvas from './WikiMindMapCanvas';
import WikiMindMapTree from './WikiMindMapTree';

/**
 * 百科「心智圖」檢視（Edward 2026-10-30）：根「阿瓦隆百科」→ 分類 → 文章，文章間的 `wiki:` 連結畫成關聯。
 * 寬螢幕（≥1024px）是可縮放拖曳的 SVG 心智圖；窄螢幕（手機、平板直向）是可收合的縮排樹。
 * 樹與關聯由 utils/wikiGraph.ts 從文章內容算出來。
 */

/** 新手入門排第一（它照〈關於阿瓦隆百科〉的建議閱讀順序），其餘大致由淺到深。 */
const MAP_CATEGORY_ORDER = ['beginner', 'rules', 'roles', 'glossary', 'strategies', 'replays', 'events', 'faq', 'about'];

const DESKTOP_QUERY = '(min-width: 1024px)';

interface WikiMindMapProps {
  articles: WikiArticle[];
  /** Opens an article the way the list does (WikiContent's modal). */
  onOpen: (article: WikiArticle) => void;
}

export default function WikiMindMap({ articles, onOpen }: WikiMindMapProps): JSX.Element {
  const { t } = useTranslation('common');
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const categories = useMemo((): WikiGraphCategory[] => {
    const rank = (id: string): number => {
      const i = MAP_CATEGORY_ORDER.indexOf(id);
      return i < 0 ? MAP_CATEGORY_ORDER.length : i;
    };
    return [...WIKI_CATEGORIES]
      .sort((a, b) => rank(a.id) - rank(b.id))
      .map((c) => ({ id: c.id, name: t(`wiki.category.${c.id}`, { defaultValue: c.name }), icon: c.icon }));
  }, [t]);

  const graph = useMemo(() => buildWikiGraph(articles, categories), [articles, categories]);
  const articlesById = useMemo(() => new Map(articles.map((a) => [a.id, a])), [articles]);
  const open = useCallback(
    (id: string): void => {
      const article = articlesById.get(id);
      if (article) onOpen(article);
    },
    [articlesById, onOpen],
  );

  return isDesktop ? (
    <WikiMindMapCanvas graph={graph} articlesById={articlesById} onOpen={open} />
  ) : (
    <WikiMindMapTree graph={graph} onOpen={open} />
  );
}
