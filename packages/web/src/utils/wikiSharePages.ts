/**
 * 每篇百科文章的分享頁（2026-11-11 Edward：之後要把百科文章一篇篇發到 Threads 引流）。
 *
 * 網站是單頁應用，文章網址是 /#wiki=<id>；hash 不會送到伺服器，Threads／LINE／Discord 的連結預覽只看得到首頁的
 * 標題與圖。所以每次 `vite build` 由 vite.config.ts 的 llmsFilesPlugin 另外產生 /w/<id>/index.html：
 *  - <title>、description、Open Graph（og:title／og:description／og:type=article／og:url／og:image／og:site_name）、
 *    Twitter card、canonical，都是那篇文章自己的；
 *  - 打開後用 script 立刻 location.replace 到 /#wiki=<id>（網站直接打開那篇），不跑 JS 的讀者看到標題、摘要和連結。
 *    不用 <meta http-equiv="refresh">：Meta（Threads／Facebook）的預覽爬蟲會跟著 meta refresh 走到首頁，預覽就變回
 *    首頁的；爬蟲不跑 script，所以停在這頁讀到文章自己的預覽。
 * 文章清單與 /wiki-md、llms.txt 同一份（orderLlmsArticles：寫死的文章在前，同名的 JSON 文章不重複）。
 * 2026-11-11 文章合併：被併入別篇的舊 id（data/wikiRedirects.ts）照樣有 /w/<舊 id>/，帶主文的預覽、canonical 指主文的
 * 分享頁，打開後轉到主文併入的那一節（/#wiki=<主文>&sec=<章節>）；這些舊頁和現存文章的分享頁一樣不列進 sitemap。
 * 這裡不碰 node API，packages/server/src/__tests__/WebWikiShare.test.ts 直接測。
 */
import { orderLlmsArticles, type LlmsArticle, type LlmsCategory } from './llmsTxt';
import { stripLayerMarks, wikiCardExcerpt } from './wikiMarkup';
import { wikiHash, wikiSharePath, wikiShareUrl } from './wikiHash';

export const WIKI_SITE_NAME = '阿瓦隆百科';

export interface ShareImage {
  /** Site-relative path of an image in packages/web/public, e.g. /logo.png. */
  path: string;
  width: number;
  height: number;
  alt: string;
}

export interface WikiShareOptions {
  /** Public site origin for og:url / og:image / canonical, no trailing slash needed. */
  siteUrl: string;
  /** Path the SPA is served under (vite `base`), default '/'. The redirect goes to `${basePath}#wiki=<id>`. */
  basePath?: string;
  categories: readonly LlmsCategory[];
  image: ShareImage;
  /** Old (merged-away) ids → the article and section they became; each gets a page that forwards there. */
  redirects?: Readonly<Record<string, { id: string; section?: string }>>;
}

/** 640×640 的站標（public/logo.png）：正方形，用 Twitter 的 summary 卡。 */
export const DEFAULT_SHARE_IMAGE: ShareImage = { path: '/logo.png', width: 640, height: 640, alt: '阿瓦隆百科' };

/** 預覽摘要的字數上限（中文字）。 */
export const SHARE_DESCRIPTION_MAX = 120;

const trimSlash = (u: string): string => u.replace(/\/+$/, '');

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 文章摘要 → 一行純文字（拿掉 Markdown 記號、論點標記、HTML），最多 max 個字（超過時以「…」結尾）。 */
export function shareDescription(article: Pick<LlmsArticle, 'excerpt' | 'content'>, max = SHARE_DESCRIPTION_MAX): string {
  const text = stripLayerMarks(wikiCardExcerpt(article.excerpt ?? '', article.content))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text.replace(/…$/, ''));
  if (chars.length <= max && !text.endsWith('…')) return text;
  return `${chars.slice(0, Math.min(chars.length, max - 1)).join('').trimEnd()}…`;
}

/** 分享頁打開後要去的網址（站內深連結；給了章節時捲到那一節）。 */
export function wikiShareRedirect(id: string, basePath = '/', section?: string): string {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return `${base}${wikiHash(id, section)}`;
}

/**
 * 一篇文章的分享頁 HTML。`moved` 給了時是舊 id 的轉址頁：網址是 /w/<舊 id>/，預覽與 canonical 用主文的，
 * 打開後轉到主文併入的那一節，並加上 noindex。
 */
export function buildWikiSharePage(article: LlmsArticle, opts: WikiShareOptions, moved?: { oldId: string; section?: string }): string {
  const site = trimSlash(opts.siteUrl);
  const url = wikiShareUrl(site, article.id);
  const target = wikiShareRedirect(article.id, opts.basePath, moved?.section);
  const description = shareDescription(article);
  const image = `${site}${opts.image.path.startsWith('/') ? '' : '/'}${opts.image.path}`;
  const card = opts.image.width >= opts.image.height * 1.5 ? 'summary_large_image' : 'summary';
  const e = escapeHtml;
  // JSON in a <script>: also escape "<" so a "</script>" can never close the tag early
  const targetJs = JSON.stringify(target).replace(/</g, '\\u003c');
  return [
    '<!doctype html>',
    '<html lang="zh-Hant">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${e(article.title)}｜${WIKI_SITE_NAME}</title>`,
    `<meta name="description" content="${e(description)}">`,
    `<link rel="canonical" href="${e(url)}">`,
    moved ? '<meta name="robots" content="noindex">' : '',
    `<meta property="og:site_name" content="${WIKI_SITE_NAME}">`,
    '<meta property="og:type" content="article">',
    '<meta property="og:locale" content="zh_TW">',
    `<meta property="og:title" content="${e(article.title)}">`,
    `<meta property="og:description" content="${e(description)}">`,
    `<meta property="og:url" content="${e(url)}">`,
    `<meta property="og:image" content="${e(image)}">`,
    `<meta property="og:image:width" content="${opts.image.width}">`,
    `<meta property="og:image:height" content="${opts.image.height}">`,
    `<meta property="og:image:alt" content="${e(opts.image.alt)}">`,
    `<meta name="twitter:card" content="${card}">`,
    `<meta name="twitter:title" content="${e(article.title)}">`,
    `<meta name="twitter:description" content="${e(description)}">`,
    `<meta name="twitter:image" content="${e(image)}">`,
    `<script>location.replace(${targetJs});</script>`,
    '<style>body{margin:0;padding:2rem 1rem;background:#0a0a0a;color:#e4e4e7;font-family:system-ui,"Noto Sans TC",sans-serif;line-height:1.6}main{max-width:40rem;margin:0 auto}a{color:#facc15}</style>',
    '</head>',
    '<body>',
    '<main>',
    `<p>${WIKI_SITE_NAME}</p>`,
    `<h1>${e(article.title)}</h1>`,
    description ? `<p>${e(description)}</p>` : '',
    moved ? `<p>這篇文章已經併入〈${e(article.title)}〉。</p>` : '',
    `<p><a href="${e(target)}">到${WIKI_SITE_NAME}閱讀全文</a></p>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].filter((line, i, all) => line !== '' || i === all.length - 1).join('\n');
}

/** 每篇文章一頁，key = build 輸出裡的路徑（w/<id>/index.html）；再加上 opts.redirects 裡每個舊 id 的轉址頁。 */
export function buildWikiSharePages(articles: readonly LlmsArticle[], opts: WikiShareOptions): Record<string, string> {
  const pages: Record<string, string> = {};
  const ordered = orderLlmsArticles(articles, opts.categories);
  for (const a of ordered) pages[wikiSharePath(a.id)] = buildWikiSharePage(a, opts);
  const byId = new Map(ordered.map((a) => [a.id, a]));
  for (const [oldId, to] of Object.entries(opts.redirects ?? {})) {
    const main = byId.get(to.id);
    if (!main || byId.has(oldId)) continue; // a live article keeps its own page
    pages[wikiSharePath(oldId)] = buildWikiSharePage(main, opts, { oldId, section: to.section });
  }
  return pages;
}
