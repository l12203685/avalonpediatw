/**
 * 百科心智圖的資料（Edward 2026-10-30：百科文章與攻略做成樹狀心智圖，並畫出文章之間的關聯）。
 *
 * 全部由文章內容算出來，不手寫：
 *   - 樹：根「阿瓦隆百科」→ 分類 → 文章；
 *   - 關聯：文章內文的 `[標題](wiki:wiki-48)` 連結（utils/wikiMarkup.ts 的 WIKI_ARTICLE_SCHEME），
 *     去掉重複、連到自己、連到不存在文章的連結；
 *   - 新手分支：〈關於阿瓦隆百科〉（wiki-153）「建議閱讀順序」一節的連結順序。那份清單有一半的文章屬於別的分類
 *     （遊戲規則、角色指南、名詞解釋、戰術分析），它們仍掛在自己的分類下，新手分支另外放一個「捷徑」葉子
 *     （alias），讓新手分支從頭到尾照順序讀。
 *
 * 純函式、不碰 React / DOM：packages/server/src/__tests__/WikiGraph.test.ts 直接測（web 沒有單元測試框架）。
 */

/** `wiki:<id>` inside an article's markdown (the link target of `[標題](wiki:wiki-48)`). */
const WIKI_LINK_RE = /wiki:([\w-]+)/g;

export interface WikiGraphArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  /** '待完成' = stub / half-written (data/wiki.ts isWikiPending). */
  status?: string;
}

export interface WikiGraphCategory {
  id: string;
  name: string;
  icon?: string;
}

export interface WikiEdge {
  /** The article whose content holds the link. */
  from: string;
  /** The article it links to. */
  to: string;
}

/** How an article relates to the selected one: it is cited by it (out), cites it (in), or both. */
export type WikiRelationKind = 'out' | 'in' | 'both';

export interface WikiRelated {
  id: string;
  kind: WikiRelationKind;
}

export interface WikiTreeLeaf {
  /** Unique per tree position (`<branch>/<article>`): an article can sit in its category and on the reading path. */
  key: string;
  articleId: string;
  title: string;
  pending: boolean;
  /** 1-based step in 建議閱讀順序, on every leaf of an article in that list. */
  readingStep?: number;
  /** The article's own category. */
  homeCategory: string;
  /** A reading-path shortcut: the article's own leaf is under `homeCategory`. */
  alias: boolean;
  /** The 〈關於阿瓦隆百科〉 article that holds the reading order. */
  guide: boolean;
}

export interface WikiTreeBranch {
  id: string;
  name: string;
  icon?: string;
  leaves: WikiTreeLeaf[];
  /** Articles whose category this is (aliases not counted). */
  articleCount: number;
}

export interface WikiGraphNodeInfo {
  id: string;
  title: string;
  category: string;
  pending: boolean;
}

export interface WikiGraph {
  rootLabel: string;
  branches: WikiTreeBranch[];
  edges: WikiEdge[];
  /** Articles each article links to, in the order they first appear in its content. */
  outgoing: Record<string, string[]>;
  /** Articles linking to each article, in article order. */
  incoming: Record<string, string[]>;
  /** 建議閱讀順序 article ids (only ones that exist). */
  readingOrder: string[];
  guideId: string | null;
  articles: Record<string, WikiGraphNodeInfo>;
}

export interface BuildWikiGraphOptions {
  rootLabel?: string;
  /** The article holding 建議閱讀順序 (default wiki-153 〈關於阿瓦隆百科〉). */
  guideId?: string;
  /** The heading of the reading-order section in the guide. */
  readingHeading?: string;
  /** The branch that follows the reading order (default beginner 新手入門). */
  readingCategory?: string;
}

export const WIKI_GUIDE_ID = 'wiki-153';
export const WIKI_READING_HEADING = '建議閱讀順序';
export const WIKI_READING_CATEGORY = 'beginner';

const isPending = (a: { status?: string }): boolean => a.status === '待完成';

/** Collapse the stray double / trailing spaces some titles carry. */
export function cleanWikiTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/** The `wiki:` link targets of a content, each once, in order of first appearance. */
export function extractWikiLinks(content: string): string[] {
  const seen = new Set<string>();
  for (const m of content.matchAll(WIKI_LINK_RE)) seen.add(m[1]);
  return [...seen];
}

/**
 * The links of the section under a `# 建議閱讀順序`-style heading, up to the next heading of the same or a higher
 * level. No such heading → [].
 */
export function extractReadingOrder(content: string, heading: string = WIKI_READING_HEADING): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim().startsWith(heading));
  if (start < 0) return [];
  const level = /^#+/.exec(lines[start])![0].length;
  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i]);
    if (h && h[1].length <= level) break;
    section.push(lines[i]);
  }
  return extractWikiLinks(section.join('\n'));
}

/** Every article-to-article link: deduplicated, no self links, no links to articles that don't exist. */
export function buildWikiEdges(articles: readonly WikiGraphArticle[]): WikiEdge[] {
  const ids = new Set(articles.map((a) => a.id));
  const edges: WikiEdge[] = [];
  const seen = new Set<string>();
  for (const a of articles) {
    if (seen.has(a.id)) continue; // duplicate id: the first article wins
    seen.add(a.id);
    for (const to of extractWikiLinks(a.content)) {
      if (to !== a.id && ids.has(to)) edges.push({ from: a.id, to });
    }
  }
  return edges;
}

/** Root → categories (in the given order; unknown ones appended, empty ones left out) → articles, plus the links. */
export function buildWikiGraph(
  input: readonly WikiGraphArticle[],
  categories: readonly WikiGraphCategory[],
  options: BuildWikiGraphOptions = {},
): WikiGraph {
  const rootLabel = options.rootLabel ?? '阿瓦隆百科';
  const readingCategory = options.readingCategory ?? WIKI_READING_CATEGORY;

  // First article per id wins (merged hard-coded + API lists).
  const articles: WikiGraphArticle[] = [];
  const byId = new Map<string, WikiGraphArticle>();
  for (const a of input) {
    if (byId.has(a.id)) continue;
    byId.set(a.id, a);
    articles.push(a);
  }

  const edges = buildWikiEdges(articles);
  const outgoing: Record<string, string[]> = {};
  const incoming: Record<string, string[]> = {};
  for (const a of articles) {
    outgoing[a.id] = [];
    incoming[a.id] = [];
  }
  for (const e of edges) {
    outgoing[e.from].push(e.to);
    incoming[e.to].push(e.from);
  }

  const guide = byId.get(options.guideId ?? WIKI_GUIDE_ID);
  const readingOrder = guide
    ? extractReadingOrder(guide.content, options.readingHeading ?? WIKI_READING_HEADING).filter(
        (id) => byId.has(id) && id !== guide.id,
      )
    : [];
  const stepOf = new Map(readingOrder.map((id, i) => [id, i + 1]));

  const info: Record<string, WikiGraphNodeInfo> = {};
  for (const a of articles) {
    info[a.id] = { id: a.id, title: cleanWikiTitle(a.title), category: a.category, pending: isPending(a) };
  }

  const leafOf = (branchId: string, a: WikiGraphArticle): WikiTreeLeaf => ({
    key: `${branchId}/${a.id}`,
    articleId: a.id,
    title: info[a.id].title,
    pending: info[a.id].pending,
    readingStep: stepOf.get(a.id),
    homeCategory: a.category,
    alias: a.category !== branchId,
    guide: a.id === guide?.id,
  });

  // Category order: the given list, then any category only the data knows about.
  const order: WikiGraphCategory[] = [...categories];
  const known = new Set(categories.map((c) => c.id));
  for (const a of articles) {
    if (!known.has(a.category)) {
      known.add(a.category);
      order.push({ id: a.category, name: a.category });
    }
  }

  const branches: WikiTreeBranch[] = [];
  for (const cat of order) {
    const own = articles.filter((a) => a.category === cat.id);
    let members: WikiGraphArticle[];
    if (cat.id === readingCategory && guide) {
      // 新手分支: the guide, then the reading order (shortcuts for other categories' articles), then the rest.
      const head = [guide, ...readingOrder.map((id) => byId.get(id)!)];
      const inHead = new Set(head.map((a) => a.id));
      members = [...head, ...sortPublishedFirst(own.filter((a) => !inHead.has(a.id)))];
    } else {
      members = sortPublishedFirst(own);
    }
    if (members.length === 0) continue;
    branches.push({
      id: cat.id,
      name: cat.name,
      icon: cat.icon,
      leaves: members.map((a) => leafOf(cat.id, a)),
      articleCount: own.length,
    });
  }

  return { rootLabel, branches, edges, outgoing, incoming, readingOrder, guideId: guide?.id ?? null, articles: info };
}

/** Finished articles before 待完成 ones, otherwise in data order. */
function sortPublishedFirst(list: WikiGraphArticle[]): WikiGraphArticle[] {
  return [...list.filter((a) => !isPending(a)), ...list.filter(isPending)];
}

/** The articles linked with `id`: the ones it cites (in content order), then the ones only citing it. */
export function relatedArticles(graph: Pick<WikiGraph, 'outgoing' | 'incoming'>, id: string): WikiRelated[] {
  const out = graph.outgoing[id] ?? [];
  const inc = new Set(graph.incoming[id] ?? []);
  const result: WikiRelated[] = out.map((to) => ({ id: to, kind: inc.has(to) ? 'both' : 'out' }));
  const listed = new Set(out);
  for (const from of graph.incoming[id] ?? []) if (!listed.has(from)) result.push({ id: from, kind: 'in' });
  return result;
}
