/**
 * 百科文章的深連結與分享頁（Edward 2026-11-11：之後要把百科文章一篇篇發到 Threads）。
 *  - packages/web/src/utils/wikiHash.ts：#wiki=<id> 打開那篇文章、分享網址 /w/<id>/
 *  - packages/web/src/utils/wikiSharePages.ts：build 時每篇文章一頁 w/<id>/index.html，帶那篇文章自己的
 *    Open Graph／Twitter 預覽，打開後轉到 /#wiki=<id>
 * web 沒有測試執行器，純函式在這裡測。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { isWikiArticleId, parseWikiHash, wikiHash, wikiSharePath, wikiShareUrl } from '../../../web/src/utils/wikiHash';
import {
  DEFAULT_SHARE_IMAGE,
  SHARE_DESCRIPTION_MAX,
  buildWikiSharePage,
  buildWikiSharePages,
  escapeHtml,
  shareDescription,
  wikiShareRedirect,
} from '../../../web/src/utils/wikiSharePages';
import { buildLlmsFiles, orderLlmsArticles, wikiMdPath, type LlmsArticle } from '../../../web/src/utils/llmsTxt';
import { WIKI_ARTICLES, WIKI_CATEGORIES } from '../../../web/src/data/wiki';
import { WIKI_MERGED_INTO_1111, WIKI_REDIRECTS } from '../../../web/src/data/wikiRedirects';

const SITE = 'https://example.test';
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const jsonArticles: LlmsArticle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'wiki_data.json'), 'utf-8'));
const allArticles: LlmsArticle[] = [...WIKI_ARTICLES, ...jsonArticles];
const opts = { siteUrl: `${SITE}/`, categories: WIKI_CATEGORIES, image: DEFAULT_SHARE_IMAGE };

/** The value of one meta / link attribute in a generated page (still HTML-escaped). */
function attr(html: string, re: RegExp): string | undefined {
  return re.exec(html)?.[1];
}
const meta = (html: string, key: string): string | undefined =>
  attr(html, new RegExp(`<meta (?:property|name)="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)">`));
const unescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

describe('wiki deep link: parseWikiHash / wikiHash', () => {
  it('#wiki opens the wiki tab; #wiki=<id> and #wiki/<id> open that article', () => {
    for (const h of ['#wiki', 'wiki', '#WIKI', '#wiki/', '#wiki=']) expect(parseWikiHash(h), h).toEqual({ id: null });
    expect(parseWikiHash('#wiki=wiki-24')).toEqual({ id: 'wiki-24' });
    expect(parseWikiHash('#wiki/wiki-24')).toEqual({ id: 'wiki-24' });
    expect(parseWikiHash('#wiki/wiki-24/')).toEqual({ id: 'wiki-24' });
    expect(parseWikiHash('#Wiki=strategy-merlin-data')).toEqual({ id: 'strategy-merlin-data' });
    expect(parseWikiHash(`#wiki=${encodeURIComponent('faq-basic')}`)).toEqual({ id: 'faq-basic' });
  });

  it('#wiki=<id>&sec=<章節> also carries the section to scroll to (2026-11-11 merged articles)', () => {
    const sec = '四、內黑的用途';
    expect(wikiHash('wiki-148', sec)).toBe(`#wiki=wiki-148&sec=${encodeURIComponent(sec)}`);
    expect(parseWikiHash(wikiHash('wiki-148', sec))).toEqual({ id: 'wiki-148', section: sec });
    expect(parseWikiHash(`#wiki=wiki-148&sec=${sec}`)).toEqual({ id: 'wiki-148', section: sec });
    // a broken or empty section is dropped, the article still opens
    for (const h of ['#wiki=wiki-148&sec=', '#wiki=wiki-148&sec=%', '#wiki=wiki-148&sec=a%20b', '#wiki=wiki-148&x=1']) {
      expect(parseWikiHash(h), h).toEqual({ id: 'wiki-148' });
    }
    expect(parseWikiHash('#wiki=%&sec=x')).toEqual({ id: null });
    expect(wikiShareRedirect('wiki-148', '/', sec)).toBe(`/#wiki=wiki-148&sec=${encodeURIComponent(sec)}`);
  });

  it('an id that cannot be an article id falls back to the wiki tab (no crash)', () => {
    for (const h of ['#wiki=%', '#wiki=<img>', '#wiki=a b', `#wiki=${'x'.repeat(65)}`, '#wiki=-x', '#wiki=中文']) {
      expect(parseWikiHash(h), h).toEqual({ id: null });
    }
  });

  it('other hashes are not wiki links', () => {
    for (const h of ['', '#', '#records=123', '#wikipedia', '#wiki-24', '#stats', undefined, null]) expect(parseWikiHash(h)).toBeNull();
  });

  it('round-trips every real article id', () => {
    for (const a of allArticles) {
      expect(isWikiArticleId(a.id), a.id).toBe(true);
      expect(parseWikiHash(wikiHash(a.id))).toEqual({ id: a.id });
    }
    expect(wikiHash()).toBe('#wiki');
    expect(wikiHash('wiki-24')).toBe('#wiki=wiki-24');
  });

  it('share URL and file path', () => {
    expect(wikiShareUrl(`${SITE}/`, 'wiki-24')).toBe(`${SITE}/w/wiki-24/`);
    expect(wikiSharePath('wiki-24')).toBe('w/wiki-24/index.html');
    expect(wikiShareRedirect('wiki-24')).toBe('/#wiki=wiki-24');
    expect(wikiShareRedirect('wiki-24', '/avalonpediatw')).toBe('/avalonpediatw/#wiki=wiki-24');
  });
});

describe('share pages: every article (real wiki data)', () => {
  const pages = buildWikiSharePages(allArticles, opts);
  const ordered = orderLlmsArticles(allArticles, WIKI_CATEGORIES);

  it('every article the site lists gets exactly one page, same list as /wiki-md', () => {
    // 2026-11-11 文章合併：57 → 40 篇
    expect(ordered.length).toBeGreaterThanOrEqual(40);
    expect(Object.keys(pages)).toHaveLength(ordered.length);
    const md = buildLlmsFiles(allArticles, { siteUrl: SITE, apiUrl: 'https://api.example.test', repoUrl: 'https://github.com/x/y', categories: WIKI_CATEGORIES });
    for (const a of ordered) {
      expect(pages[wikiSharePath(a.id)], a.id).toBeDefined();
      expect(md[wikiMdPath(a.id)], a.id).toBeDefined();
      // share pages are for link previews only (they redirect by script): kept out of sitemap.xml
      expect(md['sitemap.xml']).not.toContain(`${SITE}/w/${a.id}/`);
    }
    expect(md['llms.txt']).toContain(`${SITE}/w/<文章 id>/`);
  });

  it('each page carries that article\'s own preview and redirects to #wiki=<id>', () => {
    for (const a of ordered) {
      const html = pages[wikiSharePath(a.id)];
      const url = `${SITE}/w/${a.id}/`;
      expect(html.startsWith('<!doctype html>\n<html lang="zh-Hant">'), a.id).toBe(true);
      expect(unescape(attr(html, /<title>([^<]*)<\/title>/) ?? ''), a.id).toBe(`${a.title}｜阿瓦隆百科`);
      expect(unescape(meta(html, 'og:title') ?? ''), a.id).toBe(a.title);
      expect(meta(html, 'og:type')).toBe('article');
      expect(meta(html, 'og:site_name')).toBe('阿瓦隆百科');
      expect(meta(html, 'og:url')).toBe(url);
      expect(attr(html, /<link rel="canonical" href="([^"]*)">/)).toBe(url);
      expect(meta(html, 'og:image')).toBe(`${SITE}/logo.png`);
      expect(meta(html, 'twitter:card')).toBe('summary'); // the logo is square
      const desc = unescape(meta(html, 'description') ?? '');
      // a real sentence, not a fragment: some stored excerpts used to be the marker legend line
      // (「規則書寫明，必定成立」) or the first line of the body (「遊戲開始，上帝會請所有人閉眼」)
      expect(Array.from(desc).length, a.id).toBeGreaterThanOrEqual(25);
      expect(desc, a.id).not.toMatch(/^.{0,30}(必定|必然)成立。?$/);
      expect(Array.from(desc).length, a.id).toBeLessThanOrEqual(SHARE_DESCRIPTION_MAX);
      expect(desc, a.id).not.toMatch(/[<*`]|\]\(|【(邏輯|經驗)】/);
      expect(unescape(meta(html, 'og:description') ?? '')).toBe(desc);
      expect(html, a.id).toContain(`<script>location.replace("/#wiki=${a.id}");</script>`);
      expect(html, a.id).toContain(`<a href="/#wiki=${a.id}">`);
      // Meta's preview crawler follows meta refresh (it would land on the home page's preview); the redirect is script-only
      expect(html).not.toMatch(/http-equiv="refresh"/i);
    }
  });

  it('the logo used as og:image exists in public/', () => {
    expect(fs.existsSync(path.join(ROOT, 'packages', 'web', 'public', DEFAULT_SHARE_IMAGE.path))).toBe(true);
  });
});

describe('share pages: old merged-away ids (2026-11-11)', () => {
  const pages = buildWikiSharePages(allArticles, { ...opts, redirects: WIKI_REDIRECTS });
  const live = new Set(orderLlmsArticles(allArticles, WIKI_CATEGORIES).map((a) => a.id));
  const byId = new Map(allArticles.map((a) => [a.id, a]));

  it('every old id keeps its /w/<old id>/ page, forwarding to the main article and section with the main article\'s preview', () => {
    expect(Object.keys(pages)).toHaveLength(live.size + Object.keys(WIKI_REDIRECTS).length);
    for (const [old, to] of Object.entries(WIKI_REDIRECTS)) {
      expect(live.has(old), old).toBe(false);
      const html = pages[wikiSharePath(old)];
      expect(html, old).toBeDefined();
      const main = byId.get(to.id)!;
      const target = wikiShareRedirect(to.id, '/', to.section);
      expect(html, old).toContain(`<script>location.replace(${JSON.stringify(target)});</script>`);
      expect(attr(html, /<link rel="canonical" href="([^"]*)">/), old).toBe(`${SITE}/w/${to.id}/`);
      expect(meta(html, 'og:url'), old).toBe(`${SITE}/w/${to.id}/`);
      expect(unescape(meta(html, 'og:title') ?? ''), old).toBe(main.title);
      expect(meta(html, 'robots'), old).toBe('noindex');
      expect(html, old).not.toMatch(/http-equiv="refresh"/i);
    }
    // a live article's page has no noindex
    expect(meta(pages[wikiSharePath('wiki-148')], 'robots')).toBeUndefined();
  });

  it('the Threads posts\' old links still land in the right place', () => {
    expect(pages[wikiSharePath('wiki-2')]).toContain(`location.replace(${JSON.stringify(wikiShareRedirect('wiki-205', '/', WIKI_MERGED_INTO_1111['wiki-2'].section))})`);
    expect(pages[wikiSharePath('wiki-11')]).toContain('location.replace("/#wiki=wiki-148&sec=');
  });

  it('old share pages stay out of sitemap.xml and llms.txt lists only live articles', () => {
    const md = buildLlmsFiles(allArticles, { siteUrl: SITE, apiUrl: 'https://api.example.test', repoUrl: 'https://github.com/x/y', categories: WIKI_CATEGORIES });
    for (const old of Object.keys(WIKI_REDIRECTS)) {
      expect(md['sitemap.xml'], old).not.toContain(`/w/${old}/`);
      expect(md['sitemap.xml'], old).not.toContain(`/wiki-md/${old}.md`);
      expect(md['llms.txt'], old).not.toContain(`/wiki-md/${old}.md`);
    }
  });
});

describe('share pages: escaping and descriptions', () => {
  const nasty: LlmsArticle = {
    id: 'wiki-x',
    title: '"湖中" & <女神> \'問答\'',
    category: 'rules',
    content: '# 標題\n內文',
    excerpt: '【邏輯】 **重點**：A & B <b>粗</b> "引號" 見 [另一篇](wiki:wiki-57)</script><script>alert(1)</script>',
  };
  const html = buildWikiSharePage(nasty, opts);

  it('escapes quotes, ampersands and angle brackets in titles and excerpts', () => {
    expect(html).toContain('<title>&quot;湖中&quot; &amp; &lt;女神&gt; &#39;問答&#39;｜阿瓦隆百科</title>');
    expect(meta(html, 'og:title')).toBe('&quot;湖中&quot; &amp; &lt;女神&gt; &#39;問答&#39;');
    expect(html).toContain('<h1>&quot;湖中&quot; &amp; &lt;女神&gt; &#39;問答&#39;</h1>');
    const desc = meta(html, 'og:description') ?? '';
    expect(desc).toContain('A &amp; B');
    expect(desc).toContain('&quot;引號&quot;');
    expect(unescape(desc)).toBe('重點：A & B 粗 "引號" 見 另一篇alert(1)');
    // nothing from the article can open a tag or end the attribute
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<女神>');
  });

  it('escapeHtml', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('descriptions: plain text, at most the limit, falls back to the body when there is no excerpt', () => {
    expect(shareDescription({ excerpt: '短摘要。', content: '' })).toBe('短摘要。');
    const long = shareDescription({ excerpt: '字'.repeat(300), content: '' });
    expect(Array.from(long)).toHaveLength(SHARE_DESCRIPTION_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(shareDescription({ excerpt: '', content: '# 標題\n\n第一段 [連結](wiki:wiki-1) 的 **內容**。' })).toBe('第一段 連結 的 內容。');
  });

  it('a non-square, wide image switches to the large card; base path is honoured', () => {
    const wide = buildWikiSharePage(nasty, { ...opts, basePath: '/sub/', image: { path: 'banner.png', width: 1200, height: 630, alt: 'x' } });
    expect(meta(wide, 'twitter:card')).toBe('summary_large_image');
    expect(meta(wide, 'og:image')).toBe(`${SITE}/banner.png`);
    expect(wide).toContain('location.replace("/sub/#wiki=wiki-x")');
  });
});

describe('hosting serves /w/<id>/ as a static page', () => {
  it('firebase.json keeps the SPA fallback (static files win over rewrites) and caches /w/**', () => {
    const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf-8'));
    expect(fb.hosting.public).toBe('packages/web/dist');
    expect(fb.hosting.rewrites).toEqual([{ source: '**', destination: '/index.html' }]);
    expect(fb.hosting.headers.some((h: { source: string }) => h.source === '/w/**')).toBe(true);
  });
});
