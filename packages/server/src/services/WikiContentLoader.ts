/**
 * Wiki Content Loader
 *
 * Reads Avalon strategy articles from the GDrive wiki directory
 * and converts them into WikiArticle objects consumable by the web frontend.
 *
 * Source: C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\wiki\
 * Configured via WIKI_CONTENT_DIR env var for portability.
 */

import fs from 'fs';
import path from 'path';

export interface WikiArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  excerpt: string;
  tags: string[];
  author: string;
  updatedAt: string;
  views: number;
}

export interface WikiCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
  articleCount: number;
}

// Maps GDrive folder names to canonical category IDs and metadata
const CATEGORY_MAP: Record<string, { id: string; name: string; icon: string; description: string }> = {
  '入門基礎': {
    id: 'basics',
    name: '入門基礎',
    icon: '📖',
    description: '阿瓦隆入門觀念、遊戲規則與流程',
  },
  '角色玩法': {
    id: 'roles',
    name: '角色玩法',
    icon: '👥',
    description: '各角色的核心策略與注意事項',
  },
  '派票策略': {
    id: 'voting',
    name: '派票策略',
    icon: '🗳️',
    description: '視角派票法、區間策略與進階分析',
  },
  '湖中與投票': {
    id: 'lake',
    name: '湖中與投票',
    icon: '💧',
    description: '湖中女神的使用技巧與白球黑球解讀',
  },
  '進階思考': {
    id: 'advanced',
    name: '進階思考',
    icon: '🧠',
    description: '邏輯分析、換位思考與高階玩法',
  },
  '覆盤': {
    id: 'replay',
    name: '覆盤分析',
    icon: '🔍',
    description: '實際牌局覆盤與學習要點',
  },
  'QnA': {
    id: 'faq',
    name: '常見問題 Q&A',
    icon: '❓',
    description: '社群問答集錦，解答各種場景疑難',
  },
};

/**
 * Extract front-matter metadata from a markdown file.
 * Supports simple YAML-style front matter delimited by ---.
 */
function parseFrontMatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const meta: Record<string, string> = {};
  const lines = content.split('\n');

  if (lines[0]?.trim() !== '---') {
    return { meta, body: content };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i;
      break;
    }
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > -1) {
      const key = lines[i].slice(0, colonIdx).trim();
      const value = lines[i].slice(colonIdx + 1).trim();
      meta[key] = value;
    }
  }

  const body = endIndex > -1 ? lines.slice(endIndex + 1).join('\n').trimStart() : content;
  return { meta, body };
}

/**
 * Generate a URL-safe ID from a file path relative to the wiki root.
 * Example: "入門基礎/阿瓦隆快速指南.md" -> "basics-avaon-quick-guide"
 */
function filePathToId(folderName: string, fileName: string): string {
  const base = fileName.replace(/\.md$/i, '');
  // Use folder id + sanitized Chinese filename (keep characters, replace spaces/slashes)
  const categoryInfo = CATEGORY_MAP[folderName];
  const categoryId = categoryInfo?.id ?? folderName;
  // Create a simple slug: categoryId + hash of filename
  const slug = base.replace(/[^\w\u4e00-\u9fff]/g, '-').replace(/-+/g, '-');
  return `${categoryId}-${slug}`;
}

/**
 * Extract a short excerpt from the markdown body (first non-empty paragraph).
 */
function extractExcerpt(body: string, maxLength = 120): string {
  // Strip markdown syntax for excerpt
  const stripped = body
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 10)
    .join(' ');

  return stripped.length > maxLength ? stripped.slice(0, maxLength) + '...' : stripped;
}

/**
 * Load all wiki articles from a single category folder.
 */
function loadCategoryArticles(
  wikiDir: string,
  folderName: string,
  categoryMeta: { id: string; name: string; icon: string; description: string }
): WikiArticle[] {
  const folderPath = path.join(wikiDir, folderName);

  let files: string[];
  try {
    files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.md'));
  } catch {
    console.warn(`WikiContentLoader: cannot read folder ${folderPath}`);
    return [];
  }

  const articles: WikiArticle[] = [];

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
      console.warn(`WikiContentLoader: cannot read file ${filePath}`);
      continue;
    }

    const { meta, body } = parseFrontMatter(rawContent);

    const title = meta['title'] || file.replace(/\.md$/i, '');
    const author = meta['最後編輯者'] || meta['author'] || 'Ed';
    const updatedAt = meta['最後編輯日'] || meta['date'] || '';
    const tagsRaw = meta['tags'] || '';
    const tags = tagsRaw
      .split(',')
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0);

    articles.push({
      id: filePathToId(folderName, file),
      title,
      category: categoryMeta.id,
      content: body,
      excerpt: extractExcerpt(body),
      tags,
      author,
      updatedAt,
      views: 0,
    });
  }

  return articles;
}

export interface WikiContent {
  categories: WikiCategory[];
  articles: WikiArticle[];
  loadedAt: string;
  source: string;
}

/**
 * Load all wiki content from the GDrive wiki directory.
 *
 * Falls back to an empty content set if the directory is unavailable
 * (e.g. on a server that doesn't have GDrive mounted).
 */
export function loadWikiContent(wikiDir?: string): WikiContent {
  const dir = wikiDir ?? process.env.WIKI_CONTENT_DIR ?? '';

  if (!dir || !fs.existsSync(dir)) {
    console.warn(`WikiContentLoader: wiki directory not found: "${dir}" — returning empty content`);
    return {
      categories: [],
      articles: [],
      loadedAt: new Date().toISOString(),
      source: 'none',
    };
  }

  const allArticles: WikiArticle[] = [];
  const categories: WikiCategory[] = [];

  for (const [folderName, categoryMeta] of Object.entries(CATEGORY_MAP)) {
    const folderPath = path.join(dir, folderName);
    if (!fs.existsSync(folderPath)) continue;

    const articles = loadCategoryArticles(dir, folderName, categoryMeta);
    allArticles.push(...articles);

    categories.push({
      ...categoryMeta,
      articleCount: articles.length,
    });
  }

  console.log(
    `WikiContentLoader: loaded ${allArticles.length} articles across ${categories.length} categories from ${dir}`
  );

  return {
    categories,
    articles: allArticles,
    loadedAt: new Date().toISOString(),
    source: dir,
  };
}

// ── In-memory cache ───────────────────────────────────────────────────────────

let cachedContent: WikiContent | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cacheLoadedAt = 0;

/**
 * Get wiki content, using an in-memory cache with 5-minute TTL.
 * Pass `force: true` to bypass the cache.
 */
export function getWikiContent(options: { force?: boolean; wikiDir?: string } = {}): WikiContent {
  const now = Date.now();
  if (!options.force && cachedContent && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedContent;
  }

  cachedContent = loadWikiContent(options.wikiDir);
  cacheLoadedAt = now;
  return cachedContent;
}
