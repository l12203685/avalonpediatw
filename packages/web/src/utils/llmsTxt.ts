/**
 * 給其他 AI／爬蟲讀的純文字版本（Edward 2026-10-31：其他百科維護者用別的 AI 工具檢查網站內容，讀不到 — 網站是
 * JavaScript 單頁應用，不跑 JS 的抓取工具只拿到空殼）。每次 `vite build` 由 vite.config.ts 的 llmsFilesPlugin
 * 產生，內容永遠和打包進網站的 wiki_data.json 一致：
 *
 *   /llms.txt          llms.txt 慣例（https://llmstxt.org）：網站說明、內容怎麼分、每篇文章的 Markdown 連結、資料端點
 *   /llms-full.txt     全部文章接成一份乾淨的 Markdown
 *   /wiki-md/<id>.md   每篇文章一個 Markdown 檔
 *   /sitemap.xml       網站頁面 + 上面這些檔案
 *
 * 「乾淨」= 拿掉 HackMD 資料區塊與 [TOC]、HTML 註解與舊式 <font>/<br>；站內連結 `wiki:wiki-57` 換成那篇 .md 的
 * 完整網址；圖片換成完整網址；論點標記統一成【邏輯】【經驗】（舊標記照 utils/wikiMarkup.ts 的對照換掉）。
 * 這裡不碰 node API（vite.config.ts 讀檔後把資料傳進來），伺服器端的 vitest 直接測這個模組。
 */
import { WIKI_TAGS, canonicalLayerMarks, stripHackmdArtifacts, stripHtmlComments, stripLayerMarks, wikiCardExcerpt } from './wikiMarkup';

export interface LlmsArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  tags?: readonly string[];
  excerpt?: string;
  status?: string;
}

export interface LlmsCategory {
  id: string;
  name: string;
  description: string;
}

export interface LlmsOptions {
  /** Public site origin, no trailing slash (e.g. https://avalon-game-platform.web.app). */
  siteUrl: string;
  /** Public API origin of packages/server, no trailing slash. */
  apiUrl: string;
  /** GitHub repository URL, no trailing slash. */
  repoUrl: string;
  categories: readonly LlmsCategory[];
  /** A note shown under the title of specific articles (e.g. the live stats card that only the site renders). */
  notes?: Readonly<Record<string, string>>;
  /** Extra site pages for sitemap.xml (paths starting with /). */
  sitePages?: readonly string[];
}

export const WIKI_MD_DIR = 'wiki-md';

const trimSlash = (u: string): string => u.replace(/\/+$/, '');

export function wikiMdPath(id: string): string {
  return `${WIKI_MD_DIR}/${encodeURIComponent(id)}.md`;
}

/** Hardcoded articles first, then the JSON ones whose title isn't taken (same rule as data/wiki.ts mergeWikiArticles); grouped by category order. */
export function orderLlmsArticles(articles: readonly LlmsArticle[], categories: readonly LlmsCategory[]): LlmsArticle[] {
  const seenTitle = new Set<string>();
  const seenId = new Set<string>();
  const unique = articles.filter((a) => {
    const t = a.title.toLowerCase();
    if (seenTitle.has(t) || seenId.has(a.id)) return false;
    seenTitle.add(t);
    seenId.add(a.id);
    return true;
  });
  const rank = new Map(categories.map((c, i) => [c.id, i]));
  return unique
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (rank.get(x.a.category) ?? 999) - (rank.get(y.a.category) ?? 999) || x.i - y.i)
    .map(({ a }) => a);
}

/**
 * One article body as plain Markdown: no front matter / [TOC] / HTML comments / legacy tags, absolute links, a
 * leading H1 dropped (the caller writes the title). Code blocks are left exactly as written.
 */
export function cleanWikiMarkdown(content: string, opts: { siteUrl: string; knownIds: ReadonlySet<string> }): string {
  const site = trimSlash(opts.siteUrl);
  const lines = stripHtmlComments(stripHackmdArtifacts(content)).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      out.push(raw);
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    let line = raw
      .replace(/<br\s*\/?>/gi, '  \n')
      .replace(/<font\b[^>]*>([\s\S]*?)<\/font>/gi, '$1')
      .replace(/<\/?(?:font|span|center|u)\b[^>]*>/gi, '');
    line = canonicalLayerMarks(line);
    // [標題](wiki:wiki-57) → the article's .md; an unknown id keeps only the text
    line = line.replace(/\[([^\]]*)\]\(wiki:([^)\s]*)\)/g, (_m, text: string, id: string) =>
      opts.knownIds.has(id.trim()) ? `[${text}](${site}/${wikiMdPath(id.trim())})` : text);
    // site-relative images and links (/wiki-images/…) → absolute
    line = line.replace(/\]\((\/(?!\/)[^)\s]*)\)/g, (_m, p: string) => `](${site}${p})`);
    out.push(line);
  }
  // drop a leading H1 (it repeats the title)
  while (out.length && !out[0].trim()) out.shift();
  if (out.length && /^#\s/.test(out[0])) out.shift();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function articleHeader(a: LlmsArticle, opts: LlmsOptions, categoryName: string): string {
  const site = trimSlash(opts.siteUrl);
  const meta = [`分類：${categoryName}`];
  const tags = (a.tags ?? []).filter((t) => !opts.categories.some((c) => c.id.toLowerCase() === t.toLowerCase()));
  if (tags.length) meta.push(`標籤：${tags.join('、')}`);
  if (a.status === '待完成') meta.push('狀態：待完成（內容尚未寫完）');
  const lines = [`# ${a.title}`, '', `> ${meta.join(' ｜ ')}`, `> 本文網址：${site}/${wikiMdPath(a.id)}（文章 id：${a.id}）`];
  const note = opts.notes?.[a.id];
  if (note) lines.push(`> ${note}`);
  return lines.join('\n');
}

function oneLine(text: string, max = 110): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Every generated file, keyed by its path in the web build output. */
export function buildLlmsFiles(articles: readonly LlmsArticle[], opts: LlmsOptions): Record<string, string> {
  const site = trimSlash(opts.siteUrl);
  const api = trimSlash(opts.apiUrl);
  const repo = trimSlash(opts.repoUrl);
  const ordered = orderLlmsArticles(articles, opts.categories);
  const knownIds = new Set(ordered.map((a) => a.id));
  const categoryName = (id: string): string => opts.categories.find((c) => c.id === id)?.name ?? id;
  const files: Record<string, string> = {};

  const docs = ordered.map((a) => {
    const doc = `${articleHeader(a, opts, categoryName(a.category))}\n\n${cleanWikiMarkdown(a.content, { siteUrl: site, knownIds })}\n`;
    files[wikiMdPath(a.id)] = doc;
    return doc;
  });

  const layerLegend = (Object.keys(WIKI_TAGS) as (keyof typeof WIKI_TAGS)[])
    .map((k) => `【${WIKI_TAGS[k].label}】＝${WIKI_TAGS[k].hint}`)
    .join('；');

  const intro = [
    '# 阿瓦隆百科 Avalon Pedia TW',
    '',
    '> 繁體中文的阿瓦隆（The Resistance: Avalon）玩家社群百科：規則、角色、任務派票、投票與湖中女神、進階思考、覆盤與賽事、數據。本站以 10 人局為準。網站本身是需要 JavaScript 的單頁應用；這裡列出的 Markdown 檔是同一份內容的純文字版本，每次網站建置時自動重新產生。',
    '',
    `- 網站：${site}/（百科在「百科攻略」頁籤）`,
    `- 語言：繁體中文（zh-Hant）。文章 ${ordered.length} 篇。`,
    `- 論點標記：文章裡的【邏輯】【經驗】標出每條論點的可信度 — ${layerLegend}。網站上以文字顏色呈現（邏輯＝黃字、經驗＝綠字）。`,
    '- 牌譜記號（座位數字、o／x、> 等）與常用術語見「牌譜記錄格式與常用術語」一文；座位 0 家＝10 號。',
  ].join('\n');

  const sections: string[] = [];
  for (const c of opts.categories) {
    const list = ordered.filter((a) => a.category === c.id);
    if (!list.length) continue;
    sections.push(
      [`## ${c.name}`, '', `${c.description}`, '', ...list.map((a) => {
        const pending = a.status === '待完成' ? '（待完成）' : '';
        const summary = oneLine(stripLayerMarks(wikiCardExcerpt(a.excerpt ?? '', a.content)));
        return `- [${a.title}${pending}](${site}/${wikiMdPath(a.id)})${summary ? `: ${summary}` : ''}`;
      })].join('\n'),
    );
  }
  const others = ordered.filter((a) => !opts.categories.some((c) => c.id === a.category));
  if (others.length) {
    sections.push(['## 其他', '', ...others.map((a) => `- [${a.title}](${site}/${wikiMdPath(a.id)})`)].join('\n'));
  }

  const data = [
    '## 全文與資料',
    '',
    `- [全部文章（單一 Markdown 檔）](${site}/llms-full.txt): 上面每一篇文章接在一起，適合一次讀完整個百科`,
    `- [百科文章 JSON](${api}/api/analysis/wiki): 原始資料 { articles: [{ id, title, category, content, tags }] }，content 是含 HackMD 資料區塊的 Markdown`,
    `- [對局數據總覽 JSON](${api}/api/analysis/overview): 全部對局的彙總統計（陣營勝率、任務／刺殺／遊戲三塊結果、座位勝率，以及網站排行榜上已公開的前幾名玩家），網站「數據分析」頁與角色數據文章的數字來源`,
    `- [任務統計 JSON](${api}/api/analysis/missions)、[湖中女神統計](${api}/api/analysis/lake)、[各局統計](${api}/api/analysis/rounds)、[座位順序](${api}/api/analysis/seat-order)、[隊長統計](${api}/api/analysis/captain)、[特徵研究](${api}/api/analysis/feature-studies): 數據分析頁各分頁的彙總統計`,
    `- 注意：API 主機是免費方案，閒置後第一次請求可能要等 30～60 秒喚醒。`,
  ].join('\n');

  const optional = [
    '## Optional',
    '',
    `- [GitHub 原始碼與百科資料](${repo}): 公開的網站原始碼；百科內容的正本是 packages/server/wiki_data.json（[直接下載](${repo.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/main/packages/server/wiki_data.json)）`,
    `- [GitHub 上的文章副本 docs/avalon-wiki](${repo}/tree/main/docs/avalon-wiki): 部分文章的 Markdown 副本與社群問答整理`,
    `- [sitemap.xml](${site}/sitemap.xml)`,
  ].join('\n');

  files['llms.txt'] = `${[intro, ...sections, data, optional].join('\n\n')}\n`;

  files['llms-full.txt'] = `${[
    '# 阿瓦隆百科 Avalon Pedia TW — 全部文章',
    '',
    `> 來源：${site}/ 。共 ${ordered.length} 篇，依分類（${opts.categories.map((c) => c.name).join(' → ')}）排列；每篇以一級標題開頭。目錄與資料端點見 ${site}/llms.txt 。`,
    `> 論點標記：${layerLegend}。`,
  ].join('\n')}\n\n${docs.join('\n---\n\n')}`;

  const urls = [
    ...(opts.sitePages ?? ['/']).map((p) => `${site}${p}`),
    `${site}/llms.txt`,
    `${site}/llms-full.txt`,
    ...ordered.map((a) => `${site}/${wikiMdPath(a.id)}`),
  ];
  files['sitemap.xml'] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${xmlEscape(u)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');

  return files;
}

/** The `<noscript>` fallback for index.html: what the site is and where the readable copies are. */
export function buildNoscriptHtml(articles: readonly LlmsArticle[], opts: Pick<LlmsOptions, 'siteUrl' | 'categories'>): string {
  const site = trimSlash(opts.siteUrl);
  const esc = (s: string): string => xmlEscape(s).replace(/"/g, '&quot;');
  const items = orderLlmsArticles(articles, opts.categories)
    .map((a) => `<li><a href="${esc(`${site}/${wikiMdPath(a.id)}`)}">${esc(a.title)}</a></li>`)
    .join('');
  return [
    '<noscript>',
    '<h1>阿瓦隆百科 Avalon Pedia TW</h1>',
    '<p>繁體中文阿瓦隆（The Resistance: Avalon）玩家社群百科。網站需要 JavaScript；不執行 JavaScript 的工具（爬蟲、AI 閱讀工具）請讀純文字版：',
    `<a href="${esc(`${site}/llms.txt`)}">llms.txt（目錄）</a>、<a href="${esc(`${site}/llms-full.txt`)}">llms-full.txt（全部文章）</a>。</p>`,
    `<ul>${items}</ul>`,
    '</noscript>',
  ].join('\n');
}
